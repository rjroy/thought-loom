import type { MediaDescriptor, MediaIdeaThought } from "../idea/media";

export interface MediaRun {
  readonly id: string;
  readonly kind: "weave";
  readonly status: "queued" | "submitting" | "running" | "uncertain" | "completed" | "interrupted" | "failed";
  readonly confirmedThoughtIds: readonly string[];
  readonly responseId: string | null;
}
export interface MediaReceipt { readonly thought: MediaIdeaThought; readonly run: MediaRun }
export interface MediaUploadSnapshot { readonly file: File; readonly clarification: string | null; readonly key: string }
export interface MediaProblem { readonly status: number | null; readonly code: string | null }
export type MediaUploadResult = { readonly kind: "confirmed"; readonly receipt: MediaReceipt }
  | { readonly kind: "not-started" | "uncertain"; readonly problem: MediaProblem };
export type MediaReceiptResult = { readonly kind: "confirmed"; readonly receipt: MediaReceipt }
  | { readonly kind: "absent" | "error" };
export interface MediaClient {
  readonly upload: (snapshot: MediaUploadSnapshot) => Promise<MediaUploadResult>;
  readonly byKey: (key: string) => Promise<MediaReceiptResult>;
}
export interface MediaImportWorkspace {
  readonly file: File | null;
  readonly clarification: string;
  readonly admission: "editing" | "pending" | "not-started" | "uncertain" | "saved";
  readonly snapshot: MediaUploadSnapshot | null;
  readonly receipt: MediaReceipt | null;
  readonly checking: boolean;
  readonly receiptCheck: "none" | "absent" | "error";
  readonly problem: MediaProblem | null;
  readonly selectionError: string | null;
}

export type MediaScope = "normal" | "history";
export type MediaRetryEligibility = { readonly eligible: true; readonly reason: null }
  | { readonly eligible: false; readonly reason: "source-rejected" | "interpretation-exists" | "work-active" | "work-unsettled" | "work-completed" };
export interface MediaSourceInspection { readonly thought: MediaIdeaThought; readonly run: MediaRun | null; readonly retry: MediaRetryEligibility }
export type MediaSourceRead = { readonly kind: "found"; readonly value: MediaSourceInspection } | { readonly kind: "unavailable" | "error" };
export type MediaRunRead = { readonly kind: "found"; readonly run: MediaRun } | { readonly kind: "error" };
export type MediaRetryResult = { readonly kind: "confirmed"; readonly run: MediaRun }
  | { readonly kind: "refused" | "conflict" | "uncertain"; readonly problem: MediaProblem };
export type MediaStopResult = { readonly kind: "confirmed"; readonly run: MediaRun } | { readonly kind: "uncertain" };
export type MediaDownload = { readonly kind: "ready"; readonly bytes: Uint8Array; readonly mimeType: string; readonly filename: string }
  | { readonly kind: "error" };
export interface MediaSourceClient {
  readonly readSource: (sourceId: string, scope: MediaScope, signal?: AbortSignal) => Promise<MediaSourceRead>;
  readonly readRun: (runId: string, signal?: AbortSignal) => Promise<MediaRunRead>;
  readonly retry: (sourceId: string, key: string) => Promise<MediaRetryResult>;
  readonly stop: (run: MediaRun) => Promise<MediaStopResult>;
  readonly download: (source: MediaDescriptor, scope: MediaScope) => Promise<MediaDownload>;
}
export interface MediaRetrySnapshot { readonly sourceId: string; readonly key: string }
export interface MediaSourceWorkspace {
  readonly phase: "idle" | "ready" | "unavailable" | "error";
  readonly run: MediaRun | null;
  readonly retry: MediaRetryEligibility | null;
  readonly rejected: boolean | null;
  readonly checking: boolean;
  readonly fresh: boolean;
  readonly retryRequest: { readonly kind: "idle" } | { readonly kind: "pending" | "uncertain"; readonly snapshot: MediaRetrySnapshot };
  readonly stopping: boolean;
  readonly unconfirmedStop: MediaRun | null;
  readonly notice: "none" | "retry-conflict" | "retry-refused" | "key-unavailable" | "stop-requested";
}
