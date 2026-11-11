import { decodeExportHistoryPage, publicExportHistoryItem, validExportHistoryItem, publicExportRun, validAgentic, validExportRun, validSimple, type ExportHistoryItem, type ExportHistoryPage, type AgenticExportInput, type AdmissionResult, type ArtifactResult, type ExportRun, type MarkdownArtifact, type RunResult, type SimpleExportInput } from "./types";
import type { IdeaThought } from "../idea/types";
import { record, thought } from "../idea/validation";

export type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const error = (): ArtifactResult => ({ kind: "error", message: "Export unavailable." });
/** Abandoned bodies must not keep browser requests open or expose upstream text. */
function discard(response: Response): void {
  try { void response.body?.cancel().catch(() => {}); } catch { /* Cleanup cannot change the outcome. */ }
}
async function artifact(response: Response): Promise<ArtifactResult> {
  if (response.status === 409) { discard(response); return { kind: "not-ready", message: "Report is not ready." }; }
  if (response.status === 404) { discard(response); return { kind: "unavailable", message: "Export unavailable." }; }
  if (response.status !== 200 || !/^text\/markdown(?:\s*;|\s*$)/i.test(response.headers.get("content-type") ?? "")) { discard(response); return error(); }
  const bytes = new Uint8Array(await response.arrayBuffer());
  return { kind: "ready", artifact: { bytes, text: new TextDecoder().decode(bytes) } };
}
export async function readExportThought(id: string, deps: { readonly fetch: Fetch }): Promise<IdeaThought | null> {
  try {
    const response = await deps.fetch(`/api/export/thoughts/${encodeURIComponent(id)}`, { method: "GET", cache: "no-store", redirect: "error" });
    if (response.status !== 200) { discard(response); return null; }
    const value: unknown = await response.json();
    return thought(value) && value.id === id && value.rejected !== true ? value : null;
  } catch { return null; }
}
export async function requestSimple(input: SimpleExportInput, deps: { readonly fetch: Fetch }): Promise<ArtifactResult> {
  const snapshot = { rootId: input.rootId, count: input.count, traversal: input.traversal };
  if (!validSimple(snapshot)) return error();
  try {
    const response = await deps.fetch("/api/export/simple", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(snapshot), cache: "no-store", redirect: "error" });
    return await artifact(response);
  } catch { return error(); }
}
export async function admitExport(input: AgenticExportInput, deps: { readonly fetch: Fetch }): Promise<AdmissionResult> {
  const snapshot = Object.freeze({ request: input.request, effort: input.effort });
  const failure = (kind: "not-started" | "uncertain"): AdmissionResult => ({ kind, snapshot, message: kind === "uncertain" ? "Admission unconfirmed." : "Export was not started." });
  if (!validAgentic(snapshot)) return failure("not-started");
  try {
    const response = await deps.fetch("/api/export/agentic", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(snapshot), cache: "no-store", redirect: "error" });
    if ([400, 401, 403, 404, 503].includes(response.status)) { discard(response); return failure("not-started"); }
    if (response.status !== 201) { discard(response); return failure("uncertain"); }
    const value: unknown = await response.json();
    return record(value) && validExportRun(value.run) ? { kind: "admitted", run: publicExportRun(value.run) } : failure("uncertain");
  } catch { return failure("uncertain"); }
}
async function runRequest(run: ExportRun, deps: { readonly fetch: Fetch }, stop: boolean): Promise<RunResult> {
  const snapshot = Object.freeze({ ...publicExportRun(run), confirmedThoughtIds: Object.freeze([...run.confirmedThoughtIds]) });
  const unavailable: RunResult = { kind: "unavailable", run: snapshot, message: stop ? "Stop unconfirmed." : "Run unavailable." };
  if (!validExportRun(snapshot)) return unavailable;
  try {
    const response = await deps.fetch(`/api/export/runs/${encodeURIComponent(snapshot.id)}`, stop
      ? { method: "POST", headers: { "content-type": "application/json" }, body: "{}", cache: "no-store", redirect: "error" }
      : { method: "GET", cache: "no-store", redirect: "error" });
    if (response.status !== 200) { discard(response); return unavailable; }
    const value: unknown = await response.json();
    return validExportRun(value, snapshot.id) ? { kind: "observed", run: publicExportRun(value) } : unavailable;
  } catch { return unavailable; }
}
export function observeExport(run: ExportRun, deps: { readonly fetch: Fetch }): Promise<RunResult> { return runRequest(run, deps, false); }
export function stopExport(run: ExportRun, deps: { readonly fetch: Fetch }): Promise<RunResult> { return runRequest(run, deps, true); }
export async function readReport(run: ExportRun, deps: { readonly fetch: Fetch }): Promise<ArtifactResult> {
  if (!validExportRun(run) || run.status !== "completed") return { kind: "not-ready", message: "Report is not ready." };
  try {
    const response = await deps.fetch(`/api/export/agentic/${encodeURIComponent(run.id)}`, { method: "GET", cache: "no-store", redirect: "error" });
    return await artifact(response);
  } catch { return error(); }
}
export function downloadBytes(artifact: MarkdownArtifact): Uint8Array { return artifact.bytes.slice(); }

export async function readExportHistory(cursor: string | null, deps: { readonly fetch: Fetch }): Promise<{ kind: "ready"; page: ExportHistoryPage } | { kind: "error" | "restart" }> {
  try {
    const query = cursor ? `?${new URLSearchParams({ cursor })}` : "";
    const response = await deps.fetch(`/api/export/agentic${query}`, { method: "GET", cache: "no-store", redirect: "error" });
    if (response.status !== 200) { discard(response); return { kind: response.status === 400 && cursor ? "restart" : "error" }; }
    const page = decodeExportHistoryPage(await response.json());
    return page ? { kind: "ready", page } : { kind: "error" };
  } catch { return { kind: "error" }; }
}
export async function readExportMetadata(id: string, deps: { readonly fetch: Fetch }): Promise<{ kind: "ready"; item: ExportHistoryItem } | { kind: "missing" | "error" }> {
  try {
    const response = await deps.fetch(`/api/export/agentic/${encodeURIComponent(id)}/metadata`, { method: "GET", cache: "no-store", redirect: "error" });
    if (response.status !== 200) { discard(response); return { kind: response.status === 404 ? "missing" : "error" }; }
    const item: unknown = await response.json();
    return validExportHistoryItem(item, id) ? { kind: "ready", item: publicExportHistoryItem(item) } : { kind: "error" };
  } catch { return { kind: "error" }; }
}
export async function deleteExport(id: string, deps: { readonly fetch: Fetch }): Promise<"deleted" | "conflict" | "missing" | "uncertain"> {
  try {
    const response = await deps.fetch(`/api/export/agentic/${encodeURIComponent(id)}`, { method: "DELETE", cache: "no-store", redirect: "error" });
    discard(response);
    return response.status === 204 ? "deleted" : response.status === 409 ? "conflict" : response.status === 404 ? "missing" : "uncertain";
  } catch { return "uncertain"; }
}
