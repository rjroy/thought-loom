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
  const response = await fetch(`/api/dialogues/${encodeURIComponent(id)}`, { cache: "no-store", signal: signal ?? AbortSignal.timeout(10_000) });
  const view = response.ok ? parseDialogueView(await response.json()) : null;
  if (!view || view.id !== id || view.sourceId !== root) throw new DevelopmentError(response.status, "discussion_unavailable");
  return view;
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
