import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { AgentUncertainError, type AgentBinding, type Observation, type PersistedPrompt } from "../src/agent/opencode-adapter";
import { RunWorker, type WorkerNative } from "../src/agent/worker";
import { initialWorkerPrompt } from "../src/agent/worker-prompts";
import { RejectionService } from "../src/domain/rejection";
import { SearchService } from "../src/domain/search";
import { RunService, type Claim, type NativeDispatcher, type RunRecord } from "../src/domain/run";
import { SqliteAgentBindings } from "../src/storage/agent-binding";
import { SqliteCapabilityDispatcher } from "../src/storage/capability";
import { SqliteRejectionRepository } from "../src/storage/rejection";
import { SqliteRunOperations } from "../src/storage/run-operations";
import { SqliteRunProtocolRepository } from "../src/storage/run-protocol";
import { SqliteRunRepository } from "../src/storage/run";
import { SqliteSearchRepository } from "../src/storage/search";
import { migrate, SqliteStore } from "../src/storage/sqlite";

const now = () => "2031-01-01T00:00:00Z";
const unusedNative: NativeDispatcher = { submit: async () => {}, observe: async () => "running" };
const request = (capability: string, args: Record<string, unknown>) => JSON.stringify({ version: 1, kind: "request", request: { capability, arguments: args } });
const complete = (reply: string) => JSON.stringify({ version: 1, kind: "complete", reply });

async function fixture(action: (f: ReturnType<typeof setup>) => Promise<void>) {
  const dir = mkdtempSync(join("/tmp/opencode", "worker-owned-"));
  const db = new Database(join(dir, "owned.sqlite"));
  try { migrate(db); await action(setup(db)); } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
}
function setup(db: Database) {
  let sequence = 0;
  const id = () => `fixture-${++sequence}`;
  const store = new SqliteStore(db);
  store.saveThought({ id: "root", text: "owned subject", title: null, author: "user", kind: "captured-original", createdAt: now(), origin: "fixture", parentId: null, sourceIds: [] });
  const runs = new SqliteRunRepository(db, { id, now });
  const service = new RunService({ repository: runs, dispatcher: unusedNative, id, now });
  const steps = new SqliteRunProtocolRepository(db);
  const ops = new SqliteRunOperations(db, { id, now });
  const capabilities = new SqliteCapabilityDispatcher(db, { id, now });
  const rejection = new RejectionService(new SqliteRejectionRepository(db));
  return { db, id, store, runs, service, steps, ops, capabilities, rejection };
}
function binding(run: RunRecord): AgentBinding {
  return { sessionId: run.sessionId, serviceUrl: "http://127.0.0.1:7711", location: { directory: "/tmp/opencode/worker-fixture" }, model: { providerID: "fixture", id: "model-a" }, permissions: [{ action: "*", resource: "*", effect: "deny" }], protocolVersion: 1 };
}

/** The fake uses the same authoritative native-phase callback as the real adapter. */
class OwnedNative implements WorkerNative {
  readonly submitted: PersistedPrompt[] = [];
  readonly observed: PersistedPrompt[][] = [];
  readonly bindingsSeen: AgentBinding[] = [];
  cancellations = 0;
  loseAck = false;
  constructor(private readonly bindings: SqliteAgentBindings, private readonly output: (index: number) => string) {}
  async ensureSession(claim: Claim, value: AgentBinding) { this.bindings.bind(claim.runId, value, claim); this.bindingsSeen.push(value); }
  async submit(claim: Claim, _value: AgentBinding, prompt: PersistedPrompt) {
    this.bindings.assertActive(claim, prompt, "history");
    this.bindings.assertActive(claim, prompt, "submit");
    this.submitted.push(prompt);
    if (this.loseAck) { this.loseAck = false; this.bindings.assertActive(claim, prompt, "uncertain"); throw new AgentUncertainError("test admission lost"); }
    this.bindings.assertActive(claim, prompt, "acknowledged");
  }
  async observe(claim: Claim, _value: AgentBinding, prompts: readonly PersistedPrompt[]): Promise<Observation> {
    const last = prompts.at(-1);
    if (!last) throw new Error("Expected persisted prompt");
    expect(this.bindings.assertActive(claim, last, "history")).toEqual(prompts);
    this.observed.push([...prompts]);
    this.bindings.assertActive(claim, last, "completed");
    return { state: "completed", output: this.output(prompts.length - 1) };
  }
  async cancel(_runId: string, _value: AgentBinding, _prompt: PersistedPrompt): Promise<"pending" | "settled"> { this.cancellations++; return "settled"; }
}
function worker(f: ReturnType<typeof setup>, output: (index: number) => string, selected: (run: RunRecord) => AgentBinding | null = binding) {
  const native = new OwnedNative(new SqliteAgentBindings(f.db), output);
  const instance = new RunWorker({ db: f.db, id: f.id, now, bindingFor: selected, native: () => native });
  return { instance, native };
}
async function drive(instance: RunWorker, f: ReturnType<typeof setup>, runId: string) {
  // Test harness bound only; the worker must not impose an effort quota.
  for (let i = 0; i < 20 && !["completed", "interrupted", "failed"].includes(f.runs.get(runId)?.status ?? ""); i++) await instance.tick(runId);
}

