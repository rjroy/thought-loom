/** Application-owned SQL shared by export lifecycle commands and immutable-delete guards. */
export const exportTerminalStatuses = "'completed','interrupted','failed'";

export function exportRestoreFenceSql(runId: string): string {
  return `EXISTS(SELECT 1 FROM main.restore_fences export_fence WHERE export_fence.entity_kind='run' AND export_fence.entity_id=${runId})`;
}

export function exportSettledSql(run: string): string {
  return `((${run}.status='completed' AND ${run}.cancellation_state IN ('none','settled'))
    OR (${run}.status IN ('interrupted','failed') AND ${run}.cancellation_state='settled'))`;
}

export function exportDeletionReadySql(run: string, intent: string): string {
  return `(${run}.status IN (${exportTerminalStatuses}) AND
    (${exportSettledSql(run)} OR (${exportRestoreFenceSql(`${run}.id`)} AND ${intent}.local_disposition='local-stopped')))`;
}

/** The retained intent is consumed only by the final run-delete trigger, after all other owned rows. */
export function exportPurgeSql(runId: string): string {
  return `EXISTS(SELECT 1 FROM runs export_owner JOIN export_intents export_intent ON export_intent.run_id=export_owner.id
    WHERE export_owner.id=${runId} AND export_owner.kind='export' AND export_owner.status IN (${exportTerminalStatuses})
      AND export_intent.local_disposition='deleting')`;
}

export const exportOwnedChildTables = ["export_reports", "run_issued_thoughts", "run_operation_receipts", "run_replies",
  "run_context", "agent_bindings", "run_steps"] as const;

/** No cross-kind ownership may be cascaded or erased as a side effect of an export purge. */
export function exportPurgeCompleteSql(runId: string): string {
  return `(${exportPurgeSql(runId)} AND NOT ${exportRestoreFenceSql(runId)}
    ${[...exportOwnedChildTables, "search_turns", "markdown_import_files", "search_native_cleanup"]
      .map(table => `AND NOT EXISTS(SELECT 1 FROM ${table} WHERE run_id=${runId})`).join("\n")})`;
}
