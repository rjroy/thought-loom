import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { RunSources } from "../../src/domain/run";
import { createLogger } from "../../src/logging";
import { SqliteMediaAdmissions } from "../../src/storage/media-admission";
import type { MediaSourceWrite } from "../../src/storage/media-source";
import { migrate, SqliteStore } from "../../src/storage/sqlite";
import { mediaDigest, mediaStoreId, mediaThought, mediaTime } from "./media-source";

export function mediaAdmissionInput(index = 0): MediaSourceWrite {
  return { requestKey: `media-upload-${index}`, sha256: new Uint8Array(mediaDigest), thought: {
    ...mediaThought, id: index === 0 ? mediaThought.id : `media-admission-root-${index}`,
    mediaSource: { ...mediaThought.mediaSource, id: index === 0 ? mediaThought.mediaSource.id :
      `00000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}` },
  } };
}

const admissionTables = ["media_sources", "thoughts", "thought_titles", "thought_source_seals", "thought_sources", "runs",
  "run_steps", "run_context", "run_operation_receipts", "run_issued_thoughts", "run_replies", "agent_bindings"];
export function mediaAdmissionSnapshot(db: Database) {
  return admissionTables.map(table => ({ table, rows: db.query(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all() }));
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
