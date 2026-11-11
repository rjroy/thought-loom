import type { Database, SQLQueryBindings } from "bun:sqlite";
import { exportIntent, exportSources, renderExportReport, type AgenticExports, type ExportEffort, type ExportIntent, type ExportReport, type ExportSource } from "../domain/agentic-export";
import type { Actor } from "../domain/rejection";
import { RunConflictError, RunFenceError, RunForbiddenError, RunNotFoundError, type Claim, type RunRecord, type RunSources } from "../domain/run";
import { protocolJson } from "../domain/run-protocol";
import { displayTitle } from "../domain/thought";
import { nonEmpty } from "../domain/validation";
import { SqliteRunAggregate } from "./run-aggregate";
import { exportHistoryRequest, type ExportHistoryItem, type ExportHistoryPage } from "../domain/export-history";
import { exportDeletionReadySql, exportOwnedChildTables, exportRestoreFenceSql } from "./export-lifecycle-sql";
import { assertRestoreFenceSchema } from "./restore-fences-schema";
import { isRunRestoreFenced } from "./restore-fences";

interface ReportRow { readonly promptId: string; readonly markdown: string; readonly sources: string }
interface HistoryRow extends Omit<ExportHistoryItem,"deletionState"|"restored"> {
  readonly restored: number;
  readonly ready: number;
}
const historyColumns = `r.id,r.status,r.created_at AS createdAt,i.request,i.effort,
  ${exportRestoreFenceSql("r.id")} AS restored,${exportDeletionReadySql("r","i")} AS ready`;
const historyOwner = "runs r JOIN export_intents i ON i.run_id=r.id";
const bytes = (value: string): Uint8Array => new TextEncoder().encode(nonEmpty(value,"runId"));
function historyItem(row: HistoryRow): ExportHistoryItem {
  const {ready,restored,...metadata} = row;
  return Object.freeze({...metadata,restored:restored !== 0,
    deletionState:ready !== 0 ? "ready" : restored !== 0 || ["queued","submitting","running","uncertain"].includes(row.status) ? "stop-required" : "settling"});
}

