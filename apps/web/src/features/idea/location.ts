export type IdeaScope = "normal" | "history" | "show-rejected";
export interface IdeaLocation { readonly id: string; readonly scope: IdeaScope; readonly responseId?: string; readonly returnTo: string; }
export function decodeIdeaLocation(id: string, params: URLSearchParams): IdeaLocation | undefined {
  if (!id.trim() || [...params.keys()].some(key => !["scope", "responseId", "returnTo"].includes(key))
      || ["scope", "responseId", "returnTo"].some(key => params.getAll(key).length > 1)) return undefined;
  const explicit = params.get("scope");
  if (explicit !== null && explicit !== "normal" && explicit !== "history" && explicit !== "show-rejected") return undefined;
  const target = params.get("returnTo");
  let returnTo = "/explore", inferred: IdeaScope = "normal";
  if (target === "/explore") returnTo = target;
  else if (target && safeBrowseReturnTo(target)) returnTo = target;
  else if (target && safeSearchReturn(target)) returnTo = target;
  else if (target?.startsWith("/explore?") && !/[\\#\x00-\x1f\x7f]/.test(target)) {
    const query = decodeSearchQuery(new URLSearchParams(target.slice("/explore?".length)));
    if (query) { returnTo = target; if (query.scope === "show-rejected") inferred = "show-rejected"; }
  }
  const responseId = params.get("responseId");
  if (responseId !== null && !responseId.trim()) return undefined;
  return { id, scope: explicit ?? inferred, ...(responseId !== null ? { responseId } : {}), returnTo };
}
export function ideaActionHref(id: string, action: "evolve" | "export"): string {
  return `/${action}?${new URLSearchParams({ thoughtId: id })}`;
}
import { decodeSearchQuery } from "../explore/query";
import { safeSearchReturn } from "../agentic-search/location";
import { safeBrowseReturnTo } from "../browse/query";
