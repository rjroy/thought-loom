import type { Database } from "bun:sqlite";
import { exportDeletionReadySql, exportPurgeCompleteSql, exportPurgeSql, exportRestoreFenceSql, exportTerminalStatuses } from "./export-lifecycle-sql";
import { purgeRun as searchPurgeRunSql } from "./search-schema";

/** Subordinate artifact storage only. The authoritative core migration owns initialization and its transaction. */
export function migrateAgenticExports(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS export_intents (
      run_id TEXT PRIMARY KEY NOT NULL REFERENCES runs(id),
      request TEXT NOT NULL CHECK (length(trim(request))>0),
      effort TEXT NOT NULL DEFAULT 'standard' CHECK (effort IN ('quick','standard','thorough')),
      local_disposition TEXT NOT NULL DEFAULT 'retained' CHECK(local_disposition IN ('retained','local-stopped','deleting'))
    );
  `);
  if (!db.query<{name:string},[]>("PRAGMA table_info(export_intents)").all().some(column => column.name === "local_disposition")) {
    db.exec("ALTER TABLE export_intents ADD COLUMN local_disposition TEXT NOT NULL DEFAULT 'retained' CHECK(local_disposition IN ('retained','local-stopped','deleting'))");
  }
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS export_intents_kind BEFORE INSERT ON export_intents
    WHEN NOT EXISTS (SELECT 1 FROM runs WHERE id=NEW.run_id AND kind='export')
    BEGIN SELECT RAISE(ABORT,'export intent requires an export run'); END;
    CREATE TRIGGER IF NOT EXISTS export_intents_immutable_insert BEFORE INSERT ON export_intents
    WHEN EXISTS (SELECT 1 FROM export_intents WHERE run_id=NEW.run_id)
    BEGIN SELECT RAISE(ABORT,'export intent immutable'); END;
    CREATE TRIGGER IF NOT EXISTS export_intents_immutable_update BEFORE UPDATE ON export_intents
    BEGIN SELECT RAISE(ABORT,'export intent immutable'); END;
    CREATE TRIGGER IF NOT EXISTS export_intents_immutable_delete BEFORE DELETE ON export_intents
    BEGIN SELECT RAISE(ABORT,'export intent immutable'); END;
    CREATE TABLE IF NOT EXISTS export_reports (
      run_id TEXT PRIMARY KEY NOT NULL REFERENCES export_intents(run_id),
      prompt_id TEXT NOT NULL, markdown TEXT NOT NULL CHECK (length(trim(markdown))>0), sources_json TEXT NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS export_reports_step_identity BEFORE INSERT ON export_reports
    WHEN NOT EXISTS (SELECT 1 FROM run_steps WHERE run_id=NEW.run_id AND prompt_id=NEW.prompt_id
      AND state='completed' AND json_extract(envelope_json,'$.kind')='report')
    BEGIN SELECT RAISE(ABORT,'export report requires its completed report step'); END;
    CREATE TRIGGER IF NOT EXISTS export_reports_immutable_insert BEFORE INSERT ON export_reports
    WHEN EXISTS (SELECT 1 FROM export_reports WHERE run_id=NEW.run_id)
    BEGIN SELECT RAISE(ABORT,'export report immutable'); END;
    CREATE TRIGGER IF NOT EXISTS export_reports_immutable_update BEFORE UPDATE ON export_reports
    BEGIN SELECT RAISE(ABORT,'export report immutable'); END;
    CREATE TRIGGER IF NOT EXISTS export_reports_immutable_delete BEFORE DELETE ON export_reports
    BEGIN SELECT RAISE(ABORT,'export report immutable'); END;
  `);
}

/** Install only after all schema foundations: predecessor rebuilds and search must not overwrite these guards. */
export function migrateExportLifecycle(db: Database): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS runs_export_history ON runs(created_at DESC,id DESC) WHERE kind='export';
    DROP TRIGGER IF EXISTS export_intents_immutable_update;
    CREATE TRIGGER export_intents_immutable_update BEFORE UPDATE OF rowid,_rowid_,oid,run_id,request,effort ON export_intents
    BEGIN SELECT RAISE(ABORT,'export intent immutable'); END;
    CREATE TRIGGER IF NOT EXISTS export_intents_retained_insert BEFORE INSERT ON export_intents
    WHEN NEW.local_disposition!='retained'
    BEGIN SELECT RAISE(ABORT,'new export must be retained'); END;
    CREATE TRIGGER IF NOT EXISTS export_intents_disposition BEFORE UPDATE OF local_disposition ON export_intents
    WHEN NOT EXISTS(SELECT 1 FROM runs r WHERE r.id=OLD.run_id AND r.kind='export' AND r.status IN (${exportTerminalStatuses}) AND
      ((OLD.local_disposition='retained' AND NEW.local_disposition='local-stopped' AND ${exportRestoreFenceSql("r.id")})
       OR (OLD.local_disposition IN ('retained','local-stopped') AND NEW.local_disposition='deleting' AND ${exportDeletionReadySql("r","OLD")})))
    BEGIN SELECT RAISE(ABORT,'export disposition requires stopped ownership'); END;
    DROP TRIGGER IF EXISTS export_intents_immutable_delete;
    CREATE TRIGGER export_intents_immutable_delete BEFORE DELETE ON export_intents WHEN NOT ${exportPurgeCompleteSql("OLD.run_id")}
    BEGIN SELECT RAISE(ABORT,'export intent immutable'); END;
    DROP TRIGGER IF EXISTS export_reports_immutable_delete;
    CREATE TRIGGER export_reports_immutable_delete BEFORE DELETE ON export_reports WHEN NOT ${exportPurgeSql("OLD.run_id")}
    BEGIN SELECT RAISE(ABORT,'export report immutable'); END;
    CREATE TRIGGER IF NOT EXISTS export_replies_immutable_delete BEFORE DELETE ON run_replies
    WHEN EXISTS(SELECT 1 FROM runs WHERE id=OLD.run_id AND kind='export') AND NOT ${exportPurgeSql("OLD.run_id")}
    BEGIN SELECT RAISE(ABORT,'export reply immutable'); END;
  `);
  for (const [name,table,message] of [
    ["run_steps_immutable_delete","run_steps","step immutable"],
    ["run_context_immutable_delete","run_context","exposed context immutable"],
    ["agent_bindings_immutable_delete","agent_bindings","agent binding immutable"],
    ["run_receipts_immutable_delete","run_operation_receipts","receipt immutable"],
    ["run_issued_immutable_delete","run_issued_thoughts","issued membership immutable"],
  ]) db.exec(`DROP TRIGGER IF EXISTS ${name};
    CREATE TRIGGER ${name} BEFORE DELETE ON ${table}
    WHEN NOT (${searchPurgeRunSql("OLD.run_id")} OR ${exportPurgeSql("OLD.run_id")})
    BEGIN SELECT RAISE(ABORT,'${message}'); END;`);
  db.exec(`DROP TRIGGER IF EXISTS runs_immutable_delete;
    CREATE TRIGGER runs_immutable_delete BEFORE DELETE ON runs BEGIN
      SELECT CASE WHEN NOT (${searchPurgeRunSql("OLD.id")} OR ${exportPurgeCompleteSql("OLD.id")}) THEN RAISE(ABORT,'run immutable') END;
      DELETE FROM export_intents WHERE run_id=OLD.id AND OLD.kind='export';
    END;`);
}
