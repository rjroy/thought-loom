import { parseDialogueChanges, type DialogueChange } from "./dialogue";
import { isRecordId } from "./inspection";
import { isWeavingJobStatus, parseWeavingWorkerView, weavingWorkerAvailable, type WeavingJobStatus, type WeavingWorkerView } from "./weaving";

export const FOLLOW_UP_LIMITS = { jobs: 16, origins: 32, targets: 64, changes: 64 } as const;
export const FOLLOW_UP_CONTEXT_LIMITS = { targets: 16, origins: 8, characters: 16_000 } as const;
export type FollowUpLimits = { jobs: number; origins: number; targets: number; changes: number };
export type FollowUpContextLimits = { targets: number; origins: number; characters: number };
export type FollowUpTargetView = { kind: "item" | "relationship"; id: string; versionId: string };
export type FollowUpOriginView =
  | { kind: "dialogue"; runId: string; dialogueId: string; turnId: string; turnSourceId: string }
  | { kind: "user"; operationId: string };
export type FollowUpJobView = {
  id: string; status: WeavingJobStatus; attempts: number; run: { id: string } | null;
  recordedChanges: number;
  origins: FollowUpOriginView[]; originsTruncated: boolean;
  targets: FollowUpTargetView[]; targetsTruncated: boolean;
  changes: DialogueChange[]; changesTruncated: boolean;
  actions: { retry: boolean };
};
export type FollowUpStatusView = { sourceId: string; worker: WeavingWorkerView; jobs: FollowUpJobView[]; truncated: boolean };
export type FollowUpRetryInput = { expectedRunId: string };
export type FollowUpRetryReceipt = { id: string; sourceId: string; jobId: string; expectedRunId: string; status: "queued" };
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function count(value: unknown): value is number { return Number.isSafeInteger(value) && typeof value === "number" && value >= 0; }
export function parseFollowUpOrigin(value: unknown): FollowUpOriginView | null {
  if (!record(value)) return null;
  if (value.kind === "user" && isRecordId(value.operationId)) return { kind: "user", operationId: value.operationId };
  return value.kind === "dialogue" && isRecordId(value.runId) && isRecordId(value.dialogueId) && isRecordId(value.turnId) && isRecordId(value.turnSourceId)
    ? { kind: "dialogue", runId: value.runId, dialogueId: value.dialogueId, turnId: value.turnId, turnSourceId: value.turnSourceId } : null;
}
export function parseFollowUpTarget(value: unknown): FollowUpTargetView | null {
  return record(value) && (value.kind === "item" || value.kind === "relationship") && isRecordId(value.id) && isRecordId(value.versionId)
    ? { kind: value.kind, id: value.id, versionId: value.versionId } : null;
}
function list<T>(value: unknown, parse: (entry: unknown) => T | null): T[] | null {
  if (!Array.isArray(value) || value.length > 1024) return null;
  const entries: T[] = [];
  for (const entry of value) { const parsed = parse(entry); if (!parsed) return null; entries.push(parsed); }
  return entries;
}
export function parseFollowUpStatusView(value: unknown): FollowUpStatusView | null {
  if (!record(value) || !isRecordId(value.sourceId) || typeof value.truncated !== "boolean" || !Array.isArray(value.jobs) || value.jobs.length > 1024) return null;
  const worker = parseWeavingWorkerView(value.worker);
  if (!worker) return null;
  const jobs: FollowUpJobView[] = [];
  for (const entry of value.jobs) {
    if (!record(entry) || !isRecordId(entry.id) || !isWeavingJobStatus(entry.status) || !count(entry.attempts) || !count(entry.recordedChanges) ||
        !record(entry.actions) || typeof entry.actions.retry !== "boolean" || typeof entry.originsTruncated !== "boolean" ||
        typeof entry.targetsTruncated !== "boolean" || typeof entry.changesTruncated !== "boolean") return null;
    const origins = list(entry.origins, parseFollowUpOrigin), targets = list(entry.targets, parseFollowUpTarget);
    const changes = Array.isArray(entry.changes) && entry.changes.length <= 1024 ? parseDialogueChanges(entry.changes) : null;
    if (!origins || !targets || !changes || origins.some((origin) => origin.kind === "dialogue" && origin.turnSourceId === value.sourceId)) return null;
    let run: { id: string } | null = null;
    if (entry.run !== null) { if (!record(entry.run) || !isRecordId(entry.run.id) || entry.attempts < 1) return null; run = { id: entry.run.id }; }
    if ((entry.status === "queued") !== (run === null) || (entry.actions.retry && (!weavingWorkerAvailable(worker) || !run || !["failed", "interrupted"].includes(entry.status)))) return null;
    if (new Set(origins.map((origin) => origin.kind === "user" ? `user:${origin.operationId}` : `dialogue:${origin.runId}`)).size !== origins.length ||
        new Set(targets.map((target) => JSON.stringify([target.kind, target.id, target.versionId]))).size !== targets.length ||
        new Set(changes.map((change) => JSON.stringify([change.kind, change.id, change.versionId]))).size !== changes.length || changes.length > entry.recordedChanges) return null;
    jobs.push({ id: entry.id, status: entry.status, attempts: entry.attempts, run, recordedChanges: entry.recordedChanges, origins, targets, changes,
      originsTruncated: entry.originsTruncated, targetsTruncated: entry.targetsTruncated, changesTruncated: entry.changesTruncated, actions: { retry: entry.actions.retry } });
  }
  return new Set(jobs.map((job) => job.id)).size === jobs.length ? { sourceId: value.sourceId, worker, jobs, truncated: value.truncated } : null;
}
export function parseFollowUpRetryInput(value: unknown): FollowUpRetryInput | null {
  return record(value) && Object.keys(value).length === 1 && isRecordId(value.expectedRunId) ? { expectedRunId: value.expectedRunId } : null;
}
export function parseFollowUpRetryReceipt(value: unknown): FollowUpRetryReceipt | null {
  return record(value) && isRecordId(value.id) && isRecordId(value.sourceId) && isRecordId(value.jobId) && isRecordId(value.expectedRunId) && value.status === "queued"
    ? { id: value.id, sourceId: value.sourceId, jobId: value.jobId, expectedRunId: value.expectedRunId, status: "queued" } : null;
}
