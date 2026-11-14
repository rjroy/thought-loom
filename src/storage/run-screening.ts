import { parseScreeningJudgment, parseScreeningPolicy, screeningJudgment, type ScreeningExclusion, type ScreeningFailure, type ScreeningFinalization } from "../domain/connection-screening";
import { RunConflictError, type Claim } from "../domain/run";
import type { Thought } from "../domain/thought";
import { SqliteRunAggregate } from "./run-aggregate";
import { hasConnectionDiscovery } from "./weave-admission";
import { searchEligibilitySql } from "./search-eligibility";

interface ScreeningPass { readonly subjectId: string; readonly policyJson: string; readonly status: "collecting" | "complete" | "fallback" }
interface ScreeningPair { readonly candidateId: string; readonly judgmentJson: string | null }

/** Read-only local judgments are restartable. This is never native submission/replay authority. */
export class SqliteRunScreeningState extends SqliteRunAggregate {
  /** A generated subject's dedicated creation owner suppresses duplicate screening in ordinary follow-ups. */
  ownsScreening(runId: string): boolean {
    const run = this.require(runId), intent = this.readWeaveIntent(runId), purpose = this.weavePurpose(run);
    return run.kind === "weave" && intent !== null && (purpose === "daily-review" || purpose === "connection-only" ||
      purpose === "ordinary" && !hasConnectionDiscovery(this.db,intent.subjectId));
  }
  private pass(runId: string): ScreeningPass | null {
    return this.db.query<ScreeningPass,[string]>(`SELECT subject_id AS subjectId,policy_json AS policyJson,status
      FROM run_screening_passes WHERE run_id=?`).get(runId);
  }
  private pairs(runId: string): readonly ScreeningPair[] {
    return this.db.query<ScreeningPair,[string]>(`SELECT candidate_id AS candidateId,judgment_json AS judgmentJson
      FROM run_screening_pairs WHERE run_id=? ORDER BY position`).all(runId);
  }
  private candidateIds(subjectId: string): readonly string[] {
    // AI-normal text visibility is active thought membership; do not materialize unrelated responses/connection text.
    return this.db.query<{id:string},[string]>(`SELECT t.id FROM thoughts t WHERE t.id!=? AND t.kind!='media-original'
      AND NOT EXISTS(SELECT 1 FROM rejected_thoughts r WHERE r.thought_id=t.id) ORDER BY t.rowid`).all(subjectId).map(row => row.id);
  }
  private sameCandidates(runId: string, subjectId: string): boolean {
    const expected = new Set(this.pairs(runId).map(pair => pair.candidateId)), actual = this.candidateIds(subjectId);
    return expected.size === actual.length && actual.every(id => expected.has(id));
  }
  /** Identity-only AI-normal lookup; supporting-source rejection redacts provenance, not this active edge. */
  private exclusion(subjectId: string, candidateId: string): ScreeningExclusion | null {
    const row = this.db.query<{id:string},[string,string,string,string]>(`SELECT edge.id FROM connections edge
      WHERE ((edge.from_id=? AND edge.to_id=?) OR (edge.from_id=? AND edge.to_id=?))
        AND ${searchEligibilitySql("'connection'","edge.id")} ORDER BY edge.rowid LIMIT 1`).get(subjectId,candidateId,candidateId,subjectId);
    return row ? {kind:"already-connected",connectionId:row.id} : null;
  }
  private fallback(runId: string, generation: number, category: ScreeningFailure): void {
    const pass = this.pass(runId);
    if (!pass || pass.status === "fallback") return;
    this.db.run("UPDATE run_screening_passes SET status='fallback',failure_code=? WHERE run_id=?",[category,runId]);
    this.logger.error("[worker] screening failed; using search fallback",{runId,generation,category});
  }
  /** Stable run/subject membership and policy survive a new claim generation. Missing config never resumes an old pass. */
  beginScreening(claim: Claim, subjectId: string, policyJson: string | null): readonly string[] {
    return this.guarded("begin screening",claim,(run,visible) => {
      if (run.kind !== "weave" || this.readWeaveIntent(run.id)?.subjectId !== subjectId || !this.ownsScreening(run.id) ||
          this.currentStep(run.id).input !== null) throw new RunConflictError("Screening requires an unprepared text weave");
      const subject = visible({kind:"thought",id:subjectId});
      if (!subject || !("kind" in subject) || subject.kind === "media-original") throw new RunConflictError("Screening subject unavailable");
      let pass = this.pass(run.id);
      if (!pass) {
        if (policyJson === null) return [];
        parseScreeningPolicy(policyJson);
        const ids = this.candidateIds(subjectId);
        this.db.run(`INSERT INTO run_screening_passes(run_id,subject_id,policy_json,candidate_count,status) VALUES (?,?,?,?,'collecting')`,
          [run.id,subjectId,policyJson,ids.length]);
        for (const [position,id] of ids.entries()) this.db.run("INSERT INTO run_screening_pairs(run_id,candidate_id,position) VALUES (?,?,?)",[run.id,id,position]);
        pass = this.pass(run.id);
      }
      if (!pass || pass.subjectId !== subjectId) throw new RunConflictError("Screening subject changed");
      if (pass.status === "fallback") return [];
      if (pass.status === "collecting" && pass.policyJson !== policyJson) {
        this.fallback(run.id,claim.generation,"configuration-changed"); return [];
      }
      if (!this.sameCandidates(run.id,subjectId)) { this.fallback(run.id,claim.generation,"eligibility-changed"); return []; }
      return this.pairs(run.id).filter(pair => pair.judgmentJson === null && !this.exclusion(subjectId,pair.candidateId)).map(pair => pair.candidateId);
    });
  }
  /** Commit exposure before network entry, not a Weaver full-read witness. */
  screeningPair(claim: Claim, subjectId: string, candidateId: string): {subject: Thought; candidate: Thought} | ScreeningExclusion | null {
    return this.guarded("authorize screening pair",claim,(run,visible) => {
      const pass = this.pass(run.id);
      if (!pass || pass.subjectId !== subjectId || pass.status !== "collecting") return null;
      if (!this.db.query("SELECT 1 FROM run_screening_pairs WHERE run_id=? AND candidate_id=? AND judgment_json IS NULL").get(run.id,candidateId)) return null;
      const subject = visible({kind:"thought",id:subjectId}), candidate = visible({kind:"thought",id:candidateId});
      if (!subject || !("kind" in subject) || subject.kind === "media-original" || !candidate || !("kind" in candidate) ||
          candidate.kind === "media-original" || candidateId === subjectId) {
        this.fallback(run.id,claim.generation,"eligibility-changed"); return null;
      }
      const exclusion = this.exclusion(subjectId,candidateId);
      if (exclusion) return exclusion;
      this.track(run.id,{kind:"thought",id:subjectId}); this.track(run.id,{kind:"thought",id:candidateId});
      return {subject,candidate};
    });
  }
  recordScreeningJudgment(claim: Claim, subjectId: string, candidateId: string, score: number): void {
    const json = screeningJudgment(score);
    this.guarded("record screening judgment",claim,(run,visible) => {
      const pass = this.pass(run.id);
      if (!pass || pass.subjectId !== subjectId) throw new RunConflictError("Screening owner unavailable");
      if (pass.status === "fallback") return; // A known failure is sticky, including other already-entered calls.
      const subject = visible({kind:"thought",id:subjectId}), candidate = visible({kind:"thought",id:candidateId});
      if (pass.status !== "collecting" || !subject || !("kind" in subject) || subject.kind === "media-original" ||
          !candidate || !("kind" in candidate) || candidate.kind === "media-original") throw new RunConflictError("Screening eligibility changed");
      if ([subjectId,candidateId].some(id => !this.db.query("SELECT 1 FROM run_context WHERE run_id=? AND kind='thought' AND ref_id=?").get(run.id,id))) {
        throw new RunConflictError("Screening pair exposure unavailable");
      }
      const changed = this.db.run("UPDATE run_screening_pairs SET judgment_json=? WHERE run_id=? AND candidate_id=? AND judgment_json IS NULL",[json,run.id,candidateId]);
      if (changed.changes !== 1) throw new RunConflictError("Screening pair unavailable");
    });
  }
  screeningFailed(claim: Claim): void {
    this.guarded("record screening failure",claim,run => this.fallback(run.id,claim.generation,"screening-unavailable"));
  }
  /** Called within prepareInitial's guarded transaction: complete, select, witness and exact prompt commit are atomic. */
  protected screeningNominations(claim: Claim, subjectId: string): ScreeningFinalization | undefined {
    const pass = this.pass(claim.runId);
    if (!pass || pass.status === "fallback") return undefined;
    if (pass.subjectId !== subjectId) throw new RunConflictError("Screening subject changed");
    const pairs = this.pairs(claim.runId);
    if (!this.sameCandidates(claim.runId,subjectId)) {
      this.fallback(claim.runId,claim.generation,"eligibility-changed"); return undefined;
    }
    const exclusions = new Map<string,ScreeningExclusion>();
    for (const pair of pairs) {
      const exclusion = this.exclusion(subjectId,pair.candidateId);
      if (exclusion) exclusions.set(pair.candidateId,exclusion);
      else if (pair.judgmentJson === null) return {kind:"pending"};
    }
    // Exclusions describe this exact prompt snapshot, never a collecting-pass negative cache.
    for (const [candidateId,exclusion] of exclusions) this.db.run(`UPDATE run_screening_pairs SET excluded_connection_id=?
      WHERE run_id=? AND candidate_id=?`,[exclusion.connectionId,claim.runId,candidateId]);
    const policy = parseScreeningPolicy(pass.policyJson);
    const nominated = new Set(pairs.filter(pair => !exclusions.has(pair.candidateId) && pair.judgmentJson !== null && parseScreeningJudgment(pair.judgmentJson) >= policy.threshold).map(pair => pair.candidateId));
    const thoughts = this.rejection().listThoughts({actor:"ai",mode:"normal"}).filter(thought => nominated.has(thought.id));
    for (const thought of thoughts) this.trackThought(claim.runId,thought);
    if (pass.status === "collecting") this.db.run("UPDATE run_screening_passes SET status='complete' WHERE run_id=?",[claim.runId]);
    return {kind:"ready",thoughts};
  }
}
