import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { RejectionService } from "../src/domain/rejection";
import { RunConflictError, RunFenceError, RunForbiddenError, RunNotFoundError, RunService, type NativeDispatcher } from "../src/domain/run";
import { parseEnvelope, ProtocolValidationError, type ReportEnvelope } from "../src/domain/run-protocol";
import { SqliteAgenticExports } from "../src/storage/agentic-export";
import { SqliteCapabilityDispatcher } from "../src/storage/capability";
import { SqliteRejectionRepository } from "../src/storage/rejection";
import { SqliteRunProtocolRepository } from "../src/storage/run-protocol";
import { SqliteRunRepository } from "../src/storage/run";
import { migrate, SqliteStore } from "../src/storage/sqlite";
import { SqliteTitleRepository } from "../src/storage/title";
import { TitleService } from "../src/domain/title";
import { ValidationError } from "../src/domain/validation";
import { exportSources, renderExportReport } from "../src/domain/agentic-export";
import { SqliteRunWorkerState } from "../src/storage/run-worker";
import { SqliteAgentBindings } from "../src/storage/agent-binding";
import { AgentService } from "../src/domain/agent";
import { SqliteAgentRuns } from "../src/storage/agent";

const now = () => "2032-01-01T00:00:00Z";
const native: NativeDispatcher = { submit: async () => {}, observe: async () => "running" };
const envelope = (markdown: string, sourceThoughtIds: readonly string[]): ReportEnvelope => ({ version: 1, kind: "report", markdown, sourceThoughtIds });

test("media citations retain source attribution and do not claim binary access", () => {
  const sources = exportSources([{ id: "media-root", title: "Sketch.png", author: "source", kind: "media-original" }]);
  expect(sources).toEqual([{ id: "media-root", title: "Sketch.png", author: "source", kind: "media-original" }]);
  const report = renderExportReport("# Findings\n\nA recorded source.", sources);
  expect(report).toContain("Sketch");
  expect(report).toContain("media-original");
  expect(report).toMatch(/thought author:\s*source/i);
  expect(report).toMatch(/(?:descriptor|metadata)/i);
  expect(report).toMatch(/(?:binary|file).*(?:not|no)|(?:not|no).*(?:binary|file)/i);
  expect(() => exportSources([{ id: "media-root", title: "Sketch.png", author: "user", kind: "media-original" }])).toThrow(ValidationError);
});
function fixture(action: (f: ReturnType<typeof setup>, path: string) => void) {
  const dir = mkdtempSync(join("/tmp/opencode", "agentic-export-"));
  const path = join(dir, "owned.sqlite");
  const db = new Database(path);
  try { migrate(db); action(setup(db), path); } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
}
function setup(db: Database) {
  let counter = 0;
  const sources = { id: () => `owned-${++counter}`, now };
  const store = new SqliteStore(db);
  store.saveThought({ id: "human", text: "cobalt human thought", title: "Human title", titleAuthor: "user", author: "user", kind: "captured-original", createdAt: now(), origin: "capture", parentId: null, sourceIds: [] });
  store.saveThought({ id: "hypothesis", text: "AI hypothesis remains attributed", title: null, titleAuthor: null, author: "ai", kind: "ai-interpretation", createdAt: now(), origin: "weave", parentId: "human", sourceIds: ["human"] });
  store.saveThought({ id: "other", text: "other retained thought", title: null, titleAuthor: null, author: "user", kind: "captured-original", createdAt: now(), origin: "capture", parentId: null, sourceIds: [] });
  store.saveConnection({ id: "link", fromId: "human", toId: "hypothesis", category: "related", proposedBy: "ai", explanation: "fixture relationship", sourceIds: ["human"] });
  store.saveResponse({ id: "shared", text: "shared retained response", role: "addendum", state: "complete", thoughtIds: ["hypothesis", "other"] });
  const runs = new SqliteRunRepository(db, sources);
  const service = new RunService({ repository: runs, dispatcher: native, ...sources });
  const exports = new SqliteAgenticExports(db, sources);
  const steps = new SqliteRunProtocolRepository(db);
  const capabilities = new SqliteCapabilityDispatcher(db, sources);
  const rejection = new RejectionService(new SqliteRejectionRepository(db));
  const titles = new TitleService(new SqliteTitleRepository(db));
  return { db, sources, store, runs, service, exports, steps, capabilities, rejection, titles };
}
function begin(f: ReturnType<typeof setup>) {
  const run = f.exports.admit("user", { request: "What connects these thoughts?" });
  const claim = f.service.claim(run.id);
  f.steps.prepare(claim, { promptId: run.promptId, input: "test-owned export context" });
  let promptId = run.promptId;
  let seq = 0;
  const invoke = (capability: string, args: Record<string, unknown>) => {
    const request = { capability, arguments: args };
    f.steps.completeStep(claim, promptId, { version: 1, kind: "request", request });
    const result = f.capabilities.dispatch(claim, promptId, request);
    const next = { promptId: `${run.id}-next-${++seq}`, input: JSON.stringify(result) };
    f.steps.advance(claim, promptId, result, next); promptId = next.promptId;
    return result;
  };
  return { run, claim, invoke, complete(report: ReportEnvelope) { f.steps.completeStep(claim, promptId, report); return promptId; } };
}
function knowledge(db: Database) {
  return ["thoughts", "thought_titles", "thought_sources", "thought_source_seals", "connections", "connection_sources", "rejected_thoughts", "rejected_connections", "responses", "response_thoughts", "response_seals"].map(table => [table, db.query(`SELECT * FROM ${table} ORDER BY rowid`).all()]);
}

