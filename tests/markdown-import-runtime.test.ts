import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { LocalMarkdownImportDriver } from "../src/agent/import-driver";
import { AgentSessionMissingError } from "../src/agent/errors";
import type { InboxItem, NativeMessage, NativeSession, PublicClient } from "../src/agent/opencode-adapter";
import type { AgentConfig } from "../src/daemon/agent-config";
import { startDaemon, type RunningDaemon } from "../src/daemon/runtime";
import { ImportForbiddenError, partitionMarkdown, prepareMarkdown } from "../src/domain/markdown-import";
import { RejectionService } from "../src/domain/rejection";
import type { LogRecord } from "../src/logging";
import { SqliteImportInspection } from "../src/storage/import-inspection";
import { SqliteAgentBindings } from "../src/storage/agent-binding";
import { SqliteMarkdownImports } from "../src/storage/markdown-import";
import { SqliteRejectionRepository } from "../src/storage/rejection";
import { SqliteRunRepository } from "../src/storage/run";
import { migrate } from "../src/storage/sqlite";

const credentials = { user: "test-user-token-0123456789-abcdef012345", ai: "test-agent-token-0123456789-abcdef01234" };
const history = { actor: "user", mode: "history" } as const;
const ai = { actor: "ai", mode: "normal" } as const;

test("unconfigured daemon completes an owned import and its waiter without waiting for weaving", async () => {
  const dir = await mkdtemp(join("/tmp/opencode", "import-runtime-"));
  const path = join(dir, "owned.sqlite");
  const db = new Database(path);
  const logs: LogRecord[] = [];
  let daemon: RunningDaemon | undefined;
  let sequence = 0;
  const sources = { id: () => `fixture-${++sequence}`, now: () => "2030-01-02T03:04:05.000Z" };
  try {
    migrate(db);
    const imports = new SqliteMarkdownImports(db, sources);
    const metadata = "---\ntitle: private-metadata-token\n---\n";
    const body = "First café paragraph.\n\nSecond paragraph.";
    const bytes = new TextEncoder().encode(metadata + body);
    const batch = imports.createBatch("user", "batch");
    const file = imports.admitFile("user", batch.id, "first", "private-path-token.md", bytes);
    const waiter = imports.admitFile("user", batch.id, "copy", "copy.md", bytes);
    imports.sealBatch("user", batch.id);
    expect(file.state).toBe("queued");
    expect(waiter.state).toBe("waiting");

    daemon = await startDaemon({ port: 0, dbPath: path, credentials }, () => {}, { logSink: record => logs.push(record) });
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      const current = imports.file("user", batch.id, file.id);
      const waiting = imports.file("user", batch.id, waiter.id);
      if (current?.state === "imported" && waiting?.state === "skipped-identical") break;
      if (current?.state === "failed" || current?.state === "interrupted") break;
      await Bun.sleep(25);
    }
    const result = imports.file("user", batch.id, file.id);
    expect(result).toMatchObject({ state: "imported", thoughtCount: 1, segmentation: { method: "structural", reason: "ai-unconfigured" }, error: null });
    if (!result?.documentId || !file.runId) throw new Error("Completed import is missing its document or run");
    const documentId = result.documentId;
    expect(imports.file("user", batch.id, waiter.id)).toMatchObject({ state: "skipped-identical", documentId, runId: null });
    expect(imports.batch("user", batch.id)).toMatchObject({ state: "completed", counts: { pending: 0, imported: 1, skippedIdentical: 1 } });

    const inspection = new SqliteImportInspection(db, sources);
    expect(inspection.raw(history, documentId)).toEqual(bytes);
    const parts = inspection.parts(history, documentId).items;
    const metaEnd = new TextEncoder().encode(metadata).length;
    expect(parts).toMatchObject([
      { kind: "frontmatter", startByte: 0, endByte: metaEnd, thoughtId: null },
      { kind: "thought", startByte: metaEnd, endByte: bytes.length, ordinal: 0 },
    ]);
    const thoughtId = parts[1]?.thoughtId;
    if (!thoughtId) throw new Error("Completed import is missing its mapped thought");
    const visible = new RejectionService(new SqliteRejectionRepository(db)).listThoughts(ai);
    expect(visible.find(thought => thought.id === thoughtId)).toMatchObject({ text: body, author: "source", kind: "imported-original", title: null, parentId: null });
    expect(JSON.stringify(visible)).not.toContain("private-metadata-token");
    expect(JSON.stringify(visible)).not.toContain("private-path-token");
    expect(() => inspection.raw(ai, documentId)).toThrow(ImportForbiddenError);
    expect(() => inspection.source(ai, documentId)).toThrow(ImportForbiddenError);
    expect(() => inspection.parts(ai, documentId)).toThrow(ImportForbiddenError);
    expect(db.query("SELECT kind,status,weave_subject_id AS subjectId FROM runs ORDER BY rowid").all()).toEqual([
      { kind: "import", status: "completed", subjectId: null },
      { kind: "weave", status: "queued", subjectId: thoughtId },
    ]);
    expect(db.query("SELECT count(*) AS n FROM markdown_import_payloads").get()).toEqual({ n: 0 });
    expect(db.query("SELECT count(*) AS n FROM agent_bindings").get()).toEqual({ n: 0 });
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(JSON.stringify(logs)).not.toContain("private-metadata-token");
    expect(JSON.stringify(logs)).not.toContain("private-path-token");
  } finally {
    try { if (daemon) await daemon.stop(); }
    finally { try { db.close(); } finally { await rm(dir, { recursive: true, force: true }); } }
  }
}, 5000);

const encode = (text: string) => new TextEncoder().encode(text);
const quiet = { verbose: () => {}, info: () => {}, warning: () => {}, error: () => {} };

async function owned(action: (context: { path: string; db: Database; imports: SqliteMarkdownImports; sources: { id: () => string; now: () => string; sessionId: () => string; promptId: () => string; logger: typeof quiet } }) => Promise<void>) {
  const dir = await mkdtemp(join("/tmp/opencode", "import-runtime-cases-"));
  const path = join(dir, "owned.sqlite");
  const db = new Database(path);
  let n = 0;
  const sources = { id: () => `test-${++n}`, sessionId: () => `ses_fixture${++n}`, promptId: () => `msg_fixture${++n}`, now: () => "2030-01-02T03:04:05.000Z", logger: quiet };
  try { migrate(db, quiet); await action({ path, db, imports: new SqliteMarkdownImports(db, sources), sources }); }
  finally { try { db.close(); } finally { await rm(dir, { recursive: true, force: true }); } }
}

