import type { Thought } from "./thought";
import type { Connection } from "./connection";
import type { ResponseRecord } from "./response";
import { nonEmpty, ValidationError } from "./validation";

export type Actor = "user" | "ai";
export type ReadScope = { actor: "user"; mode: "normal" | "show-rejected" | "history" } | { actor: "ai"; mode: "normal" };

/** A repository snapshot is internal raw data, never a consumer-facing result. */
export interface RejectionSnapshot {
  readonly thoughts: readonly Thought[];
  readonly connections: readonly Connection[];
  readonly responses: readonly ResponseRecord[];
  readonly rejectedThoughtIds: readonly string[];
  readonly rejectedConnectionIds: readonly string[];
}
export interface RejectionTransaction {
  snapshot(): RejectionSnapshot;
  setThoughtRejected(id: string, rejected: boolean): void;
  setConnectionRejected(id: string, rejected: boolean): void;
}
export interface RejectionRepository {
  snapshot(): RejectionSnapshot;
  transaction<T>(action: (tx: RejectionTransaction) => T): T;
}

/** Count is the number of currently active thoughts that would change state. */
export interface BranchPreview {
  readonly rootId: string;
  readonly branchIds: readonly string[];
  readonly affectedIds: readonly string[];
  readonly count: number;
}
export class ForbiddenActorError extends Error {}
export class BranchConfirmationError extends Error {}

function requireUser(actor: Actor): void {
  if (actor !== "user") throw new ForbiddenActorError("Only the user may change rejection state");
}

function inspection(scope: ReadScope): boolean {
  if (!scope || (scope.actor !== "user" && scope.actor !== "ai")) throw new ForbiddenActorError("Invalid read actor");
  if (scope.actor === "ai" && scope.mode !== "normal") throw new ForbiddenActorError("AI cannot inspect rejected material");
  if (scope.mode !== "normal" && scope.mode !== "history" && scope.mode !== "show-rejected") {
    throw new ForbiddenActorError("Invalid read scope");
  }
  return scope.actor === "user" && scope.mode !== "normal";
}

function branch(snapshot: RejectionSnapshot, rootId: string): string[] {
  nonEmpty(rootId, "rootId");
  if (!snapshot.thoughts.some(thought => thought.id === rootId)) throw new ValidationError("Thought not found");
  const children = new Map<string, string[]>();
  for (const thought of snapshot.thoughts) {
    if (thought.parentId !== null) {
      const siblings = children.get(thought.parentId) ?? [];
      siblings.push(thought.id);
      children.set(thought.parentId, siblings);
    }
  }
  const result: string[] = [];
  const pending = [rootId];
  const visited = new Set<string>();
  while (pending.length) {
    const id = pending.pop();
    if (id === undefined || visited.has(id)) continue;
    visited.add(id);
    result.push(id);
    pending.push(...(children.get(id) ?? []));
  }
  return result.sort();
}

function preview(snapshot: RejectionSnapshot, rootId: string): BranchPreview {
  const branchIds = branch(snapshot, rootId);
  const rejected = new Set(snapshot.rejectedThoughtIds);
  const affectedIds = branchIds.filter(id => !rejected.has(id));
  return { rootId, branchIds, affectedIds, count: affectedIds.length };
}

function sameIds(actual: unknown, expected: readonly string[]): boolean {
  return Array.isArray(actual) && actual.length === expected.length &&
    actual.every(id => typeof id === "string") && [...actual].sort().every((id, index) => id === expected[index]);
}

/** Consumer boundary: no unscoped reads. Raw repository access is internal only. */
export class RejectionService {
  constructor(private readonly repository: RejectionRepository) {}

  previewBranch(actor: Actor, rootId: string): BranchPreview {
    requireUser(actor);
    return preview(this.repository.snapshot(), rootId);
  }

