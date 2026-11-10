import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
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
import { openMediaFiles, type MediaFiles } from "../storage/media-files";
import { createMediaValidator, type MediaValidator } from "../storage/media-validator";
import { mediaStoreId } from "../storage/media-source";
import { SqliteMediaImports } from "../storage/media-import";
import { ReinterpretationService } from "../domain/reinterpretation";
import { SqliteReinterpretations } from "../storage/reinterpretation";
import { BackupScheduler, systemBackupTimer, type BackupTimer } from "../backup/scheduler";
import { runBackupAttempt } from "../backup/run";
import { SqliteAgentInstructions } from "../storage/agent-instructions";

/** Optional owned transport/clock/backup seams; defaults use the real explicitly configured services. */
export interface RuntimeDependencies {
  readonly logSink?: LogSink;
  readonly resolveAgentService?: (config: AgentConfig) => Promise<ResolvedAgentService>;
  readonly createPublicClient?: (service: ResolvedAgentService) => PublicClient;
  readonly startTimer?: (poll: () => void) => () => void;
  readonly backupScheduler?: { readonly timer: BackupTimer; readonly attempt: (signal: AbortSignal) => Promise<void> };
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
  let mediaFiles: MediaFiles | undefined;
  let mediaValidator: MediaValidator | undefined;
  let backupScheduler: BackupScheduler | undefined;
  let acceptingRequests = true;
  const requestFlights = new Set<Promise<Response>>();
  async function close(force: boolean): Promise<boolean> {
    let failed = false;
    const pending: Promise<unknown>[] = [];
    acceptingRequests = false;
    // Seal/abort synchronously, and join capture/Git before originals, database and execution ownership are released.
    try { if (backupScheduler) pending.push(backupScheduler.stop()); } catch { failed = true; }
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
    // Handlers and normal worker callbacks can still use originals until their actual flights have joined.
    try { await mediaFiles?.close(); } catch { failed = true; }
    try { await mediaValidator?.close(); } catch { failed = true; }
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
    diagnostics.info("[restore] startup marker check attempt");
    let markerPresent = true;
    try { await lstat(join(dirname(executionOwner.databasePath), ".restore-in-progress")); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") markerPresent = false;
      else throw error;
    }
    if (markerPresent) {
      diagnostics.warning("[restore] startup blocked by incomplete restore");
      throw new Error("Incomplete restore");
    }
    executionOwner.assertHeld();
    diagnostics.info("[restore] startup marker check outcome");
    db = new Database(executionOwner.databasePath, { readwrite: true, create: false });
    executionOwner.assertHeld();
    diagnostics.info("[storage] enable WAL attempt");
    const journalMode = db.query("PRAGMA journal_mode=WAL").get() as { journal_mode: string } | null;
    if (journalMode?.journal_mode !== "wal") throw new Error("Knowledge database WAL mode unavailable");
    diagnostics.info("[storage] enable WAL outcome");
    migrate(db, diagnostics);
    executionOwner.register(db);
    const owner = executionOwner, mediaMaxBytes = valid.mediaMaxBytes ?? 16*1024*1024;
    diagnostics.info("[media import] limits configured",{maxBytes:mediaMaxBytes});
    mediaValidator = createMediaValidator({
      raster:{maxBytes:mediaMaxBytes,maxDimension:16384,maxTotalPixels:64*1024*1024,maxFrames:256},
      pdf:{maxBytes:mediaMaxBytes,maxPages:1024,maxObjects:100000,maxDepth:128},
      process:{dataBytes:1024*1024*1024,cpuSeconds:8,wallMs:10000,outputBytes:8192},logger:diagnostics,
    });
    mediaFiles = await openMediaFiles({db,directory:valid.mediaDir ?? `${owner.databasePath}.media`,storeId:mediaStoreId(db) ?? randomUUID(),
      id:randomUUID,now:Date.now,assertHeld:() => owner.assertHeld(),logger:diagnostics,validate:mediaValidator.validate,
      limits:{maxBytes:mediaMaxBytes,orphanGraceMs:24*60*60*1000,cleanupBatchSize:64}});
    const files = mediaFiles, mediaPath = (sourceId: string) => files.originalPath(sourceId);
    await files.cleanup();
    const scheduling = { id: randomUUID, now: () => new Date().toISOString(), logger: diagnostics,
      // Public SDK schemas require these prefixes. Existing persisted identities are never rewritten.
      sessionId: () => `ses_${randomUUID()}`, promptId: () => `msg_${randomUUID()}` };
    const store = new SqliteStore(db, scheduling);
    // Receipt lookup is invoked only at a later execution boundary, after this root has wired the session service.
    const searchClock: SearchClockDependencies = { latestObservation: owner => searchClockReceipts?.latest(owner) ?? null };
    const configuredWorker = valid.agent ? new ConfiguredRunWorker({db,...scheduling,config:valid.agent,executionOwner,searchClock,mediaPath,
      resolve:dependencies.resolveAgentService ?? resolveAgentService,client:dependencies.createPublicClient ?? createPublicClient}) : undefined;
    // The same lane owner explicitly has no native producer when unconfigured; do not invent a model or transport.
    worker = configuredWorker ?? new RunWorker({db,...scheduling,executionOwner,mediaPath});
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
      agentInstructions:new SqliteAgentInstructions(db,diagnostics),
      imports:{commands:new SqliteMarkdownImports(db,scheduling),inspection:new SqliteImportInspection(db,scheduling),maxBytes:valid.importMaxBytes ?? 1048576},
      reinterpretations:{commands:new ReinterpretationService(new SqliteReinterpretations(db,scheduling)),notify:() => supervisor?.notifyWork()},
      media:{commands:new SqliteMediaImports(db,scheduling,files,rejection),maxBytes:mediaMaxBytes,notify:() => supervisor?.notifyWork()} });
    server = Bun.serve({ hostname: "127.0.0.1", port: valid.port, fetch: request => {
      if (!acceptingRequests) return new Response("Daemon stopping",{ status: 503 });
      // Register before running any handler/await, including handlers admitted just before shutdown.
      const flight = Promise.resolve().then(() => app.fetch(request)).finally(() => requestFlights.delete(flight));
      requestFlights.add(flight);
      return flight;
    },
      maxRequestBodySize:Math.max(128*1024*1024,Math.min(Number.MAX_SAFE_INTEGER,Math.max(valid.importMaxBytes ?? 1048576,mediaMaxBytes)+4096+65536)) });
    supervisor?.start();
    imports?.start();
    const url = server.url.toString();
    let stopping: Promise<void> | undefined;
    logger({ phase: "outcome", operation: "start", success: true, url });
    diagnostics.info("[daemon] started");
    if (valid.backup && valid.backup.intervalSeconds !== null) {
      const backup = valid.backup, injected = dependencies.backupScheduler;
      backupScheduler = new BackupScheduler({ intervalSeconds: backup.intervalSeconds, timer: injected?.timer ?? systemBackupTimer, logger: diagnostics,
        attempt: injected?.attempt ?? (async signal => {
          const mediaDirectory = await realpath(valid.mediaDir ?? `${owner.databasePath}.media`);
          await runBackupAttempt({ databasePath: owner.databasePath, mediaDirectory, config: backup, signal, logger: diagnostics });
        }) });
      backupScheduler.start();
    }
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
