import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CreationService } from "../src/domain/creation";
import { RejectionService } from "../src/domain/rejection";
import { RunService, type NativeDispatcher } from "../src/domain/run";
import { TitleService } from "../src/domain/title";
import { SqliteRejectionRepository } from "../src/storage/rejection";
import { SqliteRunOperations } from "../src/storage/run-operations";
import { SqliteRunRepository } from "../src/storage/run";
import { migrate, SqliteStore } from "../src/storage/sqlite";
import { SqliteTitleRepository } from "../src/storage/title";

const now = () => "2031-02-03T04:05:06Z";
const native: NativeDispatcher = { submit: async () => { throw new Error("unexpected network"); }, observe: async () => { throw new Error("unexpected network"); } };
function fixture(action: (f: ReturnType<typeof setup>) => void) {
  const dir = mkdtempSync(join("/tmp/opencode", "schedule-owned-"));
  const db = new Database(join(dir, "owned.sqlite"));
  try { migrate(db); action(setup(db)); } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
}
function setup(db: Database) {
  let sequence = 0;
  const id = () => `owned-${++sequence}`;
  const sources = { id, now };
  const raw = new SqliteStore(db);
  raw.saveThought({ id: "root", text: "root text", title: "original title", titleAuthor: "user", author: "user", kind: "captured-original", createdAt: now(), origin: "fixture", parentId: null, sourceIds: [] });
  const store = new SqliteStore(db, sources);
  const rejection = new RejectionService(new SqliteRejectionRepository(db));
  const creation = new CreationService({ id, now, rejection, writes: { createThought: thought => store.saveThought(thought), createConnection: connection => store.saveConnection(connection) } });
  const titles = new TitleService(new SqliteTitleRepository(db, sources));
  const runs = new SqliteRunRepository(db, { ...sources, scheduleWeave: true });
  const service = new RunService({ repository: runs, dispatcher: native, id, now });
  const operations = new SqliteRunOperations(db, sources);
  return { db, raw, store, creation, titles, runs, service, operations };
}
function jobs(db: Database) {
  return db.query("SELECT id,status,weave_subject_id AS subjectId,weave_trigger_id AS triggerId FROM runs WHERE kind='weave' ORDER BY rowid").all() as { id: string; status: string; subjectId: string; triggerId: string }[];
}

test("capture queues one durable weave without agent configuration or native calls", () => fixture(f => {
  const captured = f.creation.capture("user", { text: "captured offline" });
  expect(f.store.getThought(captured.id)).toEqual(captured);
  const queued = jobs(f.db);
  expect(queued).toHaveLength(1);
  expect(queued[0]).toEqual({ id: expect.any(String), status: "queued", subjectId: captured.id, triggerId: expect.any(String) });
  expect(queued[0]?.triggerId.length).toBeGreaterThan(0);
  const reopened = new Database(f.db.filename);
  try { migrate(reopened); expect(jobs(reopened)).toEqual(queued); } finally { reopened.close(); }
  // Re-admitting an already recorded trigger must not create a second job.
  const item = queued[0];
  if (!item) throw new Error("Expected queued job");
  expect(() => f.db.run(`INSERT INTO runs (id,kind,status,session_id,prompt_id,created_at,generation,weave_subject_id,weave_trigger_id)
    VALUES ('duplicate','weave','queued','duplicate-session','duplicate-prompt','2031',0,?,?)`, [item.subjectId, item.triggerId])).toThrow(/UNIQUE constraint failed.*weave/i);
  expect(jobs(f.db)).toEqual(queued);
}));

