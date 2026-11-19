import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { captureBackup } from "../src/backup/capture";
import { restoreBackup } from "../src/backup/restore-staging";
import { startDaemon, type RunningDaemon } from "../src/daemon/runtime";
import { createLogger } from "../src/logging";
import { ScriptedClient } from "./agentic-search-capability-fixture";

// Proposed selective protocol: user passages are exact; AI may supply a
// synthesis or select a finalized reply passage. parentSelection indexes an
// earlier user selection in this result; otherwise use the turn parent.
type Selection = { speaker: "user" | "ai"; text: string; parentSelection?: number; source?: "passage" | "synthesis"; sourceTurnId?: string };
type Reply = { reply: string; selections: Selection[]; hold?: boolean } | { request: { capability: string; arguments: object } };
type Turn = { id: string; parentId: string; text: string; status: string; reply: string | null; saves: Save[] };
type Save = { thoughtId: string; speaker: "user" | "ai"; selectedBy: "user" | "ai"; text: string; parentId: string };
type Workspace = { session: { id: string; continuationThoughtId: string }; turns: Turn[] };
type Admission = { receipt: { turnId: string }; turn: Turn; run: { id: string } };
const credentials = { user: "owned-user-012345678901234567890123456789", ai: "owned-agent-01234567890123456789012345678" };
const logger = createLogger("error", () => {});

async function fixture(action: (f: {
  path: string; dir: string; client: ScriptedClient; replies: Reply[];
  request: (route: string, options?: { method?: string; body?: object; key?: string }) => Promise<Response>;
  pulseUntil: (predicate: () => Promise<boolean>) => Promise<void>;
  restart: (path?: string, mediaDir?: string) => Promise<void>;
}) => Promise<void>) {
  const dir = await mkdtemp(join("/tmp/opencode", "evolve-selective-"));
  const path = join(dir, "owned.sqlite");
  const replies: Reply[] = [];
  const client = new ScriptedClient((_index, text) => {
    const input = JSON.parse(text) as { kind?: string; context?: { job?: { kind?: string } } };
    if (input.context?.job?.kind === "weave") return { version: 1, kind: "complete", reply: "No additional findings." };
    const result = replies.shift();
    if (!result) throw new Error("Unexpected selective execution");
    if ("request" in result) return { version: 1, kind: "request", request: result.request };
    if (result.hold) client.holdOutput = true;
    return { version: 1, kind: "ideas-reply", reply: result.reply, selections: result.selections };
  });
  let poll = () => {};
  let daemon: RunningDaemon | undefined;
  const start = (dbPath: string, mediaDir?: string) => startDaemon({
    dbPath, mediaDir, port: 0, credentials,
    agent: { service: { url: "http://127.0.0.1:44991" }, directory: dir,
      model: { providerID: "fixture", id: "model" }, effort: { quick: null, standard: null, thorough: null } },
  }, () => {}, {
    startTimer: callback => { poll = callback; return () => {}; },
    resolveAgentService: async () => ({ url: "http://127.0.0.1:44991" }),
    createPublicClient: () => client, logSink: () => {},
  });
  const restart = async (dbPath = path, mediaDir?: string) => {
    await daemon?.stop();
    daemon = undefined;
    daemon = await start(dbPath, mediaDir);
  };
  const request = (route: string, options: { method?: string; body?: object; key?: string } = {}) => {
    if (!daemon) throw new Error("daemon not running");
    return fetch(new URL(route, daemon.url), { method: options.method ?? "GET", signal: AbortSignal.timeout(4000),
      headers: { authorization: `Bearer ${credentials.user}`, ...(options.body ? { "content-type": "application/json" } : {}),
        ...(options.key ? { "idempotency-key": options.key } : {}) },
      body: options.body ? JSON.stringify(options.body) : undefined });
  };
  const pulseUntil = async (predicate: () => Promise<boolean>) => {
    for (let i = 0; i < 300; i++) { poll(); if (await predicate()) return; await Bun.sleep(10); }
    throw new Error(`selective work did not settle; script errors: ${client.scriptErrors.map(String).join(", ")}`);
  };
  try {
    await restart();
    await action({ path, dir, client, replies, request, pulseUntil, restart });
  } finally {
    client.holdOutput = false;
    try { await daemon?.stop(); } finally { await rm(dir, { recursive: true, force: true }); }
  }
}