test("export history is user-only, bounded, deterministic and survives reopening", () => fixture((f, path) => {
  const a = f.exports.admit("user", { request: "First question", effort: "quick" });
  const b = f.exports.admit("user", { request: "Second question", effort: "thorough" });
  const c = f.exports.admit("user", { request: "Third question" });
  const weave = f.service.admit("user", "weave").run;
  // Generic legacy export admission has no recoverable user intent.
  const legacy = f.service.admit("user", "export").run;
  const h = f.exports;
  expect(typeof h.list).toBe("function");
  expect(() => h.list("ai")).toThrow(RunForbiddenError);
  expect(() => h.get("ai", a.id)).toThrow(RunForbiddenError);
  for (const limit of [0, 201, 1.5]) expect(() => h.list("user", { limit })).toThrow(ValidationError);
  const first = h.list("user", { limit: 2 });
  expect(first.items).toHaveLength(2);
  expect(first.nextCursor).not.toBeNull();
  const second = h.list("user", { limit: 2, cursor: first.nextCursor });
  expect(second.nextCursor).toBeNull();
  const items = [...first.items, ...second.items];
  expect(items.map(item => item.id).sort()).toEqual([a.id, b.id, c.id].sort());
  expect(items.some(item => item.id === legacy.id)).toBe(false);
  expect(h.get("user", legacy.id)).toBeNull();
  expect(h.get("user", weave.id)).toBeNull();
  expect(() => h.delete("user", weave.id)).toThrow(RunNotFoundError);
  expect(() => h.delete("user", "missing-run")).toThrow(RunNotFoundError);
  expect(h.get("user", b.id)).toEqual({ id: b.id, status: "queued", createdAt: now(), request: "Second question", effort: "thorough", deletionState: "stop-required", restored: false });
  for (const item of items) expect(Object.keys(item).sort()).toEqual(["createdAt", "deletionState", "effort", "id", "request", "restored", "status"]);
  const reopened = new Database(path);
  try {
    migrate(reopened);
    const restored = new SqliteAgenticExports(reopened, f.sources);
    expect(restored.get("user", b.id)).toEqual(h.get("user", b.id));
    expect(restored.list("user", { limit: 2 })).toEqual(first);
  } finally { reopened.close(); }
}));

const ownedTables = ["runs", "export_intents", "export_reports", "run_steps", "run_context", "agent_bindings", "run_replies", "run_operation_receipts", "run_issued_thoughts"] as const;
function ownedRows(db: Database, id: string) {
  return ownedTables.map(table => [table, db.query(`SELECT * FROM ${table} WHERE ${table === "runs" ? "id" : "run_id"}=? ORDER BY rowid`).all(id)]);
}

