import { record } from "./validation";
import type { Thought } from "./thought";

export const SCREENING_NOMINATION_THRESHOLD = 0.60;
export interface ScreeningPolicy {
  readonly version: "connection-screening-1";
  readonly threshold: number;
  readonly judgeIdentity: string;
}
export type ScreeningFailure = "screening-unavailable" | "eligibility-changed" | "configuration-changed";
/** Private historical fact, separate from a model's probability. */
export interface ScreeningExclusion { readonly kind: "already-connected"; readonly connectionId: string }
export type ScreeningFinalization = { readonly kind: "pending" } | { readonly kind: "ready"; readonly thoughts: readonly Thought[] };
export function screeningPolicy(judgeIdentity: string): string {
  if (!judgeIdentity.trim()) throw new Error("Screening identity required");
  return JSON.stringify({version:"connection-screening-1",threshold:SCREENING_NOMINATION_THRESHOLD,judgeIdentity});
}
export function parseScreeningPolicy(json: string): ScreeningPolicy {
  const value = record(JSON.parse(json));
  if (value.version !== "connection-screening-1" || typeof value.threshold !== "number" || !Number.isFinite(value.threshold) ||
      value.threshold < 0 || value.threshold > 1 || typeof value.judgeIdentity !== "string" || !value.judgeIdentity.trim() ||
      JSON.stringify({version:value.version,threshold:value.threshold,judgeIdentity:value.judgeIdentity}) !== json) {
    throw new Error("Invalid screening policy");
  }
  return {version:value.version,threshold:value.threshold,judgeIdentity:value.judgeIdentity};
}
export function screeningJudgment(score: number): string {
  if (!Number.isFinite(score) || score < 0 || score > 1) throw new Error("Invalid screening judgment");
  return JSON.stringify({score});
}
export function parseScreeningJudgment(json: string): number {
  const value = record(JSON.parse(json));
  if (typeof value.score !== "number" || screeningJudgment(value.score) !== json) throw new Error("Invalid screening judgment");
  return value.score;
}