test("weave alone renders discovery guidance alongside the shared evidence fences", () => {
  const context = { thoughts: [], connections: [], responses: [] };
  const render = (job: Parameters<typeof initialWorkerPrompt>[0]["job"]) => JSON.parse(initialWorkerPrompt({ ...context, job })) as { role: string; instructions: string[] };
  const weave = render({ kind: "weave", subjectId: "subject" });
  const text = weave.instructions.join(" ");
  for (const phrase of ["claims, themes, and implications", "Actively search", "beyond lexical similarity", "snippets as discovery leads, not evidence", "Fully read promising candidate thoughts", "already fully read and needs no redundant reread", "does not read its endpoint thoughts", "supports, contradicts, extends, or related", "intended direction", "explain concretely", "only fully read supporting thoughts", "finding no useful connection is valid", "do not reconstruct it from indirect provenance"]) expect(text).toContain(phrase);
  expect(weave.role).toContain("fill an absent title");
  const evolve = render({ kind: "evolve", contributionId: "input", continuationId: null });
  const exported = render({ kind: "export", request: "fixture question", effort: "standard" });
  for (const other of [evolve, exported]) expect(other.instructions.join(" ")).not.toContain("Actively search existing thinking for promising candidates");
});

test("weave prompt gives intent-driven source guidance without broadening restricted roles", () => {
  const context = { thoughts: [], connections: [], responses: [] };
  const render = (job: Parameters<typeof initialWorkerPrompt>[0]["job"]) => initialWorkerPrompt({ ...context, job });
  const weave = render({ kind: "weave", subjectId: "subject" }).toLowerCase();
  // These assert instructions only; the controlled native fixture does not retrieve URLs.
  for (const guidance of [/url|link/, /summari[sz]/, /intent|context/, /sibling|separat/, /attribution|source link/,
    /fresh|afresh|again/, /fail|inaccessible|unavailable/, /fabricat|invent/, /follow.*link|link.*follow/]) expect(weave).toMatch(guidance);
  const { instructions } = JSON.parse(weave) as { instructions: string[] };
  expect(instructions.some(instruction => /(?:every|each|all) source-informed interpretations?.{0,120}(?:readable|markdown).{0,60}source links?.{0,60}(?:inline|directly|in (?:its|the) text)/i.test(instruction))).toBe(true);
  const exported = render({ kind: "export", request: "fixture", effort: "standard" });
  expect(exported).toContain("Use only the capabilities listed");
  expect(exported).not.toMatch(/sibling interpretations/i);
});

