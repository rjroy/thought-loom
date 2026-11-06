import type { Actor } from "./rejection";
import { RunConflictError, RunForbiddenError, RunNotFoundError, type OrdinaryRunKind, type RunStatus } from "./run";
import type { Thought } from "./thought";
import { nonEmpty } from "./validation";
import { exportIntent, type ExportIntent, type ExportReport } from "./agentic-export";

/** User observation of durable local work, never native identities, machine envelopes, or raw run storage. */
export interface OrdinaryAgentRunView {
  readonly id: string;
  readonly kind: OrdinaryRunKind;
  readonly status: RunStatus;
  readonly confirmedThoughtIds: readonly string[];
  readonly responseId: string | null;
}
export interface ImportRunView {
  readonly id: string; readonly kind: "import"; readonly status: RunStatus;
  readonly importId: string; readonly fileId: string;
}
export type AgentRunView = OrdinaryAgentRunView | ImportRunView;
export interface EvolveAdmission { readonly contribution: Thought; readonly run: OrdinaryAgentRunView }
export interface AgenticExportAdmission { readonly run: OrdinaryAgentRunView }
export interface AgentRunRepository {
  admitEvolve(parentId: string, text: string): EvolveAdmission;
  admitExport(intent: ExportIntent): OrdinaryAgentRunView;
  report(id: string): ExportReport | null;
  status(id: string): AgentRunView | null;
  stop(id: string): AgentRunView;
}
export class AgentNotConfiguredError extends Error {}

/** Private application service: agents cannot use user history/status or gain user mutation authority. */
export class AgentService {
  constructor(private readonly repository: AgentRunRepository, private readonly configured: boolean) {}
  private user(actor: Actor): void { if (actor !== "user") throw new RunForbiddenError(); }
  evolve(actor: Actor, parentId: string, text: string): EvolveAdmission {
    this.user(actor); nonEmpty(parentId,"parentId"); nonEmpty(text,"text");
    if (!this.configured) throw new AgentNotConfiguredError();
    return this.repository.admitEvolve(parentId,text);
  }
  export(actor: Actor, input: unknown): AgenticExportAdmission {
    this.user(actor);
    const intent = exportIntent(input);
    if (!this.configured) throw new AgentNotConfiguredError();
    return {run:this.repository.admitExport(intent)};
  }
  report(actor: Actor, id: string): string {
    this.user(actor); nonEmpty(id,"id");
    const run = this.repository.status(id);
    if (!run || run.kind !== "export") throw new RunNotFoundError();
    if (run.status !== "completed") throw new RunConflictError("Report is not ready");
    const report = this.repository.report(id);
    if (!report) throw new RunConflictError("Completed report is unavailable");
    return report.markdown;
  }
  status(actor: Actor, id: string): AgentRunView {
    this.user(actor); nonEmpty(id,"id");
    const run = this.repository.status(id);
    if (!run) throw new RunNotFoundError();
    return run;
  }
  stop(actor: Actor, id: string): AgentRunView {
    this.user(actor); nonEmpty(id,"id");
    return this.repository.stop(id);
  }
}
