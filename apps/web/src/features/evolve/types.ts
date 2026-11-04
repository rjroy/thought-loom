import type { IdeaThought, SharedResponse } from "../idea/types";
export type RunStatus = "queued" | "submitting" | "running" | "uncertain" | "completed" | "interrupted" | "failed";
export interface EvolveRun { readonly id: string; readonly kind: "evolve"; readonly status: RunStatus; readonly confirmedThoughtIds: readonly string[]; readonly responseId: string | null; }
export interface EvolveReceipt { readonly contribution: IdeaThought; readonly run: EvolveRun; }
export interface AdmissionSnapshot { readonly thoughtId: string; readonly text: string; }
export type AdmissionResult = { readonly kind: "admitted"; readonly receipt: EvolveReceipt } | { readonly kind: "not-started" | "uncertain"; readonly snapshot: AdmissionSnapshot; readonly message: string };
export type ObservationResult = { readonly kind: "observed"; readonly run: EvolveRun } | { readonly kind: "unavailable"; readonly message: string };
export type StopResult = { readonly kind: "confirmed"; readonly run: EvolveRun } | { readonly kind: "uncertain"; readonly run: EvolveRun; readonly message: string };
export interface ResolvedRun { readonly outputs: readonly { readonly id: string; readonly thought: IdeaThought | null }[]; readonly reply: SharedResponse | null; readonly replyUnavailable: boolean; readonly continuationId: string | null; }
