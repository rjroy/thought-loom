import { createLogger, type Logger } from "../logging";
import type { Database } from "bun:sqlite";
import type { AgentConfig } from "../daemon/agent-config";
import { RunFenceError, type RunSources } from "../domain/run";
import { normalizeBinding, validateServiceUrl } from "./binding";
import { AgentUnavailableError } from "./errors";
import { OpenCodeAdapter, type AgentBinding, type PublicClient, type ResolvedAgentService } from "./opencode-adapter";
import type { SupervisedWorker } from "./supervisor";
import { RunWorker, type WorkerNative } from "./worker";
import { SqliteAgentBindings } from "../storage/agent-binding";
import { SqliteRunRepository } from "../storage/run";
import { SqliteAgenticExports } from "../storage/agentic-export";
import { MarkdownImportWorker, type ImportNative } from "./import-worker";
import { searchRunEffort } from "../storage/search-initial-context";
import type { SearchClockDependencies } from "../domain/search-time";
import type { ExecutionOwnerLease } from "../storage/execution-owner";
import type { SqliteSearchRetention } from "../storage/search-retention";
import { assertRunNotRestoreFenced, isRunRestoreFenced } from "../storage/restore-fences";
import { assertImportRunNotRestoreFenced } from "../storage/import-authority";

export interface ConfiguredWorkerDependencies extends RunSources {
  readonly db: Database;
  readonly config: AgentConfig;
  readonly resolve: (config: AgentConfig) => Promise<ResolvedAgentService>;
  readonly client: (service: ResolvedAgentService) => PublicClient;
  readonly searchClock?: SearchClockDependencies;
  /** Runtime-owned capability. Direct isolated worker fixtures do not acquire a deployed daemon lease. */
  readonly executionOwner?: ExecutionOwnerLease;
  /** Resolve originals from the daemon-owned store shared with OpenCode. */
  readonly mediaPath?: (sourceId: string) => Promise<string>;
}

