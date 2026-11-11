import type { RunStatus } from "./run";
import type { ExportEffort } from "./agentic-export";
import { nonEmpty, record, ValidationError } from "./validation";
import type { Actor } from "./rejection";
import type { AgenticExports } from "./agentic-export";

export type ExportDeletionState = "stop-required" | "settling" | "ready";
export type ExportLocalDisposition = "retained" | "local-stopped" | "deleting";
export interface ExportHistoryItem {
  readonly id: string;
  readonly status: RunStatus;
  readonly createdAt: string;
  readonly request: string;
  readonly effort: ExportEffort;
  readonly deletionState: ExportDeletionState;
  readonly restored: boolean;
}
export interface ExportHistoryCursor {
  readonly kind: "export-history";
  readonly limit: number;
  readonly createdAt: string;
  readonly id: string;
}
export interface ExportHistoryPage {
  readonly items: readonly ExportHistoryItem[];
  readonly nextCursor: ExportHistoryCursor | null;
}

/** User-scoped history and local retention operations, separate from agent execution. */
export class ExportHistoryService {
  constructor(private readonly exports: Pick<AgenticExports,"list"|"get"|"delete">) {}
  list(actor: Actor, request?: unknown): ExportHistoryPage { return this.exports.list(actor,exportHistoryRequest(request)); }
  get(actor: Actor, runId: string): ExportHistoryItem | null { return this.exports.get(actor,runId); }
  delete(actor: Actor, runId: string): void { this.exports.delete(actor,runId); }
}

function fields(value: Record<string,unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new ValidationError("Invalid export history fields");
}
export function exportHistoryRequest(input: unknown = {}): {readonly limit:number;readonly cursor:ExportHistoryCursor|null} {
  const value = record(input); fields(value,["limit","cursor"]);
  const data = value.cursor === undefined || value.cursor === null ? null : record(value.cursor);
  const limit = value.limit ?? data?.limit ?? 50;
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new ValidationError("Invalid export history limit");
  if (data === null) return {limit,cursor:null};
  fields(data,["kind","limit","createdAt","id"]);
  if (data.kind !== "export-history" || data.limit !== limit) throw new ValidationError("Invalid export history cursor");
  return {limit,cursor:{kind:"export-history",limit,
    createdAt:nonEmpty(data.createdAt,"createdAt"),id:nonEmpty(data.id,"id")}};
}