test("deleting a completed export removes its local execution and report without changing knowledge or unrelated runs", () => fixture((f, path) => {
  const run = begin(f);
  new SqliteAgentBindings(f.db).bind(run.run.id, { sessionId: run.run.sessionId, serviceUrl: "http://127.0.0.1:44999", location: { directory: "/owned/workspace" }, model: { providerID: "fixture-provider", id: "fixture-model" }, permissions: [{ action: "*", resource: "*", effect: "deny" }], protocolVersion: 1 }, run.claim);
  run.invoke("readThought", { id: "human" });
  const promptId = run.complete(envelope("Retained report body.", ["human"]));
  const report = f.exports.finalize(run.claim, promptId);
  f.rejection.rejectThought("user", "human");
  const before = knowledge(f.db);
  const other = f.exports.admit("user", { request: "Unrelated export" });
  const weave = f.service.admit("user", "weave").run;
  const otherBefore = ownedRows(f.db, other.id), weaveBefore = ownedRows(f.db, weave.id);
  expect(f.db.query("SELECT 1 FROM agent_bindings WHERE run_id=?").get(run.run.id)).not.toBeNull();
  expect(f.db.query("SELECT 1 FROM run_context WHERE run_id=?").get(run.run.id)).not.toBeNull();
  expect(f.db.query("SELECT 1 FROM run_steps WHERE run_id=? AND envelope_json LIKE '%Retained report body.%'").get(run.run.id)).not.toBeNull();
  const h = f.exports;
  expect(typeof h.get).toBe("function");
  expect(h.get("user", run.run.id)).toMatchObject({ id: run.run.id, request: "What connects these thoughts?", status: "completed", deletionState: "ready" });
  expect(f.exports.report("user", run.run.id)).toEqual(report);
  expect(() => h.delete("ai", run.run.id)).toThrow(RunForbiddenError);
  h.delete("user", run.run.id);
  expect(h.get("user", run.run.id)).toBeNull();
  expect(h.list("user").items.some(item => item.id === run.run.id)).toBe(false);
  expect(f.exports.report("user", run.run.id)).toBeNull();
  for (const [, rows] of ownedRows(f.db, run.run.id)) expect(rows).toEqual([]);
  expect(ownedRows(f.db, other.id)).toEqual(otherBefore);
  expect(ownedRows(f.db, weave.id)).toEqual(weaveBefore);
  expect(() => f.db.run("DELETE FROM runs WHERE id=?", [weave.id])).toThrow(/immutable/i);
  expect(() => f.db.run("DELETE FROM run_steps WHERE run_id=?", [other.id])).toThrow(/immutable/i);
  expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(knowledge(f.db)).toEqual(before);
  expect(() => f.exports.finalize(run.claim, promptId)).toThrow();
  expect(() => h.delete("user", run.run.id)).toThrow(RunNotFoundError);
  const reopened = new Database(path);
  try { migrate(reopened); for (const [, rows] of ownedRows(reopened, run.run.id)) expect(rows).toEqual([]); }
  finally { reopened.close(); }
}));

test("active and cancellation-pending exports cannot be deleted; settled Stop fences publication", () => fixture(f => {
  const run = begin(f);
  const promptId = run.complete(envelope("Late report must not publish.", []));
  const h = f.exports;
  expect(typeof h.delete).toBe("function");
  expect(() => h.delete("user", run.run.id)).toThrow(RunConflictError);
  expect(h.get("user", run.run.id)).toMatchObject({ status: "uncertain", deletionState: "stop-required" });
  f.service.stop("user", run.run.id);
  expect(f.steps.cancellation(run.run.id)).toBe("pending");
  expect(h.get("user", run.run.id)).toMatchObject({ status: "interrupted", deletionState: "settling" });
  expect(() => h.delete("user", run.run.id)).toThrow(RunConflictError);
  // A completed native envelope is not proof of unsubmitted work; settle through the existing journal boundary.
  f.steps.settleCancellation(run.run.id);
  expect(h.get("user", run.run.id)?.deletionState).toBe("ready");
  h.delete("user", run.run.id);
  expect(h.get("user", run.run.id)).toBeNull();
  for (const [, rows] of ownedRows(f.db, run.run.id)) expect(rows).toEqual([]);
  expect(() => f.exports.finalize(run.claim, promptId)).toThrow();
  expect(f.exports.report("user", run.run.id)).toBeNull();
}));

