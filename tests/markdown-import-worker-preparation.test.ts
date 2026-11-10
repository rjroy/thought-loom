import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { MarkdownImportWorker, type ImportNative } from "../src/agent/import-worker";
import { AgentSessionMissingError } from "../src/agent/errors";
import { OpenCodeAdapter, type InboxItem, type NativeMessage, type NativeSession, type PublicClient } from "../src/agent/opencode-adapter";
import { createMarkdownParser } from "../src/domain/markdown-import-parser";
import { partitionMarkdown, prepareMarkdown } from "../src/domain/markdown-import";
import { SqliteMarkdownImports } from "../src/storage/markdown-import";
import { SqliteRunRepository } from "../src/storage/run";
import { migrate } from "../src/storage/sqlite";

const quiet = { verbose: () => {}, info: () => {}, warning: () => {}, error: () => {} };
const bytes = (text: string) => new TextEncoder().encode(text);

class Client implements PublicClient {
  async instructionList(): Promise<never> { throw new Error("Unexpected instruction list"); }
  async instructionPut(): Promise<never> { throw new Error("Unexpected instruction put"); }
  async instructionRemove(): Promise<never> { throw new Error("Unexpected instruction remove"); }
  readonly sessions = new Map<string, NativeSession>();
  readonly messages = new Map<string, NativeMessage[]>();
  readonly prompts: Parameters<PublicClient["prompt"]>[0][] = [];
  blockPreflight = false;
  async serverInfo() { return { version: "99.0.0-test" }; }
  async sessionCreate(input: Parameters<PublicClient["sessionCreate"]>[0]): Promise<NativeSession> {
    const session = { id: input.id, location: input.location, model: input.model, permissions: input.permissions, metadata: input.metadata };
    this.sessions.set(input.id, session); this.messages.set(input.id, []); return session;
  }
  async sessionGet(input: { readonly sessionID: string }): Promise<NativeSession> {
    const session = this.sessions.get(input.sessionID);
    if (!session) throw new AgentSessionMissingError("fixture session absent");
    return session;
  }
  async prompt(input: Parameters<PublicClient["prompt"]>[0]): Promise<InboxItem> {
    this.prompts.push(input);
    const messages = this.messages.get(input.sessionID);
    if (!messages) throw new Error("fixture session missing");
    messages.push({ id: input.id, type: "user", time: { created: 10 }, text: input.text });
    return { id: input.id, sessionID: input.sessionID, type: "user", payload: { text: input.text }, delivery: "queue", time: { created: 10 } };
  }
  async history(input: Parameters<PublicClient["history"]>[0]) { return { data: this.messages.get(input.sessionID) ?? [], cursor: {} }; }
  async inbox() { return []; }
  async active() { return this.blockPreflight ? Object.fromEntries([...this.sessions.keys()].map(id => [id, {}])) : {}; }
  async cancelInbox() {}
  async interrupt() { return { interrupted: true }; }
  complete(sessionID: string, outcome: "valid" | "failed" | "invalid") {
    const prompt = this.prompts.find(item => item.sessionID === sessionID), messages = this.messages.get(sessionID);
    if (!prompt || !messages) throw new Error("fixture prompt missing");
    const job: unknown = JSON.parse(prompt.text);
    if (typeof job !== "object" || job === null || !("manifest" in job) || typeof job.manifest !== "object" || job.manifest === null || !("cuts" in job.manifest) || !Array.isArray(job.manifest.cuts)) throw new Error("fixture manifest missing");
    const cuts = job.manifest.cuts;
    const first: unknown = cuts[0], last: unknown = cuts.at(-1);
    if (typeof first !== "object" || first === null || !("id" in first) || typeof first.id !== "string" || typeof last !== "object" || last === null || !("id" in last) || typeof last.id !== "string") throw new Error("fixture endpoints missing");
    if (outcome !== "failed") messages.push({ id: `assistant-${prompt.id}`, type: "assistant", time: { created: 11, completed: 12 }, content: [{ type: "text", text: outcome === "valid" ? JSON.stringify({ version: 1, kind: "segmentation", cuts: [first.id, last.id] }) : "not json" }], finish: "stop" });
    messages.push({ id: `idle-${prompt.id}`, type: "idle", time: { created: 13 }, outcome: outcome === "failed" ? "failed" : "succeeded" });
  }
}

