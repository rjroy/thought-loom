import type { Database } from "bun:sqlite";
import { normalizeBinding } from "../agent/binding";
import type { SearchAdmissionFact, SearchCleanupIdentity, SearchCleanupObservation } from "../agent/search-cleanup-contract";
import { RunFenceError } from "../domain/run";
import { protocolJson } from "../domain/run-protocol";
import { createLogger, type Logger } from "../logging";
import { ExecutionOwnerLease } from "./execution-owner";
import { parseSearchCleanupManifest, searchCleanupFocus, SearchCleanupJournalError } from "./search-cleanup-manifest";
import { parseSearchCleanupEvidence, mergeCleanupFacts, type SearchCleanupEvidence } from "./search-cleanup-evidence";
import { readSearchCleanupSnapshot } from "./search-cleanup-snapshot";
import { immediate } from "./transaction";

interface CleanupRow {
  readonly run_id: string; readonly session_id: string; readonly binding_json: string; readonly last_prompt_id: string;
  readonly submit_owner: string | null; readonly prompt_sha256: Uint8Array | null; readonly prompt_manifest_json: string | null;
  readonly state: "pending" | "settled" | "ownership-conflict"; readonly drain_state: string;
  readonly admission_state: "never-submitted" | "uncertain" | "admitted" | "terminal"; readonly evidence_json: string | null;
}
interface CleanupRecord { readonly row: CleanupRow; readonly identity: SearchCleanupIdentity }