test("unsubmitted Stop becomes deletable only after worker settlement", () => fixture(f => {
  const run = f.exports.admit("user", { request: "Never dispatched" });
  const h = f.exports;
  expect(typeof h.delete).toBe("function");
  f.service.stop("user", run.id);
  expect(() => h.delete("user", run.id)).toThrow(RunConflictError);
  expect(new SqliteRunWorkerState(f.db, f.sources).settleUnsubmitted(run.id)).toBe(true);
  h.delete("user", run.id);
  expect(h.get("user", run.id)).toBeNull();
}));

test("restored export Stop acknowledges local discard without changing historical execution or cancellation", () => fixture((f, path) => {
  const run = begin(f);
  const promptId = run.complete(envelope("Historical unpublished report.", []));
  f.service.stop("user", run.run.id);
  expect(f.steps.cancellation(run.run.id)).toBe("pending");
  f.db.run("INSERT INTO restore_fences VALUES ('run',?,?,?,?)", [run.run.id, "a".repeat(64), now(), '{}']);
  const fence = f.db.query("SELECT * FROM restore_fences WHERE entity_kind='run' AND entity_id=?").get(run.run.id);
  const execution = ownedRows(f.db, run.run.id).filter(([table]) => table !== "export_intents");
  const knowledgeBefore = knowledge(f.db);
  const h = f.exports;
  expect(typeof h.get).toBe("function");
  expect(h.get("user", run.run.id)).toMatchObject({ status: "interrupted", restored: true, deletionState: "stop-required" });
  expect(() => h.delete("user", run.run.id)).toThrow(RunConflictError);
  const agent = new AgentService(new SqliteAgentRuns(f.db, f.sources), false);
  agent.stop("user", run.run.id);
  expect(h.get("user", run.run.id)).toMatchObject({ status: "interrupted", restored: true, deletionState: "ready" });
  expect(f.steps.cancellation(run.run.id)).toBe("pending");
  expect(ownedRows(f.db, run.run.id).filter(([table]) => table !== "export_intents")).toEqual(execution);
  expect(f.db.query("SELECT * FROM restore_fences WHERE entity_kind='run' AND entity_id=?").get(run.run.id)).toEqual(fence);
  const reopened = new Database(path);
  try { migrate(reopened); expect(new SqliteAgenticExports(reopened, f.sources).get("user", run.run.id)?.deletionState).toBe("ready"); }
  finally { reopened.close(); }
  h.delete("user", run.run.id);
  for (const [, rows] of ownedRows(f.db, run.run.id)) expect(rows).toEqual([]);
  expect(f.db.query("SELECT * FROM restore_fences WHERE entity_kind='run' AND entity_id=?").get(run.run.id)).toBeNull();
  expect(knowledge(f.db)).toEqual(knowledgeBefore);
  expect(() => f.exports.finalize(run.claim, promptId)).toThrow();
  expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
}));

test("a live pending export cannot forge local discard or purge authority", () => fixture(f => {
  const run = begin(f);
  f.service.stop("user", run.run.id);
  const h = f.exports;
  expect(typeof h.get).toBe("function");
  expect(h.get("user", run.run.id)).toMatchObject({ restored: false, deletionState: "settling" });
  for (const disposition of ["local-stopped", "deleting"]) {
    expect(() => f.db.run("UPDATE export_intents SET local_disposition=? WHERE run_id=?", [disposition, run.run.id])).toThrow();
  }
  expect(() => f.db.run("DELETE FROM run_steps WHERE run_id=?", [run.run.id])).toThrow(/immutable/i);
  expect(() => h.delete("user", run.run.id)).toThrow(RunConflictError);
  expect(f.steps.cancellation(run.run.id)).toBe("pending");
}));

