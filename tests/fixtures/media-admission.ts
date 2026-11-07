import { expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { RunRecord, RunSources } from "../../src/domain/run";
import { createLogger } from "../../src/logging";
import { SqliteMediaAdmissions } from "../../src/storage/media-admission";
import type { MediaSourceWrite } from "../../src/storage/media-source";
import { insertRun } from "../../src/storage/run-record";
import { migrate, SqliteStore } from "../../src/storage/sqlite";
import { mediaDigest, mediaStoreId, mediaThought, mediaTime } from "./media-source";

export function mediaAdmissionInput(index = 0): MediaSourceWrite {
  return { requestKey: `media-upload-${index}`, sha256: new Uint8Array(mediaDigest), thought: {
    ...mediaThought, id: index === 0 ? mediaThought.id : `media-admission-root-${index}`,
    mediaSource: { ...mediaThought.mediaSource, id: index === 0 ? mediaThought.mediaSource.id :
      `00000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}` },
  } };
}

export function requireMediaAttemptSchema(db: Database): void {
  const names = db.query<{ name: string }, []>("SELECT name FROM sqlite_schema WHERE type='table'").all().map(row => row.name);
  // A desired migration assertion precedes every query/fixture insert into the new journal.
  expect(names).toContain("media_weave_attempts");
  expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
}

export interface InitialMediaAttempt {
  readonly source_id: string;
  readonly position: number;
  readonly run_id: string;
  readonly request_key: string;
  readonly open_slot: number;
  readonly interpretation_thought_id: string | null;
}
export function mediaAttempts(db: Database): readonly InitialMediaAttempt[] {
  return db.query<InitialMediaAttempt, []>(`SELECT source_id,position,run_id,request_key,open_slot,interpretation_thought_id
    FROM media_weave_attempts ORDER BY source_id,position`).all();
}

const admissionTables = ["media_sources", "thoughts", "thought_titles", "thought_source_seals", "thought_sources", "runs",
  "run_steps", "media_weave_attempts", "run_context", "run_operation_receipts", "run_issued_thoughts", "run_replies", "agent_bindings"];
export function mediaAdmissionSnapshot(db: Database) {
  return admissionTables.map(table => ({ table, rows: table === "media_weave_attempts"
    ? db.query("SELECT * FROM media_weave_attempts ORDER BY source_id,position").all()
    : db.query(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all() }));
}

export async function mediaAdmissionFixture(action: (fixture: {
  db: Database; other: Database; path: string; store: SqliteStore; sources: RunSources;
  admissions: SqliteMediaAdmissions; second: SqliteMediaAdmissions;
}) => void | Promise<void>): Promise<void> {
  const directory = mkdtempSync(join("/tmp/opencode", "media-admission-")), path = join(directory, "owned.sqlite");
  const db = new Database(path), other = new Database(path);
  let sequence = 0;
  const sources: RunSources = { id: () => `media-admission-${++sequence}`, now: () => mediaTime, logger: createLogger("verbose", () => {}) };
  try {
    migrate(db, sources.logger); migrate(other, sources.logger);
    const store = new SqliteStore(db, sources);
    store.initializeMediaStore(mediaStoreId);
    await action({ db, other, path, store, sources, admissions: new SqliteMediaAdmissions(db, sources), second: new SqliteMediaAdmissions(other, sources) });
  } finally { other.close(); db.close(); rmSync(directory, { recursive: true, force: true }); }
}

/** Canonical run/initial-step insertion, deliberately independent of new admission's business guards. */
export function insertMediaAttemptRun(db: Database, id: string, subjectId: string, sourceId: string,
  position = 0, triggerId = `media:${sourceId}:${position}`, kind: "weave" | "export" = "weave"): RunRecord {
  const run: RunRecord = { id, kind, status: "queued", sessionId: `${id}-session`, promptId: `${id}-prompt`,
    createdAt: mediaTime, generation: 0, inputThoughtId: null, nativeState: "unknown" };
  insertRun(db, run, kind === "weave" ? { subjectId, triggerId } : null);
  return run;
}
