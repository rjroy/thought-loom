import type { AgentBinding } from "./binding";
import type { SearchCleanupManifest } from "../storage/search-cleanup-manifest";

/** Cancellation-only identity; never carries prompt input, model output or an active execution claim. */
export interface SearchCleanupIdentity {
  readonly runId: string;
  readonly sessionId: string;
  readonly binding: AgentBinding;
  readonly bindingJson: string;
  readonly manifest: SearchCleanupManifest;
  readonly manifestJson: string;
}
export interface SearchAdmissionFact {
  readonly runId: string;
  readonly nativeSessionId: string;
  readonly promptId: string;
  readonly inputSha256: string;
}
export interface SearchTerminalCertificate {
  readonly promptId: string;
  readonly inputSha256: string;
  readonly userMessageId: string;
  readonly assistantMessageId: string | null;
  readonly idleMessageId: string;
  readonly outcome: "completed" | "failed" | "interrupted";
}
export type SearchCleanupObservation = { readonly state: "ownership-conflict" }
  | { readonly state: "pending" | "terminal"; readonly admissions: readonly SearchAdmissionFact[];
    readonly prompts: readonly SearchTerminalCertificate[]; readonly inboxEmpty: boolean | null; readonly inactive: boolean | null };
