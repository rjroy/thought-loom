import type { Database } from "bun:sqlite";
import type { AgentRunRepository, AgentRunView, EvolveAdmission } from "../domain/agent";
import { RunAdmissionService, RunConflictError, RunNotFoundError, type RunSources } from "../domain/run";
import { SqliteRunRepository } from "./run";
import type { ExportIntent, ExportReport } from "../domain/agentic-export";
import { SqliteAgenticExports } from "./agentic-export";

/** User-only domain service owns access; each returned projection is a consistent SQLite snapshot. */
export class SqliteAgentRuns implements AgentRunRepository {
  private readonly runs: SqliteRunRepository;
  private readonly admissions: RunAdmissionService;
  private readonly exports: SqliteAgenticExports;
  constructor(private readonly db: Database, sources: RunSources) {
    this.runs = new SqliteRunRepository(db,{...sources,scheduleWeave:true});
    this.admissions = new RunAdmissionService({...sources,repository:this.runs});
    this.exports = new SqliteAgenticExports(db,sources);
  }
  private read(id: string): AgentRunView | null {
    const run = this.runs.get(id);
    if (!run) return null;
    const issued = this.db.query("SELECT thought_id AS id FROM run_issued_thoughts WHERE run_id=? ORDER BY position").all(id) as {id:string}[];
    const reply = this.db.query("SELECT response_id AS id FROM run_replies WHERE run_id=?").get(id) as {id:string|null} | null;
    return {id:run.id,kind:run.kind,status:run.status,confirmedThoughtIds:issued.map(thought => thought.id),responseId:reply?.id ?? null};
  }
  admitEvolve(parentId: string, text: string): EvolveAdmission {
    return this.db.transaction(() => {
      // Run admission validates the selected parent under normal scope inside this same write transaction.
      const admission = this.admissions.admit("user","evolve",{parentId,text});
      const run = this.read(admission.run.id);
      if (!admission.contribution || !run) throw new RunConflictError("Evolve admission was not retained");
      return {contribution:admission.contribution,run};
    }).immediate();
  }
  admitExport(intent: ExportIntent): AgentRunView {
    return this.db.transaction(() => {
      const admitted = this.exports.admit("user",intent);
      const run = this.read(admitted.id);
      if (!run) throw new RunConflictError("Export admission was not retained");
      return run;
    }).immediate();
  }
  report(id: string): ExportReport | null { return this.exports.report("user",id); }
  status(id: string): AgentRunView | null { return this.db.transaction(() => this.read(id))(); }
  stop(id: string): AgentRunView {
    return this.db.transaction(() => {
      this.runs.stop(id);
      const run = this.read(id);
      if (!run) throw new RunNotFoundError();
      return run;
    }).immediate();
  }
}