async function json<T>(response: Response, status: number): Promise<T> {
  expect(response.status).toBe(status);
  return await response.json() as T;
}
async function setup(f: Parameters<Parameters<typeof fixture>[0]>[0]) {
  const anchor = await json<{ id: string }>(await f.request("/thoughts", { method: "POST", body: { text: "Owned anchor", title: "Anchor" } }), 201);
  // Drain ordinary creation work before observing the selective turn.
  await f.pulseUntil(async () => {
    const db = new Database(f.path, { readonly: true });
    try { return (db.query("SELECT count(*) AS n FROM runs WHERE status NOT IN ('completed','failed','interrupted')").get() as { n: number }).n === 0; }
    finally { db.close(); }
  });
  const created = await json<{ session: { id: string } }>(await f.request("/evolve-sessions", { method: "POST", body: { anchorThoughtId: anchor.id } }), 201);
  return { anchor: anchor.id, base: `/evolve-sessions/${created.session.id}` };
}
async function send(f: Parameters<Parameters<typeof fixture>[0]>[0], base: string, key: string, parentId: string, text: string) {
  const body = { parentId, text };
  const admission = await json<Admission>(await f.request(`${base}/turns`, { method: "POST", key, body }), 201);
  expect(admission.run?.id).toBeTruthy();
  return { admission, body };
}
async function completed(f: Parameters<Parameters<typeof fixture>[0]>[0], base: string, id: string) {
  let workspace: Workspace | undefined;
  await f.pulseUntil(async () => {
    workspace = await json<Workspace>(await f.request(base), 200);
    return workspace.turns.some(turn => turn.id === id && turn.status === "completed");
  });
  const turn = workspace?.turns.find(item => item.id === id);
  if (!turn || !workspace) throw new Error("missing completed turn");
  expect(f.client.scriptErrors).toEqual([]);
  return { turn, workspace };
}
function thoughts(path: string) {
  const db = new Database(path, { readonly: true });
  try { return db.query("SELECT id,text,author,parent_id FROM thoughts ORDER BY rowid").all() as { id: string; text: string; author: string; parent_id: string | null }[]; }
  finally { db.close(); }
}

test("configured selective send executes once and a zero-save reply survives restart without becoming knowledge", async () => fixture(async f => {
  const { anchor, base } = await setup(f);
  const before = thoughts(f.path);
  f.replies.push({ reply: "Which direction should we explore?", selections: [] });
  const { admission, body } = await send(f, base, "zero", anchor, "Please clarify the dialogueonlymarker.");
  const { turn, workspace } = await completed(f, base, admission.turn.id);
  expect(turn).toMatchObject({ text: body.text, reply: "Which direction should we explore?", saves: [] });
  expect(workspace.session.continuationThoughtId).toBe(anchor);
  expect(thoughts(f.path)).toEqual(before);
  const search = await json<{ results: unknown[] }>(await f.request("/search?q=dialogueonlymarker"), 200);
  expect(search.results).toEqual([]);
  const exported = await f.request("/exports/simple", { method: "POST", body: { rootId: anchor, count: 50, traversal: "breadth" } });
  expect(exported.status).toBe(200);
  const markdown = await exported.text();
  expect(markdown).not.toContain("dialogueonlymarker");
  expect(markdown).not.toContain("Which direction should we explore?");
  const count = f.client.prompts.length;
  await f.restart();
  const resumed = await json<Workspace>(await f.request(base), 200);
  expect(resumed.turns).toEqual(workspace.turns);
  const replay = await json<Admission>(await f.request(`${base}/turns`, { method: "POST", key: "zero", body }), 200);
  expect(replay.receipt).toEqual(admission.receipt);
  expect(replay.run.id).toBe(admission.run.id);
  expect(f.client.prompts.length).toBe(count);
}));

