import type { Actor, ReadScope } from "./rejection";
import { nonEmpty } from "./validation";

export interface TitleState {
  readonly title: string | null;
  readonly titleAuthor: Actor | null;
}
export interface TitleRecord extends TitleState { readonly rejected: boolean }
export interface TitleTransaction {
  get(id: string): TitleRecord | null;
  set(id: string, state: TitleState): void;
  /** Optional scheduling port; implementation joins this same transaction and owns the invitation identity. */
  inviteWeave?(id: string): void;
}
export interface TitleRepository {
  transaction<T>(action: (tx: TitleTransaction) => T): T;
}
export class TitleNotFoundError extends Error {}
export class TitleConflictError extends Error {}
export class TitleForbiddenError extends Error {}

/** The transaction owns both rejection eligibility and title state. */
export class TitleService {
  constructor(private readonly repository: TitleRepository) {}
  get(scope: ReadScope, id: string): TitleState {
    if (!scope || (scope.actor !== "user" && scope.actor !== "ai") ||
        (scope.mode !== "normal" && scope.mode !== "history" && scope.mode !== "show-rejected") ||
        (scope.actor === "ai" && scope.mode !== "normal")) throw new TitleForbiddenError();
    nonEmpty(id, "id");
    return this.repository.transaction(tx => {
      const item = tx.get(id);
      if (!item || (item.rejected && scope.mode === "normal")) throw new TitleNotFoundError();
      return { title: item.title, titleAuthor: item.titleAuthor };
    });
  }
  setUser(actor: Actor, id: string, title: string | null): TitleState {
    if (actor !== "user") throw new TitleForbiddenError();
    nonEmpty(id, "id");
    if (title !== null) nonEmpty(title, "title");
    return this.repository.transaction(tx => {
      const item = tx.get(id);
      if (!item) throw new TitleNotFoundError();
      const state: TitleState = { title, titleAuthor: title === null ? null : "user" };
      tx.set(id, state);
      if (title === null && !item.rejected) tx.inviteWeave?.(id);
      return state;
    });
  }
  fillAi(actor: Actor, id: string, title: string): TitleState {
    if (actor !== "ai") throw new TitleForbiddenError();
    nonEmpty(id, "id");
    nonEmpty(title, "title");
    return this.repository.transaction(tx => {
      const item = tx.get(id);
      if (!item || item.rejected) throw new TitleNotFoundError();
      if (item.title !== null) throw new TitleConflictError();
      const state: TitleState = { title, titleAuthor: "ai" };
      tx.set(id, state);
      return state;
    });
  }
}