async function until(predicate: () => boolean, timeout = 2500) {
  const deadline = Date.now() + timeout;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(10);
  expect(predicate()).toBe(true);
}

function chooseStructural(imports: SqliteMarkdownImports, fileId: string, bytes: Uint8Array) {
  const claim = imports.claim(fileId), prepared = prepareMarkdown(bytes);
  imports.prepare(claim, prepared.manifest);
  const input = imports.privateInput(claim);
  if (input.input === null) throw new Error("Prepared input missing");
  return imports.choose(claim, partitionMarkdown(bytes, prepared, prepared.fallbackCuts, { method: "structural", reason: "ai-unconfigured" }), {
    state: "not-submitted", promptId: input.promptId, inputSha256: createHash("sha256").update(input.input).digest("hex"),
  });
}

test("restart finalizes an already chosen partition locally and leaves a submitted unknown untouched", async () => owned(async ({ path, db, imports, sources }) => {
  const batch = imports.createBatch("user", "restart"), bytes = encode("Owned resumed text");
  const selected = imports.admitFile("user", batch.id, "selected", "selected.md", bytes);
  const unknown = imports.admitFile("user", batch.id, "unknown", "unknown.md", encode("Pending submitted text"));
  const chosen = chooseStructural(imports, selected.id, bytes);
  const before = db.query("SELECT result_json AS result FROM run_steps WHERE run_id=?").get(chosen.runId);
  const claim = imports.claim(unknown.id), prepared = prepareMarkdown(encode("Pending submitted text"));
  imports.prepare(claim, prepared.manifest);
  const input = imports.privateInput(claim);
  // Persist a crash-window submission intent; no native call is made by this fixture.
  db.transaction(() => {
    db.run("UPDATE run_steps SET state='submitting' WHERE run_id=? AND prompt_id=?", [claim.runId, input.promptId]);
    db.run("UPDATE runs SET status='submitting' WHERE id=?", [claim.runId]);
  })();
  const unknownBefore = db.query("SELECT state,input,result_json FROM run_steps WHERE run_id=?").get(claim.runId);
  expect(db.query("SELECT count(*) AS n FROM import_documents").get()).toEqual({ n: 0 });
  // Close the admission connection: all authority needed for recovery is persisted.
  db.close();
  const reopened = new Database(path);
  let daemon: RunningDaemon | undefined;
  try {
    const recovered = new SqliteMarkdownImports(reopened, sources);
    daemon = await startDaemon({ port: 0, dbPath: path, credentials }, () => {}, { logSink: () => {} });
    await until(() => recovered.file("user", batch.id, selected.id)?.state === "imported");
    expect(reopened.query("SELECT result_json AS result FROM run_steps WHERE run_id=?").get(chosen.runId)).toEqual(before);
    expect(recovered.file("user", batch.id, selected.id)).toMatchObject({ thoughtCount: 1, segmentation: { method: "structural", reason: "ai-unconfigured" } });
    expect(recovered.file("user", batch.id, unknown.id)?.state).toBe("submitting");
    expect(reopened.query("SELECT state,input,result_json FROM run_steps WHERE run_id=?").get(claim.runId)).toEqual(unknownBefore);
    expect(reopened.query("SELECT count(*) AS n FROM agent_bindings").get()).toEqual({ n: 0 });
    expect(reopened.query("SELECT status FROM runs WHERE kind='weave'").all()).toEqual([{ status: "queued" }]);
  } finally { try { if (daemon) await daemon.stop(); } finally { reopened.close(); } }
}), 5000);

test("unconfigured restart recovers a bound but never-submitted import and its waiter", async () => owned(async ({ path, db, imports, sources }) => {
  const bytes = encode("---\ntitle: private-recovery-metadata\n---\nBound before submission café"), batch = imports.createBatch("user", "bound-recovery");
  const file = imports.admitFile("user", batch.id, "holder", "private-recovery-path.md", bytes);
  const waiter = imports.admitFile("user", batch.id, "waiter", "copy.md", bytes);
  imports.sealBatch("user", batch.id);
  if (!file.runId) throw new Error("Missing holder run");
  const runId = file.runId, claim = imports.claim(file.id);
  imports.prepare(claim, prepareMarkdown(bytes).manifest);
  const input = imports.privateInput(claim);
  if (input.input === null) throw new Error("Missing prepared import input");
  const prompt = { promptId: input.promptId, input: input.input };
  const run = new SqliteRunRepository(db, sources).get(runId);
  if (!run) throw new Error("Missing prepared run");
  const bindings = new SqliteAgentBindings(db, quiet);
  bindings.bindImport(claim, { sessionId: run.sessionId, serviceUrl: "http://127.0.0.1:44991", location: { directory: "/tmp/opencode/recovery-fixture" }, model: { providerID: "fixture", id: "model" }, permissions: [{ action: "*", resource: "*", effect: "deny" }], protocolVersion: 1 });
  bindings.assertImportPreparation(claim, [prompt]);
  expect(() => bindings.assertImportOwnership(claim, [prompt])).toThrow();
  const journal = () => db.query(`SELECT r.status,s.state,s.native_state AS nativeState,s.result_json AS result,
    EXISTS(SELECT 1 FROM agent_bindings b WHERE b.run_id=r.id) AS bound
    FROM runs r JOIN run_steps s ON s.run_id=r.id AND s.position=0 WHERE r.id=?`).get(runId);
  const expectedJournal = { status: "queued", state: "prepared", nativeState: "unknown", result: null, bound: 1 };
  expect(journal()).toEqual(expectedJournal);
  expect(waiter.state).toBe("waiting");
  db.close();
  const reopened = new Database(path);
  let daemon: RunningDaemon | undefined, nativeCalls = 0;
  try {
    const recovered = new SqliteMarkdownImports(reopened, sources);
    daemon = await startDaemon({ port: 0, dbPath: path, credentials }, () => {}, {
      logSink: () => {},
      resolveAgentService: async () => { nativeCalls++; throw new Error("Unexpected resolver call"); },
      createPublicClient: () => { nativeCalls++; throw new Error("Unexpected native client"); },
    });
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline && (recovered.file("user", batch.id, file.id)?.state !== "imported" || recovered.file("user", batch.id, waiter.id)?.state !== "skipped-identical")) await Bun.sleep(20);
    const result = recovered.file("user", batch.id, file.id);
    const after = reopened.query(`SELECT r.status,s.state,s.native_state AS nativeState,s.result_json IS NOT NULL AS hasResult,
      EXISTS(SELECT 1 FROM agent_bindings b WHERE b.run_id=r.id) AS bound
      FROM runs r JOIN run_steps s ON s.run_id=r.id AND s.position=0 WHERE r.id=?`).get(runId);
    expect({ state: result?.state, segmentation: result?.segmentation, waiter: recovered.file("user", batch.id, waiter.id)?.state, nativeCalls, journal: after }).toMatchObject({
      state: "imported", segmentation: { method: "structural", reason: "ai-unconfigured" }, waiter: "skipped-identical", nativeCalls: 0,
    });
    if (!result?.documentId) throw new Error("Recovered import has no canonical source");
    const documentId = result.documentId;
    const inspection = new SqliteImportInspection(reopened, sources);
    expect(inspection.raw(history, documentId)).toEqual(bytes);
    expect(() => inspection.raw(ai, documentId)).toThrow(ImportForbiddenError);
    expect(recovered.file("user", batch.id, waiter.id)).toMatchObject({ documentId, runId: null });
    expect(recovered.batch("user", batch.id)).toMatchObject({ state: "completed", counts: { pending: 0, imported: 1, skippedIdentical: 1 } });
    expect(reopened.query("SELECT status FROM runs WHERE kind='weave'").all()).toEqual([{ status: "queued" }]);
    expect(nativeCalls).toBe(0);
  } finally { try { if (daemon) await daemon.stop(); } finally { reopened.close(); } }
}), 5000);