test("controlled link-list weave saves searchable sibling summaries and a partial-failure outcome", async () => fixture(async f => {
  f.store.saveThought({ id: "links", text: "https://example.test/one\nhttps://example.test/two\nhttps://example.test/missing", title: null, author: "user", kind: "captured-original", createdAt: now(), origin: "fixture", parentId: null, sourceIds: [] });
  const run = f.ops.admitWeave("user", { subjectId: "links", triggerId: "link-list" });
  const outputs = [
    request("interpretation", { text: "Albatross findings [source](https://example.test/one)", sourceIds: [] }),
    request("interpretation", { text: "Borealis findings [source](https://example.test/two)", sourceIds: [] }),
    complete("Summarized two sources; https://example.test/missing was inaccessible."),
  ];
  const w = worker(f, index => outputs[index] ?? complete("unexpected extra turn"));
  await drive(w.instance, f, run.id);
  expect(f.runs.get(run.id)?.status).toBe("completed");
  const issued = f.db.query("SELECT thought_id AS id FROM run_issued_thoughts WHERE run_id=? ORDER BY position").all(run.id) as { id: string }[];
  expect(issued).toHaveLength(2);
  for (const [index, text] of ["Albatross findings [source](https://example.test/one)", "Borealis findings [source](https://example.test/two)"].entries()) {
    expect(f.store.getThought(issued[index]?.id ?? "")).toMatchObject({ text, parentId: "links", kind: "ai-interpretation", author: "ai", sourceIds: [] });
  }
  const search = new SearchService(new SqliteSearchRepository(f.db));
  for (const [index, query] of ["albatross", "borealis"].entries()) {
    expect(search.search({ actor: "user", mode: "normal" }, query)).toContainEqual(expect.objectContaining({ kind: "thought", id: issued[index]?.id }));
  }
  expect(f.db.query("SELECT COUNT(*) AS n FROM thoughts WHERE parent_id='links'").get()).toEqual({ n: 2 });
  const reply = f.runs.reply(run.id);
  expect(reply).toMatchObject({ text: "Summarized two sources; https://example.test/missing was inaccessible.", state: "complete" });
  expect(reply?.thoughtIds).toContain("links");
  f.rejection.rejectThought("user", "links");
  if (!reply) throw new Error("Expected retained outcome");
  expect(f.rejection.getResponse({ actor: "ai", mode: "normal" }, reply.id)).toBeNull();
}));