test("bounded transcript and receipt pages retain large replies and every manual save", async () => fixture(async f => {
  const { anchor, base } = await setup(f);
  // JSON expands these valid non-NUL characters sixfold. The page budget must
  // apply to encoded bytes, not just the number of turns or receipt objects.
  const reply = "\u0001".repeat(16_384);
  f.replies.push({ reply, selections: [] });
  const body = { parentId: anchor, text: "Owned large receipt source." };
  const first = { admission: await json<Admission>(await f.request(`${base}/turns?view=receipt`, { method: "POST", key: "large-page", body }), 201) };
  expect(first.admission.turn.saves).toEqual([]);
  await completed(f, base, first.admission.turn.id);
  const receiptIds: string[] = [];
  for (let index = 0; index < 44; index++) {
    const response = await f.request(`${base}/turns/${first.admission.turn.id}/saves`, {
      method: "POST", key: `receipt-${index}`, body: { speaker: "ai", text: reply, parentId: anchor },
    });
    const value = await json<{ receipt: { thoughtId: string } }>(response, 201);
    receiptIds.push(value.receipt.thoughtId);
  }
  for (const response of [
    await f.request(`${base}/turns/by-key/large-page?view=receipt`),
    await f.request(`${base}/turns?view=receipt`, { method: "POST", key: "large-page", body }),
  ]) {
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const raw = await response.text();
    expect(new TextEncoder().encode(raw).length).toBeLessThanOrEqual(256 * 1024);
    const recovered = JSON.parse(raw) as Admission;
    expect(recovered.receipt).toEqual(first.admission.receipt);
    expect(recovered.run.id).toBe(first.admission.run.id);
    expect(recovered.turn).toMatchObject({ id: first.admission.turn.id, parentId: anchor, text: body.text, saves: [] });
  }
  for (const response of [
    await f.request(`${base}/turns/by-key/large-page`),
    await f.request(`${base}/turns`, { method: "POST", key: "large-page", body }),
  ]) {
    expect(response.status).toBe(200);
    const raw = await response.text();
    expect(new TextEncoder().encode(raw).length).toBeGreaterThan(4 * 1024 * 1024);
    expect((JSON.parse(raw) as Admission).turn.saves.map(save => save.thoughtId)).toEqual(receiptIds);
  }
  const bounded = await f.request(`${base}?limit=20`);
  expect(bounded.status).toBe(200);
  const wire = await bounded.text();
  expect(new TextEncoder().encode(wire).length).toBeLessThanOrEqual(256 * 1024);
  const page = JSON.parse(wire) as { turns: { id: string; reply: string; saves: Save[]; savesNextAfter: string | null; savesHasMore: boolean }[]; nextBefore: string | null };
  expect(page.turns).toHaveLength(1);
  expect(page.turns[0]?.reply).toBe(reply);
  expect(page.turns[0]?.saves.length).toBeLessThan(receiptIds.length);
  const preview = page.turns[0]?.saves ?? [];
  expect(preview.map(item => item.thoughtId)).toEqual(receiptIds.slice(0, preview.length));
  expect(page.turns[0]?.savesHasMore).toBe(true);
  expect(page.turns[0]?.savesNextAfter).toBe(preview.at(-1)?.thoughtId ?? null);
  const seen: string[] = [];
  let after: string | null = null;
  do {
    const response = await f.request(`${base}/turns/${first.admission.turn.id}/saves?limit=20${after ? `&after=${encodeURIComponent(after)}` : ""}`);
    expect(response.status).toBe(200);
    const raw = await response.text();
    expect(new TextEncoder().encode(raw).length).toBeLessThanOrEqual(256 * 1024);
    const result = JSON.parse(raw) as { saves: Save[]; nextAfter: string | null };
    expect(result.saves.length).toBeGreaterThan(0);
    expect(result.saves.length).toBeLessThanOrEqual(20);
    expect(result.saves.every(item => item.text === reply)).toBe(true);
    seen.push(...result.saves.map(item => item.thoughtId));
    after = result.nextAfter;
    expect(seen.length).toBeLessThanOrEqual(receiptIds.length);
  } while (after !== null);
  expect(seen).toEqual(receiptIds);
  expect(new Set(seen).size).toBe(receiptIds.length);
  expect((await f.request(`${base}/turns/${first.admission.turn.id}/saves?limit=20&after=unknown`)).status).toBeGreaterThanOrEqual(400);
  expect((await f.request(`${base}/turns/${first.admission.turn.id}/saves?limit=21`)).status).toBeGreaterThanOrEqual(400);
  const other = await setup(f);
  expect((await f.request(`${other.base}/turns/${first.admission.turn.id}/saves?limit=20`)).status).toBeGreaterThanOrEqual(400);
  const legacy = await json<Workspace>(await f.request(base), 200);
  expect(legacy.turns[0]?.saves.map(save => save.thoughtId)).toEqual(receiptIds);
}));

