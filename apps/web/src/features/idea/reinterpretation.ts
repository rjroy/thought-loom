/** User-only control projection; no thought content or native identities. */
export interface ReinterpretationRun {
  readonly id: string; readonly kind: "weave";
  readonly status: "queued" | "submitting" | "running" | "uncertain" | "completed" | "interrupted" | "failed";
  readonly confirmedThoughtIds: readonly string[]; readonly responseId: string | null;
}
export type ReinterpretationEligibility =
  | {readonly eligible:true; readonly reason:null; readonly blockingRun:null}
  | {readonly eligible:false; readonly reason:"subject-rejected"; readonly blockingRun:null}
  | {readonly eligible:false; readonly reason:"work-active" | "work-unsettled" | "work-unverified"; readonly blockingRun:ReinterpretationRun};
export interface ReinterpretationSnapshot {
  readonly receipt: {readonly subjectId:string; readonly requestKey:string; readonly runId:string} | null;
  readonly run: ReinterpretationRun | null;
  readonly eligibility: ReinterpretationEligibility;
}
export interface InterpretationRetirement {
  readonly runId: string;
  readonly retiredAt: string | null;
  readonly eligibility: ReinterpretationEligibility;
}
export interface ConfirmedInterpretationRetirement extends InterpretationRetirement {
  readonly retiredAt: string;
  readonly remoteState: "unknown";
}
export const reinterpretationKey = (value: string): boolean => /^[A-Za-z0-9._:-]{1,128}$/.test(value) && value !== "." && value !== "..";
export const reinterpretationId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_~.-]+$/.test(value) && value !== "." && value !== "..";
const record = (value: unknown): value is Record<string,unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const exact = (value: Record<string,unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value,key));
export function reinterpretationRun(value: unknown): value is ReinterpretationRun {
  return record(value) && exact(value,["id","kind","status","confirmedThoughtIds","responseId"]) && reinterpretationId(value.id)
    && value.kind === "weave" && typeof value.status === "string" && ["queued","submitting","running","uncertain","completed","interrupted","failed"].includes(value.status)
    && Array.isArray(value.confirmedThoughtIds) && value.confirmedThoughtIds.every(reinterpretationId)
    && new Set(value.confirmedThoughtIds).size === value.confirmedThoughtIds.length && (value.responseId === null || reinterpretationId(value.responseId));
}
export function reinterpretationEligibility(value: unknown): value is ReinterpretationEligibility {
  if (!record(value) || !exact(value,["eligible","reason","blockingRun"])) return false;
  return value.eligible === true && value.reason === null && value.blockingRun === null
    || value.eligible === false && value.reason === "subject-rejected" && value.blockingRun === null
    || value.eligible === false && typeof value.reason === "string" && ["work-active","work-unsettled","work-unverified"].includes(value.reason) && reinterpretationRun(value.blockingRun);
}
export function interpretationRetirement(value: unknown, runId: string): value is InterpretationRetirement {
  return record(value) && exact(value,["runId","retiredAt","eligibility"]) && retirementFields(value,runId);
}
export function confirmedInterpretationRetirement(value: unknown, runId: string): value is ConfirmedInterpretationRetirement {
  return record(value) && exact(value,["runId","retiredAt","remoteState","eligibility"])
    && retirementFields(value,runId) && value.retiredAt !== null && value.remoteState === "unknown";
}
function retirementFields(value: Record<string,unknown>, runId: string): boolean {
  return reinterpretationId(runId) && value.runId === runId && reinterpretationEligibility(value.eligibility)
    && (value.retiredAt === null || typeof value.retiredAt === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value.retiredAt) && Number.isFinite(Date.parse(value.retiredAt)));
}
/** The blocker, rather than an unrelated admission receipt, owns recovery controls. */
export function interpretationBlocker(eligibility: ReinterpretationEligibility | null): ReinterpretationRun | null {
  return eligibility?.eligible === false ? eligibility.blockingRun : null;
}
export function retirementCandidate(eligibility: ReinterpretationEligibility | null): ReinterpretationRun | null {
  const blocker = interpretationBlocker(eligibility);
  return blocker && ["failed","interrupted"].includes(blocker.status) ? blocker : null;
}
export function reinterpretationSnapshot(value: unknown, subjectId: string, requestKey: string): value is ReinterpretationSnapshot {
  if (!reinterpretationKey(requestKey) || !record(value) || !exact(value,["receipt","run","eligibility"]) || !reinterpretationEligibility(value.eligibility)) return false;
  if (value.receipt === null) return value.run === null;
  return record(value.receipt) && exact(value.receipt,["subjectId","requestKey","runId"])
    && value.receipt.subjectId === subjectId && value.receipt.requestKey === requestKey && reinterpretationId(value.receipt.runId)
    && reinterpretationRun(value.run) && value.run.id === value.receipt.runId;
}