/** One worker and one lazy attachment snapshot; no SDK/service work at construction or daemon readiness. */
export class ConfiguredRunWorker implements SupervisedWorker {
  readonly importWorker: MarkdownImportWorker;
  private readonly logger: Logger;
  private unavailable = false;
  private readonly worker: RunWorker;
  private readonly bindings: SqliteAgentBindings;
  private readonly runs: SqliteRunRepository;
  private readonly exports: SqliteAgenticExports;
  private service: ResolvedAgentService | undefined;
  private resolving: Promise<void> | undefined;
  private paused = false;
  constructor(private readonly dependencies: ConfiguredWorkerDependencies) {
    this.logger = dependencies.logger ?? createLogger();
    this.bindings = new SqliteAgentBindings(dependencies.db,this.logger,dependencies.executionOwner);
    this.runs = new SqliteRunRepository(dependencies.db,dependencies);
    this.exports = new SqliteAgenticExports(dependencies.db,dependencies);
    this.importWorker=new MarkdownImportWorker({...dependencies,native:(bindings,localFence) => {
      let adapter: OpenCodeAdapter | undefined;
      const owned=async (runId: string, binding: AgentBinding): Promise<OpenCodeAdapter> => {
        assertImportRunNotRestoreFenced(dependencies.db,runId);
        localFence(); this.assertOwner(); await this.resolve(); localFence(); this.assertOwner();
        assertImportRunNotRestoreFenced(dependencies.db,runId);
        const service=this.service;
        if (this.paused || !service || service.url!==binding.serviceUrl) throw new AgentUnavailableError("Import-owned service is unavailable");
        if (!adapter) {
          try { adapter=new OpenCodeAdapter(dependencies.client(service),bindings,{ordinary:bindings.assertActive.bind(bindings),import:localFence,runtime:() => this.assertOwner()},this.logger); }
          catch { throw new AgentUnavailableError("Import client is unavailable"); }
        }
        return adapter;
      };
      const native: ImportNative={
        bindingFor:async run => {
          assertImportRunNotRestoreFenced(dependencies.db,run.id);
          localFence(); this.assertOwner(); await this.resolve(); localFence(); this.assertOwner();
          assertImportRunNotRestoreFenced(dependencies.db,run.id);
          const service=this.service, config=dependencies.config;
          if (!service || this.paused) throw new AgentUnavailableError("Import agent service is unavailable");
          const variant=config.effort.standard;
          return normalizeBinding({sessionId:run.sessionId,serviceUrl:service.url,location:{directory:config.directory},
            model:{...config.model,...(variant===null ? {} : {variant})},permissions:[{action:"*",resource:"*",effect:"deny"}],protocolVersion:1});
        },
        ensureSession:async (claim,binding,prompt) => (await owned(claim.runId,binding)).ensureImportSession(claim,binding,prompt),
        submit:async (claim,binding,prompt) => (await owned(claim.runId,binding)).submitImport(claim,binding,prompt),
        observe:async (claim,binding,prompts) => (await owned(claim.runId,binding)).observeImport(claim,binding,prompts),
        cancel:async (claim,binding,prompt) => (await owned(claim.runId,binding)).cancelImport(claim,binding,prompt),
      };
      return native;
    }});
    this.worker = new RunWorker({...dependencies,bindingFor:run => {
      if (run.kind !== "weave" && run.kind !== "evolve" && run.kind !== "export" && run.kind !== "search") return null;
      const effort = run.kind === "search" ? searchRunEffort(dependencies.db,run.id) : run.kind === "export" ? this.exports.intent(run.id)?.effort : "standard";
      if (effort === undefined || effort === null) return null; // Unknown legacy intent is blocked, never assigned an invented effort/question.
      const service = this.service;
      if (!service) return null;
      const config = dependencies.config;
      const variant = config.effort[effort];
      return normalizeBinding({sessionId:run.sessionId,serviceUrl:service.url,location:{directory:config.directory},
        model:{...config.model,...(variant === null ? {} : {variant})},
        permissions:[{action:"*",resource:"*",effect:run.kind === "weave" || run.kind === "evolve" ? "allow" : "deny"}],protocolVersion:1});
    },native:bindings => {
      let adapter: OpenCodeAdapter | undefined;
      const owned = async (runId: string, binding: AgentBinding): Promise<OpenCodeAdapter> => {
        this.assertOwner();
        assertRunNotRestoreFenced(dependencies.db,runId);
        await this.resolve();
        this.assertOwner();
        assertRunNotRestoreFenced(dependencies.db,runId);
        const service = this.service;
        // Never retarget a persisted session or send a newly selected endpoint's credentials to an old endpoint.
        if (this.paused || !service || service.url !== binding.serviceUrl) throw new AgentUnavailableError("Run-owned service is unavailable");
        return adapter ??= new OpenCodeAdapter(dependencies.client(service),bindings,{ordinary:bindings.assertActive.bind(bindings),
          import:() => { throw new RunFenceError("Import authority is not available on the ordinary transport"); },runtime:() => this.assertOwner()},this.logger);
      };
      const native: WorkerNative = {
        ensureSession:async (claim,binding) => (await owned(claim.runId,binding)).ensureSession(claim,binding),
        submit:async (claim,binding,prompt,onAdmission) => (await owned(claim.runId,binding)).submit(claim,binding,prompt,onAdmission),
        observe:async (claim,binding,prompts) => (await owned(claim.runId,binding)).observe(claim,binding,prompts),
        cancel:async (runId,binding,prompt) => (await owned(runId,binding)).cancel(runId,binding,prompt),
        cancelSearch:async (identity,authorize) => {
          authorize();
          const adapter = await owned(identity.runId,identity.binding);
          authorize();
          return adapter.cancelSearch(identity,authorize);
        },
      };
      return native;
    }});
  }
  private assertOwner(): void { this.dependencies.executionOwner?.assertHeld(); }
  private resolve(): Promise<void> {
    this.assertOwner();
    if (this.service) return Promise.resolve();
    if (!this.resolving) this.resolving = (async () => {
      this.logger.verbose("[agent runtime] resolve service attempt");
      try {
        const selected = await this.dependencies.resolve(this.dependencies.config);
        this.assertOwner();
        if (this.paused) return;
        const url = validateServiceUrl(selected.url);
        const headers = selected.headers === undefined ? undefined : Object.freeze(Object.fromEntries(new Headers(selected.headers)));
        this.service = Object.freeze({url,...(headers === undefined ? {} : {headers}),...(selected.token === undefined ? {} : {token:selected.token})});
        this.logger.verbose("[agent runtime] resolve service succeeded");
        if (this.unavailable) { this.unavailable = false; this.logger.info("[agent runtime] service available"); }
      } catch (error) {
        if (error instanceof RunFenceError) throw error;
        if (!this.unavailable) { this.unavailable = true; this.logger.warning("[agent runtime] service unavailable"); }
        else this.logger.verbose("[agent runtime] service remains unavailable");
        throw new AgentUnavailableError("Configured agent service is unavailable");
      }
    })().finally(() => { this.resolving = undefined; });
    return this.resolving;
  }
  private async beforePoll(runId: string): Promise<void> {
    if (this.paused) return;
    if (isRunRestoreFenced(this.dependencies.db,runId)) return;
    const run = this.runs.get(runId);
    if (run && run.kind !== "weave" && run.kind !== "evolve" && run.kind !== "export" && run.kind !== "search") return;
    // Canonical local output and terminal cleanup without a binding do not require discovery or a network connection.
    const selectable = run && (run.kind !== "export" || this.exports.intent(runId) !== null);
    if (selectable && ["queued","submitting","running","uncertain"].includes(run.status) && !this.bindings.get(runId)) {
      try { await this.resolve(); } catch (error) { if (error instanceof RunFenceError) throw error; } // A later poll retries unavailable discovery.
    }
  }
  tick(runId: string): Promise<void> { return this.worker.tick(runId,() => this.beforePoll(runId)); }
  searchRetention(): SqliteSearchRetention | null { return this.worker.searchRetention(); }
  onSearchCleanupAvailable(notify: () => void): () => void { return this.worker.onSearchCleanupAvailable(notify); }
  pause(): void { this.paused = true; this.worker.pause(); this.importWorker.pause(); }
  /** Final run-lane/shared-resolver join after listener producers finish; the import driver owns its file lanes. */
  async drain(): Promise<readonly PromiseSettledResult<void>[]> {
    this.pause();
    const [runs,resolution] = await Promise.all([this.worker.drain(),Promise.allSettled(this.resolving ? [this.resolving] : [])]);
    return [...runs,...resolution];
  }
  /** Trusted retention hook; clears timing metadata only, never native work or run authority. */
  forgetSearchClock(runId: string): void { this.worker.forgetSearchClock(runId); }
}
