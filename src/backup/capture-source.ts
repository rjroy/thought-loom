import { Database } from "bun:sqlite";
import { validateSourceSchema } from "./schema";
import { check, type Guard } from "./capture-files";
import { readSqlSnapshot, type SqlSnapshot } from "./records";
export { table, text, bytes, integer, validateBytes, type SqlSnapshot, type CapturedTable } from "./records";

/** The callback is the supervisor's bounded source-ready handshake, not a model/application callback. */
export async function readSource(databasePath: string, guard: Guard, ready: () => Promise<void>): Promise<SqlSnapshot> {
  guard(); const db = new Database(databasePath, { readonly: true, create: false, safeIntegers: true, strict: true });
  try {
    guard(); db.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA read_uncommitted=OFF; PRAGMA busy_timeout=1000;");
    check(db.query<{ journal_mode: string }, []>("PRAGMA main.journal_mode").get()?.journal_mode === "wal", "wal-required");
    db.exec("BEGIN"); db.query("SELECT count(*) FROM main.sqlite_schema").get();
    const inventory = validateSourceSchema(db);
    await ready(); const snapshot = readSqlSnapshot(db,guard,inventory);
    guard(); db.exec("COMMIT"); return snapshot;
  } finally { try { if (db.inTransaction) db.exec("ROLLBACK"); } finally { db.close(true); } }
}
