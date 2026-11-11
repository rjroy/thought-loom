import type { Database } from "bun:sqlite";
import type { AgentRunRepository, AgentRunView, EvolveAdmission, OrdinaryAgentRunView } from "../domain/agent";
import { RunAdmissionService, RunConflictError, RunNotFoundError, type RunSources } from "../domain/run";
import { SqliteRunRepository } from "./run";
import type { ExportIntent, ExportReport } from "../domain/agentic-export";
import { SqliteAgenticExports } from "./agentic-export";
import { createLogger, type Logger } from "../logging";
import { logCommittedInterruption } from "./run-fences";

/** User-only domain service owns access; each returned projection is a consistent SQLite snapshot. */
export class SqliteAgentRuns implements AgentRunRepository {
  private readonly runs: SqliteRunRepository;
  private readonly admissions: RunAdmissionService;
  private readonly exports: SqliteAgenticExports;
  private readonly logger: Logger;
  constructor(private readonly db: Database, sources: RunSources) {
    this.logger = sources.logger ?? createLogger();
    this.runs = new SqliteRunRepository(db,{...sources,scheduleWeave:true});
    this.admissions = new RunAdmissionService({...sources,repository:this.runs});
    this.exports = new SqliteAgenticExports(db,sources);
  }
  private read(id: string): AgentRunView | null {
    const run = this.runs.get(id);
    if (!run) return null;
    if (run.kind === "search") return null; // Search-specific public status/Stop DTOs belong to their later route scope.
    if (run.kind === "import") {
      const file=this.db.query("SELECT id AS fileId,import_id AS importId FROM markdown_import_files WHERE run_id=?").get(id) as {fileId:string;importId:string}|null;
      if (!file) throw new RunConflictError("Import run owner is unavailable");
      return {id:run.id,kind:"import",status:run.status,...file};
    }
    const issued = this.db.query("SELECT thought_id AS id FROM run_issued_thoughts WHERE run_id=? ORDER BY position").all(id) as {id:string}[];
    const reply = this.db.query("SELECT response_id AS id FROM run_replies WHERE run_id=?").get(id) as {id:string|null} | null;
    return {id:run.id,kind:run.kind,status:run.status,confirmedThoughtIds:issued.map(thought => thought.id),responseId:reply?.id ?? null};
  }
  admitEvolve(parentId: string, text: string): EvolveAdmission {
    return this.db.transaction(() => {
      // Run admission validates the selected parent under normal scope inside this same write transaction.
      const admission = this.admissions.admit("user","evolve",{parentId,text});
      const run = this.read(admission.run.id);
      if (!admission.contribution || !run || run.kind!=="evolve") throw new RunConflictError("Evolve admission was not retained");
      return {contribution:admission.contribution,run};
    }).immediate();
  }
  admitExport(intent: ExportIntent): OrdinaryAgentRunView {
    return this.db.transaction(() => {
      const admitted = this.exports.admit("user",intent);
      const run = this.read(admitted.id);
      if (!run || run.kind!=="export") throw new RunConflictError("Export admission was not retained");
      return run;
    }).immediate();
  }
  report(id: string): ExportReport | null { return this.exports.report("user",id); }
  status(id: string): AgentRunView | null { return this.db.transaction(() => this.read(id))(); }
  stop(id: string): AgentRunView {
    const outerTransaction = this.db.inTransaction;
    const outcome = this.db.transaction(() => {
      const existing = this.read(id);
      if (!existing) throw new RunNotFoundError();
      const before = this.runs.get(id);
      if (existing.kind === "export" && this.exports.get("user",id)) this.exports.stop("user",id);
      else this.runs.stop(id);
      const run = this.read(id);
      if (!run) throw new RunNotFoundError();
      return { run, before };
    }).immediate();
    if (!outerTransaction && outcome.before && !["completed","interrupted","failed"].includes(outcome.before.status)) {
      logCommittedInterruption(this.db,this.logger,{ run: outcome.before, reason: "stopped" });
    }
    return outcome.run;
  }
}
