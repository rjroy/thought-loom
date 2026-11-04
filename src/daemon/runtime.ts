import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { CreationService } from "../domain/creation";
import { RejectionService } from "../domain/rejection";
import { SearchService } from "../domain/search";
import { SimpleExportService } from "../domain/simple-export";
import { TitleService } from "../domain/title";
import { SqliteRejectionRepository } from "../storage/rejection";
import { SqliteSearchRepository } from "../storage/search";
import { SqliteTitleRepository } from "../storage/title";
import { migrate, SqliteStore } from "../storage/sqlite";
import { createApp, type BoundaryEvent } from "./app";
import { validateConfig, type DaemonConfig } from "./config";
import type { AgentConfig } from "./agent-config";
import type { PublicClient, ResolvedAgentService } from "../agent/opencode-adapter";
import { createPublicClient, resolveAgentService } from "../agent/opencode-adapter";
import { ConfiguredRunWorker } from "../agent/configured-worker";
import { RunSupervisor } from "../agent/supervisor";
import { AgentService } from "../domain/agent";
import { SqliteAgentRuns } from "../storage/agent";
import { ConfigError } from "./config-error";

/** Optional test-owned transport and technical timer seams; default runtime uses the maintained SDK. */
export interface RuntimeDependencies {
  readonly resolveAgentService?: (config: AgentConfig) => Promise<ResolvedAgentService>;
  readonly createPublicClient?: (service: ResolvedAgentService) => PublicClient;
  readonly startTimer?: (poll: () => void) => () => void;
}

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
export async function startDaemon(config: DaemonConfig, logger: (event: DaemonEvent) => void, dependencies: RuntimeDependencies = {}): Promise<RunningDaemon> {
  logger({ phase: "attempt", operation: "start" });
  let db: Database | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let supervisor: RunSupervisor | undefined;
  async function close(force: boolean): Promise<boolean> {
    let failed = false;
    const pending: Promise<unknown>[] = [];
    // Pause the worker synchronously before awaiting either drain; a late native callback cannot advance local work.
    try { if (supervisor) pending.push(supervisor.stop()); } catch { failed = true; }
    try { if (server) pending.push(Promise.resolve(server.stop(force))); } catch { failed = true; }
    const results = await Promise.allSettled(pending);
    if (results.some(result => result.status === "rejected")) failed = true;
    try { db?.close(); } catch { failed = true; }
    return failed;
  }
  try {
    const valid = validateConfig(config);
    await mkdir(dirname(valid.dbPath), { recursive: true });
    db = new Database(valid.dbPath, { create: true });
    migrate(db);
    const scheduling = { id: randomUUID, now: () => new Date().toISOString(),
      // Public SDK schemas require these prefixes. Existing persisted identities are never rewritten.
      sessionId: () => `ses_${randomUUID()}`, promptId: () => `msg_${randomUUID()}` };
    const store = new SqliteStore(db, scheduling);
    const rejection = new RejectionService(new SqliteRejectionRepository(db));
    const creation = new CreationService({ rejection, id: randomUUID, now: () => new Date().toISOString(), writes: {
      createThought: thought => store.saveThought(thought), createConnection: connection => store.saveConnection(connection),
    } });
    const titles = new TitleService(new SqliteTitleRepository(db, scheduling));
    const search = new SearchService(new SqliteSearchRepository(db));
    const simpleExport = new SimpleExportService(rejection);
    const agents = new AgentService(new SqliteAgentRuns(db,scheduling),valid.agent != null);
    if (valid.agent) {
      const worker = new ConfiguredRunWorker({db,...scheduling,config:valid.agent,
        resolve:dependencies.resolveAgentService ?? resolveAgentService,client:dependencies.createPublicClient ?? createPublicClient});
      supervisor = new RunSupervisor({db,worker,startTimer:dependencies.startTimer ?? (poll => {
        // Technical polling cadence only, never a model turn/time/token budget.
        const timer = setInterval(poll,250);
        return () => clearInterval(timer);
      })});
    }
    const app = createApp({ rejection, creation, titles, search, simpleExport, agents, credentials: valid.credentials, logger });
    server = Bun.serve({ hostname: "127.0.0.1", port: valid.port, fetch: app.fetch });
    supervisor?.start();
    const url = server.url.toString();
    let stopping: Promise<void> | undefined;
    logger({ phase: "outcome", operation: "start", success: true, url });
    return {
      url,
      stop() {
        if (!stopping) stopping = (async () => {
          let failed = false;
          try { logger({ phase: "attempt", operation: "stop" }); } catch { failed = true; }
          if (await close(false)) failed = true;
          if (failed) {
            try { logger({ phase: "outcome", operation: "stop", success: false }); } catch { /* Resources were still cleaned up. */ }
            throw new Error("Daemon shutdown failed");
          }
          try { logger({ phase: "outcome", operation: "stop", success: true }); }
          catch { throw new Error("Daemon shutdown failed"); }
        })();
        return stopping;
      },
    };
  } catch (error) {
    await close(true);
    try { logger({ phase: "outcome", operation: "start", success: false }); } catch { /* Do not expose logger failures. */ }
    if (error instanceof ConfigError) throw error;
    throw new Error("Daemon startup failed");
  }
}
