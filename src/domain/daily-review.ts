import { record } from "./validation";

export interface DailyReviewPolicy { readonly rotationDays: number; readonly maxPerDay: number }
export const defaultDailyReviewPolicy: DailyReviewPolicy = Object.freeze({rotationDays:30,maxPerDay:20});
export const dailyReviewPrefix = "daily-review:";
export interface DailyReviewCandidate {
  readonly id: string;
  readonly createdAt: string;
  readonly lastReviewedAt: string | null;
  readonly lastAttemptedAt: string | null;
}
export type DailyReviewAdmission =
  | { readonly kind: "admitted"; readonly date: string; readonly runIds: readonly string[] }
  | { readonly kind: "unconfigured" | "already-admitted" | "empty" | "deferred"; readonly date: string };
export interface DailyReviewCommands {
  admitDueBatch(now: string, agentsConfigured: boolean): DailyReviewAdmission;
  lastReviewedAt(thoughtId: string): string | null;
}

export function dailyReviewPolicy(input: unknown): DailyReviewPolicy {
  const value = record(input);
  if (Object.keys(value).length !== 2 || !Number.isSafeInteger(value.rotationDays) || Number(value.rotationDays) <= 0 ||
      !Number.isSafeInteger(value.maxPerDay) || Number(value.maxPerDay) <= 0) throw new Error("Invalid daily review policy");
  return Object.freeze({rotationDays:Number(value.rotationDays),maxPerDay:Number(value.maxPerDay)});
}
export function dailyReviewPolicyJson(policy: DailyReviewPolicy): string {
  const value = dailyReviewPolicy(policy);
  return JSON.stringify({rotationDays:value.rotationDays,maxPerDay:value.maxPerDay});
}
export function parseDailyReviewPolicy(json: string): DailyReviewPolicy {
  const value = dailyReviewPolicy(JSON.parse(json));
  if (dailyReviewPolicyJson(value) !== json) throw new Error("Invalid daily review policy encoding");
  return value;
}
export function dailyReviewCeiling(count: number, policy: DailyReviewPolicy): number {
  const valid = dailyReviewPolicy(policy);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error("Invalid eligible thought count");
  return Math.min(valid.maxPerDay,Math.ceil(count / valid.rotationDays));
}
/** Scheduling/completion writes use canonical UTC; immutable older thought dates are not rewritten. */
export function dailyReviewInstant(now: string): string {
  if (typeof now !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(now)) throw new Error("Invalid review time");
  const date = new Date(now);
  if (!Number.isFinite(date.getTime()) || date.toISOString().replace(".000Z","Z") !== now.replace(".000Z","Z")) throw new Error("Invalid review time");
  return date.toISOString();
}
export function dailyReviewDate(triggerId: string): string | null {
  if (!triggerId.startsWith(dailyReviewPrefix) && triggerId !== "daily-review") return null;
  const date = triggerId.slice(dailyReviewPrefix.length);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || dailyReviewInstant(`${date}T00:00:00Z`).slice(0,10) !== date) throw new Error("Invalid daily review trigger");
  return date;
}
export function dailyReviewTrigger(date: string): string {
  const trigger = `${dailyReviewPrefix}${date}`;
  dailyReviewDate(trigger);
  return trigger;
}
const encoder = new TextEncoder();
function binary(left: string, right: string): number {
  const a = encoder.encode(left), b = encoder.encode(right);
  for (let i=0;i<Math.min(a.length,b.length);i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}
function nullable(left: string | null, right: string | null): number {
  return left === null ? right === null ? 0 : -1 : right === null ? 1 : binary(left,right);
}
/** Attempt age breaks equal successful-review ages, never substitutes for successful review. */
export function selectDailyReviewSubjects(candidates: readonly DailyReviewCandidate[], limit: number): readonly string[] {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("Invalid review limit");
  return candidates.toSorted((a,b) => nullable(a.lastReviewedAt,b.lastReviewedAt) || nullable(a.lastAttemptedAt,b.lastAttemptedAt) ||
    binary(a.createdAt,b.createdAt) || binary(a.id,b.id)).slice(0,limit).map(item => item.id);
}