test("agent selections preserve exact speaker text, child and sibling ancestry, and selectable continuation", async () => fixture(async f => {
  const { anchor, base } = await setup(f);
  const user = "A shared map makes disagreement easier to examine.";
  const child = "A map can also expose missing assumptions.";
  const sibling = "A private journal offers another route.";
  f.replies.push({ reply: `${child} ${sibling}`, selections: [
    { speaker: "user", text: user }, { speaker: "ai", text: child, parentSelection: 0 }, { speaker: "ai", text: sibling },
  ] });
  const { admission } = await send(f, base, "ideas", anchor, `Consider this: ${user} What follows?`);
  const { turn, workspace } = await completed(f, base, admission.turn.id);
  expect(turn.saves).toHaveLength(3);
  const [human, developed, alternative] = turn.saves;
  if (!human || !developed || !alternative) throw new Error("missing saves");
  expect(human).toMatchObject({ speaker: "user", selectedBy: "ai", text: user, parentId: anchor });
  expect(developed).toMatchObject({ speaker: "ai", selectedBy: "ai", text: child, parentId: human.thoughtId });
  expect(alternative).toMatchObject({ speaker: "ai", selectedBy: "ai", text: sibling, parentId: anchor });
  expect(thoughts(f.path)).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: human.thoughtId, text: user, author: "user", parent_id: anchor }),
    expect.objectContaining({ id: developed.thoughtId, text: child, author: "ai", parent_id: human.thoughtId }),
    expect.objectContaining({ id: alternative.thoughtId, text: sibling, author: "ai", parent_id: anchor }),
  ]));
  expect(workspace.session.continuationThoughtId).toBe(alternative.thoughtId);
  expect((await f.request(`/thoughts/${human.thoughtId}`)).status).toBe(200);
  expect((await json<Workspace>(await f.request(base), 200)).session.continuationThoughtId).toBe(alternative.thoughtId);
  const selected = await f.request(`${base}/continuation`, { method: "PUT", body: { thoughtId: human.thoughtId } });
  expect(selected.status).toBe(200);
  expect((await json<Workspace>(await f.request(base), 200)).session.continuationThoughtId).toBe(human.thoughtId);
  f.replies.push({ reply: "A follow-up.", selections: [] });
  const next = await send(f, base, "branch", human.thoughtId, "Continue this branch.");
  const branch = await completed(f, base, next.admission.turn.id);
  expect(branch.turn.parentId).toBe(human.thoughtId);
  expect(branch.workspace.session.continuationThoughtId).toBe(human.thoughtId);
}));

test("continuation CAS refuses stale send and change without writes, while exact send replay wins before CAS", async () => fixture(async f => {
  const { anchor, base } = await setup(f);
  const idea = "A reliable handoff makes returning easier.";
  f.replies.push({ reply: idea, selections: [{ speaker: "ai", text: idea }] });
  const body = { parentId: anchor, text: "Explore a reliable handoff.", expectedContinuationThoughtId: anchor };
  const original = await json<Admission>(await f.request(`${base}/turns`, { method: "POST", key: "cas-original", body }), 201);
  const published = await completed(f, base, original.turn.id);
  const saved = published.turn.saves[0];
  if (!saved) throw new Error("missing confirmed continuation");
  expect(published.workspace.session.continuationThoughtId).toBe(saved.thoughtId);
  const snapshot = () => {
    const db = new Database(f.path, { readonly: true });
    try {
      return {
        turns: db.query("SELECT id,run_id,parent_id,text FROM evolve_turns ORDER BY rowid").all(),
        runs: db.query("SELECT id FROM runs WHERE id IN (SELECT run_id FROM evolve_turns) ORDER BY id").all(),
        sessions: db.query("SELECT id,continuation_id FROM evolve_sessions ORDER BY id").all(),
      };
    } finally { db.close(); }
  };
  const before = snapshot();
  const staleSend = await f.request(`${base}/turns`, { method: "POST", key: "cas-stale", body: {
    parentId: anchor, text: "Must not be admitted.", expectedContinuationThoughtId: anchor,
  } });
  expect(staleSend.status).toBe(409);
  expect(await staleSend.json()).toMatchObject({ code: "stale-continuation" });
  const staleChange = await f.request(`${base}/continuation`, { method: "PUT", body: {
    thoughtId: anchor, expectedContinuationThoughtId: anchor,
  } });
  expect(staleChange.status).toBe(409);
  expect(await staleChange.json()).toMatchObject({ code: "stale-continuation" });
  expect(snapshot()).toEqual(before);
  const replay = await json<Admission>(await f.request(`${base}/turns`, { method: "POST", key: "cas-original", body }), 200);
  expect(replay.receipt).toEqual(original.receipt);
  expect(replay.turn.id).toBe(original.turn.id);
  expect(snapshot()).toEqual(before);
  const change = await f.request(`${base}/continuation`, { method: "PUT", body: {
    thoughtId: anchor, expectedContinuationThoughtId: saved.thoughtId,
  } });
  expect(change.status).toBe(200);
  expect((await json<Workspace>(await f.request(base), 200)).session.continuationThoughtId).toBe(anchor);
}));