  rejectBranch(actor: Actor, confirmation: BranchPreview | null): void {
    requireUser(actor);
    if (!confirmation || typeof confirmation.rootId !== "string" || !confirmation.rootId.trim()) throw new BranchConfirmationError("Branch confirmation required");
    this.repository.transaction(tx => {
      let current: BranchPreview;
      try { current = preview(tx.snapshot(), confirmation.rootId); }
      catch (error) {
        if (error instanceof ValidationError) throw new BranchConfirmationError("Branch confirmation is stale");
        throw error;
      }
      if (confirmation.count !== current.count || !sameIds(confirmation.branchIds, current.branchIds) || !sameIds(confirmation.affectedIds, current.affectedIds)) {
        throw new BranchConfirmationError("Branch confirmation is stale or invalid");
      }
      for (const id of current.affectedIds) tx.setThoughtRejected(id, true);
    });
  }

  private setThought(actor: Actor, id: string, rejected: boolean): void {
    requireUser(actor);
    nonEmpty(id, "id");
    this.repository.transaction(tx => {
      if (!tx.snapshot().thoughts.some(thought => thought.id === id)) throw new ValidationError("Thought not found");
      tx.setThoughtRejected(id, rejected);
    });
  }
  rejectThought(actor: Actor, id: string): void { this.setThought(actor, id, true); }
  restoreThought(actor: Actor, id: string): void { this.setThought(actor, id, false); }
  restoreBranch(actor: Actor, id: string): void {
    requireUser(actor);
    this.repository.transaction(tx => {
      const snapshot = tx.snapshot();
      const rejected = new Set(snapshot.rejectedThoughtIds);
      for (const thoughtId of branch(snapshot, id)) if (rejected.has(thoughtId)) tx.setThoughtRejected(thoughtId, false);
    });
  }
  private setConnection(actor: Actor, id: string, rejected: boolean): void {
    requireUser(actor);
    nonEmpty(id, "id");
    this.repository.transaction(tx => {
      if (!tx.snapshot().connections.some(connection => connection.id === id)) throw new ValidationError("Connection not found");
      tx.setConnectionRejected(id, rejected);
    });
  }
  rejectConnection(actor: Actor, id: string): void { this.setConnection(actor, id, true); }
  restoreConnection(actor: Actor, id: string): void { this.setConnection(actor, id, false); }

  listThoughts(scope: ReadScope): readonly Thought[] {
    const showRejected = inspection(scope);
    const snapshot = this.repository.snapshot();
    if (showRejected) return snapshot.thoughts;
    const rejected = new Set(snapshot.rejectedThoughtIds);
    return snapshot.thoughts.filter(thought => !rejected.has(thought.id)).map(thought => scope.actor === "ai" ? {
      ...thought,
      parentId: thought.parentId !== null && rejected.has(thought.parentId) ? null : thought.parentId,
      sourceIds: thought.sourceIds.filter(id => !rejected.has(id)),
    } : thought);
  }

  listConnections(scope: ReadScope): readonly Connection[] {
    const showRejected = inspection(scope);
    const snapshot = this.repository.snapshot();
    if (showRejected) return snapshot.connections;
    const rejected = new Set(snapshot.rejectedThoughtIds);
    const rejectedConnections = new Set(snapshot.rejectedConnectionIds);
    return snapshot.connections.filter(connection => !rejectedConnections.has(connection.id) && !rejected.has(connection.fromId) && !rejected.has(connection.toId))
      .map(connection => scope.actor === "ai" ? { ...connection, sourceIds: connection.sourceIds.filter(id => !rejected.has(id)) } : connection);
  }

  getResponse(scope: ReadScope, id: string): ResponseRecord | null {
    const showRejected = inspection(scope);
    nonEmpty(id, "id");
    const snapshot = this.repository.snapshot();
    const response = snapshot.responses.find(item => item.id === id);
    if (!response || (!showRejected && snapshot.rejectedThoughtIds.includes(response.thoughtId))) return null;
    return response;
  }
}
