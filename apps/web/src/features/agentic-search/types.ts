import type { IdeaThought } from "../idea/types";

export type Effort = "quick" | "standard" | "thorough";
export interface Session { readonly id: string; readonly title: string; readonly createdAt: string; readonly lastActivityAt: string; readonly revision: number }
export interface Run { readonly id: string; readonly kind: "search"; readonly status: "queued" | "submitting" | "running" | "uncertain" | "completed" | "interrupted" | "failed"; readonly searchSessionId: string; readonly userMessageId: string; readonly assistantMessageId: string | null; readonly outcomeReason: "stopped" | "context-invalidated" | "failed" | null; readonly cancellation: "none" | "pending" | "settled" }
export interface Composer { readonly composerId: string; readonly contextToken: string; readonly eligibilityRevision: number }
export interface Message { readonly id: string; readonly runId: string; readonly position: number; readonly role: "user" | "assistant"; readonly text: string | null; readonly createdAt: string; readonly disposition: "awaiting-user" | "done" | null; readonly evidenceThoughtIds: readonly string[]; readonly availability: "available" | "context-unavailable" }
export interface Discovery { readonly id: string; readonly position: number; readonly addedAt: string; readonly removedAt: string | null; readonly thought: Pick<IdeaThought,"id" | "title" | "titleAuthor" | "author" | "kind" | "createdAt"> | null; readonly why: string | null; readonly evidenceThoughtIds: readonly string[]; readonly availability: "available" | "thought-unavailable"; readonly reasonStatus: "available" | "context-unavailable" }
export interface Page<T> { readonly items: readonly T[]; readonly nextCursor: string | null }
export interface NormalPage<T> extends Page<T>, Composer { readonly sessionRevision: number }
export interface Preview extends Composer { readonly thought: IdeaThought; readonly sessionRevision: number }
export interface Control { readonly receipt: { readonly searchSessionId: string; readonly runId: string; readonly userMessageId: string; readonly admittedAt: string }; readonly run: Run; readonly session: Session }
export interface TurnPayload { readonly text: string; readonly startingThoughtIds: readonly string[]; readonly requestClock: { readonly at: string; readonly timeZone: string }; readonly effort: Effort; readonly contextMode: "continue"; readonly composerId: string; readonly contextToken: string }
export interface Snapshot { readonly key: string; readonly payload: TurnPayload }
export type Admission = { readonly kind: "idle" } | { readonly kind: "submitting"; readonly snapshot: Snapshot } | { readonly kind: "unconfirmed"; readonly snapshot: Snapshot } | { readonly kind: "known"; readonly run: Run } | { readonly kind: "not-started"; readonly reason: string };
export type Context = { readonly kind: "unopened" } | { readonly kind: "editable"; readonly composer: Composer } | { readonly kind: "changed"; readonly blockedDraft: string };
export type Content = { readonly kind: "unopened" } | { readonly kind: "normal"; readonly composerId: string; readonly messages: Page<Message>; readonly discoveries: Page<Discovery>; readonly preview: Preview | null; readonly revision: number } | { readonly kind: "history"; readonly messages: Page<Message>; readonly discoveries: Page<Discovery> };
export interface Workspace { readonly session: Session | null; readonly phase: "loading" | "ready" | "error" | "deleted"; readonly context: Context; readonly content: Content; readonly draft: string; readonly blockedDraft: string | null; readonly effort: Effort; readonly admission: Admission; readonly busy: boolean; readonly observationError: boolean; readonly scrollY: number }
export interface Catalog { readonly phase: "idle" | "loading" | "ready" | "error"; readonly items: readonly Session[]; readonly nextCursor: string | null }
export const terminal = (run: Run): boolean => run.status === "completed" || run.status === "interrupted" || run.status === "failed";
export function controls(workspace: Workspace) {
  const run = workspace.admission.kind === "known" ? workspace.admission.run : null;
  return { canSend: workspace.context.kind === "editable" && workspace.content.kind === "normal" && !!workspace.draft.trim() && !workspace.busy && workspace.admission.kind !== "submitting" && workspace.admission.kind !== "unconfirmed" && (!run || terminal(run)),
    canCheck: !workspace.busy && (workspace.admission.kind === "unconfirmed" || !!run), canStop: !workspace.busy && !!run && !terminal(run) };
}