test("bounded scans complete multiple holders, over fifty waiters and metadata-only sources", async () => owned(async ({ path, db, imports }) => {
  const batch = imports.createBatch("user", "fair"), holders = [];
  for (let i = 0; i < 7; i++) holders.push(imports.admitFile("user", batch.id, `h${i}`, `h${i}.md`, encode(`distinct thought ${i}`)));
  const empty = imports.admitFile("user", batch.id, "empty", "empty.md", encode(""));
  const metadata = imports.admitFile("user", batch.id, "metadata", "metadata.md", encode("---\ntitle: private\n---\n"));
  for (let i = 0; i < 55; i++) expect(imports.admitFile("user", batch.id, `w${i}`, `w${i}.md`, encode("distinct thought 0")).state).toBe("waiting");
  imports.sealBatch("user", batch.id);
  let daemon: RunningDaemon | undefined;
  try {
    daemon = await startDaemon({ port: 0, dbPath: path, credentials }, () => {}, { logSink: () => {} });
    await until(() => imports.batch("user", batch.id)?.state === "completed", 4000);
    expect(imports.batch("user", batch.id)?.counts).toMatchObject({ pending: 0, imported: 9, skippedIdentical: 55, failed: 0 });
    for (const file of holders) expect(imports.file("user", batch.id, file.id)).toMatchObject({ state: "imported", thoughtCount: 1 });
    for (const file of [empty, metadata]) expect(imports.file("user", batch.id, file.id)).toMatchObject({ state: "imported", thoughtCount: 0, segmentation: { method: "not-needed", reason: null } });
    expect(db.query("SELECT status,count(*) AS n FROM runs WHERE kind='weave' GROUP BY status").all()).toEqual([{ status: "queued", n: 7 }]);
    expect(db.query("SELECT count(*) AS n FROM markdown_import_payloads").get()).toEqual({ n: 0 });
  } finally { if (daemon) await daemon.stop(); }
}), 6500);

test("pause drains an owned poll without interrupting its file and restart resumes it", async () => owned(async ({ path, db, imports, sources }) => {
  const batch = imports.createBatch("user", "pause");
  const file = imports.admitFile("user", batch.id, "file", "pause.md", encode("Resume after pause"));
  let cancelled = false;
  const driver = new LocalMarkdownImportDriver({ db, ...sources, startTimer: () => () => { cancelled = true; } });
  driver.start();
  const inFlight = driver.poll();
  // Let the scan enter its first owned turn before pausing it.
  await Promise.resolve();
  await driver.stop();
  await inFlight;
  expect(cancelled).toBe(true);
  expect(imports.file("user", batch.id, file.id)).toMatchObject({ state: "queued", documentId: null });
  expect(db.query("SELECT count(*) AS n FROM markdown_import_payloads").get()).toEqual({ n: 1 });
  let daemon: RunningDaemon | undefined;
  try {
    daemon = await startDaemon({ port: 0, dbPath: path, credentials }, () => {}, { logSink: () => {} });
    await until(() => imports.file("user", batch.id, file.id)?.state === "imported");
    expect(imports.file("user", batch.id, file.id)).toMatchObject({ thoughtCount: 1, segmentation: { method: "structural", reason: "ai-unconfigured" } });
  } finally { if (daemon) await daemon.stop(); }
}), 5000);

test("Stop fences queued and selected holders, releases waiters, and corrupt staged bytes fail without blocking other files", async () => owned(async ({ path, db, imports, sources }) => {
  const batch = imports.createBatch("user", "fences"), runs = new SqliteRunRepository(db, sources);
  const queuedBytes = encode("Queued stop"), selectedBytes = encode("Selected stop");
  const queued = imports.admitFile("user", batch.id, "q", "q.md", queuedBytes);
  const queuedWaiter = imports.admitFile("user", batch.id, "qw", "qw.md", queuedBytes);
  const selected = imports.admitFile("user", batch.id, "s", "s.md", selectedBytes);
  const selectedWaiter = imports.admitFile("user", batch.id, "sw", "sw.md", selectedBytes);
  const corrupt = imports.admitFile("user", batch.id, "corrupt", "corrupt.md", encode("Original staged data"));
  const good = imports.admitFile("user", batch.id, "good", "good.md", encode("Unaffected thought"));
  if (!queued.runId || !selected.runId) throw new Error("Holder run missing");
  const chosen = chooseStructural(imports, selected.id, selectedBytes);
  runs.stop(queued.runId); runs.stop(selected.runId);
  expect(() => imports.finalize(chosen)).toThrow();
  expect(db.query("SELECT count(*) AS n FROM import_documents").get()).toEqual({ n: 0 });
  // Simulate disk corruption in this isolated fixture, then let migration restore the guard.
  db.exec("DROP TRIGGER imports_payload_immutable");
  db.run("UPDATE markdown_import_payloads SET bytes=? WHERE file_id=?", [encode("Corrupt staged data!"), corrupt.id]);
  imports.sealBatch("user", batch.id);
  let daemon: RunningDaemon | undefined;
  try {
    daemon = await startDaemon({ port: 0, dbPath: path, credentials }, () => {}, { logSink: () => {} });
    await until(() => imports.batch("user", batch.id)?.state === "completed", 4000);
    for (const file of [queued, selected]) expect(imports.file("user", batch.id, file.id)).toMatchObject({ state: "interrupted", documentId: null });
    for (const file of [queuedWaiter, selectedWaiter, good]) expect(imports.file("user", batch.id, file.id)).toMatchObject({ state: "imported", thoughtCount: 1 });
    expect(imports.file("user", batch.id, corrupt.id)).toMatchObject({ state: "failed", documentId: null, error: { code: "preservation-failed" }, segmentation: null });
    expect(db.query("SELECT count(*) AS n FROM import_documents").get()).toEqual({ n: 3 });
    expect(db.query("SELECT count(*) AS n FROM thoughts").get()).toEqual({ n: 3 });
    expect(db.query("SELECT count(*) AS n FROM runs WHERE kind='weave' AND status='queued'").get()).toEqual({ n: 3 });
  } finally { if (daemon) await daemon.stop(); }
}), 6500);