function fixture() {
  const db = new Database(":memory:");
  migrate(db, quiet);
  let id = 0, parses = 0;
  const sources = { id: () => `owned-${++id}`, sessionId: () => `ses_owned${++id}`, promptId: () => `msg_owned${++id}`, now: () => "2030-01-02T00:00:00Z", logger: quiet };
  const imports = new SqliteMarkdownImports(db, sources), client = new Client();
  const parser = createMarkdownParser(body => { parses++; return fromMarkdown(body, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }); });
  const native = (bindings: ConstructorParameters<typeof OpenCodeAdapter>[1], localFence: () => void): ImportNative => {
    const adapter = new OpenCodeAdapter(client, bindings, { ordinary: () => { throw new Error("Unexpected ordinary capability"); }, import: localFence }, quiet);
    return {
      bindingFor: async run => ({ sessionId: run.sessionId, serviceUrl: "http://127.0.0.1:44991", location: { directory: "/tmp/opencode/owned-preparation" }, model: { providerID: "fixture", id: "model" }, permissions: [{ action: "*", resource: "*", effect: "deny" }], protocolVersion: 1 }),
      ensureSession: (claim, binding, prompt) => adapter.ensureImportSession(claim, binding, prompt),
      submit: (claim, binding, prompt) => adapter.submitImport(claim, binding, prompt),
      observe: (claim, binding, prompts) => adapter.observeImport(claim, binding, prompts),
      cancel: (claim, binding, prompt) => adapter.cancelImport(claim, binding, prompt),
    };
  };
  const worker = () => new MarkdownImportWorker({ db, ...sources, parser, native });
  const batch = imports.createBatch("user", "preparation");
  const admit = (n: number) => imports.admitFile("user", batch.id, `key-${n}`, `owned-${n}.md`, bytes(`# Heading ${n}\n\nfixture content ${n}`));
  const tick = async (w: MarkdownImportWorker, fileId: string) => {
    const item = w.candidates(0, null, 200).items.find(value => value.fileId === fileId);
    if (!item) throw new Error(`No eligible fixture candidate ${fileId}`);
    await w.tick(item);
  };
  const session = (runId: string) => {
    const run = new SqliteRunRepository(db, sources).get(runId);
    if (!run) throw new Error("fixture run missing");
    return run.sessionId;
  };
  return { db, imports, client, worker, batch, admit, tick, session, count: () => parses, close: () => db.close(), sources };
}

test.each(["valid", "failed", "invalid"] as const)("%s terminal selection reuses genuine preparation throughout observation", async outcome => {
  const f = fixture();
  try {
    const file = f.admit(1); if (!file.runId) throw new Error("run missing");
    const worker = f.worker();
    await f.tick(worker, file.id); const first = f.count();
    expect(f.client.prompts).toHaveLength(1);
    for (let i = 0; i < 3; i++) await f.tick(worker, file.id);
    const pending = f.count();
    f.client.complete(f.session(file.runId), outcome);
    await f.tick(worker, file.id); const terminal = f.count();
    expect(f.imports.file("user", f.batch.id, file.id)).toMatchObject({ state: "imported", segmentation: outcome === "valid" ? { method: "ai", reason: null } : { method: "structural", reason: outcome === "failed" ? "ai-failed" : "ai-invalid" } });
    expect(f.client.prompts).toHaveLength(1);
    expect({ first, pending, terminal }).toEqual({ first: 1, pending: 1, terminal: 1 });
  } finally { f.close(); }
});

test("pre-dispatch retries do not reparse unchanged owned input", async () => {
  const f = fixture();
  try {
    const file = f.admit(1), worker = f.worker();
    f.client.blockPreflight = true;
    await f.tick(worker, file.id); const first = f.count();
    for (let i = 0; i < 3; i++) await f.tick(worker, file.id);
    const retried = f.count();
    expect(f.client.prompts).toHaveLength(0);
    expect(f.imports.file("user", f.batch.id, file.id)?.state).toBe("queued");
    f.client.blockPreflight = false;
    await f.tick(worker, file.id);
    expect(f.client.prompts).toHaveLength(1);
    expect({ first, retried, submitted: f.count() }).toEqual({ first: 1, retried: 1, submitted: 1 });
  } finally { f.close(); }
});

test("worker restart observes a submitted job without parsing until terminal rehydration", async () => {
  const f = fixture();
  try {
    const file = f.admit(1); if (!file.runId) throw new Error("run missing");
    const first = f.worker(); await f.tick(first, file.id); expect(f.count()).toBe(1); first.pause();
    const restarted = f.worker();
    for (let i = 0; i < 3; i++) await f.tick(restarted, file.id);
    const pending = f.count();
    f.client.complete(f.session(file.runId), "valid");
    await f.tick(restarted, file.id);
    expect(f.imports.file("user", f.batch.id, file.id)).toMatchObject({ state: "imported", segmentation: { method: "ai", reason: null } });
    expect(f.client.prompts).toHaveLength(1);
    expect({ pending, terminal: f.count() }).toEqual({ pending: 1, terminal: 2 });
  } finally { f.close(); }
});

