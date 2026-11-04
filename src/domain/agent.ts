import type { Actor } from "./rejection";
import { RunForbiddenError, RunNotFoundError, type RunKind, type RunStatus } from "./run";
import type { Thought } from "./thought";
import { nonEmpty } from "./validation";

/** User observation of durable local work, never native identities, machine envelopes, or raw run storage. */
export interface AgentRunView {
  readonly id: string;
  readonly kind: RunKind;
  readonly status: RunStatus;
  readonly confirmedThoughtIds: readonly string[];
  readonly responseId: string | null;
}
export interface EvolveAdmission { readonly contribution: Thought; readonly run: AgentRunView }
export interface AgentRunRepository {
  admitEvolve(parentId: string, text: string): EvolveAdmission;
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