/** In-memory decoded SDK facade; neither discovery nor a native service is contacted. */
class ImportClient implements PublicClient {
  async instructionList(): Promise<never> { throw new Error("Unexpected instruction list"); }
  async instructionPut(): Promise<never> { throw new Error("Unexpected instruction put"); }
  async instructionRemove(): Promise<never> { throw new Error("Unexpected instruction remove"); }
  readonly sessions = new Map<string, NativeSession>();
  readonly messages = new Map<string, NativeMessage[]>();
  readonly prompts: Parameters<PublicClient["prompt"]>[0][] = [];
  constructor(private readonly cuts: readonly string[]) {}
  async serverInfo() { return { version: "99.0.0-fixture" }; }
  async sessionCreate(input: Parameters<PublicClient["sessionCreate"]>[0]): Promise<NativeSession> {
    const session: NativeSession = { id: input.id, location: input.location, model: input.model, permissions: input.permissions, metadata: input.metadata };
    this.sessions.set(input.id, session); this.messages.set(input.id, []); return session;
  }
  async sessionGet(input: { readonly sessionID: string }): Promise<NativeSession> {
    const session = this.sessions.get(input.sessionID);
    if (!session) throw new AgentSessionMissingError("Test session absent");
    return session;
  }
  async prompt(input: Parameters<PublicClient["prompt"]>[0]): Promise<InboxItem> {
    this.prompts.push(input);
    const messages = this.messages.get(input.sessionID);
    if (!messages) throw new Error("Test session history absent");
    const parsed: unknown = JSON.parse(input.text);
    const isImport = typeof parsed === "object" && parsed !== null && "kind" in parsed && parsed.kind === "import-job";
    const output = isImport ? { version: 1, kind: "segmentation", cuts: this.cuts } : { version: 1, kind: "complete", reply: "no findings" };
    const n = messages.length * 10 + 10;
    messages.push({ id: input.id, type: "user", time: { created: n }, text: input.text },
      { id: `assistant-${input.id}`, type: "assistant", time: { created: n + 1, completed: n + 2 }, content: [{ type: "text", text: JSON.stringify(output) }], finish: "stop" },
      { id: `idle-${input.id}`, type: "idle", time: { created: n + 3 }, outcome: "succeeded" });
    return { id: input.id, sessionID: input.sessionID, type: "user", payload: { text: input.text }, delivery: "queue", time: { created: n } };
  }
  async inbox() { return []; }
  async history(input: Parameters<PublicClient["history"]>[0]) { return { data: this.messages.get(input.sessionID) ?? [], cursor: {} }; }
  async active() { return {}; }
  async cancelInbox() {}
  async interrupt() { return { interrupted: true }; }
}

type ImportReply = "failed" | "empty" | "malformed" | "invalid-cuts" | "lost-ack";
class FailureClient extends ImportClient {
  hideHistory = false;
  constructor(readonly reply: ImportReply) { super([]); }
  override async prompt(input: Parameters<PublicClient["prompt"]>[0]): Promise<InboxItem> {
    const parsed: unknown = JSON.parse(input.text);
    if (typeof parsed !== "object" || parsed === null || !("kind" in parsed) || parsed.kind !== "import-job") return super.prompt(input);
    this.prompts.push(input);
    const messages = this.messages.get(input.sessionID);
    if (!messages) throw new Error("Test session history absent");
    messages.push({ id: input.id, type: "user", time: { created: 10 }, text: input.text });
    if (this.reply === "lost-ack") { this.hideHistory = true; throw new Error("test transport lost acknowledgement"); }
    if (this.reply !== "failed") {
      const text = this.reply === "empty" ? "" : this.reply === "malformed" ? "{not-json" : JSON.stringify({ version: 1, kind: "segmentation", cuts: ["foreign"] });
      messages.push({ id: `assistant-${input.id}`, type: "assistant", time: { created: 11, completed: 12 }, content: [{ type: "text", text }], finish: "stop" });
    }
    messages.push({ id: `idle-${input.id}`, type: "idle", time: { created: 13 }, outcome: this.reply === "failed" ? "failed" : "succeeded" });
    return { id: input.id, sessionID: input.sessionID, type: "user", payload: { text: input.text }, delivery: "queue", time: { created: 10 } };
  }
  override async history(input: Parameters<PublicClient["history"]>[0]) {
    return this.hideHistory ? { data: [], cursor: {} } : super.history(input);
  }
}

const configuredAgent: AgentConfig = { service: { url: "http://127.0.0.1:44991", token: "fixture-only-token" }, directory: "/tmp/opencode/import-agent-fixture", model: { providerID: "fixture", id: "model" }, effort: { quick: "q", standard: "s", thorough: "t" } };

async function configured(path: string, client: PublicClient, unavailable = false, onLog: (record: LogRecord) => void = () => {}) {
  const callbacks = new Set<() => void>();
  const daemon = await startDaemon({ port: 0, dbPath: path, credentials, agent: configuredAgent }, () => {}, {
    logSink: onLog,
    resolveAgentService: async () => { if (unavailable) throw new Error("test-owned service unavailable"); return { url: "http://127.0.0.1:44991" }; },
    createPublicClient: () => client,
    startTimer: poll => { callbacks.add(poll); return () => { callbacks.delete(poll); }; },
  });
  return { daemon, async pulse() { for (const poll of callbacks) poll(); await Bun.sleep(10); } };
}

