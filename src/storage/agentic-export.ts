import type { Database } from "bun:sqlite";
import { exportIntent, exportSources, renderExportReport, type AgenticExports, type ExportEffort, type ExportIntent, type ExportReport, type ExportSource } from "../domain/agentic-export";
import type { Actor } from "../domain/rejection";
import { RunConflictError, RunFenceError, RunForbiddenError, RunNotFoundError, type Claim, type RunRecord, type RunSources } from "../domain/run";
import { protocolJson } from "../domain/run-protocol";
import { displayTitle } from "../domain/thought";
import { nonEmpty } from "../domain/validation";
import { SqliteRunAggregate } from "./run-aggregate";

interface ReportRow { readonly promptId: string; readonly markdown: string; readonly sources: string }

/** Read-only knowledge execution on the existing run aggregate; report lifecycle writes never enter knowledge storage. */
export class SqliteAgenticExports extends SqliteRunAggregate implements AgenticExports {
  constructor(db: Database, private readonly sources: RunSources) { super(db,sources.logger); }
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
