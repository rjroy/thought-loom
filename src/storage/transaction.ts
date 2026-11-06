import type { Database } from "bun:sqlite";

/** A failed deferred-FK COMMIT must not leave the connection in its failed transaction. */
export function immediate<T>(db: Database, action: () => T): T {
  const nested = db.inTransaction;
  try { return db.transaction(action).immediate(); }
  catch (error) {
    if (!nested && db.inTransaction) db.exec("ROLLBACK");
    throw error;
  }
}