test("restored formerly active export with no cancellation journal needs local Stop, not invented settlement", () => fixture(f => {
  const run = f.exports.admit("user", { request: "Restored queued export" });
  // Restore recovery interrupts active local work without recording a native cancellation.
  f.db.run("UPDATE runs SET status='interrupted',generation=generation+1 WHERE id=?", [run.id]);
  f.db.run("INSERT INTO restore_fences VALUES ('run',?,?,?,?)", [run.id, "c".repeat(64), now(), '{"runs.status":"queued"}']);
  const h = f.exports;
  expect(typeof h.get).toBe("function");
  expect(h.get("user", run.id)).toMatchObject({ restored: true, deletionState: "stop-required" });
  expect(() => h.delete("user", run.id)).toThrow(RunConflictError);
  new AgentService(new SqliteAgentRuns(f.db, f.sources), false).stop("user", run.id);
  expect(f.steps.cancellation(run.id)).toBe("none");
  expect(h.get("user", run.id)?.deletionState).toBe("ready");
  h.delete("user", run.id);
  for (const [, rows] of ownedRows(f.db, run.id)) expect(rows).toEqual([]);
}));

test("restored export deletion failure preserves local acknowledgement, execution and restore fence", () => fixture(f => {
  const run = f.exports.admit("user", { request: "Restored rollback" });
  f.service.stop("user", run.id);
  f.db.run("INSERT INTO restore_fences VALUES ('run',?,?,?,?)", [run.id, "b".repeat(64), now(), '{}']);
  const h = f.exports;
  expect(typeof h.delete).toBe("function");
  new AgentService(new SqliteAgentRuns(f.db, f.sources), false).stop("user", run.id);
  const before = ownedRows(f.db, run.id);
  const fence = f.db.query("SELECT * FROM restore_fences WHERE entity_kind='run' AND entity_id=?").get(run.id);
  f.db.exec("CREATE TRIGGER test_restored_delete_failure BEFORE DELETE ON runs BEGIN SELECT RAISE(ABORT,'test restored delete failure'); END");
  expect(() => h.delete("user", run.id)).toThrow(/test restored delete failure/);
  expect(ownedRows(f.db, run.id)).toEqual(before);
  expect(f.db.query("SELECT * FROM restore_fences WHERE entity_kind='run' AND entity_id=?").get(run.id)).toEqual(fence);
  expect(h.get("user", run.id)).toMatchObject({ restored: true, deletionState: "ready" });
  expect(f.steps.cancellation(run.id)).toBe("pending");
}));

test("failed execution deletion rolls back all export-owned rows together", () => fixture(f => {
  const run = begin(f);
  const promptId = run.complete(envelope("Rollback report.", []));
  const report = f.exports.finalize(run.claim, promptId);
  const before = ownedRows(f.db, run.run.id);
  const h = f.exports;
  expect(typeof h.delete).toBe("function");
  f.db.exec("CREATE TRIGGER test_export_delete_failure BEFORE DELETE ON runs BEGIN SELECT RAISE(ABORT,'test export delete failure'); END");
  expect(() => h.delete("user", run.run.id)).toThrow(/test export delete failure/);
  expect(h.get("user", run.run.id)?.id).toBe(run.run.id);
  expect(f.exports.report("user", run.run.id)).toEqual(report);
  expect(ownedRows(f.db, run.run.id)).toEqual(before);
}));

test("strict report envelopes accept only one complete typed report, never malformed or model authority", () => {
  const valid = envelope("# Findings\n\nExisting thinking.", ["human", "hypothesis"]);
  expect(parseEnvelope(JSON.stringify(valid))).toEqual(valid);
  expect(parseEnvelope(JSON.stringify(envelope("No relevant findings.", [])))).toEqual(envelope("No relevant findings.", []));
  for (const invalid of [
    '{"version":1,"kind":"report","markdown":"truncated"',
    JSON.stringify({ ...valid, version: 2 }), JSON.stringify({ ...valid, id: "model-id" }),
    JSON.stringify({ ...valid, sourceThoughtIds: ["human", "human"] }), JSON.stringify({ ...valid, sourceThoughtIds: [5] }),
    JSON.stringify({ ...valid, markdown: " " }), '{"version":1,"kind":"report","markdown":"a","markdown":"b","sourceThoughtIds":[]}',
  ]) expect(() => parseEnvelope(invalid)).toThrow(ProtocolValidationError);
});

