import type { Database } from "bun:sqlite";
import { ReinterpretationConflictError, reinterpretationTrigger, type ReinterpretationAdmission, type ReinterpretationEligibility,
  type ReinterpretationRepository, type ReinterpretationSnapshot, type WeaveRunControl } from "../domain/reinterpretation";
import { RunConflictError, RunNotFoundError, type RunSources } from "../domain/run";
import type { MaterialKind } from "../domain/thought";
import { resolveWeavePurpose } from "../domain/weave-scheduling";
import { createLogger, type Logger } from "../logging";
import { SqliteAgentRuns } from "./agent";
import { subjectWeaveWork, weaveWorkBlockReason } from "./weave-work";
import { immediate } from "./transaction";
import { admitWeave } from "./weave-admission";

interface SubjectControl {readonly kind:MaterialKind;readonly rejected:number}
interface RetirementIdentity { readonly status:string; readonly generation:number; readonly triggerId:string; readonly retiredAt:string|null }
export interface RetirementSnapshot { readonly runId:string; readonly retiredAt:string|null; readonly eligibility:ReinterpretationEligibility }

/** A weave trigger is the durable receipt. No network calls, content reads or independent command journal. */
export class SqliteReinterpretations implements ReinterpretationRepository {
  private readonly logger: Logger;
  private readonly runs: SqliteAgentRuns;
  constructor(private readonly db: Database, private readonly sources: RunSources) {
    this.logger = sources.logger ?? createLogger();
    this.runs = new SqliteAgentRuns(db,sources);
  }
  private subject(subjectId: string): SubjectControl {
    const subject = this.db.query<SubjectControl,[string]>(`SELECT kind,
      EXISTS(SELECT 1 FROM rejected_thoughts WHERE thought_id=t.id) AS rejected FROM thoughts t WHERE id=?`).get(subjectId);
    if (!subject) throw new RunNotFoundError();
    return subject;
  }
  private run(runId: string): WeaveRunControl {
    const run = this.runs.status(runId);
    if (!run || run.kind !== "weave") throw new RunConflictError("Reinterpretation weave is unavailable");
    return {...run,kind:"weave"};
  }
  private eligibility(subjectId: string, subject: SubjectControl): ReinterpretationEligibility {
    if (subject.rejected) return {eligible:false,reason:"subject-rejected",blockingRun:null};
    for (const row of subjectWeaveWork(this.db,subjectId,subject.kind)) {
      const reason = weaveWorkBlockReason(this.db,row);
      if (reason !== null) return {eligible:false,reason,blockingRun:this.run(row.id)};
    }
    return {eligible:true,reason:null,blockingRun:null};
  }
  private snapshot(subjectId: string, requestKey: string, subject: SubjectControl): ReinterpretationSnapshot {
    const receipt = this.db.query<{id:string},[string,string]>(`SELECT id FROM runs
      WHERE kind='weave' AND weave_subject_id=? AND weave_trigger_id=? ORDER BY rowid LIMIT 1`).get(subjectId,reinterpretationTrigger(requestKey));
    const run = receipt ? this.run(receipt.id) : null;
    return {receipt:run ? {subjectId,requestKey,runId:run.id} : null,run,eligibility:this.eligibility(subjectId,subject)};
  }
  private retirementIdentity(subjectId: string, runId: string): RetirementIdentity {
    const row = this.db.query<RetirementIdentity,[string,string]>(`SELECT status,generation,weave_trigger_id AS triggerId,weave_retired_at AS retiredAt
      FROM runs WHERE id=? AND kind='weave' AND weave_subject_id=? AND weave_trigger_id IS NOT NULL`).get(runId,subjectId);
    if (!row) throw new RunNotFoundError();
    return row;
  }
  retirement(subjectId: string, runId: string): RetirementSnapshot {
    this.logger.verbose("[reinterpretation] retirement lookup attempt",{runId});
    try {
      const result = this.db.transaction(() => {
        const subject = this.subject(subjectId), identity = this.retirementIdentity(subjectId,runId);
        return {runId,retiredAt:identity.retiredAt,eligibility:this.eligibility(subjectId,subject)};
      })();
      this.logger.verbose("[reinterpretation] retirement lookup succeeded",{runId});
      return result;
    } catch (error) { this.logger.verbose("[reinterpretation] retirement lookup failed",{runId}); throw error; }
  }
  /** The caller joins the exact run's local execution before invoking the returned synchronous commit. */
  prepareRetirement(subjectId: string, runId: string): () => RetirementSnapshot & {remoteState:"unknown"} {
    this.logger.info("[reinterpretation] retirement attempt",{runId});
    let expected: RetirementIdentity;
    try {
      const subject = this.subject(subjectId);
      expected = this.retirementIdentity(subjectId,runId);
      if (!["failed","interrupted"].includes(expected.status) || resolveWeavePurpose(subject.kind,expected.triggerId) === "media-title-only") {
        throw new RunConflictError("Weave cannot be retired");
      }
    }
    catch (error) { this.logger.warning("[reinterpretation] retirement refused",{runId}); throw error; }
    return () => {
      try {
        const snapshot = immediate(this.db,() => {
          const subject = this.subject(subjectId), current = this.retirementIdentity(subjectId,runId);
          if (current.status !== expected.status || current.generation !== expected.generation || current.triggerId !== expected.triggerId ||
              !["failed","interrupted"].includes(current.status) || resolveWeavePurpose(subject.kind,current.triggerId) === "media-title-only") {
            throw new RunConflictError("Weave cannot be retired");
          }
          const retiredAt = current.retiredAt ?? this.sources.now();
          if (current.retiredAt === null) this.db.run("UPDATE runs SET weave_retired_at=? WHERE id=?",[retiredAt,runId]);
          return {runId,retiredAt,remoteState:"unknown" as const,eligibility:this.eligibility(subjectId,subject)};
        });
        this.logger.info("[reinterpretation] retirement recorded",{runId});
        return snapshot;
      } catch (error) { this.logger.warning("[reinterpretation] retirement refused",{runId}); throw error; }
    };
  }
  admit(subjectId: string, requestKey: string): ReinterpretationAdmission {
    this.logger.verbose("[reinterpretation] admission attempt",{subjectId});
    try {
      const result = immediate(this.db,() => {
        const subject = this.subject(subjectId), snapshot = this.snapshot(subjectId,requestKey,subject);
        if (snapshot.receipt) return {snapshot,replayed:true};
        if (subject.rejected) throw new RunNotFoundError();
        if (!snapshot.eligibility.eligible) throw new ReinterpretationConflictError(
          snapshot.eligibility.reason === "work-active" ? "interpretation-active" : "interpretation-unsettled",snapshot);
        const admitted = admitWeave(this.db,this.sources,{subjectId,triggerId:reinterpretationTrigger(requestKey)});
        const run = this.run(admitted.id);
        return {snapshot:{receipt:{subjectId,requestKey,runId:run.id},run,eligibility:this.eligibility(subjectId,subject)},replayed:false};
      });
      if (result.replayed) this.logger.verbose("[reinterpretation] receipt replayed",{subjectId,runId:result.snapshot.receipt?.runId});
      else this.logger.info("[reinterpretation] admitted",{subjectId,runId:result.snapshot.receipt?.runId});
      return result;
    } catch (error) {
      this.logger.verbose("[reinterpretation] admission refused",{subjectId});
      throw error;
    }
  }
  byKey(subjectId: string, requestKey: string): ReinterpretationSnapshot {
    this.logger.verbose("[reinterpretation] receipt lookup attempt",{subjectId});
    try {
      const snapshot = this.db.transaction(() => this.snapshot(subjectId,requestKey,this.subject(subjectId)))();
      this.logger.verbose("[reinterpretation] receipt lookup succeeded",{subjectId,found:snapshot.receipt !== null});
      return snapshot;
    } catch (error) {
      this.logger.verbose("[reinterpretation] receipt lookup failed",{subjectId});
      throw error;
    }
  }
}