test("AI synthesis remains AI-authored, while remember-this saves an identifiable user passage and asks when ambiguous", async () => fixture(async f => {
  const { anchor, base } = await setup(f);
  const passage = "A small reversible experiment can test the idea.";
  const synthesis = "Reversibility reduces the cost of learning.";
  f.replies.push({ reply: "That suggests a useful experiment.", selections: [
    { speaker: "user", text: passage }, { speaker: "ai", text: synthesis, source: "synthesis", parentSelection: 0 },
  ] });
  const first = await send(f, base, "remember", anchor, `Remember this: ${passage}`);
  const saved = await completed(f, base, first.admission.turn.id);
  expect(saved.turn.saves).toHaveLength(2);
  const human = saved.turn.saves[0], ai = saved.turn.saves[1];
  if (!human || !ai) throw new Error("missing saved ideas");
  expect(human).toMatchObject({ text: passage, speaker: "user", selectedBy: "ai", parentId: anchor });
  expect(ai).toMatchObject({ text: synthesis, speaker: "ai", selectedBy: "ai", parentId: human.thoughtId });
  expect(thoughts(f.path)).toContainEqual(expect.objectContaining({ id: ai.thoughtId, text: synthesis, author: "ai" }));
  f.replies.push({ reply: "Which passage should I remember?", selections: [] });
  const ambiguous = await send(f, base, "ambiguous", ai.thoughtId, "Remember this.");
  const clarification = await completed(f, base, ambiguous.admission.turn.id);
  expect(clarification.turn).toMatchObject({ reply: "Which passage should I remember?", saves: [] });
  expect(clarification.workspace.session.continuationThoughtId).toBe(ai.thoughtId);
  const native = f.client.prompts.find(p => f.client.sessions.get(p.sessionID)?.metadata.runId === first.admission.run.id);
  if (!native) throw new Error("missing selective prompt");
  expect(native.text).toContain("Remember this");
}));

// sourceTurnId identifies an eligible prior turn included in this run's
// session-scoped context. Omitting it continues to mean the current message.
test("remembering an identified prior user passage saves its exact words with user authorship", async () => fixture(async f => {
  const { anchor, base } = await setup(f);
  const passage = "Shared maps make differences easier to discuss.";
  f.replies.push({ reply: "That is worth exploring.", selections: [] });
  const first = await send(f, base, "prior-passage", anchor, passage);
  await completed(f, base, first.admission.turn.id);
  f.replies.push({ reply: "I saved that passage.", selections: [
    { speaker: "user", text: passage, sourceTurnId: first.admission.turn.id },
  ] });
  const second = await send(f, base, "remember-prior", anchor, 'Remember the earlier passage beginning "Shared maps".');
  const result = await completed(f, base, second.admission.turn.id);
  expect(result.turn.saves).toHaveLength(1);
  const receipt = result.turn.saves[0];
  expect(receipt).toMatchObject({ speaker: "user", selectedBy: "ai", text: passage, parentId: anchor,
    sourceTurnId: first.admission.turn.id });
  expect(thoughts(f.path)).toContainEqual(expect.objectContaining({ id: receipt?.thoughtId, text: passage, author: "user", parent_id: anchor }));
  const native = f.client.prompts.find(p => f.client.sessions.get(p.sessionID)?.metadata.runId === second.admission.run.id);
  if (!native) throw new Error("missing remember-this native context");
  expect(native.text).toContain(first.admission.turn.id);
  expect(native.text).toContain(passage);
}));

test("prior passage selection cannot read from another session or from rejection-ineligible history", async () => fixture(async f => {
  const { anchor, base } = await setup(f);
  const other = await json<{ session: { id: string } }>(await f.request("/evolve-sessions", { method: "POST", body: { anchorThoughtId: anchor } }), 201);
  const otherBase = `/evolve-sessions/${other.session.id}`;
  const passage = "A private passage from a different conversation.";
  f.replies.push({ reply: "Noted.", selections: [] });
  const foreign = await send(f, otherBase, "foreign", anchor, passage);
  await completed(f, otherBase, foreign.admission.turn.id);
  f.replies.push({ reply: "I saved it.", selections: [{ speaker: "user", text: passage, sourceTurnId: foreign.admission.turn.id }] });
  const forged = await send(f, base, "cross-session", anchor, "Remember a passage.");
  await f.pulseUntil(async () => ["completed", "failed", "interrupted"].includes(
    (await json<{ status: string }>(await f.request(`/runs/${forged.admission.run.id}`), 200)).status));
  expect(thoughts(f.path).some(t => t.text === passage)).toBe(false);

  const ineligible = "This earlier passage depends on a rejected idea.";
  const rejected = "A rejectable idea from this exchange.";
  f.replies.push({ reply: rejected, selections: [{ speaker: "ai", text: rejected }] });
  const prior = await send(f, base, "ineligible", anchor, ineligible);
  const previous = await completed(f, base, prior.admission.turn.id);
  const saved = previous.turn.saves[0];
  if (!saved) throw new Error("missing prior save");
  expect((await f.request(`/thoughts/${saved.thoughtId}/reject`, { method: "POST" })).status).toBe(204);
  f.replies.push({ reply: "I saved it.", selections: [{ speaker: "user", text: ineligible, sourceTurnId: prior.admission.turn.id }] });
  const unsafe = await send(f, base, "rejected-prior", anchor, "Remember the earlier passage.");
  await f.pulseUntil(async () => ["completed", "failed", "interrupted"].includes(
    (await json<{ status: string }>(await f.request(`/runs/${unsafe.admission.run.id}`), 200)).status));
  expect(thoughts(f.path).some(t => t.text === ineligible)).toBe(false);
}));

