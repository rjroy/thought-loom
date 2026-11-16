import type { RunKind, RunStatus } from "./run";
import type { LocalStopSnapshot } from "./local-work-stop";

export type BackgroundView = "needs-attention" | "in-progress" | "locally-closed";
export type BackgroundTarget = { readonly type: "run" | "import-file"; readonly id: string };
export interface BackgroundItem {
  readonly target: BackgroundTarget;
  readonly kind: RunKind;
  readonly status: RunStatus | "waiting" | "imported" | "skipped-identical" | "skipped-changed" | "pending" | "settled" | "ownership-conflict";
  readonly createdAt: string | null;
  readonly owner: { readonly type: "thought" | "search-session" | "import" | "export" | "unknown"; readonly id: string | null; readonly title: string | null };
  readonly reason: "uncertain" | "cancellation-pending" | "failed" | "interrupted" | "ownership-conflict" | "waiting" | "unverified" | null;
  readonly actions: { readonly checkStatus: boolean; readonly stopLocalTracking: boolean };
  readonly localStop?:LocalStopSnapshot;
}
export interface BackgroundPosition extends BackgroundTarget { readonly createdAt: string | null }
export interface BackgroundWorkRepository {
  summary(): Record<BackgroundView, number>;
  list(view: BackgroundView, limit: number, after?: BackgroundPosition): { items: BackgroundItem[]; hasMore: boolean };
  get(target: BackgroundTarget): BackgroundItem | null;
}