test("user admission persists immutable request and effort with standard default across reopen", () => fixture((f, path) => {
  const standard = f.exports.admit("user", { request: "Find prior thinking" });
  const quick = f.exports.admit("user", { request: "Compare sources", effort: "quick" });
  const thorough = f.exports.admit("user", { request: "Trace history", effort: "thorough" });
  expect(standard.kind).toBe("export");
  expect(f.exports.intent(standard.id)).toEqual({ request: "Find prior thinking", effort: "standard" });
  expect(f.exports.intent(quick.id)).toEqual({ request: "Compare sources", effort: "quick" });
  expect(f.exports.intent(thorough.id)).toEqual({ request: "Trace history", effort: "thorough" });
  expect(() => f.exports.admit("ai", { request: "forged user request" })).toThrow(RunForbiddenError);
  expect(() => f.exports.admit("user", { request: " " })).toThrow(ValidationError);
  expect(() => f.db.run("UPDATE export_intents SET request='changed' WHERE run_id=?", [standard.id])).toThrow(/immutable/i);
  expect(() => f.db.run("UPDATE export_intents SET effort='quick' WHERE run_id=?", [standard.id])).toThrow(/immutable/i);
  const reopened = new Database(path);
  try { migrate(reopened); expect(new SqliteAgenticExports(reopened, f.sources).intent(standard.id)).toEqual({ request: "Find prior thinking", effort: "standard" }); }
  finally { reopened.close(); }
}));

test("full-read citations finalize immutable Markdown and attribution without knowledge writes", () => fixture((f, path) => {
  const run = begin(f);
  run.invoke("readThought", { id: "human" });
  run.invoke("readThought", { id: "hypothesis" });
  f.titles.setUser("user", "human", "Current user title");
  const before = knowledge(f.db);
  const promptId = run.complete(envelope("# Report\n\nA connection between recorded material.", ["human", "hypothesis"]));
  const report = f.exports.finalize(run.claim, promptId);
  expect(report.runId).toBe(run.run.id);
  expect(report.markdown).toContain("A connection between recorded material.");
  expect(report.markdown).toContain("human"); expect(report.markdown).toContain("hypothesis");
  expect(report.sources).toEqual([
    { id: "human", title: "Current user title", author: "user", kind: "captured-original" },
    { id: "hypothesis", title: "AI hypothesis remains attributed", author: "ai", kind: "ai-interpretation" },
  ]);
  expect(f.runs.get(run.run.id)?.status).toBe("completed");
  expect(f.runs.reply(run.run.id)).toBeNull();
  expect(knowledge(f.db)).toEqual(before);
  expect(() => f.exports.report("ai", run.run.id)).toThrow(RunForbiddenError);
  expect(() => f.exports.finalize(run.claim, promptId)).toThrow(RunFenceError);
  expect(() => f.db.run("UPDATE export_reports SET markdown='changed' WHERE run_id=?", [run.run.id])).toThrow(/immutable/i);
  expect(() => f.db.run("DELETE FROM export_reports WHERE run_id=?", [run.run.id])).toThrow(/immutable/i);
  expect(() => f.db.run("INSERT OR REPLACE INTO export_reports SELECT * FROM export_reports WHERE run_id=?", [run.run.id])).toThrow(/immutable/i);
  const reopened = new Database(path);
  try { migrate(reopened); expect(new SqliteAgenticExports(reopened, f.sources).report("user", run.run.id)).toEqual(report); }
  finally { reopened.close(); }
}));

test("a report envelope cannot complete weave or Evolve runs", () => fixture(f => {
  const weave = f.service.admit("user", "weave").run;
  const evolve = f.service.admit("user", "evolve", { parentId: "human", text: "user question" }).run;
  for (const run of [weave, evolve]) {
    const claim = f.service.claim(run.id);
    f.steps.prepare(claim, { promptId: run.promptId, input: "not an export" });
    expect(() => f.steps.completeStep(claim, run.promptId, envelope("Not a conversation reply.", []))).toThrow(RunForbiddenError);
    expect(f.exports.report("user", run.id)).toBeNull();
  }
}));