async function drive(timer: Awaited<ReturnType<typeof configured>>, predicate: () => boolean, limit = 100) {
  for (let i = 0; i < limit && !predicate(); i++) await timer.pulse();
  expect(predicate()).toBe(true);
}

test.each(["failed", "empty", "malformed", "invalid-cuts"] as const)("configured %s terminal response retains source via structural fallback", async reply => owned(async ({ path, db, imports, sources }) => {
  const bytes = encode("---\ntitle: private\n---\n# One\nAlpha\n\n# Two\nBeta"), client = new FailureClient(reply);
  const batch = imports.createBatch("user", "terminal"), file = imports.admitFile("user", batch.id, "f", "file.md", bytes);
  const duplicate = imports.admitFile("user", batch.id, "d", "duplicate.md", bytes);
  const timer = await configured(path, client);
  try {
    await drive(timer, () => imports.file("user", batch.id, file.id)?.state === "imported" && imports.file("user", batch.id, duplicate.id)?.state === "skipped-identical");
    const result = imports.file("user", batch.id, file.id);
    expect(result).toMatchObject({ segmentation: { method: "structural", reason: reply === "failed" ? "ai-failed" : "ai-invalid" }, error: null });
    if (!result?.documentId || !file.runId) throw new Error("Missing completed import");
    expect(new SqliteImportInspection(db, sources).raw(history, result.documentId)).toEqual(bytes);
    expect(imports.file("user", batch.id, duplicate.id)).toMatchObject({ documentId: result.documentId, runId: null });
    const submitted = client.prompts.filter(prompt => client.sessions.get(prompt.sessionID)?.metadata.runId === file.runId);
    expect(submitted).toHaveLength(1);
    expect(db.query("SELECT status FROM runs WHERE id=?").get(file.runId)).toEqual({ status: "completed" });
    expect(db.query("SELECT count(*) AS n FROM import_document_seals WHERE document_id=?").get(result.documentId)).toEqual({ n: 1 });
    expect(db.query("SELECT count(*) AS n FROM runs WHERE kind='weave'").get()).toEqual({ n: result.thoughtCount });
  } finally { await timer.daemon.stop(); }
}), 5000);

test("lost acknowledgement stays observation-only across restart and recovers the same submitted prompt", async () => owned(async ({ path, db, imports, sources }) => {
  const text = "Unknown outcome source", bytes = encode(text), client = new FailureClient("lost-ack");
  const batch = imports.createBatch("user", "uncertain"), file = imports.admitFile("user", batch.id, "f", "unknown.md", bytes);
  if (!file.runId) throw new Error("Missing import run");
  let timer = await configured(path, client);
  try {
    await drive(timer, () => client.prompts.length === 1 && imports.file("user", batch.id, file.id)?.state === "uncertain");
    const prompt = client.prompts[0]; if (!prompt) throw new Error("Missing test prompt");
    const journal = db.query("SELECT prompt_id,input FROM run_steps WHERE run_id=?").get(file.runId);
    await timer.daemon.stop();
    timer = await configured(path, client);
    for (let i = 0; i < 15; i++) await timer.pulse();
    expect(imports.file("user", batch.id, file.id)).toMatchObject({ state: "uncertain", documentId: null, segmentation: null });
    expect(client.prompts).toHaveLength(1);
    expect(db.query("SELECT prompt_id,input FROM run_steps WHERE run_id=?").get(file.runId)).toEqual(journal);
    expect(db.query("SELECT count(*) AS n FROM import_documents").get()).toEqual({ n: 0 });
    const prepared = prepareMarkdown(bytes), last = prepared.manifest.cuts.at(-1);
    if (!last) throw new Error("Missing test endpoint");
    const messages = client.messages.get(prompt.sessionID); if (!messages) throw new Error("Missing test history");
    messages.push({ id: `assistant-${prompt.id}`, type: "assistant", time: { created: 11, completed: 12 }, content: [{ type: "text", text: JSON.stringify({ version: 1, kind: "segmentation", cuts: ["b0", last.id] }) }], finish: "stop" },
      { id: `idle-${prompt.id}`, type: "idle", time: { created: 13 }, outcome: "succeeded" });
    client.hideHistory = false;
    await drive(timer, () => imports.file("user", batch.id, file.id)?.state === "imported");
    const result = imports.file("user", batch.id, file.id);
    expect(result).toMatchObject({ segmentation: { method: "ai", reason: null } });
    if (!result?.documentId) throw new Error("Missing canonical source");
    expect(new SqliteImportInspection(db, sources).raw(history, result.documentId)).toEqual(bytes);
    expect(client.prompts.filter(value => value.sessionID === prompt.sessionID)).toEqual([prompt]);
  } finally { await timer.daemon.stop(); }
}), 6000);

test("proven pre-dispatch unavailability falls back without a native submission", async () => owned(async ({ path, db, imports, sources }) => {
  const bytes = encode("Unavailable fixture"), client = new FailureClient("failed");
  const batch = imports.createBatch("user", "offline"), file = imports.admitFile("user", batch.id, "f", "offline.md", bytes);
  const timer = await configured(path, client, true);
  try {
    await drive(timer, () => imports.file("user", batch.id, file.id)?.state === "imported");
    const result = imports.file("user", batch.id, file.id);
    expect(result).toMatchObject({ segmentation: { method: "structural", reason: "ai-unavailable" } });
    if (!result?.documentId) throw new Error("Missing canonical source");
    expect(new SqliteImportInspection(db, sources).raw(history, result.documentId)).toEqual(bytes);
    expect(client.prompts).toEqual([]);
    expect(client.sessions.size).toBe(0);
  } finally { await timer.daemon.stop(); }
}), 5000);