test("manual saves of either speaker are confirmed, replay-safe and never retarget an older turn", async () => fixture(async f => {
  const { anchor, base } = await setup(f);
  const user = "My overlooked observation is precise.";
  const ai = "The overlooked alternative is reversible.";
  f.replies.push({ reply: ai, selections: [] });
  const first = await send(f, base, "first", anchor, user);
  await completed(f, base, first.admission.turn.id);
  f.replies.push({ reply: "A newer idea.", selections: [{ speaker: "ai", text: "A newer idea." }] });
  const second = await send(f, base, "second", anchor, "Develop another direction.");
  const current = await completed(f, base, second.admission.turn.id);
  const continuation = current.workspace.session.continuationThoughtId;
  const prompts = f.client.prompts.length;
  for (const [speaker, text] of [["user", user], ["ai", ai]] as const) {
    const body = { speaker, text, parentId: anchor };
    const route = `${base}/turns/${first.admission.turn.id}/saves`;
    const firstSave = await json<{ receipt: Save }>(await f.request(route, { method: "POST", key: `keep-${speaker}`, body }), 201);
    expect(firstSave.receipt).toMatchObject({ speaker, selectedBy: "user", text, parentId: anchor });
    const replay = await json<{ receipt: Save }>(await f.request(route, { method: "POST", key: `keep-${speaker}`, body }), 200);
    expect(replay.receipt).toEqual(firstSave.receipt);
    expect((await f.request(route, { method: "POST", key: `keep-${speaker}`, body: { ...body, text: "forged" } })).status).toBe(409);
    expect(thoughts(f.path).filter(t => t.id === firstSave.receipt.thoughtId)).toEqual([
      expect.objectContaining({ text, author: speaker, parent_id: anchor }),
    ]);
  }
  expect(f.client.prompts.length).toBe(prompts);
  expect((await json<Workspace>(await f.request(base), 200)).session.continuationThoughtId).toBe(continuation);
}));

test("a real completed transcript and its confirmed receipt survive backup and restore", async () => fixture(async f => {
  const { anchor, base } = await setup(f);
  const passage = "Retained idea from the actual exchange.";
  f.replies.push({ reply: passage, selections: [{ speaker: "ai", text: passage }] });
  const { admission, body } = await send(f, base, "backup", anchor, "Explore this.");
  const { workspace } = await completed(f, base, admission.turn.id);
  const output = join(f.dir, "backup-output"); await mkdir(output, { mode: 0o700 });
  const snapshot = await captureBackup({ databasePath: f.path, mediaDirectory: `${f.path}.media`, outputDirectory: output, logger });
  const restored = await restoreBackup({ snapshotDirectory: snapshot.snapshotDirectory, targetDirectory: join(f.dir, "restore"), restoredAt: "2032-01-01T00:00:00.000Z", logger });
  await f.restart(restored.databasePath, restored.mediaDirectory);
  expect(await json<Workspace>(await f.request(base), 200)).toEqual(workspace);
  const replay = await json<Admission>(await f.request(`${base}/turns`, { method: "POST", key: "backup", body }), 200);
  expect(replay.receipt).toEqual(admission.receipt);
  expect(replay.run.id).toBe(admission.run.id);
  expect(thoughts(restored.databasePath)).toContainEqual(expect.objectContaining({ text: passage, author: "ai" }));
}), 45000);

test("a model cannot attribute invented or cross-speaker text to the user", async () => fixture(async f => {
  const { anchor, base } = await setup(f);
  const before = thoughts(f.path);
  const reply = "The model invented this assertion.";
  f.replies.push({ reply, selections: [{ speaker: "user", text: reply }, { speaker: "user", text: "A fabricated user passage." }] });
  const { admission } = await send(f, base, "spoof", anchor, "What do you think?");
  await f.pulseUntil(async () => {
    const result = await json<{ status: string }>(await f.request(`/runs/${admission.run.id}`), 200);
    return ["completed", "failed", "interrupted"].includes(result.status);
  });
  expect(thoughts(f.path)).toEqual(before);
  const workspace = await json<Workspace>(await f.request(base), 200);
  expect(workspace.turns.find(t => t.id === admission.turn.id)?.saves ?? []).toEqual([]);
}));

