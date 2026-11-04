import type { Thought } from "./thought";
import type { Connection } from "./connection";
import type { ResponseRecord } from "./response";
import { scopeSharedResponse } from "./shared-response";
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
export type ThoughtRead = Thought & { readonly rejected?: boolean };
export type ConnectionRead = Connection & { readonly rejected?: boolean };
export interface RejectionTransaction {
  snapshot(): RejectionSnapshot;
  setThoughtRejected(id: string, rejected: boolean): void;
  setConnectionRejected(id: string, rejected: boolean): void;
}
export interface RejectionRepository {
  snapshot(): RejectionSnapshot;
  transaction<T>(action: (tx: RejectionTransaction) => T): T;
  exportTree?(rootId: string): readonly ExportTreeNode[];
}

/** Internal ancestry includes rejected nodes only as traversal links, never as content. */
export interface ExportTreeNode {
  readonly id: string;
  readonly parentId: string | null;
  readonly createdAt: string;
  readonly thought: Thought | null;
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

/** Apply normal-scope provenance redaction to an active thought. */
export function scopeActiveThought(actor: Actor, thought: Thought, rejected: ReadonlySet<string>): Thought | null {
  if (rejected.has(thought.id)) return null;
  return actor === "ai" ? { ...thought,
    parentId: thought.parentId !== null && rejected.has(thought.parentId) ? null : thought.parentId,
    sourceIds: thought.sourceIds.filter(id => !rejected.has(id)),
  } : thought;
}

/** Apply normal-scope visibility and provenance redaction to a connection. */
export function scopeActiveConnection(actor: Actor, connection: Connection, rejected: ReadonlySet<string>, rejectedConnections: ReadonlySet<string>): Connection | null {
  if (rejectedConnections.has(connection.id) || rejected.has(connection.fromId) || rejected.has(connection.toId)) return null;
  return actor === "ai" ? { ...connection, sourceIds: connection.sourceIds.filter(id => !rejected.has(id)) } : connection;
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

  /** User-only active output; rejected ancestry is traversed but never returned. */
  exportThoughts(actor: Actor, rootId: string, count: number, traversal: "breadth" | "depth"): readonly Thought[] | null {
    requireUser(actor);
    let nodes: readonly ExportTreeNode[];
    if (this.repository.exportTree) nodes = this.repository.exportTree(rootId);
    else {
      const snapshot = this.repository.snapshot();
      const rejected = new Set(snapshot.rejectedThoughtIds);
      nodes = snapshot.thoughts.map(thought => ({ id: thought.id, parentId: thought.parentId, createdAt: thought.createdAt,
        thought: rejected.has(thought.id) ? null : { ...thought, sourceIds: thought.sourceIds.filter(id => !rejected.has(id)) } }));
    }
    const root = nodes.find(node => node.id === rootId);
    if (!root?.thought) return null;
    const children = new Map<string, ExportTreeNode[]>();
    for (const node of nodes) if (node.parentId !== null) {
      const siblings = children.get(node.parentId) ?? [];
      siblings.push(node);
      children.set(node.parentId, siblings);
    }
    const compare = (a: ExportTreeNode, b: ExportTreeNode) => a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    for (const siblings of children.values()) siblings.sort(compare);
    const pending = [root];
    let cursor = 0;
    const visited = new Set<string>();
    const result: Thought[] = [];
    while ((traversal === "breadth" ? cursor < pending.length : pending.length > 0) && result.length < count) {
      const node = traversal === "breadth" ? pending[cursor++] : pending.pop();
      if (!node || visited.has(node.id)) continue;
      visited.add(node.id);
      if (node.thought) result.push(node.thought);
      const next = children.get(node.id) ?? [];
      if (traversal === "breadth") for (const child of next) pending.push(child);
      else for (let i = next.length - 1; i >= 0; i--) { const child = next[i]; if (child) pending.push(child); }
    }
    return result;
  }

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

  private thoughtsInSnapshot(scope: ReadScope, snapshot: RejectionSnapshot): readonly ThoughtRead[] {
    const showRejected = inspection(scope);
    const rejected = new Set(snapshot.rejectedThoughtIds);
    if (showRejected) return snapshot.thoughts.map(thought => ({ ...thought, rejected: rejected.has(thought.id) }));
    return snapshot.thoughts.map(thought => scopeActiveThought(scope.actor, thought, rejected)).filter((thought): thought is Thought => thought !== null);
  }

  listThoughts(scope: ReadScope): readonly ThoughtRead[] {
    return this.thoughtsInSnapshot(scope, this.repository.snapshot());
  }

  private connectionsInSnapshot(scope: ReadScope, snapshot: RejectionSnapshot): readonly ConnectionRead[] {
    const showRejected = inspection(scope);
    const rejected = new Set(snapshot.rejectedThoughtIds);
    const rejectedConnections = new Set(snapshot.rejectedConnectionIds);
    if (showRejected) return snapshot.connections.map(connection => ({ ...connection, rejected: rejectedConnections.has(connection.id) }));
    return snapshot.connections.map(connection => scopeActiveConnection(scope.actor, connection, rejected, rejectedConnections))
      .filter((connection): connection is Connection => connection !== null);
  }

  listConnections(scope: ReadScope): readonly ConnectionRead[] {
    return this.connectionsInSnapshot(scope, this.repository.snapshot());
  }

  private relationshipSnapshot(scope: ReadScope, id: string): RejectionSnapshot | null {
    nonEmpty(id, "id");
    const snapshot = this.repository.snapshot();
    return this.thoughtsInSnapshot(scope, snapshot).some(thought => thought.id === id) ? snapshot : null;
  }

  listChildren(scope: ReadScope, id: string): readonly ThoughtRead[] | null {
    const snapshot = this.relationshipSnapshot(scope, id);
    return snapshot ? this.thoughtsInSnapshot(scope, snapshot).filter(thought => thought.parentId === id) : null;
  }

  listThoughtConnections(scope: ReadScope, id: string): readonly ConnectionRead[] | null {
    const snapshot = this.relationshipSnapshot(scope, id);
    return snapshot ? this.connectionsInSnapshot(scope, snapshot).filter(connection => connection.fromId === id || connection.toId === id) : null;
  }

  listThoughtResponses(scope: ReadScope, id: string): readonly ResponseRecord[] | null {
    const snapshot = this.relationshipSnapshot(scope, id);
    if (!snapshot) return null;
    return snapshot.responses.filter(response => response.thoughtIds.includes(id))
      .map(response => scopeSharedResponse(scope, response, snapshot.rejectedThoughtIds))
      .filter((response): response is ResponseRecord => response !== null);
  }

  getResponse(scope: ReadScope, id: string): ResponseRecord | null {
    inspection(scope);
    nonEmpty(id, "id");
    const snapshot = this.repository.snapshot();
    const response = snapshot.responses.find(item => item.id === id);
    return response ? scopeSharedResponse(scope, response, snapshot.rejectedThoughtIds) : null;
  }
}
