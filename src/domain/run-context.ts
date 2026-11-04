import type { Connection } from "./connection";
import type { SharedResponse } from "./shared-response";
import type { Thought } from "./thought";

/** Trusted initial context, selected and witnessed by the run aggregate under AI read scope. */
export interface InitialRunContext {
  readonly job:
    | { readonly kind: "weave"; readonly subjectId: string }
    | { readonly kind: "evolve"; readonly contributionId: string; readonly continuationId: string | null };
  readonly thoughts: readonly Thought[];
  readonly connections: readonly Connection[];
  readonly responses: readonly SharedResponse[];
}
