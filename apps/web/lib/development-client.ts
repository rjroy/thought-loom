import { parseDialogueView, type DialogueSelection } from "@thoughtloom/contracts";

export class DevelopmentError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

export async function postDevelopment(path: string, input: object, key: string): Promise<unknown> {
  console.info("development.command attempt", { path });
  try {
    const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify(input), signal: AbortSignal.timeout(10_000) });
    const body: unknown = await response.json();
    if (!response.ok) {
      const code = typeof body === "object" && body !== null && "error" in body && typeof body.error === "string" ? body.error : "command_unconfirmed";
      throw new DevelopmentError(response.status, code);
    }
    console.info("development.command acknowledged", { path, status: response.status });
    return body;
  } catch (error) {
    console.warn("development.command unresolved", { path, status: error instanceof DevelopmentError ? error.status : 0 });
    throw error instanceof DevelopmentError ? error : new DevelopmentError(503, "command_unconfirmed");
  }
}

export async function getDialogue(id: string, root: string, signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(10_000);
  const response = await fetch(`/api/dialogues/${encodeURIComponent(id)}`, { cache: "no-store", signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  const view = response.ok ? parseDialogueView(await response.json()) : null;
  if (!view || view.id !== id || view.sourceId !== root) throw new DevelopmentError(response.status, "discussion_unavailable");
  return view;
}

// Canonical outcomes are immutable. A delayed live snapshot must not revive
// their preview, or remove a later turn already observed in this discussion.
export function reconcileDialogue(previous: ReturnType<typeof parseDialogueView>, incoming: NonNullable<ReturnType<typeof parseDialogueView>>) {
  if (!previous) return incoming;
  if (previous.id !== incoming.id || previous.sourceId !== incoming.sourceId || selectionKey(previous.selection) !== selectionKey(incoming.selection)) throw new DevelopmentError(503, "discussion_identity_changed");
  const last = incoming.turns.at(-1), position = last ? previous.turns.findIndex((turn) => turn.id === last.id) : -1;
  if ((!last && previous.turns.length) || (position >= 0 && position < previous.turns.length - 1)) return previous;
  const known = new Map(previous.turns.map((turn) => [turn.id, turn]));
  return { ...incoming, turns: incoming.turns.map((turn) => {
    const prior = known.get(turn.id);
    return prior && (prior.assistant !== undefined || ["completed", "failed", "interrupted"].includes(prior.status)) ? prior : turn;
  }) };
}

export function selectionKey(selection: DialogueSelection): string {
  if (selection.kind === "source") return JSON.stringify(["source", selection.id]);
  if (selection.kind === "item") return JSON.stringify(["item", selection.id, selection.versionId]);
  return JSON.stringify(["relationship", selection.id, selection.versionId, selection.fromVersionId, selection.toVersionId]);
}

export async function creationKey(root: string, selection: DialogueSelection): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(["thoughtloom-context-v1", root, selectionKey(selection)])));
  return `discussion_${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
