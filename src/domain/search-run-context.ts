import type { SearchMessageView } from "./agentic-search";
import type { SearchClockContext } from "./search-time";

/** Trusted initial model input, not a user history projection or a capability result. */
export interface InitialSearchJob {
  readonly kind: "search";
  readonly searchSessionId: string;
  readonly turnPosition: number;
  readonly effort: "quick" | "standard" | "thorough";
  readonly contextMode: "continue" | "restart";
  readonly request: { readonly messageId: string; readonly text: string; readonly startingThoughtIds: readonly string[] };
  readonly conversation: { readonly messages: readonly SearchMessageView[]; readonly earlierMessagesOmitted: boolean };
  readonly clockContext: SearchClockContext;
}
