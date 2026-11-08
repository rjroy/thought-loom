import type { OrdinaryAgentRunView } from "./agent";
import type { Actor } from "./rejection";
import { RunConflictError, RunForbiddenError } from "./run";
import { nonEmpty, record, ValidationError } from "./validation";

const keyPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const triggerPrefix = "reinterpret:";
export function reinterpretationRequestKey(value: unknown): string {
  if (typeof value !== "string" || !keyPattern.test(value)) throw new ValidationError("Invalid reinterpretation request key");
  return value;
}
export function reinterpretationTrigger(key: string): string { return `${triggerPrefix}${reinterpretationRequestKey(key)}`; }
export function isReinterpretationTrigger(trigger: string): boolean {
  return trigger.startsWith(triggerPrefix) && keyPattern.test(trigger.slice(triggerPrefix.length));
}

export type WeaveRunControl = Omit<OrdinaryAgentRunView,"kind"> & {readonly kind:"weave"};
export type ReinterpretationEligibility =
  | {readonly eligible:true;readonly reason:null;readonly blockingRun:null}
  | {readonly eligible:false;readonly reason:"subject-rejected";readonly blockingRun:null}
  | {readonly eligible:false;readonly reason:"work-active"|"work-unsettled"|"work-unverified";readonly blockingRun:WeaveRunControl};
export interface ReinterpretationSnapshot {
  readonly receipt: {readonly subjectId:string;readonly requestKey:string;readonly runId:string} | null;
  readonly run: WeaveRunControl | null;
  readonly eligibility: ReinterpretationEligibility;
}
export interface ReinterpretationAdmission {readonly snapshot:ReinterpretationSnapshot;readonly replayed:boolean}
export interface ReinterpretationRepository {
  admit(subjectId: string, requestKey: string): ReinterpretationAdmission;
  byKey(subjectId: string, requestKey: string): ReinterpretationSnapshot;
}
export class ReinterpretationConflictError extends RunConflictError {
  constructor(readonly code:"interpretation-active"|"interpretation-unsettled",readonly snapshot:ReinterpretationSnapshot) { super(code); }
}

/** User command receipts are control/history reads, never AI retrieval or publication authority. */
export class ReinterpretationService {
  constructor(private readonly repository: ReinterpretationRepository) {}
  private user(actor: Actor): void { if (actor !== "user") throw new RunForbiddenError("Reinterpretation is user-only"); }
  admit(actor: Actor, subjectId: string, requestKey: unknown, input: unknown): ReinterpretationAdmission {
    this.user(actor); nonEmpty(subjectId,"subjectId");
    const key = reinterpretationRequestKey(requestKey);
    if (Object.keys(record(input)).length !== 0) throw new ValidationError("Reinterpretation requires an empty object");
    return this.repository.admit(subjectId,key);
  }
  byKey(actor: Actor, subjectId: string, requestKey: unknown): ReinterpretationSnapshot {
    this.user(actor); nonEmpty(subjectId,"subjectId");
    return this.repository.byKey(subjectId,reinterpretationRequestKey(requestKey));
  }
}