test("rejection excludes dependent dialogue from subsequent native context", async () => fixture(async f => {
  const { anchor, base } = await setup(f);
  const sensitive = "REJECTED-DEPENDENT-DIALOGUE-SENTINEL";
  const retained = "A rejectable direction.";
  f.replies.push({ reply: retained, selections: [{ speaker: "ai", text: retained }] });
  const first = await send(f, base, "dependent", anchor, sensitive);
  const saved = await completed(f, base, first.admission.turn.id);
  const rejected = saved.turn.saves[0];
  if (!rejected) throw new Error("missing confirmed save");
  expect((await f.request(`/thoughts/${rejected.thoughtId}/reject`, { method: "POST" })).status).toBe(204);
  f.replies.push({ reply: "Starting from eligible material.", selections: [] });
  const second = await send(f, base, "safe", anchor, "Continue from the original anchor.");
  await completed(f, base, second.admission.turn.id);
  const native = f.client.prompts.find(p => f.client.sessions.get(p.sessionID)?.metadata.runId === second.admission.run.id);
  if (!native) throw new Error("missing second native run");
  expect(native.text).not.toContain(sensitive);
  expect(native.text).not.toContain(retained);
}));

test("Stop fences a held final reply and late output cannot publish a thought", async () => fixture(async f => {
  const { anchor, base } = await setup(f);
  f.replies.push({ reply: "Previously confirmed idea.", selections: [{ speaker: "ai", text: "Previously confirmed idea." }] });
  const first = await send(f, base, "confirmed", anchor, "Develop the anchor.");
  const confirmed = await completed(f, base, first.admission.turn.id);
  const receipt = confirmed.turn.saves[0];
  if (!receipt) throw new Error("missing confirmed save");
  const before = thoughts(f.path);
  f.replies.push({ reply: "Late fenced idea.", selections: [{ speaker: "ai", text: "Late fenced idea." }] });
  f.client.holdOutput = true;
  const { admission } = await send(f, base, "stop", receipt.thoughtId, "Explore but stop.");
  await f.pulseUntil(async () => f.client.prompts.some(p => f.client.sessions.get(p.sessionID)?.metadata.runId === admission.run.id));
  const stopped = await f.request(`/runs/${admission.run.id}/stop`, { method: "POST", body: {} });
  expect([200, 204]).toContain(stopped.status);
  f.client.holdOutput = false;
  await f.pulseUntil(async () => {
    const run = await json<{ status: string }>(await f.request(`/runs/${admission.run.id}`), 200);
    return ["interrupted", "failed"].includes(run.status);
  });
  expect(thoughts(f.path)).toEqual(before);
  const workspace = await json<Workspace>(await f.request(base), 200);
  const turn = workspace.turns.find(t => t.id === admission.turn.id);
  expect(turn?.status).not.toBe("completed");
  expect(turn?.saves ?? []).toEqual([]);
  expect(workspace.turns.find(t => t.id === first.admission.turn.id)?.saves).toContainEqual(receipt);
  expect(thoughts(f.path)).toContainEqual(expect.objectContaining({ id: receipt.thoughtId, text: "Previously confirmed idea." }));
}));

test("rejection while native output is held fences publication that depends on the rejected idea", async () => fixture(async f => {
  const { anchor, base } = await setup(f);
  f.replies.push({ reply: "Dependency for pending run.", selections: [{ speaker: "ai", text: "Dependency for pending run." }] });
  const first = await send(f, base, "dependency", anchor, "Develop this.");
  const completedFirst = await completed(f, base, first.admission.turn.id);
  const dependency = completedFirst.turn.saves[0];
  if (!dependency) throw new Error("missing dependency");
  f.replies.push({ reply: "Forbidden late publication.", selections: [{ speaker: "ai", text: "Forbidden late publication." }] });
  f.client.holdOutput = true;
  const pending = await send(f, base, "held", dependency.thoughtId, "Build on that.");
  await f.pulseUntil(async () => f.client.prompts.some(p => f.client.sessions.get(p.sessionID)?.metadata.runId === pending.admission.run.id));
  expect((await f.request(`/thoughts/${dependency.thoughtId}/reject`, { method: "POST" })).status).toBe(204);
  f.client.holdOutput = false;
  await f.pulseUntil(async () => {
    const run = await json<{ status: string }>(await f.request(`/runs/${pending.admission.run.id}`), 200);
    return ["interrupted", "failed"].includes(run.status);
  });
  expect(thoughts(f.path).some(t => t.text === "Forbidden late publication.")).toBe(false);
  const workspace = await json<Workspace>(await f.request(base), 200);
  expect(workspace.turns.find(t => t.id === pending.admission.turn.id)?.status).not.toBe("completed");
}));

