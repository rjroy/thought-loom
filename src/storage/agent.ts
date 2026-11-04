import type { Database } from "bun:sqlite";
import type { AgentRunRepository, AgentRunView, EvolveAdmission } from "../domain/agent";
import { RunAdmissionService, RunConflictError, RunNotFoundError, type RunSources } from "../domain/run";
import { SqliteRunRepository } from "./run";

/** User-only domain service owns access; each returned projection is a consistent SQLite snapshot. */
export class SqliteAgentRuns implements AgentRunRepository {
  private readonly runs: SqliteRunRepository;
  private readonly admissions: RunAdmissionService;
  constructor(private readonly db: Database, sources: RunSources) {
    this.runs = new SqliteRunRepository(db,{...sources,scheduleWeave:true});
    this.admissions = new RunAdmissionService({...sources,repository:this.runs});
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