/** Internal retained-run and tombstoned purged-outbox cleanup. No transaction awaits or calls native code. */
export class SqliteSearchCleanup {
  constructor(private readonly db: Database, private readonly owner?: ExecutionOwnerLease, private readonly logger: Logger = createLogger()) {
    if (owner !== undefined) {
      if (!(owner instanceof ExecutionOwnerLease)) throw new RunFenceError("A runtime lease capability is required");
      owner.assertRegistered(db);
    }
  }
  private row(runId: string): CleanupRow | null {
    return this.db.query("SELECT * FROM search_native_cleanup WHERE run_id=?").get(runId) as CleanupRow | null;
  }
  private decode(row: CleanupRow): CleanupRecord | null {
    if (row.prompt_manifest_json === null) return null; // Historical unqualified rows never gain new authority.
    const manifest = parseSearchCleanupManifest(row.prompt_manifest_json), binding = normalizeBinding(JSON.parse(row.binding_json));
    const focus = searchCleanupFocus(manifest);
    if (manifest.runId !== row.run_id || manifest.searchSessionId !== row.session_id || manifest.nativeSessionId !== binding.sessionId ||
      row.last_prompt_id !== focus.promptId || row.submit_owner !== focus.submitOwnerId ||
      (row.prompt_sha256 === null ? null : Buffer.from(row.prompt_sha256).toString("hex")) !== focus.inputSha256) throw new SearchCleanupJournalError();
    return {row,identity:Object.freeze({runId:row.run_id,sessionId:row.session_id,binding,bindingJson:row.binding_json,
      manifest,manifestJson:row.prompt_manifest_json})};
  }
  private retained(runId: string, generation?: number): boolean {
    return this.db.query(`SELECT 1 FROM runs r JOIN search_turns t ON t.run_id=r.id WHERE r.id=? AND r.kind='search'
      AND r.status IN ('completed','interrupted','failed') AND r.cancellation_state='pending' AND t.open_slot=0
      AND r.generation>=?`).get(runId,generation ?? 0) !== null;
  }
  isPurged(runId: string): boolean {
    return this.db.query(`SELECT 1 FROM search_native_cleanup c JOIN search_sessions s ON s.id=c.session_id
      WHERE c.run_id=? AND s.deleted_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM runs WHERE id=c.run_id)`).get(runId) !== null;
  }
  prepare(runId: string): SearchCleanupIdentity | null {
    // Non-search/active ticks take no additional write lock. The authoritative check repeats inside the snapshot transaction.
    if (!this.retained(runId) && !this.isPurged(runId)) return null;
    return immediate(this.db,() => {
      this.owner?.assertRegistered(this.db);
      if (!this.retained(runId) && !this.isPurged(runId)) return null;
      let row = this.row(runId);
      if (!row) {
        if (!this.db.query("SELECT 1 FROM agent_bindings WHERE run_id=?").get(runId)) return null;
        this.sealInTransaction(runId);
        row = this.row(runId);
      }
      if (!row || row.state !== "pending") return null;
      return this.decode(row)?.identity ?? null;
    });
  }
  /** Seal before input erasure. Existing Stop/rejection/legacy records remain byte-identical, never replaced or backfilled. */
  sealInTransaction(runId: string): void {
    if (!this.db.inTransaction) throw new SearchCleanupJournalError();
    this.owner?.assertRegistered(this.db);
    const snapshot = readSearchCleanupSnapshot(this.db,runId), prior = this.row(runId);
    if (prior) {
      if (prior.session_id !== snapshot.sessionId || protocolJson(normalizeBinding(JSON.parse(prior.binding_json))) !== snapshot.bindingJson) throw new SearchCleanupJournalError();
      const saved = this.decode(prior);
      if (saved) {
        const fresh = parseSearchCleanupManifest(snapshot.promptManifestJson), old = saved.identity.manifest;
        if (old.fencedGeneration > fresh.fencedGeneration || old.setupOwnerId !== fresh.setupOwnerId ||
          protocolJson(old.steps) !== protocolJson(fresh.steps)) throw new SearchCleanupJournalError();
      }
      return;
    }
    this.logger.verbose("[search cleanup] snapshot attempt",{runId});
    this.db.run(`INSERT INTO search_native_cleanup(run_id,session_id,binding_json,last_prompt_id,submit_owner,prompt_sha256,
      prompt_manifest_json,drain_state,admission_state,state,evidence_json) VALUES (?,?,?,?,?,?,?,?,?,?,NULL)`,
    [snapshot.runId,snapshot.sessionId,snapshot.bindingJson,snapshot.lastPromptId,snapshot.submitOwner,snapshot.promptSha256,
      snapshot.promptManifestJson,snapshot.drainState,snapshot.admissionState,snapshot.state]);
    this.logger.info("[search cleanup] snapshot applied in transaction",{runId});
  }
  private current(identity: SearchCleanupIdentity): CleanupRecord {
    const row = this.row(identity.runId);
    if (!row || row.state !== "pending" || row.session_id !== identity.sessionId || row.binding_json !== identity.bindingJson ||
      row.prompt_manifest_json !== identity.manifestJson ||
      (!this.retained(identity.runId,identity.manifest.fencedGeneration) && !this.isPurged(identity.runId))) throw new RunFenceError();
    const saved = this.decode(row);
    if (!saved || protocolJson(saved.identity.manifest) !== protocolJson(identity.manifest) ||
      protocolJson(saved.identity.binding) !== protocolJson(identity.binding)) throw new RunFenceError();
    return saved;
  }
  private qualified(identity: SearchCleanupIdentity): boolean {
    if (!this.owner) return false;
    this.owner.assertRegistered(this.db);
    const owners = new Set<string>();
    if (identity.manifest.setupOwnerId === null) return false;
    owners.add(identity.manifest.setupOwnerId);
    for (const step of identity.manifest.steps) {
      if (step.authorization === "unattributed") return false;
      if (step.authorization === "authorized-uncertain") {
        if (step.submitOwnerId === null || step.inputSha256 === null) return false;
        owners.add(step.submitOwnerId);
      }
    }
    for (const id of owners) if (!this.db.query(`SELECT 1 FROM execution_owners WHERE id=? AND database_identity=? AND lease_protocol=?`)
      .get(id,this.owner.databaseIdentity,this.owner.leaseProtocol)) return false;
    return true;
  }
  /** Called only by the existing run lane's cleanup tail after its captured execution promise has settled.
   * Matching predecessor owners are excluded by this held lease, not PID/heartbeat/remote absence inference.
   */
  drained(identity: SearchCleanupIdentity): boolean {
    return immediate(this.db,() => {
      const {row} = this.current(identity);
      if (!this.qualified(identity) || !this.owner) return false;
      const old = parseSearchCleanupEvidence(identity,row.evidence_json);
      const evidence = this.evidence(identity,{...old,drainOwnerId:this.owner.id});
      if (identity.manifest.steps.every(step => step.authorization === "never-authorized")) {
        this.settle(identity,evidence,"never-submitted");
        return false; // Local-only settlement needs no native container operation.
      }
      if (row.drain_state !== "drained" || row.evidence_json !== protocolJson(evidence)) {
        this.db.run("UPDATE search_native_cleanup SET drain_state='drained',evidence_json=? WHERE run_id=?",[protocolJson(evidence),identity.runId]);
        this.logger.info("[search cleanup] local execution joined",{runId:identity.runId});
      }
      return true;
    });
  }
  authorize(identity: SearchCleanupIdentity): void {
    const {row} = this.current(identity);
    if (!this.qualified(identity) || row.drain_state !== "drained") throw new RunFenceError();
  }
  private evidence(identity: SearchCleanupIdentity, evidence: SearchCleanupEvidence): SearchCleanupEvidence {
    return parseSearchCleanupEvidence(identity,protocolJson(evidence));
  }
  private settle(identity: SearchCleanupIdentity, evidence: SearchCleanupEvidence, admission: "never-submitted" | "terminal"): void {
    this.db.run("UPDATE search_native_cleanup SET drain_state='drained',admission_state=?,state='settled',evidence_json=? WHERE run_id=?",
      [admission,protocolJson(evidence),identity.runId]);
    const result = this.db.run(`UPDATE runs SET cancellation_state='settled' WHERE id=? AND kind='search'
      AND status IN ('completed','interrupted','failed') AND cancellation_state='pending'
      AND EXISTS (SELECT 1 FROM search_turns WHERE run_id=runs.id AND open_slot=0)`,[identity.runId]);
    if (result.changes !== 1 && !this.isPurged(identity.runId)) throw new RunFenceError();
    this.logger.info("[search cleanup] cancellation settled",{runId:identity.runId});
  }
  observed(identity: SearchCleanupIdentity, observation: SearchCleanupObservation): void {
    immediate(this.db,() => {
      this.authorize(identity);
      const {row} = this.current(identity);
      if (observation.state === "ownership-conflict") {
        this.db.run("UPDATE search_native_cleanup SET state='ownership-conflict' WHERE run_id=?",[identity.runId]);
        this.logger.warning("[search cleanup] native ownership conflict",{runId:identity.runId}); return;
      }
      const old = parseSearchCleanupEvidence(identity,row.evidence_json);
      const current = this.evidence(identity,{...old,admissions:observation.admissions,prompts:observation.prompts,
        inboxEmpty:observation.inboxEmpty,inactive:observation.inactive});
      const evidence = this.evidence(identity,{...current,admissions:mergeCleanupFacts(old.admissions,current.admissions),
        prompts:mergeCleanupFacts(old.prompts,current.prompts)});
      if (observation.state === "terminal") {
        const authorized = identity.manifest.steps.filter(step => step.authorization === "authorized-uncertain");
        if (current.inboxEmpty !== true || current.inactive !== true || current.prompts.length !== authorized.length ||
          current.admissions.length !== authorized.length) throw new SearchCleanupJournalError();
        this.settle(identity,evidence,"terminal"); return;
      }
      const admission = evidence.admissions.some(fact => fact.promptId === row.last_prompt_id) ? "admitted" : row.admission_state;
      this.db.run("UPDATE search_native_cleanup SET admission_state=?,evidence_json=? WHERE run_id=?",[admission,protocolJson(evidence),identity.runId]);
      this.logger.verbose("[search cleanup] native remains pending",{runId:identity.runId});
    });
  }
  /** Transport ACK only, before an active-claim post-await fence. No row creation, prose, execution or settlement. */
  recordAdmission(fact: SearchAdmissionFact): void {
    if (!this.owner) return;
    this.owner.assertRegistered(this.db);
    immediate(this.db,() => {
      const row = this.row(fact.runId);
      if (!row || row.state !== "pending") return;
      const saved = this.decode(row);
      if (!saved) return;
      const {identity} = saved, step = identity.manifest.steps.find(step => step.promptId === fact.promptId);
      if (!step || step.submitOwnerId !== this.owner?.id) return;
      const old = parseSearchCleanupEvidence(identity,row.evidence_json);
      const evidence = this.evidence(identity,{...old,admissions:mergeCleanupFacts(old.admissions,[fact])});
      const admission = evidence.admissions.some(item => item.promptId === row.last_prompt_id) ? "admitted" : row.admission_state;
      this.db.run("UPDATE search_native_cleanup SET admission_state=?,evidence_json=? WHERE run_id=?",[admission,protocolJson(evidence),fact.runId]);
      this.logger.verbose("[search cleanup] owned admission retained",{runId:fact.runId,promptId:fact.promptId});
    });
  }
}
