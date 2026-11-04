import type { IdeaThought, SharedResponse } from "../idea/types";
import { sharedResponse, thought } from "../idea/validation";
import type { AdmissionResult, AdmissionSnapshot, EvolveReceipt, EvolveRun, ObservationResult, ResolvedRun, StopResult } from "./types";
import { publicRun, validReceipt, validRun } from "./validation";

export type EvolveReadResult<T> = { readonly kind: "found"; readonly value: T } | { readonly kind: "unavailable" | "error"; readonly message: string };
/** Client-safe test seam for the existing normal-scoped selected-thought route. */
export async function readEvolveThought(id: string, deps: { readonly fetch: typeof fetch }): Promise<EvolveReadResult<IdeaThought>> {
  const error: EvolveReadResult<IdeaThought> = { kind: "error", message: "Thought unavailable." };
  try {
    const response = await deps.fetch(`/api/evolve/thoughts/${encodeURIComponent(id)}`, { method: "GET", cache: "no-store", redirect: "error" });
    if (response.status === 404) return { kind: "unavailable", message: "Thought unavailable." };
    if (response.status !== 200) return error;
    const value: unknown = await response.json();
    return thought(value) && value.id === id && value.rejected !== true ? { kind: "found", value } : error;
  } catch { return error; }
}
/** Call only with a known contribution or issued thought identity from the admitted run. */
export async function readEvolveResponse(thoughtId: string, responseId: string, deps: { readonly fetch: typeof fetch }): Promise<EvolveReadResult<SharedResponse>> {
  const error: EvolveReadResult<SharedResponse> = { kind: "error", message: "Response unavailable." };
  try {
    const response = await deps.fetch(`/api/evolve/thoughts/${encodeURIComponent(thoughtId)}/responses/${encodeURIComponent(responseId)}`, { method: "GET", cache: "no-store", redirect: "error" });
    if (response.status === 404) return { kind: "unavailable", message: "Response unavailable." };
    if (response.status !== 200) return error;
    const value: unknown = await response.json();
    return sharedResponse(value) && value.id === responseId && value.thoughtIds.includes(thoughtId) ? { kind: "found", value } : error;
  } catch { return error; }
}

export async function admitEvolve(snapshot: AdmissionSnapshot, deps: { readonly fetch: typeof fetch }): Promise<AdmissionResult> {
  const submitted = Object.freeze({ thoughtId: snapshot.thoughtId, text: snapshot.text });
  const result = (kind: "not-started" | "uncertain"): AdmissionResult => ({ kind, snapshot: submitted, message: kind === "uncertain" ? "Admission unconfirmed." : "Evolve was not started." });
  if (!submitted.thoughtId.trim() || !submitted.text.trim()) return result("not-started");
  try {
    const response = await deps.fetch(`/api/evolve/thoughts/${encodeURIComponent(submitted.thoughtId)}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: submitted.text }), cache: "no-store", redirect: "error",
    });
    if ([400, 401, 403, 404, 503].includes(response.status)) return result("not-started");
    if (response.status !== 201) return result("uncertain");
    const value: unknown = await response.json();
    return validReceipt(value, submitted) ? { kind: "admitted", receipt: { contribution: value.contribution, run: publicRun(value.run) } } : result("uncertain");
  } catch { return result("uncertain"); }
}
export async function observeEvolve(receipt: EvolveReceipt, deps: { readonly fetch: typeof fetch }): Promise<ObservationResult> {
  const unavailable: ObservationResult = { kind: "unavailable", message: "Run unavailable." };
  const id = receipt.run.id;
  if (!validRun(receipt.run)) return unavailable;
  try {
    const response = await deps.fetch(`/api/evolve/runs/${encodeURIComponent(id)}`, { method: "GET", cache: "no-store", redirect: "error" });
    if (response.status !== 200) return unavailable;
    const value: unknown = await response.json();
    return validRun(value, id) ? { kind: "observed", run: publicRun(value) } : unavailable;
  } catch { return unavailable; }
}
export async function stopEvolve(run: EvolveRun, deps: { readonly fetch: typeof fetch }): Promise<StopResult> {
  const saved = Object.freeze({ ...publicRun(run), confirmedThoughtIds: Object.freeze([...run.confirmedThoughtIds]) });
  const uncertain: StopResult = { kind: "uncertain", run: saved, message: "Stop unconfirmed." };
  if (!validRun(saved)) return uncertain;
  try {
    const response = await deps.fetch(`/api/evolve/runs/${encodeURIComponent(saved.id)}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}", cache: "no-store", redirect: "error",
    });
    if (response.status !== 200) return uncertain;
    const value: unknown = await response.json();
    return validRun(value, saved.id) ? { kind: "confirmed", run: publicRun(value) } : uncertain;
  } catch { return uncertain; }
}
export async function resolveEvolve(receipt: EvolveReceipt, run: EvolveRun, deps: { readonly getThought: (id: string, scope: "normal") => Promise<IdeaThought | null>; readonly getResponse: (id: string, scope: "normal") => Promise<SharedResponse | null> }): Promise<ResolvedRun> {
  const empty: ResolvedRun = { outputs: [], reply: null, replyUnavailable: false, continuationId: null };
  if (!validRun(receipt.run) || !validRun(run, receipt.run.id) || !thought(receipt.contribution)
      || receipt.contribution.author !== "user" || receipt.contribution.kind !== "user-contribution"
      || receipt.contribution.origin !== "contribution" || receipt.contribution.rejected === true) return empty;
  const knownRun = publicRun(run);
  const contributionId = receipt.contribution.id;
  const outputs: { id: string; thought: IdeaThought | null }[] = [];
  for (const id of knownRun.confirmedThoughtIds) {
    let value: IdeaThought | null = null;
    try { const candidate = await deps.getThought(id, "normal"); if (thought(candidate) && candidate.id === id && candidate.rejected !== true) value = candidate; } catch { /* Unavailable stays unavailable. */ }
    outputs.push({ id, thought: value });
  }
  let reply: SharedResponse | null = null;
  if (knownRun.responseId !== null) {
    try {
      const candidate = await deps.getResponse(knownRun.responseId, "normal");
      if (sharedResponse(candidate) && candidate.id === knownRun.responseId) {
        const ids = candidate.thoughtIds;
        const valid = candidate.role === "fallback"
          ? ids.length === 1 && ids[0] === contributionId
          : ids.every((id, index) => knownRun.confirmedThoughtIds.includes(id) && (index === 0 || knownRun.confirmedThoughtIds.indexOf(ids[index - 1]) < knownRun.confirmedThoughtIds.indexOf(id)));
        if (valid) reply = candidate;
      }
    } catch { /* Unavailable stays unavailable. */ }
  }
  let continuationId = outputs.findLast(item => item.thought !== null)?.id ?? null;
  if (!continuationId && reply?.role === "fallback" && reply.state === "complete") continuationId = contributionId;
  return { outputs, reply, replyUnavailable: knownRun.responseId !== null && reply === null, continuationId };
}
