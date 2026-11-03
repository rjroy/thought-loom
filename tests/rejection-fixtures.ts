import type { Thought } from "../src/domain/thought";
import type { Connection } from "../src/domain/connection";
import type { ResponseRecord } from "../src/domain/response";
import type { RejectionRepository, RejectionSnapshot, RejectionTransaction } from "../src/domain/rejection";

function thought(id: string, parentId: string | null, author: "user" | "ai", sourceIds: readonly string[] = []): Thought {
  return { id, parentId, author, sourceIds, text: `private text ${id}`, title: null, kind: "developing-idea", createdAt: "2026-01-01T00:00:00Z", origin: "test" };
}
export const thoughts = [
  thought("root", null, "user"), thought("child", "root", "ai", ["root", "outside"]),
  thought("grandchild", "child", "user"), thought("sibling", "root", "ai"), thought("outside", null, "user"),
];
export const links: Connection[] = [
  { id: "cross", fromId: "child", toId: "outside", category: "supports", proposedBy: "ai", explanation: "link rationale", sourceIds: ["root", "outside"] },
  { id: "within", fromId: "child", toId: "grandchild", category: "related", proposedBy: "user", explanation: "internal rationale", sourceIds: [] },
];
export const responses: ResponseRecord[] = [
  { id: "root-response", thoughtId: "root", role: "fallback", text: "private root response" },
  { id: "child-response", thoughtId: "child", role: "addendum", text: "child response" },
];

/** In-memory transaction double; copies mutable rejection state for rollback. */
export class MemoryRepository implements RejectionRepository {
  private thoughtState = new Set<string>();
  private connectionState = new Set<string>();
  snapshot(): RejectionSnapshot {
    return { thoughts, connections: links, responses, rejectedThoughtIds: [...this.thoughtState], rejectedConnectionIds: [...this.connectionState] };
  }
  transaction<T>(action: (tx: RejectionTransaction) => T): T {
    const oldThoughts = new Set(this.thoughtState);
    const oldConnections = new Set(this.connectionState);
    const tx: RejectionTransaction = {
      snapshot: () => this.snapshot(),
      setThoughtRejected: (id, rejected) => { if (rejected) this.thoughtState.add(id); else this.thoughtState.delete(id); },
      setConnectionRejected: (id, rejected) => { if (rejected) this.connectionState.add(id); else this.connectionState.delete(id); },
    };
    try { return action(tx); } catch (error) { this.thoughtState = oldThoughts; this.connectionState = oldConnections; throw error; }
  }
}
