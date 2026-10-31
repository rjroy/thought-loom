import { isRecordId } from "./inspection";

export type WeavingWorkerState = "starting" | "working" | "waiting" | "unavailable" | "failed" | "stopped";
export type WeavingJobStatus = "queued" | "running" | "uncertain" | "completed" | "failed" | "interrupted";
export type WeavingWorkerView = { configured: boolean; state: WeavingWorkerState };
export type WeavingStatusView = {
  sourceId: string;
  worker: WeavingWorkerView;
  job: { id: string; status: WeavingJobStatus; attempts: number; recordedChanges: number | null };
  run: { id: string } | null;
  actions: { retry: boolean };
};
export type WeavingRetryInput = { expectedRunId: string };
// This is a command acknowledgment, not the current job state. Replays retain it
// even after the supervisor claims or completes the next attempt.
export type WeavingRetryReceipt = { id: string; sourceId: string; jobId: string; expectedRunId: string; status: "queued" };

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function count(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
export function isWeavingWorkerState(value: unknown): value is WeavingWorkerState {
  return value === "starting" || value === "working" || value === "waiting" || value === "unavailable" || value === "failed" || value === "stopped";
}
function status(value: unknown): value is WeavingJobStatus {
  return value === "queued" || value === "running" || value === "uncertain" || value === "completed" || value === "failed" || value === "interrupted";
}
export function parseWeavingWorkerView(value: unknown): WeavingWorkerView | null {
  if (!record(value) || typeof value.configured !== "boolean" || !isWeavingWorkerState(value.state) || (!value.configured && value.state !== "unavailable")) return null;
  return { configured: value.configured, state: value.state };
}
export function weavingWorkerAvailable(worker: WeavingWorkerView): boolean {
  return worker.configured && (worker.state === "starting" || worker.state === "working" || worker.state === "waiting");
}
export function parseWeavingStatusView(value: unknown): WeavingStatusView | null {
  if (!record(value) || !isRecordId(value.sourceId) || !record(value.job) || !record(value.actions) || typeof value.actions.retry !== "boolean") return null;
  const worker = parseWeavingWorkerView(value.worker), job = value.job;
  if (!worker || !isRecordId(job.id) || !status(job.status) || !count(job.attempts) || (job.recordedChanges !== null && !count(job.recordedChanges))) return null;
  let run: { id: string } | null = null;
  if (value.run !== null) {
    if (!record(value.run) || !isRecordId(value.run.id) || job.attempts < 1) return null;
    run = { id: value.run.id };
  }
  if (job.status === "queued" ? run !== null || job.recordedChanges !== null : run === null || job.recordedChanges === null) return null;
  if (value.actions.retry && (!weavingWorkerAvailable(worker) || (job.status !== "failed" && job.status !== "interrupted") || !run)) return null;
  return { sourceId: value.sourceId, worker, job: { id: job.id, status: job.status, attempts: job.attempts, recordedChanges: job.recordedChanges }, run, actions: { retry: value.actions.retry } };
}
export function parseWeavingRetryInput(value: unknown): WeavingRetryInput | null {
  return record(value) && Object.keys(value).length === 1 && isRecordId(value.expectedRunId) ? { expectedRunId: value.expectedRunId } : null;
}
export function parseWeavingRetryReceipt(value: unknown): WeavingRetryReceipt | null {
  if (!record(value) || !isRecordId(value.id) || !isRecordId(value.sourceId) || !isRecordId(value.jobId) || !isRecordId(value.expectedRunId) || value.status !== "queued") return null;
  return { id: value.id, sourceId: value.sourceId, jobId: value.jobId, expectedRunId: value.expectedRunId, status: "queued" };
}