test("five pending runs evict bounded proof without reparsing on observation; evicted terminal rehydrates once", async () => {
  const f = fixture();
  try {
    const files = Array.from({ length: 5 }, (_, i) => f.admit(i)), worker = f.worker();
    for (const file of files) await f.tick(worker, file.id);
    const initial = f.count(), first = files[0];
    if (!first?.runId) throw new Error("run missing");
    for (let i = 0; i < 3; i++) await f.tick(worker, first.id);
    const pending = f.count();
    f.client.complete(f.session(first.runId), "valid");
    await f.tick(worker, first.id);
    expect(f.imports.file("user", f.batch.id, first.id)).toMatchObject({ state: "imported", segmentation: { method: "ai", reason: null } });
    expect(f.client.prompts).toHaveLength(5);
    expect({ initial, pending, terminal: f.count() }).toEqual({ initial: 5, pending: 5, terminal: 6 });
  } finally { f.close(); }
});

test("recovery of an already durable partition finalizes with no parser or native calls", async () => {
  const f = fixture();
  try {
    const file = f.admit(1), claim = f.imports.claim(file.id), source = f.imports.privateInput(claim);
    const prepared = prepareMarkdown(source.bytes);
    f.imports.prepare(claim, prepared.manifest);
    const input = f.imports.privateInput(claim);
    if (input.input === null) throw new Error("prepared prompt missing");
    f.imports.choose(claim, partitionMarkdown(source.bytes, prepared, prepared.fallbackCuts, { method: "structural", reason: "ai-unconfigured" }), {
      state: "not-submitted", promptId: input.promptId, inputSha256: createHash("sha256").update(input.input).digest("hex"),
    });
    await f.tick(f.worker(), file.id);
    expect(f.imports.file("user", f.batch.id, file.id)).toMatchObject({ state: "imported", segmentation: { method: "structural", reason: "ai-unconfigured" } });
    expect(f.count()).toBe(0);
    expect(f.client.prompts).toHaveLength(0);
    expect(f.client.sessions.size).toBe(0);
  } finally { f.close(); }
});

test("Stop invalidates a prepared in-flight generation without publishing its cached source", async () => {
  const f = fixture();
  try {
    const file = f.admit(1); if (!file.runId) throw new Error("run missing");
    const worker = f.worker();
    await f.tick(worker, file.id);
    const initial = f.count(), before = new SqliteRunRepository(f.db, f.sources).get(file.runId);
    if (!before) throw new Error("run missing after submission");
    new SqliteRunRepository(f.db, f.sources).stop(file.runId);
    const after = new SqliteRunRepository(f.db, f.sources).get(file.runId);
    expect(after).toMatchObject({ status: "interrupted", generation: before.generation + 1 });
    f.client.complete(f.session(file.runId), "valid");
    await f.tick(worker, file.id);
    expect(f.imports.file("user", f.batch.id, file.id)).toMatchObject({ state: "interrupted", documentId: null });
    expect(f.db.query("SELECT count(*) AS n FROM import_documents").get()).toEqual({ n: 0 });
    expect(f.db.query("SELECT count(*) AS n FROM thoughts").get()).toEqual({ n: 0 });
    expect(f.count()).toBe(initial);
    expect(f.client.prompts).toHaveLength(1);
  } finally { f.close(); }
});

test.each(["payload", "prompt"] as const)("fault-injected %s corruption cannot use a cached preparation to publish", async target => {
  const f = fixture();
  try {
    const file = f.admit(1); if (!file.runId) throw new Error("run missing");
    const worker = f.worker();
    await f.tick(worker, file.id);
    expect(f.count()).toBe(1);
    const prompt = f.client.prompts[0]; if (!prompt) throw new Error("prompt missing");
    const originalHash = createHash("sha256").update(prompt.text).digest("hex");
    // Fault injection only: drop the relevant guard in this isolated database to
    // simulate disk corruption that normal application writes cannot perform.
    if (target === "payload") {
      f.db.exec("DROP TRIGGER imports_payload_immutable");
      f.db.run("UPDATE markdown_import_payloads SET bytes=? WHERE file_id=?", [bytes("# Heading 1\n\nfixture content X"), file.id]);
    } else {
      f.db.exec("DROP TRIGGER run_steps_input_immutable");
      const damaged = prompt.text.replace("fixture content 1", "fixture content X");
      expect(createHash("sha256").update(damaged).digest("hex")).not.toBe(originalHash);
      f.db.run("UPDATE run_steps SET input=? WHERE run_id=? AND position=0", [damaged, file.runId]);
    }
    f.client.complete(f.session(file.runId), "valid");
    await f.tick(worker, file.id);
    expect(f.imports.file("user", f.batch.id, file.id)).toMatchObject({ state: "failed", documentId: null });
    expect(f.db.query("SELECT result_json AS result FROM run_steps WHERE run_id=?").get(file.runId)).toEqual({ result: null });
    expect(f.db.query("SELECT count(*) AS n FROM import_documents").get()).toEqual({ n: 0 });
    expect(f.db.query("SELECT count(*) AS n FROM thoughts").get()).toEqual({ n: 0 });
    expect(f.db.query("SELECT count(*) AS n FROM runs WHERE kind='weave'").get()).toEqual({ n: 0 });
    expect(f.client.prompts).toEqual([prompt]);
    expect(f.count()).toBe(1);
  } finally { f.close(); }
});