test("capture and its job roll back even when failure occurs after both inserts", () => fixture(f => {
  f.db.exec(`CREATE TRIGGER test_capture_after_job AFTER INSERT ON thoughts
    WHEN NEW.text='atomic capture' AND EXISTS(SELECT 1 FROM runs WHERE kind='weave' AND weave_subject_id=NEW.id)
    BEGIN SELECT RAISE(ABORT,'test capture after both'); END;
    CREATE TRIGGER test_job_after_capture AFTER INSERT ON runs
    WHEN NEW.kind='weave' AND EXISTS(SELECT 1 FROM thoughts WHERE id=NEW.weave_subject_id AND text='atomic capture')
    BEGIN SELECT RAISE(ABORT,'test capture after both'); END;`);
  expect(() => f.creation.capture("user", { text: "atomic capture" })).toThrow(/test capture after both/);
  expect(f.db.query("SELECT COUNT(*) AS n FROM thoughts WHERE text='atomic capture'").get()).toEqual({ n: 0 });
  expect(jobs(f.db)).toEqual([]);
  f.db.exec("DROP TRIGGER test_capture_after_job; DROP TRIGGER test_job_after_capture");
  const thought = f.creation.capture("user", { text: "atomic capture" });
  expect(jobs(f.db)).toEqual([{ id: expect.any(String), status: "queued", subjectId: thought.id, triggerId: expect.any(String) }]);
}));

test("title clear invites regeneration transactionally; later distinct clears get distinct triggers", () => fixture(f => {
  f.db.exec(`CREATE TRIGGER test_clear_after_job AFTER UPDATE OF title ON thought_titles
    WHEN NEW.thought_id='root' AND NEW.title IS NULL AND EXISTS(SELECT 1 FROM runs WHERE kind='weave' AND weave_subject_id='root')
    BEGIN SELECT RAISE(ABORT,'test clear after both'); END;
    CREATE TRIGGER test_job_after_clear AFTER INSERT ON runs
    WHEN NEW.kind='weave' AND NEW.weave_subject_id='root' AND EXISTS(SELECT 1 FROM thought_titles WHERE thought_id='root' AND title IS NULL)
    BEGIN SELECT RAISE(ABORT,'test clear after both'); END;`);
  expect(() => f.titles.setUser("user", "root", null)).toThrow(/test clear after both/);
  expect(f.store.getThought("root")?.title).toBe("original title");
  expect(jobs(f.db)).toEqual([]);
  f.db.exec("DROP TRIGGER test_clear_after_job; DROP TRIGGER test_job_after_clear");
  expect(f.titles.setUser("user", "root", null)).toEqual({ title: null, titleAuthor: null });
  const first = jobs(f.db);
  expect(first).toHaveLength(1);
  expect(first[0]).toMatchObject({ status: "queued", subjectId: "root" });
  f.titles.setUser("user", "root", "new user title");
  expect(jobs(f.db)).toEqual(first);
  f.titles.setUser("user", "root", null);
  const second = jobs(f.db);
  expect(second).toHaveLength(2);
  expect(second[1]?.subjectId).toBe("root");
  expect(second[1]?.triggerId).not.toBe(first[0]?.triggerId);
}));

