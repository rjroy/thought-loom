import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { RejectionService } from "../domain/rejection";
import { SqliteRejectionRepository } from "../storage/rejection";
import { migrate, SqliteStore } from "../storage/sqlite";
import { createApp, type BoundaryEvent } from "./app";
import { validateConfig, type DaemonConfig } from "./config";

export interface LifecycleEvent {
  readonly phase: "attempt" | "outcome";
  readonly operation: "start" | "stop";
  readonly success?: boolean;
  readonly url?: string;
}
export type DaemonEvent = BoundaryEvent | LifecycleEvent;
export interface RunningDaemon {
  readonly url: string;
  stop(): Promise<void>;
}

/** Start a loopback-only daemon and own its listener and database. */
export async function startDaemon(config: DaemonConfig, logger: (event: DaemonEvent) => void): Promise<RunningDaemon> {
  logger({ phase: "attempt", operation: "start" });
  let db: Database | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    const valid = validateConfig(config);
    await mkdir(dirname(valid.dbPath), { recursive: true });
    db = new Database(valid.dbPath, { create: true });
    migrate(db);
    const store = new SqliteStore(db);
    const rejection = new RejectionService(new SqliteRejectionRepository(db));
    const app = createApp({ rejection, credentials: valid.credentials, logger, writes: {
      createThought: thought => store.saveThought(thought),
      createConnection: connection => store.saveConnection(connection),
    } });
    server = Bun.serve({ hostname: "127.0.0.1", port: valid.port, fetch: app.fetch });
    const url = server.url.toString();
    const runningServer = server;
    const runningDb = db;
    let stopping: Promise<void> | undefined;
    logger({ phase: "outcome", operation: "start", success: true, url });
    return {
      url,
      stop() {
        if (!stopping) stopping = (async () => {
          logger({ phase: "attempt", operation: "stop" });
          let failed = false;
          try {
            await runningServer.stop();
          } catch {
            failed = true;
          } finally {
            try { runningDb.close(); } catch { failed = true; }
          }
          if (failed) {
            logger({ phase: "outcome", operation: "stop", success: false });
            throw new Error("Daemon shutdown failed");
          }
          logger({ phase: "outcome", operation: "stop", success: true });
        })();
        return stopping;
      },
    };
  } catch (error) {
    try {
      if (server) await server.stop(true);
    } finally {
      try { db?.close(); }
      finally { logger({ phase: "outcome", operation: "start", success: false }); }
    }
    throw error;
  }
}
