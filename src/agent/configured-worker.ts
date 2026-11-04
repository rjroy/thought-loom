import type { Database } from "bun:sqlite";
import type { AgentConfig } from "../daemon/agent-config";
import type { RunSources } from "../domain/run";
import { normalizeBinding, validateServiceUrl } from "./binding";
import { AgentUnavailableError } from "./errors";
import { OpenCodeAdapter, type AgentBinding, type PublicClient, type ResolvedAgentService } from "./opencode-adapter";
import type { SupervisedWorker } from "./supervisor";
import { RunWorker, type WorkerNative } from "./worker";
import { SqliteAgentBindings } from "../storage/agent-binding";
import { SqliteRunRepository } from "../storage/run";

export interface ConfiguredWorkerDependencies extends RunSources {
  readonly db: Database;
  readonly config: AgentConfig;
  readonly resolve: (config: AgentConfig) => Promise<ResolvedAgentService>;
  readonly client: (service: ResolvedAgentService) => PublicClient;
}

/** One worker and one lazy attachment snapshot; no SDK/service work at construction or daemon readiness. */
export class ConfiguredRunWorker implements SupervisedWorker {
  private readonly worker: RunWorker;
  private readonly bindings: SqliteAgentBindings;
  private readonly runs: SqliteRunRepository;
  private service: ResolvedAgentService | undefined;
  private resolving: Promise<void> | undefined;
  private paused = false;
  constructor(private readonly dependencies: ConfiguredWorkerDependencies) {
    this.bindings = new SqliteAgentBindings(dependencies.db);
    this.runs = new SqliteRunRepository(dependencies.db,dependencies);
    this.worker = new RunWorker({...dependencies,bindingFor:run => {
      const service = this.service;
      if (!service) return null;
      const config = dependencies.config;
      const variant = config.effort.standard;
      return normalizeBinding({sessionId:run.sessionId,serviceUrl:service.url,location:{directory:config.directory},
        model:{...config.model,...(variant === null ? {} : {variant})},permissions:[{action:"*",resource:"*",effect:"deny"}],protocolVersion:1});
    },native:bindings => {
      let adapter: OpenCodeAdapter | undefined;
      const owned = async (binding: AgentBinding): Promise<OpenCodeAdapter> => {
        await this.resolve();
        const service = this.service;
        // Never retarget a persisted session or send a newly selected endpoint's credentials to an old endpoint.
        if (this.paused || !service || service.url !== binding.serviceUrl) throw new AgentUnavailableError("Run-owned service is unavailable");
        return adapter ??= new OpenCodeAdapter(dependencies.client(service),bindings,bindings.assertActive.bind(bindings));
      };
      const native: WorkerNative = {
        ensureSession:async (claim,binding) => (await owned(binding)).ensureSession(claim,binding),
        submit:async (claim,binding,prompt) => (await owned(binding)).submit(claim,binding,prompt),
        observe:async (claim,binding,prompts) => (await owned(binding)).observe(claim,binding,prompts),
        cancel:async (runId,binding,prompt) => (await owned(binding)).cancel(runId,binding,prompt),
      };
      return native;
    }});
  }
  private resolve(): Promise<void> {
    if (this.service) return Promise.resolve();
    if (!this.resolving) this.resolving = (async () => {
      console.info("[agent runtime] resolve service attempt");
      try {
        const selected = await this.dependencies.resolve(this.dependencies.config);
        if (this.paused) return;
        const url = validateServiceUrl(selected.url);
        const headers = selected.headers === undefined ? undefined : Object.freeze(Object.fromEntries(new Headers(selected.headers)));
        this.service = Object.freeze({url,...(headers === undefined ? {} : {headers}),...(selected.token === undefined ? {} : {token:selected.token})});
        console.info("[agent runtime] resolve service succeeded");
      } catch {
        console.error("[agent runtime] resolve service unavailable");
        throw new AgentUnavailableError("Configured agent service is unavailable");
      }
    })().finally(() => { this.resolving = undefined; });
    return this.resolving;
  }
  async tick(runId: string): Promise<void> {
    if (this.paused) return;
    const run = this.runs.get(runId);
    // Canonical local output and terminal cleanup without a binding do not require discovery or a network connection.
    if (run && ["queued","submitting","running","uncertain"].includes(run.status) && !this.bindings.get(runId)) {
      try { await this.resolve(); } catch { return; } // A later technical poll retries unavailable discovery.
    }
    if (!this.paused) await this.worker.tick(runId);
  }
  pause(): void { this.paused = true; this.worker.pause(); }
}
