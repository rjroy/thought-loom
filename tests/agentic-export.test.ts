import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { RejectionService } from "../src/domain/rejection";
import { RunFenceError, RunForbiddenError, RunNotFoundError, RunService, type NativeDispatcher } from "../src/domain/run";
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