test("search snippets do not authorize citations; unknown and rejected sources cannot be published", () => fixture(f => {
  const run = begin(f);
  expect(run.invoke("search", { query: "cobalt" })).toMatchObject({ type: "search", candidates: [{ id: "human" }] });
  const promptId = run.complete(envelope("Claim about a search candidate.", ["human"]));
  expect(() => f.exports.finalize(run.claim, promptId)).toThrow(RunForbiddenError);
  expect(f.exports.report("user", run.run.id)).toBeNull();
  const unknown = begin(f);
  const unknownPrompt = unknown.complete(envelope("Invented citation.", ["nonexistent"]));
  expect(() => f.exports.finalize(unknown.claim, unknownPrompt)).toThrow(RunNotFoundError);
  expect(f.exports.report("user", unknown.run.id)).toBeNull();
  const rejected = begin(f);
  rejected.invoke("readThought", { id: "human" });
  const rejectedPrompt = rejected.complete(envelope("A now rejected source.", ["human"]));
  f.rejection.rejectThought("user", "human");
  expect(() => f.exports.finalize(rejected.claim, rejectedPrompt)).toThrow(RunFenceError);
  expect(f.exports.report("user", rejected.run.id)).toBeNull();
}));

test("shared-response exposure fences publication after any associated thought is rejected", () => fixture(f => {
  const run = begin(f);
  expect(run.invoke("readResponse", { id: "shared" })).toMatchObject({ type: "response", response: { id: "shared" } });
  const promptId = run.complete(envelope("No findings based on retained sources.", []));
  f.rejection.rejectThought("user", "other");
  expect(() => f.exports.finalize(run.claim, promptId)).toThrow(RunFenceError);
  expect(f.runs.get(run.run.id)?.status).toBe("interrupted");
  expect(f.exports.report("user", run.run.id)).toBeNull();
}));

test("fault after report and terminal state exist rolls both back; Stop fences a later publication", () => fixture(f => {
  const run = begin(f);
  const promptId = run.complete(envelope("No relevant findings.", []));
  f.db.exec(`CREATE TRIGGER test_report_after_terminal AFTER INSERT ON export_reports
    WHEN EXISTS(SELECT 1 FROM runs WHERE id=NEW.run_id AND status='completed') BEGIN SELECT RAISE(ABORT,'test report after both'); END;
    CREATE TRIGGER test_terminal_after_report AFTER UPDATE OF status ON runs
    WHEN NEW.status='completed' AND EXISTS(SELECT 1 FROM export_reports WHERE run_id=NEW.id) BEGIN SELECT RAISE(ABORT,'test report after both'); END;`);
  expect(() => f.exports.finalize(run.claim, promptId)).toThrow(/test report after both/);
  expect(f.exports.report("user", run.run.id)).toBeNull();
  expect(f.runs.get(run.run.id)?.status).not.toBe("completed");
  f.db.exec("DROP TRIGGER test_report_after_terminal; DROP TRIGGER test_terminal_after_report");
  const report = f.exports.finalize(run.claim, promptId);
  expect(report.sources).toEqual([]);
  expect(report.markdown).toContain("No relevant findings.");
  const stopped = begin(f);
  const stoppedPrompt = stopped.complete(envelope("Must not publish.", []));
  f.service.stop("user", stopped.run.id);
  expect(() => f.exports.finalize(stopped.claim, stoppedPrompt)).toThrow(RunFenceError);
  expect(f.exports.report("user", stopped.run.id)).toBeNull();
}));

test("export dispatcher denies each model knowledge write and retains unchanged knowledge", () => fixture(f => {
  const before = knowledge(f.db);
  for (const request of [
    { capability: "development", arguments: { parentId: "human", text: "forged", sourceIds: [] } },
    { capability: "interpretation", arguments: { text: "forged", sourceIds: [] } },
    { capability: "title-fill", arguments: { title: "forged" } },
    { capability: "connection", arguments: { fromId: "human", toId: "other", category: "related", explanation: "forged", sourceIds: [] } },
  ]) {
    const run = begin(f);
    f.steps.completeStep(run.claim, run.run.promptId, { version: 1, kind: "request", request });
    expect(() => f.capabilities.dispatch(run.claim, run.run.promptId, request)).toThrow(RunForbiddenError);
  }
  expect(knowledge(f.db)).toEqual(before);
}));