test("a successor claim fences the stale proof and rehydrates only for terminal recovery", async () => {
  const f = fixture();
  try {
    const file = f.admit(1); if (!file.runId) throw new Error("run missing");
    const stale = f.worker(); await f.tick(stale, file.id);
    const before = new SqliteRunRepository(f.db, f.sources).get(file.runId);
    if (!before) throw new Error("run missing after submit");
    const work = f.imports.nativeCandidates(0, null, 200).items.find(item => item.runId === file.runId);
    if (!work) throw new Error("submitted candidate missing");
    const successor = f.imports.claimNative(work);
    if (!successor) throw new Error("successor claim missing");
    expect(successor.generation).toBe(before.generation + 1);
    f.client.complete(f.session(file.runId), "valid");
    await f.tick(stale, file.id);
    expect(f.imports.file("user", f.batch.id, file.id)?.state).not.toBe("imported");
    expect(f.db.query("SELECT count(*) AS n FROM import_documents").get()).toEqual({ n: 0 });
    expect(f.count()).toBe(1);
    const current = f.worker(); await f.tick(current, file.id);
    expect(f.imports.file("user", f.batch.id, file.id)).toMatchObject({ state: "imported", segmentation: { method: "ai", reason: null } });
    expect(f.count()).toBe(2);
    expect(f.client.prompts).toHaveLength(1);
  } finally { f.close(); }
});

test("pause drops pre-dispatch preparation; the restarted owner verifies it once before retrying", async () => {
  const f = fixture();
  try {
    const file = f.admit(1); if (!file.runId) throw new Error("run missing");
    f.client.blockPreflight = true;
    const first = f.worker(); await f.tick(first, file.id); first.pause();
    expect(f.count()).toBe(1);
    expect(f.client.prompts).toHaveLength(0);
    const next = f.worker();
    for (let i = 0; i < 3; i++) await f.tick(next, file.id);
    expect(f.count()).toBe(2);
    expect(f.client.prompts).toHaveLength(0);
    f.client.blockPreflight = false;
    await f.tick(next, file.id);
    f.client.complete(f.session(file.runId), "valid");
    await f.tick(next, file.id);
    expect(f.imports.file("user", f.batch.id, file.id)).toMatchObject({ state: "imported", segmentation: { method: "ai", reason: null } });
    expect(f.count()).toBe(2);
    expect(f.client.prompts).toHaveLength(1);
  } finally { f.close(); }
});

test("evicted never-submitted preparation stays verified on retries and rehydrates only at selection", async () => {
  const f = fixture();
  try {
    const files = Array.from({ length: 5 }, (_, i) => f.admit(i)), worker = f.worker();
    f.client.blockPreflight = true;
    for (const file of files) await f.tick(worker, file.id);
    expect(f.count()).toBe(5);
    expect(f.client.prompts).toHaveLength(0);
    const first = files[0]; if (!first?.runId) throw new Error("run missing");
    for (let i = 0; i < 3; i++) await f.tick(worker, first.id);
    expect(f.count()).toBe(5);
    expect(f.imports.file("user", f.batch.id, first.id)?.state).toBe("queued");
    expect(f.client.prompts).toHaveLength(0);
    f.client.blockPreflight = false;
    await f.tick(worker, first.id);
    expect(f.count()).toBe(5);
    expect(f.client.prompts).toHaveLength(1);
    f.client.complete(f.session(first.runId), "valid");
    await f.tick(worker, first.id);
    expect(f.imports.file("user", f.batch.id, first.id)).toMatchObject({ state: "imported", segmentation: { method: "ai", reason: null } });
    expect(f.count()).toBe(6);
    expect(f.client.prompts).toHaveLength(1);
  } finally { f.close(); }
});
