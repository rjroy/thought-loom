import type { IdeaThought } from "../idea/types";
import { record } from "../idea/validation";
export interface SimpleExportInput { readonly rootId: string; readonly count: number; readonly traversal: "breadth" | "depth"; }
export interface AgenticExportInput { readonly request: string; readonly effort: "quick" | "standard" | "thorough"; }
export interface ExportRun { readonly id: string; readonly kind: "export"; readonly status: "queued" | "submitting" | "running" | "uncertain" | "completed" | "interrupted" | "failed"; readonly confirmedThoughtIds: readonly string[]; readonly responseId: string | null; }
export interface MarkdownArtifact { readonly bytes: Uint8Array; readonly text: string; }
export type ArtifactResult = { readonly kind: "ready"; readonly artifact: MarkdownArtifact } | { readonly kind: "not-ready" | "unavailable" | "error"; readonly message: string };
export type AdmissionResult = { readonly kind: "admitted"; readonly run: ExportRun } | { readonly kind: "not-started" | "uncertain"; readonly snapshot: AgenticExportInput; readonly message: string };
export type RunResult = { readonly kind: "observed"; readonly run: ExportRun } | { readonly kind: "unavailable"; readonly run: ExportRun; readonly message: string };
export interface ExportSource { readonly id: string; readonly thought: IdeaThought | null; }
export interface ExportHistoryItem extends AgenticExportInput {
  readonly id: string;
  readonly status: ExportRun["status"];
  readonly createdAt: string;
  readonly restored: boolean;
  readonly deletionState: "stop-required" | "settling" | "ready";
}
export interface ExportHistoryPage { readonly items: readonly ExportHistoryItem[]; readonly nextCursor: string | null; }
export const exportId = (id: string) => /^[A-Za-z0-9_~.-]+$/.test(id) && id !== "." && id !== "..";
export const terminalExportStatus = (status: ExportRun["status"]) => ["completed", "interrupted", "failed"].includes(status);

export function validExportHistoryItem(value: unknown, id?: string): value is ExportHistoryItem {
  return record(value) && typeof value.id === "string" && exportId(value.id) && (id === undefined || value.id === id)
    && typeof value.status === "string" && ["queued", "submitting", "running", "uncertain", "completed", "interrupted", "failed"].includes(value.status)
    && typeof value.createdAt === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value.createdAt) && Number.isFinite(Date.parse(value.createdAt))
    && typeof value.request === "string" && !!value.request.trim()
    && typeof value.effort === "string" && ["quick", "standard", "thorough"].includes(value.effort)
    && typeof value.restored === "boolean" && typeof value.deletionState === "string" && ["stop-required", "settling", "ready"].includes(value.deletionState)
    && (value.deletionState !== "ready" || ["completed", "interrupted", "failed"].includes(value.status));
}
export function publicExportHistoryItem(item: ExportHistoryItem): ExportHistoryItem {
  return { id: item.id, status: item.status, createdAt: item.createdAt, request: item.request, effort: item.effort, restored: item.restored, deletionState: item.deletionState };
}
export function decodeExportHistoryPage(value: unknown, limit = 50): ExportHistoryPage | null {
  if (!record(value) || !Array.isArray(value.items) || value.items.length > limit || !value.items.every(item => validExportHistoryItem(item))
    || !(value.nextCursor === null || (typeof value.nextCursor === "string" && !!value.nextCursor.trim() && value.nextCursor.length <= 8192))
    || new Set(value.items.map(item => item.id)).size !== value.items.length) return null;
  return { items: value.items.map(publicExportHistoryItem), nextCursor: value.nextCursor };
}

export function validExportRun(value: unknown, id?: string): value is ExportRun {
  return record(value) && typeof value.id === "string" && !!value.id.trim() && (id === undefined || value.id === id)
    && value.kind === "export" && typeof value.status === "string"
    && ["queued", "submitting", "running", "uncertain", "completed", "interrupted", "failed"].includes(value.status)
    && Array.isArray(value.confirmedThoughtIds) && value.confirmedThoughtIds.every(item => typeof item === "string" && !!item.trim())
    && new Set(value.confirmedThoughtIds).size === value.confirmedThoughtIds.length
    && (value.responseId === null || (typeof value.responseId === "string" && !!value.responseId.trim()));
}
export function publicExportRun(run: ExportRun): ExportRun {
  return { id: run.id, kind: run.kind, status: run.status, confirmedThoughtIds: [...run.confirmedThoughtIds], responseId: run.responseId };
}
export function validSimple(value: unknown): value is SimpleExportInput {
  return record(value) && Object.keys(value).length === 3 && typeof value.rootId === "string" && !!value.rootId.trim()
    && typeof value.count === "number" && Number.isInteger(value.count) && value.count > 0
    && (value.traversal === "breadth" || value.traversal === "depth");
}
export function validAgentic(value: unknown): value is AgenticExportInput {
  return record(value) && Object.keys(value).length === 2 && typeof value.request === "string" && !!value.request.trim()
    && (value.effort === "quick" || value.effort === "standard" || value.effort === "thorough");
}