test("a save confirmed during a running turn survives Stop while its later reply remains interrupted", async () => fixture(async f => {
  const { anchor, base } = await setup(f);
  const passage = "A confirmed user insight before stopping.";
  f.replies.push(
    { request: { capability: "saveIdea", arguments: { speaker: "user", text: passage, parentId: anchor } } },
    { reply: "An unconfirmed late reply.", selections: [], hold: true },
  );
  const pending = await send(f, base, "partial-save", anchor, passage);
  let receipt: Save | undefined;
  await f.pulseUntil(async () => {
    const workspace = await json<Workspace>(await f.request(base), 200);
    receipt = workspace.turns.find(t => t.id === pending.admission.turn.id)?.saves[0];
    return !!receipt && f.client.holdOutput;
  });
  if (!receipt) throw new Error("save was not confirmed before Stop");
  expect(receipt).toMatchObject({ speaker: "user", selectedBy: "ai", text: passage, parentId: anchor });
  const stopped = await f.request(`/runs/${pending.admission.run.id}/stop`, { method: "POST", body: {} });
  expect([200, 204]).toContain(stopped.status);
  f.client.holdOutput = false;
  await f.pulseUntil(async () => {
    const run = await json<{ status: string }>(await f.request(`/runs/${pending.admission.run.id}`), 200);
    return ["interrupted", "failed"].includes(run.status);
  });
  const workspace = await json<Workspace>(await f.request(base), 200);
  const turn = workspace.turns.find(t => t.id === pending.admission.turn.id);
  expect(turn?.status).not.toBe("completed");
  expect(turn?.saves).toContainEqual(receipt);
  expect(thoughts(f.path)).toContainEqual(expect.objectContaining({ id: receipt.thoughtId, text: passage, author: "user" }));
}));

test("frozen logical-10 backup restores the original session and pending admission receipt", async () => {
  const frozen = JSON.parse(await readFile(new URL("./fixtures/evolve-logical-10.json", import.meta.url), "utf8")) as {
    session: { id: string; anchorThoughtId: string }; input: { parentId: string; text: string };
    turn: { receipt: { turnId: string }; turn: { id: string } }; files: Record<string, string>;
  };
  const dir = await mkdtemp(join("/tmp/opencode", "evolve-logical10-"));
  let daemon: RunningDaemon | undefined;
  try {
    const source = join(dir, "snapshot"); await mkdir(source, { mode: 0o700 });
    for (const [name, encoded] of Object.entries(frozen.files)) {
      const target = join(source, name);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, Buffer.from(encoded, "base64"), { mode: 0o600 });
    }
    const restored = await restoreBackup({ snapshotDirectory: source, targetDirectory: join(dir, "restore"), restoredAt: "2032-01-01T00:00:00.000Z", logger });
    daemon = await startDaemon({ dbPath: restored.databasePath, mediaDir: restored.mediaDirectory, port: 0, credentials }, () => {}, { logSink: () => {} });
    const base = `/evolve-sessions/${frozen.session.id}`;
    const request = (route: string, options: RequestInit = {}) => fetch(new URL(route, daemon?.url), { ...options, signal: AbortSignal.timeout(4000),
      headers: { authorization: `Bearer ${credentials.user}`, ...options.headers } });
    const lookup = await json<{ receipt: unknown; turn: { id: string } }>(await request(`${base}/turns/by-key/frozen-turn`), 200);
    expect(lookup.receipt).toEqual(frozen.turn.receipt);
    expect(lookup.turn.id).toBe(frozen.turn.turn.id);
    const replay = await json<{ receipt: unknown; turn: { id: string } }>(await request(`${base}/turns`, { method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "frozen-turn" }, body: JSON.stringify(frozen.input) }), 200);
    expect(replay.receipt).toEqual(frozen.turn.receipt);
    expect(replay.turn.id).toBe(frozen.turn.turn.id);
    const workspace = await json<Workspace>(await request(base), 200);
    expect(workspace.session).toMatchObject({ id: frozen.session.id, continuationThoughtId: frozen.session.anchorThoughtId });
    expect(workspace.turns).toHaveLength(1);
    expect(workspace.turns[0]).toMatchObject(frozen.input);
    const db = new Database(restored.databasePath, { readonly: true });
    try { expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]); }
    finally { db.close(); }
  } finally { await daemon?.stop(); await rm(dir, { recursive: true, force: true }); }
}, 45000);
