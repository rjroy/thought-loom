import type { IdeaScope } from "./location";
import type { BranchPreview, CommandResult, IdeaCommand, IdeaView } from "./types";
import { command as validCommand, createdConnection, preview, thought, view } from "./validation";
export type IdeaReadResult = { readonly kind: "view"; readonly value: IdeaView } | { readonly kind: "preview"; readonly value: BranchPreview }
  | { readonly kind: "unavailable" | "error"; readonly message: string };
// Cancellation is best-effort and must never delay or change the classified outcome.
function discard(response: Response): void {
  try { void response.body?.cancel().catch(() => {}); } catch { /* An unusable body remains an error. */ }
}
export async function readIdea(id: string, options: { readonly scope: IdeaScope; readonly part: "view" | "preview"; readonly responseId?: string }, deps: { readonly fetch: typeof fetch }): Promise<IdeaReadResult> {
  const error: IdeaReadResult = { kind: "error", message: "Idea unavailable." };
  try {
    const params = new URLSearchParams({ scope: options.scope, part: options.part });
    if (options.responseId !== undefined) params.set("responseId", options.responseId);
    const response = await deps.fetch(`/api/ideas/${encodeURIComponent(id)}?${params}`, { method: "GET", cache: "no-store", redirect: "error" });
    if (response.status !== 200) {
      discard(response);
      return response.status === 404 ? { kind: "unavailable", message: "Idea unavailable." } : error;
    }
    const data: unknown = await response.json();
    if (options.part === "view" && view(data) && data.thought.id === id) return { kind: "view", value: data };
    if (options.part === "preview" && preview(data, id)) return { kind: "preview", value: data };
    return error;
  } catch { return error; }
}
export async function commandIdea(command: IdeaCommand, deps: { readonly fetch: typeof fetch }): Promise<CommandResult> {
  const snapshot: IdeaCommand = Object.freeze(command.action === "reject-branch"
    ? { ...command, preview: Object.freeze({ ...command.preview, branchIds: Object.freeze([...command.preview.branchIds]), affectedIds: Object.freeze([...command.preview.affectedIds]) }) }
    : command.action === "create-connection" && Array.isArray(command.sourceIds)
    ? { ...command, sourceIds: Object.freeze([...command.sourceIds]) }
    : { ...command });
  const result = (kind: "not-applied" | "conflict" | "uncertain"): CommandResult => ({ kind, message: kind === "uncertain" ? "Outcome unconfirmed." : kind === "conflict" ? "The branch changed; review a new preview." : "The change was not applied.", command: snapshot });
  if (!validCommand(snapshot, snapshot.thoughtId)) return result("not-applied");
  try {
    const response = await deps.fetch(`/api/ideas/${encodeURIComponent(snapshot.thoughtId)}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(snapshot), cache: "no-store", redirect: "error",
    });
    if ([400, 401, 403, 404].includes(response.status)) { discard(response); return result("not-applied"); }
    if (response.status === 409 && snapshot.action === "reject-branch") { discard(response); return result("conflict"); }
    if (snapshot.action === "title" && response.status === 200) {
      const data: unknown = await response.json();
      return thought(data) && data.id === snapshot.thoughtId && data.title === snapshot.title
        && data.titleAuthor === (snapshot.title === null ? null : "user") ? { kind: "applied", thought: data } : result("uncertain");
    }
    if (snapshot.action === "create-connection" && response.status === 201) {
      const data: unknown = await response.json();
      return createdConnection(data, snapshot) ? { kind: "applied" } : result("uncertain");
    }
    if (snapshot.action !== "title" && snapshot.action !== "create-connection" && response.status === 204) return { kind: "applied" };
    discard(response);
    return result("uncertain");
  } catch { return result("uncertain"); }
}
