import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { RunWorker, type WorkerNative } from "../src/agent/worker";
import type { PersistedPrompt } from "../src/agent/opencode-adapter";
import { RunFenceError, RunForbiddenError } from "../src/domain/run";
import { SqliteMediaAdmissions } from "../src/storage/media-admission";
import type { MediaSourceWrite } from "../src/storage/media-source";
import { SqliteRunOperations } from "../src/storage/run-operations";
import { SqliteRunProtocolRepository } from "../src/storage/run-protocol";
import { SqliteRunRepository } from "../src/storage/run";
import { migrate, SqliteStore } from "../src/storage/sqlite";
import { immediate } from "../src/storage/transaction";
import { insertMediaAttemptRun, mediaAdmissionFixture, mediaAdmissionInput, mediaAdmissionSnapshot, mediaAttempts,
  requireMediaAttemptSchema } from "./fixtures/media-admission";
import { mediaTime } from "./fixtures/media-source";

describe("atomic initial media attempt admission", () => {
  test("core migration adds an empty media attempt journal without late backfill", async () => mediaAdmissionFixture(f => {
    const metadata = mediaAdmissionInput();
    f.store.saveMediaSource(metadata);
    const before = f.store.getThought(metadata.thought.id);
    migrate(f.db, f.sources.logger);
    requireMediaAttemptSchema(f.db);
    expect(mediaAttempts(f.db)).toEqual([]);
    expect(f.store.getThought(metadata.thought.id)).toEqual(before);
    expect(f.db.query("SELECT id FROM runs").all()).toEqual([]);
    expect(f.db.query("SELECT prompt_id FROM run_steps").all()).toEqual([]);
    expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  }));

  test("initial media admission atomically retains its source root and ordinary weave attempt", async () => mediaAdmissionFixture(f => {
    requireMediaAttemptSchema(f.db);
    const input = mediaAdmissionInput(), admission = f.admissions.admit("user", input);
    expect(admission.replayed).toBe(false);
    expect(admission.thought).toEqual(input.thought);
    expect(f.store.getThought(input.thought.id)).toEqual(input.thought);
    expect(admission.run).toMatchObject({ kind: "weave", status: "queued", generation: 0, inputThoughtId: null, nativeState: "unknown", createdAt: mediaTime });
    expect(new SqliteRunRepository(f.db, f.sources).get(admission.run.id)).toEqual(admission.run);
    expect(new SqliteRunOperations(f.db, f.sources).weaveIntent(admission.run.id)).toEqual({
      subjectId: input.thought.id, triggerId: `media:${input.thought.mediaSource.id}:0`,
    });
    expect(new SqliteRunProtocolRepository(f.db).steps(admission.run.id)).toEqual([{
      runId: admission.run.id, position: 0, promptId: admission.run.promptId, input: null, state: "prepared", envelope: null, result: null,
    }]);
    const attempt = mediaAttempts(f.db)[0];
    expect(attempt).toBeDefined();
    if (!attempt) throw new Error("Expected the associated initial attempt");
    expect(attempt).toMatchObject({ source_id: input.thought.mediaSource.id, position: 0, run_id: admission.run.id, open_slot: 1, interpretation_thought_id: null });
    expect(attempt.request_key.trim().length).toBeGreaterThan(0);
    expect(attempt.request_key).not.toBe(input.requestKey); // Reserved internal initial identity, not an upload/retry key supplied by the user.
    expect(mediaAttempts(f.db)).toHaveLength(1);
    expect(f.db.query("SELECT request_key,sha256 FROM media_sources").all()).toEqual([{ request_key: input.requestKey, sha256: input.sha256 }]);
    expect(f.db.query("SELECT thought_id,title,title_author FROM thought_titles").all()).toEqual([{ thought_id: input.thought.id, title: null, title_author: null }]);
    expect(f.db.query("SELECT thought_id FROM thought_source_seals").all()).toEqual([{ thought_id: input.thought.id }]);
    expect(f.db.query("SELECT * FROM thought_sources").all()).toEqual([]);
    for (const table of ["agent_bindings", "run_context", "run_operation_receipts", "run_issued_thoughts"]) expect(f.db.query(`SELECT * FROM ${table}`).all()).toEqual([]);
    expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  }));

  test.each(["initial step", "attempt association"] as const)("failure after the %s insert rolls back the entire new admission", async phase => mediaAdmissionFixture(f => {
    requireMediaAttemptSchema(f.db);
    f.store.saveMediaSource(mediaAdmissionInput(9));
    const before = mediaAdmissionSnapshot(f.db), input = mediaAdmissionInput();
    if (phase === "initial step") f.db.exec(`CREATE TRIGGER fixture_media_step_failure AFTER INSERT ON run_steps
      WHEN EXISTS(SELECT 1 FROM runs r JOIN media_sources m ON m.source_thought_id=r.weave_subject_id
        WHERE r.id=NEW.run_id AND m.request_key='media-upload-0')
      BEGIN SELECT RAISE(ABORT,'injected after media initial step'); END;`);
    else f.db.exec(`CREATE TRIGGER fixture_media_association_failure AFTER INSERT ON media_weave_attempts
      WHEN EXISTS(SELECT 1 FROM media_sources m JOIN thoughts t ON t.id=m.source_thought_id
        JOIN thought_titles title ON title.thought_id=t.id JOIN thought_source_seals seal ON seal.thought_id=t.id
        JOIN runs r ON r.id=NEW.run_id AND r.weave_subject_id=t.id JOIN run_steps s ON s.run_id=r.id AND s.position=0
        WHERE m.id=NEW.source_id AND m.request_key='media-upload-0' AND s.prompt_id=r.prompt_id)
      BEGIN SELECT RAISE(ABORT,'injected after complete media association'); END;`);
    expect(() => f.admissions.admit("user", input)).toThrow(phase === "initial step" ? "injected after media initial step" : "injected after complete media association");
    expect(f.db.inTransaction).toBe(false);
    expect(mediaAdmissionSnapshot(f.db)).toEqual(before);
    expect(f.store.getThought(input.thought.id)).toBeNull();
    expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    f.db.exec(`DROP TRIGGER ${phase === "initial step" ? "fixture_media_step_failure" : "fixture_media_association_failure"}`);
    expect(f.admissions.admit("user", input).replayed).toBe(false);
    expect(mediaAttempts(f.db)).toHaveLength(1);
  }));

  test.each(["same key", "different key"] as const)("metadata-only persistence cannot acquire an initial attempt later through %s admission", async mode => mediaAdmissionFixture(f => {
    requireMediaAttemptSchema(f.db);
    const input = mediaAdmissionInput();
    f.store.saveMediaSource(input);
    const before = mediaAdmissionSnapshot(f.db);
    expect(() => f.admissions.admit("user", { ...input, requestKey: mode === "same key" ? input.requestKey : "late-media-upload" })).toThrow();
    expect(mediaAdmissionSnapshot(f.db)).toEqual(before);
    expect(mediaAttempts(f.db)).toEqual([]);
  }));

  test("same-key replay from another connection returns the original source and run despite newly allocated daemon identities", async () => mediaAdmissionFixture(f => {
    requireMediaAttemptSchema(f.db);
    const input = mediaAdmissionInput(), first = f.admissions.admit("user", input), before = mediaAdmissionSnapshot(f.db);
    const fresh = mediaAdmissionInput(1);
    const replay = f.second.admit("user", { ...fresh, requestKey: input.requestKey, thought: { ...fresh.thought, createdAt: "2031-02-03T04:05:06.000Z" } });
    expect(replay).toEqual({ thought: first.thought, run: first.run, replayed: true });
    expect(mediaAdmissionSnapshot(f.db)).toEqual(before);
    expect(f.store.getThought(fresh.thought.id)).toBeNull();
  }));

  const conflicts: readonly { name: string; change: (input: MediaSourceWrite) => MediaSourceWrite }[] = [
    { name: "digest", change: input => ({ ...input, sha256: input.sha256.map((byte, index) => index === 0 ? byte ^ 255 : byte) }) },
    { name: "filename", change: input => ({ ...input, thought: { ...input.thought, mediaSource: { ...input.thought.mediaSource, name: "different.png" } } }) },
    { name: "MIME", change: input => ({ ...input, thought: { ...input.thought, mediaSource: { ...input.thought.mediaSource, mimeType: "image/jpeg" } } }) },
    { name: "length", change: input => ({ ...input, thought: { ...input.thought, mediaSource: { ...input.thought.mediaSource, byteLength: input.thought.mediaSource.byteLength + 1 } } }) },
    { name: "exact clarification", change: input => ({ ...input, thought: { ...input.thought, mediaSource: { ...input.thought.mediaSource, clarification: "Different instructions", clarificationAuthor: "user" } } }) },
  ];
  for (const { name, change } of conflicts) test(`same-key conflicting ${name} cannot change or duplicate the admission`, async () => mediaAdmissionFixture(f => {
    requireMediaAttemptSchema(f.db);
    const input = mediaAdmissionInput();
    f.admissions.admit("user", input);
    const before = mediaAdmissionSnapshot(f.db), fresh = mediaAdmissionInput(1);
    expect(() => f.second.admit("user", change({ ...fresh, requestKey: input.requestKey }))).toThrow();
    expect(mediaAdmissionSnapshot(f.db)).toEqual(before);
  }));

  test("different upload keys retain equal bytes independently and give each source one active slot", async () => mediaAdmissionFixture(f => {
    requireMediaAttemptSchema(f.db);
    const first = f.admissions.admit("user", mediaAdmissionInput()), second = f.second.admit("user", mediaAdmissionInput(1));
    expect(first.thought.mediaSource.id).not.toBe(second.thought.mediaSource.id);
    expect(first.run.id).not.toBe(second.run.id);
    expect(mediaAttempts(f.db).map(attempt => ({ source: attempt.source_id, position: attempt.position, open: attempt.open_slot }))).toEqual([
      { source: first.thought.mediaSource.id, position: 0, open: 1 }, { source: second.thought.mediaSource.id, position: 0, open: 1 },
    ]);
    const indexes = f.db.query<{ name: string; unique: number; partial: number }, []>("PRAGMA index_list(media_weave_attempts)").all();
    const sourceSlots = indexes.filter(index => index.unique === 1 && index.partial === 1).filter(index => {
      const name = index.name.replaceAll('"', '""');
      return f.db.query<{ name: string }, []>(`PRAGMA index_info("${name}")`).all().map(column => column.name).join(",") === "source_id";
    });
    const openSlotIndex = sourceSlots.find(index => {
      const row = f.db.query<{ sql: string }, [string]>("SELECT sql FROM sqlite_schema WHERE type='index' AND name=?").get(index.name);
      return row !== null && /WHERE\s+\(?\s*open_slot\s*=\s*1\s*\)?\s*$/i.test(row.sql);
    });
    expect(openSlotIndex).toBeDefined(); // Verify the required partial uniqueness without inventing retry clearance to create position one.
  }));

  test.each(["wrong subject", "title-clear trigger", "non-weave run", "position gap"] as const)("SQL rejects an initial attempt with %s and rolls back its source/run graph", async mismatch => mediaAdmissionFixture(f => {
    requireMediaAttemptSchema(f.db);
    const seed = f.admissions.admit("user", mediaAdmissionInput()), knownInitial = mediaAttempts(f.db)[0];
    if (!knownInitial) throw new Error("Expected a valid internal initial attempt key");
    const input = mediaAdmissionInput(1), before = mediaAdmissionSnapshot(f.db);
    expect(() => immediate(f.db, () => {
      f.store.saveMediaSource(input);
      const position = mismatch === "position gap" ? 2 : 0;
      const run = insertMediaAttemptRun(f.db, "invalid-attempt-run", mismatch === "wrong subject" ? seed.thought.id : input.thought.id,
        input.thought.mediaSource.id, position, mismatch === "title-clear trigger" ? "title-clear:fixture" : `media:${input.thought.mediaSource.id}:${position}`,
        mismatch === "non-weave run" ? "export" : "weave");
      f.db.run("INSERT INTO media_weave_attempts(source_id,position,run_id,request_key) VALUES (?,?,?,?)",
        [input.thought.mediaSource.id, position, run.id, knownInitial.request_key]);
    })).toThrow();
    expect(mediaAdmissionSnapshot(f.db)).toEqual(before);
    expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  }));

  test("SQL accepts a matching attempt in the same source-first transaction", async () => mediaAdmissionFixture(f => {
    requireMediaAttemptSchema(f.db);
    f.admissions.admit("user", mediaAdmissionInput());
    const knownInitial = mediaAttempts(f.db)[0];
    if (!knownInitial) throw new Error("Expected a valid internal initial attempt key");
    const input = mediaAdmissionInput(1);
    const run = immediate(f.db, () => {
      f.store.saveMediaSource(input);
      const created = insertMediaAttemptRun(f.db, "matching-attempt-run", input.thought.id, input.thought.mediaSource.id);
      f.db.run("INSERT INTO media_weave_attempts(source_id,position,run_id,request_key) VALUES (?,0,?,?)",
        [input.thought.mediaSource.id, created.id, knownInitial.request_key]);
      return created;
    });
    expect(f.store.getThought(input.thought.id)).toEqual(input.thought);
    expect(mediaAttempts(f.db)).toContainEqual({ source_id: input.thought.mediaSource.id, position: 0,
      run_id: run.id, request_key: knownInitial.request_key, open_slot: 1, interpretation_thought_id: null });
    expect(new SqliteRunProtocolRepository(f.db).steps(run.id)).toHaveLength(1);
    expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  }));

  test("initial attempt identity cannot be rewritten, deleted or replaced", async () => mediaAdmissionFixture(f => {
    requireMediaAttemptSchema(f.db);
    f.admissions.admit("user", mediaAdmissionInput());
    const spare = mediaAdmissionInput(1);
    f.store.saveMediaSource(spare);
    f.store.saveThought({ id: "identity-text-root", text: "A separate ordinary run subject", author: "user", kind: "captured-original",
      title: null, titleAuthor: null, parentId: null, sourceIds: [], createdAt: mediaTime, origin: "fixture" });
    const ordinary = new SqliteRunOperations(f.db, f.sources).admitWeave("user", { subjectId: "identity-text-root", triggerId: "identity-spare-run" });
    const before = mediaAdmissionSnapshot(f.db);
    // These replacements have valid, unoccupied FKs, so FK/uniqueness failures cannot stand in for identity protection.
    const replacements: readonly (readonly [string, string])[] = [
      ["UPDATE media_weave_attempts SET source_id=?", spare.thought.mediaSource.id],
      ["UPDATE media_weave_attempts SET run_id=?", ordinary.id],
    ];
    for (const [sql, value] of replacements) expect(() => f.db.query(sql).run(value)).toThrow();
    for (const sql of ["UPDATE media_weave_attempts SET position=1", "UPDATE media_weave_attempts SET request_key='different-key'",
      "DELETE FROM media_weave_attempts", "INSERT OR REPLACE INTO media_weave_attempts SELECT * FROM media_weave_attempts"]) expect(() => f.db.exec(sql)).toThrow();
    expect(mediaAdmissionSnapshot(f.db)).toEqual(before);
  }));

  test("initial source/run/attempt identity survives repeated migration and reopen without late admission", async () => mediaAdmissionFixture(f => {
    requireMediaAttemptSchema(f.db);
    f.store.saveMediaSource(mediaAdmissionInput(9));
    const input = mediaAdmissionInput(), first = f.admissions.admit("user", input), before = mediaAdmissionSnapshot(f.db);
    const reopened = new Database(f.path);
    try {
      migrate(reopened, f.sources.logger); migrate(reopened, f.sources.logger);
      expect(mediaAdmissionSnapshot(reopened)).toEqual(before);
      expect(new SqliteStore(reopened).getThought(first.thought.id)).toEqual(first.thought);
      expect(new SqliteMediaAdmissions(reopened, f.sources).admit("user", input)).toEqual({ ...first, replayed: true });
      expect(mediaAdmissionSnapshot(reopened)).toEqual(before);
      expect(reopened.query("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(reopened.query("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
    } finally { reopened.close(); }
  }));

  test("AI cannot invoke user source admission", async () => mediaAdmissionFixture(f => {
    requireMediaAttemptSchema(f.db);
    const before = mediaAdmissionSnapshot(f.db);
    expect(() => f.admissions.admit("ai", mediaAdmissionInput())).toThrow(RunForbiddenError);
    expect(mediaAdmissionSnapshot(f.db)).toEqual(before);
  }));

  test("an admitted initial attempt cannot dispatch a metadata-only prompt without media delivery authority", async () => mediaAdmissionFixture(async f => {
    requireMediaAttemptSchema(f.db);
    const admission = f.admissions.admit("user", mediaAdmissionInput()), received: PersistedPrompt[] = [];
    const worker = new RunWorker({ db: f.db, ...f.sources,
      bindingFor: run => ({ sessionId: run.sessionId, serviceUrl: "https://media-admission.example.invalid",
        location: { directory: "/tmp/opencode/media-admission-owned-binding" }, model: { providerID: "fixture", id: "media-admission" },
        permissions: [{ action: "*", resource: "*", effect: "deny" }], protocolVersion: 1 }),
      native: () => {
        const native: WorkerNative = {
          ensureSession: async () => {},
          submit: async (_claim, _binding, prompt) => { received.push({ ...prompt }); },
          observe: async (_claim, _binding, prompts) => { received.push(...prompts); return { state: "running" }; },
          cancel: async (_runId, _binding, prompt) => { received.push({ ...prompt }); return "settled"; },
        };
        return native;
      },
    });
    try {
      for (let tick = 0; tick < 6 && received.length === 0; tick++) {
        try { await worker.tick(admission.run.id); }
        catch (error) { expect(error instanceof RunForbiddenError || error instanceof RunFenceError).toBe(true); }
      }
      expect(received).toEqual([]);
      expect(new SqliteRunProtocolRepository(f.db).steps(admission.run.id)[0]?.input).toBeNull();
    } finally { worker.pause(); await worker.drain(); }
  }));
});
