import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { RunSupervisor } from "../src/agent/supervisor";
import { ReinterpretationService } from "../src/domain/reinterpretation";
import { RejectionService } from "../src/domain/rejection";
import { TitleService } from "../src/domain/title";
import { createLogger } from "../src/logging";
import { SqliteRejectionRepository } from "../src/storage/rejection";
import { SqliteReinterpretations } from "../src/storage/reinterpretation";
import { SqliteRunOperations } from "../src/storage/run-operations";
import { SqliteRunRepository } from "../src/storage/run";
import { SqliteTitleRepository } from "../src/storage/title";
import { migrate, SqliteStore } from "../src/storage/sqlite";
import { weaveDispatchAllowed } from "../src/storage/weave-work";

const now = () => "2030-01-02T03:04:05.000Z", logger = createLogger("verbose", () => {});
async function fixture(action: (f: ReturnType<typeof setup>) => Promise<void> | void): Promise<void> {
  const dir = await mkdtemp("/tmp/opencode/restore-coordination-"), db = new Database(join(dir, "owned.sqlite"));
  try { migrate(db, logger); await action(setup(db)); } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
}
function setup(db: Database) {
  let n = 0;
  const sources = { id: () => `owned-${++n}`, sessionId: () => `ses_owned${++n}`, promptId: () => `msg_owned${++n}`, now, logger };
  const store = new SqliteStore(db), runs = new SqliteRunRepository(db, sources), ops = new SqliteRunOperations(db, sources);
  const commands = new ReinterpretationService(new SqliteReinterpretations(db, sources));
  const rejection = new RejectionService(new SqliteRejectionRepository(db, logger));
  const subject = (id: string) => store.saveThought({ id, text: `owned ${id}`, title: null, author: "user", kind: "captured-original",
    createdAt: now(), origin: "fixture", parentId: null, sourceIds: [] });
  const fence = (id: string) => db.run("INSERT INTO restore_fences VALUES ('run',?,?,?,?)", [id, "a".repeat(64), now(), "{}"]);
  const history = (id: string) => ({ run: db.query("SELECT * FROM runs WHERE id=?").get(id), steps: db.query("SELECT * FROM run_steps WHERE run_id=? ORDER BY position").all(id),
    binding: db.query("SELECT * FROM agent_bindings WHERE run_id=?").all(id) });
  return { db, sources, runs, ops, commands, rejection, subject, fence, history };
}

test("fenced historical weave work does not block fresh reinterpretation while keyed history remains replayable", async () => {
  for (const state of ["queued", "submitting", "failed-pending", "failed-unverified"] as const) await fixture(f => {
    f.subject("subject");
    const old = f.commands.admit("user", "subject", "old-key", {});
    const oldId = old.snapshot.receipt?.runId; if (!oldId) throw new Error("Missing owned old receipt");
    if (state !== "queued") {
      f.db.run("UPDATE run_steps SET input=?,state=? WHERE run_id=?", ["owned retained input", state === "submitting" ? "submitting" : "uncertain", oldId]);
      f.db.run("UPDATE runs SET status=?,cancellation_state=? WHERE id=?", [state === "submitting" ? "submitting" : "failed", state === "failed-unverified" ? "settled" : "pending", oldId]);
    }
    f.fence(oldId); const before = f.history(oldId);
    expect(f.commands.byKey("user", "subject", "old-key").receipt?.runId).toBe(oldId);
    expect(f.commands.byKey("user", "subject", "new-key").eligibility.eligible).toBe(true);
    const next = f.commands.admit("user", "subject", "new-key", {});
    const nextId = next.snapshot.receipt?.runId; if (!nextId) throw new Error("Missing fresh receipt");
    expect(nextId).not.toBe(oldId); expect(next.replayed).toBe(false);
    expect(weaveDispatchAllowed(f.db, nextId)).toBe(true);
    expect(f.runs.claim(nextId).runId).toBe(nextId);
    const count = f.db.query("SELECT count(*) AS n FROM runs").get();
    const replay = f.commands.admit("user", "subject", "old-key", {});
    expect(replay.replayed).toBe(true); expect(replay.snapshot.receipt?.runId).toBe(oldId);
    expect(f.db.query("SELECT count(*) AS n FROM runs").get()).toEqual(count);
    expect(f.history(oldId)).toEqual(before);
  });
}, 30000);

test("rejected subject still denies fresh reinterpretation while old fenced key remains inspectable", async () => fixture(f => {
  f.subject("subject"); const old = f.commands.admit("user", "subject", "old", {}), oldId = old.snapshot.receipt?.runId;
  if (!oldId) throw new Error("Missing owned old receipt");
  f.rejection.rejectThought("user", "subject"); f.fence(oldId);
  const before = f.history(oldId), count = f.db.query("SELECT count(*) AS n FROM runs").get();
  expect(f.commands.byKey("user", "subject", "old").receipt?.runId).toBe(oldId);
  expect(f.commands.byKey("user", "subject", "new").eligibility).toMatchObject({ eligible: false, reason: "subject-rejected" });
  expect(() => f.commands.admit("user", "subject", "new", {})).toThrow();
  expect(f.db.query("SELECT count(*) AS n FROM runs").get()).toEqual(count); expect(f.history(oldId)).toEqual(before);
}));

test("a user title clear creates dispatchable fresh work without reviving a fenced old weave", async () => fixture(f => {
  f.subject("subject"); const old = f.ops.admitWeave("user", { subjectId: "subject", triggerId: "capture:subject" });
  f.fence(old.id); const before = f.history(old.id);
  const titles = new TitleService(new SqliteTitleRepository(f.db, f.sources));
  expect(titles.setUser("user", "subject", null)).toEqual({ title: null, titleAuthor: null });
  const invited = f.db.query<{ id: string }, []>("SELECT id FROM runs WHERE weave_subject_id='subject' AND weave_trigger_id LIKE 'title-clear:%'").get();
  if (!invited) throw new Error("Missing user title-clear invitation");
  expect(invited.id).not.toBe(old.id); expect(weaveDispatchAllowed(f.db, invited.id)).toBe(true);
  expect(f.runs.claim(invited.id).runId).toBe(invited.id); expect(f.history(old.id)).toEqual(before);
}));

test("fenced queued runs do not occupy supervisor capacity ahead of fresh work", async () => fixture(async f => {
  for (let n = 0; n < 12; n++) {
    const subject = `old-${n}`; f.subject(subject);
    const run = f.ops.admitWeave("user", { subjectId: subject, triggerId: `capture:${subject}` }); f.fence(run.id);
  }
  f.subject("fresh"); const fresh = f.ops.admitWeave("user", { subjectId: "fresh", triggerId: "capture:fresh" });
  const seen: string[] = [];
  const supervisor = new RunSupervisor({ db: f.db, logger, startTimer: () => () => {}, worker: {
    async tick(runId) { seen.push(runId); }, pause() {},
  } });
  try { await supervisor.poll(); expect(seen).toEqual([fresh.id]); }
  finally { await supervisor.stop(); }
}));