test("failed fallback cancellation stays pending and settles after daemon restart", async () => owned(async ({ path, db, imports }) => {
  class CancelClient extends FailureClient {
    calls = 0;
    fail = true;
    constructor() { super("failed"); }
    override async cancelInbox() { this.calls++; if (this.fail) throw new Error("test cancellation outage"); }
  }
  const client = new CancelClient(), batch = imports.createBatch("user", "cancel"), file = imports.admitFile("user", batch.id, "f", "cancel.md", encode("Fallback survives cleanup"));
  if (!file.runId) throw new Error("Missing import run");
  let timer = await configured(path, client);
  try {
    await drive(timer, () => imports.file("user", batch.id, file.id)?.state === "imported" && client.calls > 0);
    const result = imports.file("user", batch.id, file.id);
    expect(result).toMatchObject({ segmentation: { method: "structural", reason: "ai-failed" } });
    if (!result?.documentId) throw new Error("Missing fallback source");
    const documentId = result.documentId;
    expect(db.query("SELECT cancellation_state AS state FROM runs WHERE id=?").get(file.runId)).toEqual({ state: "pending" });
    const snapshot = db.query("SELECT * FROM import_documents WHERE id=?").get(documentId);
    await timer.daemon.stop();
    client.fail = false;
    timer = await configured(path, client);
    await drive(timer, () => (db.query("SELECT cancellation_state AS state FROM runs WHERE id=?").get(file.runId) as {state:string}).state === "settled");
    expect(client.calls).toBeGreaterThan(1);
    expect(imports.file("user", batch.id, file.id)).toEqual(result);
    expect(db.query("SELECT * FROM import_documents WHERE id=?").get(documentId)).toEqual(snapshot);
    expect(client.prompts.filter(prompt => client.sessions.get(prompt.sessionID)?.metadata.runId === file.runId)).toHaveLength(1);
  } finally { await timer.daemon.stop(); }
}), 5000);

test("held native import does not block a second import or ordinary weave", async () => owned(async ({ path, db, imports }) => {
  class HeldClient extends FailureClient {
    held = false;
    private releaseHold: () => void = () => {};
    private readonly gate = new Promise<void>(resolve => { this.releaseHold = resolve; });
    constructor() { super("invalid-cuts"); }
    release() { this.releaseHold(); }
    override async prompt(input: Parameters<PublicClient["prompt"]>[0]): Promise<InboxItem> {
      if (input.text.includes("Held unique content")) { this.held = true; await this.gate; }
      return super.prompt(input);
    }
  }
  const client = new HeldClient(), batch = imports.createBatch("user", "fair-native");
  const held = imports.admitFile("user", batch.id, "held", "held.md", encode("Held unique content"));
  const other = imports.admitFile("user", batch.id, "other", "other.md", encode("Other unique content"));
  const timer = await configured(path, client);
  try {
    const response = await fetch(new URL("/thoughts", timer.daemon.url), { method: "POST", headers: { authorization: `Bearer ${credentials.user}`, "content-type": "application/json" }, body: JSON.stringify({ text: "Ordinary fixture thought" }), signal: AbortSignal.timeout(1500) });
    expect(response.status).toBe(201);
    const captured: unknown = await response.json();
    if (typeof captured !== "object" || captured === null || !("id" in captured) || typeof captured.id !== "string") throw new Error("Missing ordinary thought identity");
    const thoughtId = captured.id;
    await drive(timer, () => client.held && imports.file("user", batch.id, other.id)?.state === "imported" && (db.query("SELECT count(*) AS n FROM runs WHERE kind='weave' AND status='completed' AND weave_subject_id=?").get(thoughtId) as {n:number}).n > 0);
    expect(imports.file("user", batch.id, held.id)?.state).not.toBe("imported");
    expect(imports.file("user", batch.id, other.id)).toMatchObject({ state: "imported", segmentation: { method: "structural", reason: "ai-invalid" } });
    client.release();
    await drive(timer, () => imports.file("user", batch.id, held.id)?.state === "imported");
    expect(client.prompts.filter(prompt => client.sessions.get(prompt.sessionID)?.metadata.runId === held.runId)).toHaveLength(1);
  } finally { client.release(); await timer.daemon.stop(); }
}), 6000);

test("daemon restart resumes the real durable fallback choice without another native submission", async () => owned(async ({ path, db, imports, sources }) => {
  const bytes = encode("Restart a selected fallback"), client = new FailureClient("failed");
  const batch = imports.createBatch("user", "choice-restart"), file = imports.admitFile("user", batch.id, "holder", "holder.md", bytes);
  if (!file.runId) throw new Error("Missing holder run");
  const runId = file.runId;
  let stopping: Promise<void> | undefined;
  let timer: Awaited<ReturnType<typeof configured>>;
  timer = await configured(path, client, false, record => {
    if (record.message === "[import] structural partition retained" && record.context?.runId === runId) {
      // The log occurs inside choose's transaction. The microtask runs after commit,
      // before the worker's next setImmediate finalization turn.
      queueMicrotask(() => { stopping = timer.daemon.stop(); });
    }
  });
  try {
    await drive(timer, () => stopping !== undefined);
    if (!stopping) throw new Error("Choice boundary was not observed");
    await stopping;
    const choice = db.query("SELECT result_json AS result FROM run_steps WHERE run_id=?").get(runId) as {result:string|null};
    expect(choice.result).not.toBeNull();
    expect(JSON.parse(choice.result ?? "null")).toMatchObject({ partition: { segmentation: { method: "structural", reason: "ai-failed" } }, evidence: { state: "terminal-failure", promptId: client.prompts[0]?.id } });
    const beforeRun = db.query("SELECT status,generation FROM runs WHERE id=?").get(runId) as {status:string;generation:number};
    expect(beforeRun.status).toBe("uncertain");
    expect(imports.file("user", batch.id, file.id)).toMatchObject({ state: "uncertain", documentId: null });
    expect(db.query("SELECT count(*) AS n FROM import_documents").get()).toEqual({ n: 0 });
    expect(client.prompts).toHaveLength(1);
    timer = await configured(path, client);
    await drive(timer, () => imports.file("user", batch.id, file.id)?.state === "imported");
    const result = imports.file("user", batch.id, file.id);
    expect(result).toMatchObject({ segmentation: { method: "structural", reason: "ai-failed" } });
    if (!result?.documentId) throw new Error("Missing finalized source");
    expect(new SqliteImportInspection(db, sources).raw(history, result.documentId)).toEqual(bytes);
    expect(db.query("SELECT result_json AS result FROM run_steps WHERE run_id=?").get(runId)).toEqual(choice);
    expect(client.prompts.filter(prompt => client.sessions.get(prompt.sessionID)?.metadata.runId === runId)).toHaveLength(1);
    const after = db.query("SELECT status,generation FROM runs WHERE id=?").get(runId) as {status:string;generation:number};
    expect(after.status).toBe("completed");
    expect(after.generation).toBeGreaterThan(beforeRun.generation);
  } finally { await timer.daemon.stop(); }
}), 5000);