test("Evolve finish atomically saves canonical reply and targeted follow-up on latest issued development", () => fixture(f => {
  const admission = f.service.admit("user", "evolve", { parentId: "root", text: "question" });
  if (!admission.contribution) throw new Error("Expected contribution");
  const claim = f.service.claim(admission.run.id);
  const first = f.service.execute(claim, { id: "op-first", type: "development", parentId: admission.contribution.id, text: "first result", sourceIds: [] });
  const last = f.service.execute(claim, { id: "op-last", type: "development", parentId: admission.contribution.id, text: "last result", sourceIds: [] });
  const reply = { id: "reply", role: "addendum", state: "complete", text: "canonical reply", thoughtIds: [first.thought.id, last.thought.id] } as const;
  const discovery = jobs(f.db);
  expect(discovery).toEqual([admission.contribution.id,first.thought.id,last.thought.id].map(subjectId => ({
    id:expect.any(String),status:"queued",subjectId,triggerId:`connection-discovery:${admission.run.id}`,
  })));
  f.db.exec(`CREATE TRIGGER test_reply_after_followup AFTER INSERT ON responses
    WHEN NEW.id='reply' AND EXISTS(SELECT 1 FROM runs WHERE kind='weave' AND weave_subject_id='${last.thought.id}' AND weave_trigger_id='evolve:${admission.run.id}')
    BEGIN SELECT RAISE(ABORT,'test finish after both'); END;
    CREATE TRIGGER test_followup_after_reply AFTER INSERT ON runs
    WHEN NEW.kind='weave' AND NEW.weave_subject_id='${last.thought.id}' AND NEW.weave_trigger_id='evolve:${admission.run.id}' AND EXISTS(SELECT 1 FROM responses WHERE id='reply')
    BEGIN SELECT RAISE(ABORT,'test finish after both'); END;`);
  expect(() => f.service.finish(claim, reply)).toThrow(/test finish after both/);
  expect(f.store.getResponse("reply")).toBeNull();
  expect(f.runs.reply(admission.run.id)).toBeNull();
  expect(f.runs.get(admission.run.id)?.status).not.toBe("completed");
  expect(jobs(f.db)).toEqual(discovery);
  expect(f.store.getThought(last.thought.id)).toEqual(last.thought);
  f.db.exec("DROP TRIGGER test_reply_after_followup; DROP TRIGGER test_followup_after_reply");
  f.service.finish(claim, reply);
  expect(f.runs.reply(admission.run.id)).toEqual(reply);
  expect(f.runs.get(admission.run.id)?.status).toBe("completed");
  expect(jobs(f.db)).toEqual([...discovery,{ id: expect.any(String), status: "queued", subjectId: last.thought.id, triggerId: `evolve:${admission.run.id}` }]);
}));

test("Evolve fallback adds no ordinary contribution weave; metadata and connection writes do not recursively schedule", () => fixture(f => {
  const admission = f.service.admit("user", "evolve", { parentId: "root", text: "fallback input" });
  if (!admission.contribution) throw new Error("Expected contribution");
  const claim = f.service.claim(admission.run.id);
  f.service.finish(claim, { id: "fallback", role: "fallback", state: "complete", text: "question back", thoughtIds: [admission.contribution.id] });
  const before = jobs(f.db);
  expect(f.runs.reply(admission.run.id)).toMatchObject({ text: "question back", role: "fallback", thoughtIds: [admission.contribution.id] });
  expect(before).toEqual([{id:expect.any(String),status:"queued",subjectId:admission.contribution.id,triggerId:`connection-discovery:${admission.run.id}`}]);
  const interpretation = f.creation.interpret("ai", "root", { text: "weaver interpretation" });
  f.titles.fillAi("ai", interpretation.id, "AI title");
  f.creation.connect("ai", { fromId: "root", toId: interpretation.id, category: "related", explanation: "relationship" });
  expect(jobs(f.db)).toEqual(before);
}));

test("Evolve completion retains its reply and queues a follow-up while the target already has a weave", () => fixture(f => {
  const admission = f.service.admit("user", "evolve", { parentId: "root", text: "question while busy" });
  if (!admission.contribution) throw new Error("Expected contribution");
  const claim = f.service.claim(admission.run.id);
  const result = f.service.execute(claim, { id: "busy-development", type: "development", parentId: admission.contribution.id, text: "target for follow-up", sourceIds: [] });
  const existing = f.operations.admitWeave("user", { subjectId: result.thought.id, triggerId: "already-active" });
  const before = jobs(f.db);
  expect(before).toEqual([
    ...[admission.contribution.id,result.thought.id].map(subjectId => ({id:expect.any(String),status:"queued",subjectId,triggerId:`connection-discovery:${admission.run.id}`})),
    {id:existing.id,status:"queued",subjectId:result.thought.id,triggerId:"already-active"},
  ]);
  const reply = { id: "busy-reply", role: "addendum", state: "complete", text: "retained reply", thoughtIds: [result.thought.id] } as const;
  f.service.finish(claim, reply);
  expect(f.runs.reply(admission.run.id)).toEqual(reply);
  expect(f.runs.get(admission.run.id)?.status).toBe("completed");
  expect(jobs(f.db)).toEqual([...before,
    {id:expect.any(String),subjectId:result.thought.id,status:"queued",triggerId:`evolve:${admission.run.id}`},
  ]);
}));
