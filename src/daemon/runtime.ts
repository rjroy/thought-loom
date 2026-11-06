import { Database } from "bun:sqlite";
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
import { RunWorker } from "../agent/worker";
import { RunSupervisor } from "../agent/supervisor";
import { LocalMarkdownImportDriver } from "../agent/import-driver";
import { AgentService } from "../domain/agent";
import { SqliteAgentRuns } from "../storage/agent";
import { SqliteMarkdownImports } from "../storage/markdown-import";
import { SqliteImportInspection } from "../storage/import-inspection";
import { ConfigError } from "./config-error";
import { createLogger, type Logger, type LogSink } from "../logging";
import { ExecutionOwnerHeldError, ExecutionOwnerLease } from "../storage/execution-owner";
import { SearchClockReceipts } from "./search-clock-receipts";
import type { SearchClockDependencies } from "../domain/search-time";

/** Optional test-owned transport and technical timer seams; default runtime uses the maintained SDK. */
export interface RuntimeDependencies {
  readonly logSink?: LogSink;
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
  let imports: LocalMarkdownImportDriver | undefined;
  let worker: ConfiguredRunWorker | RunWorker | undefined;
  let executionOwner: ExecutionOwnerLease | undefined;
  let failureLogger: Logger | undefined;
  let searchClockReceipts: SearchClockReceipts | undefined;
  let acceptingRequests = true;
  const requestFlights = new Set<Promise<Response>>();
  async function close(force: boolean): Promise<boolean> {
    let failed = false;
    const pending: Promise<unknown>[] = [];
    acceptingRequests = false;
    // Pause the worker synchronously before awaiting either drain; a late native callback cannot advance local work.
    try { worker?.pause(); } catch { failed = true; }
    try { if (supervisor) pending.push(supervisor.stop()); } catch { failed = true; }
    try { if (imports) pending.push(imports.stop()); } catch { failed = true; }
    try { if (server) pending.push(Promise.resolve(server.stop(force))); } catch { failed = true; }
    const results = await Promise.allSettled(pending);
    if (results.some(result => result.status === "rejected")) failed = true;
    // Listener handlers can have been producers before pause. Join the actual lanes again after all listener work ends.
    let drained = false;
    try {
      const requests = await Promise.allSettled([...requestFlights]);
      if (requests.some(result => result.status === "rejected")) failed = true;
      const final = await Promise.all([worker?.drain() ?? [],imports?.drain() ?? []]);
      if (final.some(results => results.some(result => result.status === "rejected"))) failed = true;
      drained = true;
    } catch { failed = true; }
    // A stop error does not skip the real handler/lane joins. Any still-open listener is sealed from application work.
    if (!drained) return true;
    searchClockReceipts?.clear();
    try { db?.close(); } catch { return true; }
    try { executionOwner?.release(); } catch { failed = true; }
    return failed;
  }
  try {
    const valid = validateConfig(config);
    const diagnostics = createLogger(valid.logLevel, dependencies.logSink);
    failureLogger = diagnostics;
    diagnostics.info("[import] transport configured",{maxBytes:valid.importMaxBytes ?? 1048576});
    executionOwner = await ExecutionOwnerLease.acquire(valid.dbPath,diagnostics);
    executionOwner.assertHeld();
    db = new Database(executionOwner.databasePath, { readwrite: true, create: false });
    executionOwner.assertHeld();
    migrate(db, diagnostics);
    executionOwner.register(db);
    const scheduling = { id: randomUUID, now: () => new Date().toISOString(), logger: diagnostics,
      // Public SDK schemas require these prefixes. Existing persisted identities are never rewritten.
      sessionId: () => `ses_${randomUUID()}`, promptId: () => `msg_${randomUUID()}` };
    const store = new SqliteStore(db, scheduling);
    // Receipt lookup is invoked only at a later execution boundary, after this root has wired the session service.
    const searchClock: SearchClockDependencies = { latestObservation: owner => searchClockReceipts?.latest(owner) ?? null };
    const configuredWorker = valid.agent ? new ConfiguredRunWorker({db,...scheduling,config:valid.agent,executionOwner,searchClock,
      resolve:dependencies.resolveAgentService ?? resolveAgentService,client:dependencies.createPublicClient ?? createPublicClient}) : undefined;
    // The same lane owner explicitly has no native producer when unconfigured; do not invent a model or transport.
    worker = configuredWorker ?? new RunWorker({db,...scheduling,executionOwner});
    const retention = worker.searchRetention();
    if (!retention) throw new Error("Runtime search retention ownership is unavailable");
    const searchSessions = store.searchSessions(scheduling,retention);
    searchClockReceipts = new SearchClockReceipts(searchSessions,scheduling.now);
    const receipts = searchClockReceipts;
    const rejection = new RejectionService(new SqliteRejectionRepository(db,diagnostics));
    const creation = new CreationService({ rejection, id: randomUUID, now: () => new Date().toISOString(), writes: {
      createThought: thought => store.saveThought(thought), createConnection: connection => store.saveConnection(connection),
    } });
    const titles = new TitleService(new SqliteTitleRepository(db, scheduling));
    const search = new SearchService(new SqliteSearchRepository(db,undefined,diagnostics));
    const simpleExport = new SimpleExportService(rejection);
    const agents = new AgentService(new SqliteAgentRuns(db,scheduling),valid.agent != null);
    const startPolling=dependencies.startTimer ?? ((poll: () => void) => {
      // Technical polling cadence only, never a model turn/time/token budget.
      const timer=setInterval(poll,250);
      return () => clearInterval(timer);
    });
    // One owned technical clock serves both independent bounded queues. Subscribers own their drains.
    const polls=new Set<() => void>();
    let cancelPolling: (() => void) | undefined;
    const startTimer=(poll: () => void): (() => void) => {
      polls.add(poll);
      try { cancelPolling ??= startPolling(() => { for (const callback of polls) callback(); }); }
      catch (error) { polls.delete(poll); throw error; }
      return () => {
        polls.delete(poll);
        if (polls.size===0) { const cancel=cancelPolling; cancelPolling=undefined; cancel?.(); }
      };
    };
    if (configuredWorker) {
      supervisor = new RunSupervisor({db,worker:configuredWorker,logger:diagnostics,startTimer});
      imports=new LocalMarkdownImportDriver({db,...scheduling,startTimer,worker:configuredWorker.importWorker});
    } else imports=new LocalMarkdownImportDriver({db,...scheduling,startTimer});
    const app = createApp({ rejection, creation, titles, search, searchSessions, searchAgentsConfigured: valid.agent != null,
      notifySearchAdmission: () => supervisor?.notifyWork(), searchClockReceipts: receipts, simpleExport, agents, diagnostics, credentials: valid.credentials, logger,
      imports:{commands:new SqliteMarkdownImports(db,scheduling),inspection:new SqliteImportInspection(db,scheduling),maxBytes:valid.importMaxBytes ?? 1048576} });
    server = Bun.serve({ hostname: "127.0.0.1", port: valid.port, fetch: request => {
      if (!acceptingRequests) return new Response("Daemon stopping",{ status: 503 });
      // Register before running any handler/await, including handlers admitted just before shutdown.
      const flight = Promise.resolve().then(() => app.fetch(request)).finally(() => requestFlights.delete(flight));
      requestFlights.add(flight);
      return flight;
    },
      maxRequestBodySize:Math.max(128*1024*1024,Math.min(Number.MAX_SAFE_INTEGER,(valid.importMaxBytes ?? 1048576)+4096+65536)) });
    supervisor?.start();
    imports?.start();
    const url = server.url.toString();
    let stopping: Promise<void> | undefined;
    logger({ phase: "outcome", operation: "start", success: true, url });
    diagnostics.info("[daemon] started");
    return {
      url,
      stop() {
        if (!stopping) stopping = (async () => {
          let failed = false;
          try { logger({ phase: "attempt", operation: "stop" }); } catch { failed = true; }
          if (await close(false)) failed = true;
          if (failed) {
            diagnostics.error("[daemon] stop failed");
            try { logger({ phase: "outcome", operation: "stop", success: false }); } catch { /* Resources were still cleaned up. */ }
            throw new Error("Daemon shutdown failed");
          }
          try { logger({ phase: "outcome", operation: "stop", success: true }); }
          catch { throw new Error("Daemon shutdown failed"); }
          diagnostics.info("[daemon] stopped");
        })();
        return stopping;
      },
    };
  } catch (error) {
    await close(true);
    try { failureLogger?.error("[daemon] startup failed"); } catch { /* Preserve the sanitized startup error. */ }
    try { logger({ phase: "outcome", operation: "start", success: false }); } catch { /* Do not expose logger failures. */ }
    if (error instanceof ConfigError) throw error;
    if (error instanceof ExecutionOwnerHeldError) throw new ExecutionOwnerHeldError();
    throw new Error("Daemon startup failed");
  }
}