test("Stop after durable selection fences finalization and releases the waiting file", async () => owned(async ({ path, db, imports, sources }) => {
  const bytes = encode("Stopped selected holder"), client = new FailureClient("failed");
  const batch = imports.createBatch("user", "choice-stop"), holder = imports.admitFile("user", batch.id, "holder", "holder.md", bytes);
  const waiter = imports.admitFile("user", batch.id, "waiter", "waiter.md", bytes);
  if (!holder.runId) throw new Error("Missing holder run");
  const runId = holder.runId, runs = new SqliteRunRepository(db, sources);
  let selectedGeneration: number | undefined, stopError: unknown;
  const timer = await configured(path, client, false, record => {
    if (record.message === "[import] structural partition retained" && record.context?.runId === runId) queueMicrotask(() => {
      try {
        selectedGeneration = (db.query("SELECT generation FROM runs WHERE id=?").get(runId) as {generation:number}).generation;
        runs.stop(runId);
      } catch (error) { stopError = error; }
    });
  });
  try {
    await drive(timer, () => selectedGeneration !== undefined || stopError !== undefined);
    if (stopError) throw stopError;
    if (selectedGeneration === undefined) throw new Error("Selection generation missing");
    const choiceGeneration = selectedGeneration;
    const choice = db.query("SELECT result_json AS result FROM run_steps WHERE run_id=?").get(runId) as {result:string|null};
    expect(JSON.parse(choice.result ?? "null")).toMatchObject({ evidence: { state: "terminal-failure", promptId: client.prompts[0]?.id }, partition: { segmentation: { reason: "ai-failed" } } });
    expect(db.query("SELECT status,generation FROM runs WHERE id=?").get(runId)).toEqual({ status: "interrupted", generation: choiceGeneration + 1 });
    expect(() => imports.finalize({ runId, generation: choiceGeneration })).toThrow();
    for (const table of ["import_documents", "import_document_parts", "thoughts"]) expect(db.query(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    expect(db.query("SELECT count(*) AS n FROM runs WHERE kind='weave'").get()).toEqual({ n: 0 });
    expect(imports.file("user", batch.id, holder.id)).toMatchObject({ state: "interrupted", documentId: null });
    await drive(timer, () => imports.file("user", batch.id, waiter.id)?.state === "imported");
    expect(imports.file("user", batch.id, holder.id)).toMatchObject({ state: "interrupted", documentId: null });
    expect(db.query("SELECT result_json AS result FROM run_steps WHERE run_id=?").get(runId)).toEqual(choice);
    expect(db.query("SELECT count(*) AS n FROM import_documents").get()).toEqual({ n: 1 });
    expect(client.prompts.filter(prompt => client.sessions.get(prompt.sessionID)?.metadata.runId === runId)).toHaveLength(1);
    expect(client.prompts.filter(prompt => client.sessions.get(prompt.sessionID)?.metadata.runId === imports.file("user", batch.id, waiter.id)?.runId)).toHaveLength(1);
  } finally { await timer.daemon.stop(); }
}), 5000);

test("late native history and a stale claim cannot replace a committed fallback", async () => owned(async ({ path, db, imports }) => {
  const bytes = encode("Late native completion"), client = new FailureClient("failed");
  const batch = imports.createBatch("user", "late"), file = imports.admitFile("user", batch.id, "f", "late.md", bytes);
  if (!file.runId) throw new Error("Missing import run");
  const runId = file.runId;
  let selectedGeneration: number | undefined;
  const timer = await configured(path, client, false, record => {
    if (record.message === "[import] structural partition retained" && record.context?.runId === runId) queueMicrotask(() => {
      selectedGeneration = (db.query("SELECT generation FROM runs WHERE id=?").get(runId) as {generation:number}).generation;
    });
  });
  try {
    await drive(timer, () => imports.file("user", batch.id, file.id)?.state === "imported");
    if (selectedGeneration === undefined) throw new Error("Selection generation missing");
    const choiceGeneration = selectedGeneration;
    const result = imports.file("user", batch.id, file.id), prompt = client.prompts.find(value => client.sessions.get(value.sessionID)?.metadata.runId === runId);
    if (!result?.documentId || !prompt) throw new Error("Missing fallback or native identity");
    const documentId = result.documentId;
    const snapshot = [db.query("SELECT * FROM import_documents WHERE id=?").get(documentId), db.query("SELECT * FROM import_document_parts WHERE document_id=? ORDER BY position").all(documentId), db.query("SELECT * FROM thoughts WHERE import_document_id=? ORDER BY rowid").all(documentId), db.query("SELECT result_json FROM run_steps WHERE run_id=?").get(runId)];
    const messages = client.messages.get(prompt.sessionID); if (!messages) throw new Error("Missing native history");
    messages.push({ id: `late-${prompt.id}`, type: "assistant", time: { created: 14, completed: 15 }, content: [{ type: "text", text: '{"version":1,"kind":"segmentation","cuts":["b0","b1"]}' }], finish: "stop" });
    expect(() => imports.finalize({ runId, generation: choiceGeneration })).toThrow();
    for (let i = 0; i < 12; i++) await timer.pulse();
    expect(imports.file("user", batch.id, file.id)).toEqual(result);
    expect([db.query("SELECT * FROM import_documents WHERE id=?").get(documentId), db.query("SELECT * FROM import_document_parts WHERE document_id=? ORDER BY position").all(documentId), db.query("SELECT * FROM thoughts WHERE import_document_id=? ORDER BY rowid").all(documentId), db.query("SELECT result_json FROM run_steps WHERE run_id=?").get(runId)]).toEqual(snapshot);
    expect(client.prompts.filter(value => value.sessionID === prompt.sessionID)).toEqual([prompt]);
  } finally { await timer.daemon.stop(); }
}), 5000);

test("Stop fences a held native observation and its late completion while the waiter proceeds", async () => owned(async ({ path, db, imports, sources }) => {
  class HeldObservation extends FailureClient {
    held = false;
    blockedSession: string | undefined;
    private releaseHold: () => void = () => {};
    private readonly gate = new Promise<void>(resolve => { this.releaseHold = resolve; });
    constructor() { super("failed"); }
    release() { this.releaseHold(); }
    override async history(input: Parameters<PublicClient["history"]>[0]) {
      if (input.sessionID === this.blockedSession && (this.messages.get(input.sessionID)?.length ?? 0) > 0) { this.held = true; await this.gate; }
      return super.history(input);
    }
  }
  const bytes = encode("Stop held observation"), client = new HeldObservation();
  const batch = imports.createBatch("user", "late-observation"), holder = imports.admitFile("user", batch.id, "holder", "holder.md", bytes);
  const waiter = imports.admitFile("user", batch.id, "waiter", "waiter.md", bytes);
  if (!holder.runId) throw new Error("Missing holder run");
  const runId = holder.runId;
  const identity = db.query("SELECT session_id AS sessionId FROM runs WHERE id=?").get(runId) as {sessionId:string};
  client.blockedSession = identity.sessionId;
  const timer = await configured(path, client);
  try {
    await drive(timer, () => client.held);
    const generation = (db.query("SELECT generation FROM runs WHERE id=?").get(runId) as {generation:number}).generation;
    new SqliteRunRepository(db, sources).stop(runId);
    expect(db.query("SELECT status,generation FROM runs WHERE id=?").get(runId)).toEqual({ status: "interrupted", generation: generation + 1 });
    client.release();
    await drive(timer, () => imports.file("user", batch.id, waiter.id)?.state === "imported");
    expect(imports.file("user", batch.id, holder.id)).toMatchObject({ state: "interrupted", documentId: null });
    expect(db.query("SELECT result_json AS result FROM run_steps WHERE run_id=?").get(runId)).toEqual({ result: null });
    expect(db.query("SELECT count(*) AS n FROM import_documents").get()).toEqual({ n: 1 });
    expect(db.query("SELECT count(*) AS n FROM thoughts").get()).toEqual({ n: 1 });
    expect(db.query("SELECT count(*) AS n FROM runs WHERE kind='weave'").get()).toEqual({ n: 1 });
    expect(client.prompts.filter(prompt => prompt.sessionID === identity.sessionId)).toHaveLength(1);
  } finally { client.release(); await timer.daemon.stop(); }
}), 5000);

test("configured daemon submits one restricted owned import and commits its AI segmentation", async () => owned(async ({ path, db, imports, sources }) => {
  const agent: AgentConfig = { service: { url: "http://127.0.0.1:44991", token: "fixture-only-token" }, directory: "/tmp/opencode/import-agent-fixture", model: { providerID: "fixture", id: "model" }, effort: { quick: "q", standard: "s", thorough: "t" } };
  const text = "---\ntitle: private fixture\n---\n# First\nAlpha café\n\n# Second\nBeta";
  const bytes = encode(text), prepared = prepareMarkdown(bytes);
  const first = prepared.manifest.cuts[0], last = prepared.manifest.cuts.at(-1);
  if (!first || !last) throw new Error("Test document lacks selection endpoints");
  const client = new ImportClient([first.id, last.id]);
  const batch = imports.createBatch("user", "configured"), file = imports.admitFile("user", batch.id, "file", "private.md", bytes);
  const duplicate = imports.admitFile("user", batch.id, "duplicate", "copy.md", bytes);
  imports.sealBatch("user", batch.id);
  expect(file.state).toBe("queued");
  expect(duplicate.state).toBe("waiting");
  const callbacks: (() => void)[] = [];
  let resolutions = 0, factories = 0;
  let daemon: RunningDaemon | undefined;
  try {
    daemon = await startDaemon({ port: 0, dbPath: path, credentials, agent }, () => {}, {
      logSink: () => {},
      resolveAgentService: async () => { resolutions++; return { url: "http://127.0.0.1:44991", token: "fixture-only-token" }; },
      createPublicClient: () => { factories++; return client; },
      startTimer: poll => { callbacks.push(poll); return () => {}; },
    });
    for (let i = 0; i < 80; i++) {
      for (const poll of callbacks) poll();
      if (imports.file("user", batch.id, file.id)?.state === "imported" && imports.file("user", batch.id, duplicate.id)?.state === "skipped-identical") break;
      await Bun.sleep(10);
    }
    const result = imports.file("user", batch.id, file.id);
    const importPrompts = client.prompts.filter(prompt => client.sessions.get(prompt.sessionID)?.metadata.runId === file.runId);
    expect({ state: result?.state, segmentation: result?.segmentation, importPrompts: importPrompts.length, totalPrompts: client.prompts.length, resolutions, factories }).toMatchObject({
      state: "imported", segmentation: { method: "ai", reason: null }, importPrompts: 1,
    });
    if (!result?.documentId || !file.runId) throw new Error("Completed import has no owned document or run");
    expect(imports.file("user", batch.id, duplicate.id)).toMatchObject({ state: "skipped-identical", documentId: result.documentId, runId: null });
    expect(client.prompts.filter(prompt => {
      const value: unknown = JSON.parse(prompt.text);
      return typeof value === "object" && value !== null && "kind" in value && value.kind === "import-job";
    })).toHaveLength(1);
    const prompt = importPrompts[0];
    if (!prompt) throw new Error("Owned import prompt missing");
    const job: unknown = JSON.parse(prompt.text);
    expect(job).toMatchObject({ version: 1, kind: "import-job", document: text, manifest: prepared.manifest, capabilities: [] });
    expect(db.query("SELECT prompt_id AS promptId,input FROM run_steps WHERE run_id=? AND position=0").get(file.runId)).toEqual({ promptId: prompt.id, input: prompt.text });
    const session = client.sessions.get(prompt.sessionID);
    expect(session).toMatchObject({ id: prompt.sessionID, location: { directory: agent.directory }, model: { providerID: "fixture", id: "model", variant: "s" }, permissions: [{ action: "*", resource: "*", effect: "deny" }], metadata: { owner: "thoughtloom", runId: file.runId, protocolVersion: "1" } });
    expect(db.query("SELECT session_id AS sessionId FROM agent_bindings WHERE run_id=?").get(file.runId)).toEqual({ sessionId: prompt.sessionID });
    const inspection = new SqliteImportInspection(db, sources);
    expect(inspection.raw(history, result.documentId)).toEqual(bytes);
    const parts = inspection.parts(history, result.documentId).items;
    const thought = parts.find(part => part.kind === "thought");
    if (!thought?.thoughtId) throw new Error("AI segmentation did not map a thought");
    expect(result.thoughtCount).toBe(1);
    expect(new RejectionService(new SqliteRejectionRepository(db, quiet)).listThoughts(ai).find(item => item.id === thought.thoughtId)).toMatchObject({ text: "# First\nAlpha café\n\n# Second\nBeta", author: "source", kind: "imported-original" });
    expect(db.query("SELECT count(*) AS n FROM runs WHERE kind='weave' AND weave_subject_id=?").get(thought.thoughtId)).toEqual({ n: 1 });
    expect(db.query("SELECT count(*) AS n FROM connections").get()).toEqual({ n: 0 });
  } finally { if (daemon) await daemon.stop(); }
}), 5000);