/** Read-only knowledge execution on the existing run aggregate; report lifecycle writes never enter knowledge storage. */
export class SqliteAgenticExports extends SqliteRunAggregate implements AgenticExports {
  constructor(db: Database, private readonly sources: RunSources) { super(db,sources.logger); }
  private user(actor: Actor): void { if (actor !== "user") throw new RunForbiddenError(); }
  private historyRow(runId: string): HistoryRow | null {
    return this.db.query<HistoryRow,[Uint8Array]>(`SELECT ${historyColumns} FROM ${historyOwner}
      WHERE r.kind='export' AND r.id=CAST(? AS TEXT)`).get(bytes(runId));
  }
  list(actor: Actor, request?: unknown): ExportHistoryPage {
    this.user(actor);
    const {limit,cursor} = exportHistoryRequest(request);
    return this.transaction("list export history","exports",() => {
      assertRestoreFenceSchema(this.db);
      const after = cursor ? "AND (r.created_at,r.id)<(CAST(? AS TEXT),CAST(? AS TEXT))" : "";
      const params: SQLQueryBindings[] = cursor ? [new TextEncoder().encode(cursor.createdAt),bytes(cursor.id),limit+1] : [limit+1];
      const rows = this.db.query<HistoryRow,SQLQueryBindings[]>(
        `SELECT ${historyColumns} FROM ${historyOwner} WHERE r.kind='export'
          ${after} ORDER BY r.created_at DESC,r.id DESC LIMIT ?`).all(...params);
      const items = rows.slice(0,limit).map(historyItem), last = items.at(-1);
      return Object.freeze({items:Object.freeze(items),nextCursor:rows.length>limit && last ?
        Object.freeze({kind:"export-history" as const,limit,createdAt:last.createdAt,id:last.id}) : null});
    });
  }
  get(actor: Actor, runId: string): ExportHistoryItem | null {
    this.user(actor); bytes(runId);
    return this.transaction("read export metadata",runId,() => {
      assertRestoreFenceSchema(this.db);
      const row = this.historyRow(runId); return row === null ? null : historyItem(row);
    });
  }
  stop(actor: Actor, runId: string): void {
    this.user(actor); bytes(runId);
    this.transaction("stop export",runId,() => {
      const restored = isRunRestoreFenced(this.db,runId), row = this.historyRow(runId);
      if (!row) throw new RunNotFoundError();
      if (restored) {
        if (!["completed","interrupted","failed"].includes(row.status)) throw new RunConflictError("Restored export must be inert before local discard");
        const changed = this.db.run(`UPDATE export_intents SET local_disposition='local-stopped'
          WHERE run_id=CAST(? AS TEXT) AND local_disposition='retained'`,[bytes(runId)]);
        if (changed.changes !== 0) this.logger.info("[export] restored local Stop applied in transaction",{runId,remoteWork:"unaffected"});
        else this.logger.verbose("[export] restored local Stop already acknowledged",{runId});
      } else if (["queued","submitting","running","uncertain"].includes(row.status)) this.finalInterrupt(this.require(runId));
    });
  }
  delete(actor: Actor, runId: string): void {
    this.user(actor); const identity = bytes(runId);
    this.logger.info("[export] local deletion attempt",{runId});
    try {
      this.transaction("delete export",runId,() => {
        // Repeat exact identity/schema authority before consulting metadata or granting the purge disposition.
        isRunRestoreFenced(this.db,runId);
        const row = this.historyRow(runId);
        if (!row) throw new RunNotFoundError();
        if (historyItem(row).deletionState !== "ready") throw new RunConflictError("Export requires Stop or cancellation settlement before deletion");
        for (const table of ["search_turns","markdown_import_files","search_native_cleanup"]) {
          if (this.db.query(`SELECT 1 FROM ${table} WHERE run_id=CAST(? AS TEXT)`).get(identity)) throw new RunConflictError("Export has unrelated execution ownership");
        }
        this.db.run("UPDATE export_intents SET local_disposition='deleting' WHERE run_id=CAST(? AS TEXT)",[identity]);
        for (const table of exportOwnedChildTables) this.db.run(`DELETE FROM ${table} WHERE run_id=CAST(? AS TEXT)`,[identity]);
        this.db.run("DELETE FROM restore_fences WHERE entity_kind='run' AND entity_id=CAST(? AS TEXT)",[identity]);
        // The root trigger validates complete child removal and consumes the still-present intent witness.
        this.db.run("DELETE FROM runs WHERE id=CAST(? AS TEXT)",[identity]);
        for (const table of ["export_intents",...exportOwnedChildTables]) {
          if (this.db.query(`SELECT 1 FROM ${table} WHERE run_id=CAST(? AS TEXT)`).get(identity)) throw new RunConflictError("Export deletion is incomplete");
        }
        if (this.db.query("SELECT 1 FROM runs WHERE id=CAST(? AS TEXT)").get(identity) ||
            this.db.query("SELECT 1 FROM restore_fences WHERE entity_kind='run' AND entity_id=CAST(? AS TEXT)").get(identity)) throw new RunConflictError("Export deletion is incomplete");
      });
      this.logger.info("[export] local deletion succeeded",{runId});
    } catch (error) { this.logger.warning("[export] local deletion refused or failed",{runId}); throw error; }
  }
  admit(actor: Actor, input: { readonly request: string; readonly effort?: ExportEffort }): RunRecord {
    if (actor !== "user") throw new RunForbiddenError();
    const intent = exportIntent(input);
    const {id,now} = this.sources;
    const run: RunRecord = {id:nonEmpty(id(),"runId"),kind:"export",status:"queued",sessionId:nonEmpty(this.sources.sessionId?.() ?? id(),"sessionId"),
      promptId:nonEmpty(this.sources.promptId?.() ?? id(),"promptId"),createdAt:nonEmpty(now(),"createdAt"),generation:0,inputThoughtId:null,nativeState:"unknown"};
    return this.transaction("admit export",run.id,() => {
      this.insertRun(run);
      this.db.run("INSERT INTO export_intents (run_id,request,effort) VALUES (?,?,?)",[run.id,intent.request,intent.effort]);
      return Object.freeze(run);
    });
  }
  intent(runId: string): ExportIntent | null {
    this.require(runId);
    const row = this.db.query("SELECT request,effort FROM export_intents WHERE run_id=?").get(runId) as ExportIntent | null;
    return row === null ? null : exportIntent(row);
  }
  private read(runId: string): { readonly row: ReportRow; readonly report: ExportReport } | null {
    const row = this.db.query("SELECT prompt_id AS promptId,markdown,sources_json AS sources FROM export_reports WHERE run_id=?").get(runId) as ReportRow | null;
    if (!row) return null;
    try { return {row,report:Object.freeze({runId,markdown:row.markdown,sources:exportSources(JSON.parse(row.sources))})}; }
    catch { throw new RunConflictError("Invalid retained export report"); }
  }
  finalize(claim: Claim, promptId: string): ExportReport {
    return this.guarded("finalize export report",claim,(run,visible) => {
      if (run.kind !== "export") throw new RunForbiddenError();
      if (!this.intent(run.id)) throw new RunConflictError("Legacy export request is unavailable; cannot infer intent");
      if (run.promptId !== promptId) throw new RunFenceError("Report belongs to an earlier prompt");
      const step = this.currentStep(run.id);
      if (step.input === null || step.state !== "completed" || step.envelope?.kind !== "report") throw new RunConflictError("A canonical completed report is required");
      const envelope = step.envelope;
      const sources = envelope.sourceThoughtIds.map((id): ExportSource => {
        const thought = visible({kind:"thought",id});
        if (!thought || !("parentId" in thought)) throw new RunNotFoundError();
        if (!this.db.query("SELECT 1 FROM run_context WHERE run_id=? AND kind='thought' AND ref_id=? AND full_read=1").get(run.id,id)) {
          throw new RunForbiddenError("A full thought read is required for a report citation");
        }
        return {id:thought.id,title:displayTitle(thought),author:thought.author,kind:thought.kind};
      });
      const existing = this.read(run.id);
      let report: ExportReport;
      if (existing) {
        if (existing.row.promptId !== promptId || protocolJson(existing.report.sources.map(source => source.id)) !== protocolJson(envelope.sourceThoughtIds) ||
            renderExportReport(envelope.markdown,existing.report.sources) !== existing.report.markdown) throw new RunConflictError("Retained report differs from its completed source payload");
        report = existing.report;
      } else {
        report = Object.freeze({runId:run.id,markdown:renderExportReport(envelope.markdown,sources),sources:exportSources(sources)});
        this.db.run("INSERT INTO export_reports (run_id,prompt_id,markdown,sources_json) VALUES (?,?,?,?)",[run.id,promptId,report.markdown,protocolJson(report.sources)]);
      }
      this.db.run("UPDATE runs SET status='completed',generation=generation+1 WHERE id=?",[run.id]);
      return report;
    });
  }
  report(actor: Actor, runId: string): ExportReport | null {
    if (actor !== "user") throw new RunForbiddenError();
    nonEmpty(runId,"runId");
    // Deliberate human history access: later rejection cannot rewrite this immutable artifact or expose it to AI.
    return this.transaction("read export report",runId,() => this.read(runId)?.report ?? null);
  }
}
