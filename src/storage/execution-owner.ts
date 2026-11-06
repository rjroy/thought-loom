import { Database, SQLiteError } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { RunFenceError } from "../domain/run";
import { createLogger, type Logger } from "../logging";
import { prepareExecutionDatabase, prepareExecutionSidecar, sameExecutionFile, type ExecutionOwnerPaths } from "./execution-owner-path";
import { immediate } from "./transaction";

declare const executionOwnerId: unique symbol;
declare const executionDatabaseIdentity: unique symbol;
export type ExecutionOwnerId = string & { readonly [executionOwnerId]: true };
export type ExecutionDatabaseIdentity = string & { readonly [executionDatabaseIdentity]: true };
interface OwnerRecord { readonly database_identity: string; readonly lease_protocol: string }

export const executionOwnerHeldDiagnostic = "Daemon startup failed: execution owner already held";
export class ExecutionOwnerHeldError extends Error {
  constructor() { super(executionOwnerHeldDiagnostic); }
}
export class ExecutionOwnerLostError extends RunFenceError {
  constructor() { super("Execution ownership is no longer held"); }
}
const reservations = new Set<string>();
const identityKey = (file: ExecutionOwnerPaths["database"]): string => `${file.dev}:${file.ino}`;
function contention(error: unknown): boolean {
  return error instanceof SQLiteError && typeof error.code === "string" && (error.code.startsWith("SQLITE_BUSY") || error.code.startsWith("SQLITE_LOCKED"));
}

/** Actual held resource capability. Registered identity is attribution, never a remote-drain proof. */
export class ExecutionOwnerLease {
  readonly databasePath: string;
  readonly databaseIdentity: ExecutionDatabaseIdentity;
  readonly leaseProtocol = "sqlite-sidecar-v1";
  readonly #id = randomUUID() as ExecutionOwnerId;
  get id(): ExecutionOwnerId { return this.#id; }
  private released = false;
  private poisoned = false;
  private constructor(private readonly sidecar: Database, private readonly paths: ExecutionOwnerPaths, private readonly logger: Logger) {
    this.databasePath = paths.databasePath;
    this.databaseIdentity = JSON.stringify({ path: paths.databasePath, dev: String(paths.database.dev), ino: String(paths.database.ino) }) as ExecutionDatabaseIdentity;
  }
  static async acquire(dbPath: string, logger: Logger = createLogger()): Promise<ExecutionOwnerLease> {
    logger.verbose("[execution owner] acquisition attempt");
    let database: Awaited<ReturnType<typeof prepareExecutionDatabase>>;
    try { database = await prepareExecutionDatabase(dbPath); }
    catch (error) {
      logger.warning("[execution owner] acquisition failed",{ reason: "unsupported-path" });
      throw error;
    }
    const key = identityKey(database.database);
    if (reservations.has(key)) {
      logger.warning("[execution owner] acquisition rejected",{ reason: "already-held" });
      throw new ExecutionOwnerHeldError();
    }
    reservations.add(key);
    let sidecar: Database | undefined;
    try {
      const paths = await prepareExecutionSidecar(database);
      sidecar = new Database(paths.sidecarPath,{ readwrite: true, create: false });
      sidecar.exec("PRAGMA busy_timeout=0");
      const mode = sidecar.query("PRAGMA journal_mode=DELETE").get() as { journal_mode: string };
      if (mode.journal_mode !== "delete") throw new Error("Rollback journal required for execution ownership");
      sidecar.exec("BEGIN EXCLUSIVE");
      const lease = new ExecutionOwnerLease(sidecar,paths,logger);
      lease.assertHeld();
      logger.info("[execution owner] acquired");
      return lease;
    } catch (error) {
      try { sidecar?.close(); }
      catch {
        logger.error("[execution owner] failed acquisition could not close its sidecar");
        throw new Error("Execution owner acquisition cleanup failed");
      }
      reservations.delete(key);
      const held = contention(error);
      logger.warning("[execution owner] acquisition failed",{ reason: held ? "already-held" : "unavailable" });
      if (held) throw new ExecutionOwnerHeldError();
      throw error;
    }
  }
  assertHeld(): void {
    if (this.released || this.poisoned) throw new ExecutionOwnerLostError();
    try {
      if (!this.sidecar.inTransaction || !sameExecutionFile(this.paths.databasePath,this.paths.database,false) ||
        !sameExecutionFile(this.paths.sidecarPath,this.paths.sidecar,true)) throw new ExecutionOwnerLostError();
    } catch {
      this.poisoned = true;
      this.logger.error("[execution owner] ownership lost");
      throw new ExecutionOwnerLostError();
    }
  }
  private assertDatabase(db: Database): void {
    this.assertHeld();
    try {
      const path = realpathSync(db.filename);
      if (path !== this.databasePath || !sameExecutionFile(path,this.paths.database,false)) {
        throw new ExecutionOwnerLostError();
      }
    } catch { throw new ExecutionOwnerLostError(); }
  }
  private registered(db: Database): boolean {
    const row = db.query("SELECT database_identity,lease_protocol FROM execution_owners WHERE id=?").get(this.id) as OwnerRecord | null;
    return row !== null && row.database_identity === this.databaseIdentity && row.lease_protocol === this.leaseProtocol;
  }
  /** Startup-only short transaction, before workers. A copied DB cannot register this capability against another file. */
  register(db: Database): void {
    this.logger.verbose("[execution owner] registration attempt");
    try {
      this.assertDatabase(db);
      immediate(db,() => {
        if (!this.registered(db)) db.run("INSERT INTO execution_owners(id,database_identity,lease_protocol) VALUES (?,?,?)",
          [this.id,this.databaseIdentity,this.leaseProtocol]);
        this.assertRegistered(db);
      });
      this.assertRegistered(db);
      this.logger.info("[execution owner] registered");
    } catch (error) {
      this.logger.warning("[execution owner] registration failed");
      throw error;
    }
  }
  /** Matching identity/protocol is required, not merely registry membership or a caller-supplied owner string. */
  assertRegistered(db: Database): void {
    this.assertDatabase(db);
    if (!this.registered(db)) throw new ExecutionOwnerLostError();
  }
  /** Close a resource only. The runtime must first join actual producers; this method certifies no drain or network absence. */
  release(): void {
    if (this.released) return;
    this.logger.verbose("[execution owner] release attempt");
    try {
      this.sidecar.close();
      this.released = true;
      reservations.delete(identityKey(this.paths.database));
      this.logger.info("[execution owner] released");
    } catch {
      this.poisoned = true;
      this.logger.error("[execution owner] release failed");
      throw new Error("Execution owner release failed");
    }
  }
}