test("worker without native configuration leaves an unbound queued run untouched", async () => fixture(async f => {
  const run = f.ops.admitWeave("user", { subjectId: "root", triggerId: "unconfigured" });
  const worker = new RunWorker({ db: f.db, id: f.id, now });
  const snapshot = () => ["runs", "run_steps", "agent_bindings", "run_context"].map(table => f.db.query(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all());
  const before = snapshot();
  try {
    await worker.tick(run.id); await worker.tick(run.id);
    expect(snapshot()).toEqual(before);
    expect(f.runs.get(run.id)).toEqual(expect.objectContaining({ status: "queued", generation: 0 }));
  } finally { worker.pause(); await worker.drain(); }
}));

test("weave can search and read a candidate then connect it to the preloaded subject without rereading it", async () => fixture(async f => {
  f.store.saveThought({ id: "candidate", text: "zircon candidate", title: null, author: "user", kind: "captured-original", createdAt: now(), origin: "fixture", parentId: null, sourceIds: [] });
  const run = f.ops.admitWeave("user", { subjectId: "root", triggerId: "discovery" });
  const outputs = [request("search", { query: "zircon" }), request("readThought", { id: "candidate" }), request("connection", { fromId: "root", toId: "candidate", category: "related", explanation: "The subject and candidate share a fixture theme", sourceIds: ["root", "candidate"] }), complete("done")];
  const w = worker(f, index => outputs[index] ?? complete("done"));
  await drive(w.instance, f, run.id);
  expect(f.runs.get(run.id)?.status).toBe("completed");
  expect(f.capabilities.fullReadWitnesses(run.id)).toEqual(expect.arrayContaining([{ kind: "thought", id: "root" }, { kind: "thought", id: "candidate" }]));
  expect(f.db.query("SELECT from_id AS fromId,to_id AS toId,category,explanation FROM connections").get()).toEqual({ fromId: "root", toId: "candidate", category: "related", explanation: "The subject and candidate share a fixture theme" });
  expect(w.native.submitted).toHaveLength(4);
}));

test("worker persists scoped initial context and ordered development result before the next prompt", async () => fixture(async f => {
  const admission = f.service.admit("user", "evolve", { parentId: "root", text: "my contribution" });
  if (!admission.contribution) throw new Error("Expected contribution");
  const contributionId = admission.contribution.id;
  const w = worker(f, index => index === 0 ? request("development", { parentId: contributionId, text: "saved development", sourceIds: [] }) : complete("actual response"));
  await drive(w.instance, f, admission.run.id);
  expect(f.runs.get(admission.run.id)?.status).toBe("completed");
  expect(w.native.submitted).toHaveLength(2);
  const steps = f.steps.steps(admission.run.id);
  expect(steps.map(s => s.promptId)).toEqual(w.native.submitted.map(s => s.promptId));
  expect(steps.map(s => s.input)).toEqual(w.native.submitted.map(s => s.input));
  expect(w.native.submitted[0]?.input).toContain("my contribution");
  expect(f.capabilities.fullReadWitnesses(admission.run.id)).toContainEqual({ kind: "thought", id: contributionId });
  const issued = f.db.query("SELECT thought_id AS id FROM run_issued_thoughts WHERE run_id=? ORDER BY position").all(admission.run.id) as { id: string }[];
  expect(issued).toHaveLength(1);
  expect(w.native.submitted[1]?.input).toContain(issued[0]?.id);
  expect(f.runs.reply(admission.run.id)).toEqual({ id: expect.any(String), text: "actual response", role: "addendum", state: "complete", thoughtIds: [issued[0]?.id] });
  expect(f.ops.stepReceipt(admission.run.id, steps[0]?.promptId ?? "")).not.toBeNull();
  expect(w.native.observed[1]?.map(p => p.promptId)).toEqual(steps.map(s => s.promptId));
}));

test("lost admission acknowledgement and shutdown recover existing prompt without resubmission or rebinding", async () => fixture(async f => {
  const run = f.ops.admitWeave("user", { subjectId: "root", triggerId: "one" });
  const first = worker(f, () => complete("no findings"));
  // Build the adapter before the first dispatch and simulate admission followed by lost acknowledgement.
  first.native.loseAck = true;
  for (let i = 0; i < 8 && first.native.submitted.length === 0; i++) await first.instance.tick(run.id);
  expect(first.native.submitted).toHaveLength(1);
  first.instance.pause();
  expect(f.runs.get(run.id)?.status).not.toBe("interrupted");
  const bound = new SqliteAgentBindings(f.db).get(run.id);
  const second = worker(f, () => complete("no findings"), r => ({ ...binding(r), model: { providerID: "fixture", id: "changed-model" } }));
  await drive(second.instance, f, run.id);
  expect(f.runs.get(run.id)?.status).toBe("completed");
  expect(second.native.submitted).toEqual([]);
  expect(second.native.observed.flat().map(p => p.promptId)).toContain(first.native.submitted[0]?.promptId);
  expect(new SqliteAgentBindings(f.db).get(run.id)).toEqual(bound);
  expect(second.native.bindingsSeen.every(value => value.model.id === "model-a")).toBe(true);
  expect(f.runs.reply(run.id)).toMatchObject({ text: "no findings", state: "complete", thoughtIds: ["root"] });
}));

test("unconfigured queued work performs no native call and remains durable", async () => fixture(async f => {
  const run = f.ops.admitWeave("user", { subjectId: "root", triggerId: "unconfigured" });
  let calls = 0;
  const w = new RunWorker({ db: f.db, id: f.id, now, bindingFor: () => null, native: () => { calls++; throw new Error("must not connect"); } });
  await w.tick(run.id);
  expect(calls).toBe(0);
  expect(f.runs.get(run.id)).toMatchObject({ status: "queued", generation: 0 });
  expect(f.steps.steps(run.id)[0]?.input).toBeNull();
}));

test("Stop fences locally and later worker tick settles cancellation without losing contribution", async () => fixture(async f => {
  const admission = f.service.admit("user", "evolve", { parentId: "root", text: "retained question" });
  if (!admission.contribution) throw new Error("Expected contribution");
  const w = worker(f, () => complete("late answer"));
  for (let i = 0; i < 8 && w.native.submitted.length === 0; i++) await w.instance.tick(admission.run.id);
  expect(w.native.submitted).toHaveLength(1);
  f.service.stop("user", admission.run.id);
  expect(f.runs.get(admission.run.id)?.status).toBe("interrupted");
  await w.instance.tick(admission.run.id);
  expect(w.native.cancellations).toBe(1);
  expect(f.steps.cancellation(admission.run.id)).toBe("settled");
  expect(f.store.getThought(admission.contribution.id)?.text).toBe("retained question");
  expect(f.runs.reply(admission.run.id)).toBeNull();
}));

test("Stop after binding and preparation but before native session creation settles locally", async () => fixture(async f => {
  const admission = f.service.admit("user", "evolve", { parentId: "root", text: "retain before native creation" });
  if (!admission.contribution) throw new Error("Expected contribution");
  const w = worker(f, () => complete("must not run"));
  let cancellationCalls = 0;
  w.native.cancel = async () => { cancellationCalls++; return "pending"; };
  await w.instance.tick(admission.run.id);
  const prepared = f.steps.steps(admission.run.id);
  expect(prepared).toHaveLength(1);
  expect(prepared[0]?.state).toBe("prepared");
  expect(typeof prepared[0]?.input).toBe("string");
  expect(new SqliteAgentBindings(f.db).get(admission.run.id)?.sessionId).toBe(admission.run.sessionId);
  expect(w.native.bindingsSeen).toEqual([]); // No ensureSession call, and therefore no native session lookup/create.
  expect(w.native.submitted).toEqual([]);
  const beforeStop = f.runs.get(admission.run.id);
  if (!beforeStop) throw new Error("Expected active run");
  f.service.stop("user", admission.run.id);
  const stopped = f.runs.get(admission.run.id);
  if (!stopped) throw new Error("Expected stopped run");
  expect(stopped.status).toBe("interrupted");
  expect(stopped.generation).toBeGreaterThan(beforeStop.generation);
  expect(f.steps.cancellation(admission.run.id)).toBe("pending");
  for (let i = 0; i < 3; i++) await w.instance.tick(admission.run.id);
  expect(f.steps.cancellation(admission.run.id)).toBe("settled");
  expect(cancellationCalls).toBe(0);
  expect(w.native.bindingsSeen).toEqual([]);
  expect(w.native.submitted).toEqual([]);
  expect(f.steps.steps(admission.run.id)).toEqual(prepared);
  expect(f.runs.get(admission.run.id)).toEqual(stopped);
  expect(f.store.getThought(admission.contribution.id)?.text).toBe("retain before native creation");
  expect(f.runs.reply(admission.run.id)).toBeNull();
}));

test("prepared successor does not hide earlier submitted work from cancellation", async () => fixture(async f => {
  const run = f.ops.admitWeave("user", { subjectId: "root", triggerId: "prior-submitted-step" });
  const w = worker(f, () => request("readThought", { id: "root" }));
  for (let i = 0; i < 20 && f.steps.steps(run.id).length < 2; i++) await w.instance.tick(run.id);
  const steps = f.steps.steps(run.id);
  expect(steps).toHaveLength(2);
  expect(steps[0]?.state).toBe("processed");
  expect(steps[1]?.state).toBe("prepared");
  expect(w.native.submitted).toHaveLength(1);
  f.service.stop("user", run.id);
  await w.instance.tick(run.id);
  expect(w.native.cancellations).toBe(1);
  expect(f.steps.cancellation(run.id)).toBe("settled");
  expect(f.runs.get(run.id)?.status).toBe("interrupted");
  expect(w.native.submitted).toHaveLength(1);
}));

test("terminal pending cancellation retries until settled without reviving or resubmitting", async () => fixture(async f => {
  const run = f.ops.admitWeave("user", { subjectId: "root", triggerId: "cancel-retry" });
  const w = worker(f, () => complete("late output"));
  let attempts = 0;
  w.native.cancel = async () => { attempts++; return attempts === 1 ? "pending" : "settled"; };
  for (let i = 0; i < 8 && w.native.submitted.length === 0; i++) await w.instance.tick(run.id);
  expect(w.native.submitted).toHaveLength(1);
  f.service.stop("user", run.id);
  await w.instance.tick(run.id);
  expect(attempts).toBe(1);
  expect(f.steps.cancellation(run.id)).toBe("pending");
  expect(f.runs.get(run.id)?.status).toBe("interrupted");
  await w.instance.tick(run.id);
  expect(attempts).toBe(2);
  expect(f.steps.cancellation(run.id)).toBe("settled");
  expect(f.runs.get(run.id)?.status).toBe("interrupted");
  expect(w.native.submitted).toHaveLength(1);
  expect(f.runs.reply(run.id)).toBeNull();
}));

test("malformed completed model output cannot become a fallback reply", async () => fixture(async f => {
  const admission = f.service.admit("user", "evolve", { parentId: "root", text: "question" });
  const w = worker(f, () => '{"version":1,"kind":"complete","reply":');
  await drive(w.instance, f, admission.run.id);
  expect(f.runs.get(admission.run.id)?.status).not.toBe("completed");
  expect(f.runs.reply(admission.run.id)).toBeNull();
}));

test("valid reply without developments attaches once to the original contribution", async () => fixture(async f => {
  const admission = f.service.admit("user", "evolve", { parentId: "root", text: "clarify" });
  if (!admission.contribution) throw new Error("Expected contribution");
  const w = worker(f, () => complete("clarifying question"));
  await drive(w.instance, f, admission.run.id);
  expect(f.runs.get(admission.run.id)?.status).toBe("completed");
  expect(f.runs.reply(admission.run.id)).toEqual({ id: expect.any(String), text: "clarifying question", role: "fallback", state: "complete", thoughtIds: [admission.contribution.id] });
  expect(f.db.query("SELECT COUNT(*) AS n FROM run_issued_thoughts WHERE run_id=?").get(admission.run.id)).toEqual({ n: 0 });
  expect(w.native.submitted).toHaveLength(1);
}));

test("rejecting exposed input fences the session and settles cancellation instead of continuing", async () => fixture(async f => {
  const run = f.ops.admitWeave("user", { subjectId: "root", triggerId: "rejection" });
  const w = worker(f, () => request("interpretation", { text: "must not save", sourceIds: [] }));
  for (let i = 0; i < 8 && w.native.submitted.length === 0; i++) await w.instance.tick(run.id);
  expect(w.native.submitted).toHaveLength(1);
  expect(f.capabilities.fullReadWitnesses(run.id)).toContainEqual({ kind: "thought", id: "root" });
  f.rejection.rejectThought("user", "root");
  await w.instance.tick(run.id);
  await w.instance.tick(run.id);
  expect(f.runs.get(run.id)?.status).toBe("interrupted");
  expect(f.steps.cancellation(run.id)).toBe("settled");
  expect(w.native.cancellations).toBe(1);
  expect(w.native.submitted).toHaveLength(1);
  expect(f.db.query("SELECT COUNT(*) AS n FROM thoughts WHERE text='must not save'").get()).toEqual({ n: 0 });
}));

for (const fence of ["stop", "reject"] as const) test(`${fence} fences a completed but unpublished Weaver outcome while retaining confirmed summary`, async () => fixture(async f => {
  const run = f.ops.admitWeave("user", { subjectId: "root", triggerId: `outcome-${fence}` });
  const outputs = [request("interpretation", { text: "Confirmed [source](https://example.test/one)", sourceIds: [] }), complete("A second source was inaccessible")];
  const w = worker(f, index => outputs[index] ?? complete("unexpected"));
  for (let i = 0; i < 20; i++) {
    const last = f.steps.steps(run.id).at(-1);
    if (last?.state === "completed" && last.envelope?.kind === "complete") break;
    await w.instance.tick(run.id);
  }
  expect(f.steps.steps(run.id).at(-1)).toMatchObject({ state: "completed", envelope: { kind: "complete", reply: "A second source was inaccessible" } });
  expect(f.db.query("SELECT COUNT(*) AS n FROM thoughts WHERE parent_id='root'").get()).toEqual({ n: 1 });
  if (fence === "stop") f.service.stop("user", run.id);
  else f.rejection.rejectThought("user", "root");
  await w.instance.tick(run.id);
  expect(f.runs.get(run.id)?.status).toBe("interrupted");
  expect(f.runs.reply(run.id)).toBeNull();
  expect(f.db.query("SELECT COUNT(*) AS n FROM thoughts WHERE parent_id='root'").get()).toEqual({ n: 1 });
}));
