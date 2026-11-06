import type { Connection } from "./connection";
import type { SharedResponse } from "./shared-response";
import type { Thought } from "./thought";
import type { ExportIntent } from "./agentic-export";
import type { InitialSearchJob } from "./search-run-context";

/** Trusted initial context, selected and witnessed by the run aggregate under AI read scope. */
export interface InitialRunContext {
  readonly job:
    | { readonly kind: "weave"; readonly subjectId: string }
    | { readonly kind: "evolve"; readonly contributionId: string; readonly continuationId: string | null }
    | ({ readonly kind: "export" } & ExportIntent)
    | InitialSearchJob;
  readonly thoughts: readonly Thought[];
  readonly connections: readonly Connection[];
  readonly responses: readonly SharedResponse[];
}
