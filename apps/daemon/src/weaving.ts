import type { Database } from "bun:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { openDatabase } from "./storage";
import { isIdempotencyKey, isRecordId, parseDialoguePreview, parseWeavingRetryReceipt, parseWeavingStatusView, parseWeavingWorkerView, weavingWorkerAvailable, type DialoguePreview,
  type WeavingJobKind, type WeavingJobStatus, type WeavingRetryInput, type WeavingRetryReceipt, type WeavingStatusView, type WeavingWorkerView } from "@thoughtloom/contracts";
import { enqueueDialogueFollowUp } from "./follow-up";
import { freezeFollowUpInput, followUpOrigins, followUpTargets, followUpChanges, followUpChangeCount } from "./follow-up-data";
import { FOLLOW_UP_LIMITS, parseFollowUpStatusView, parseFollowUpRetryReceipt, type FollowUpLimits, type FollowUpStatusView,
  type FollowUpRetryInput, type FollowUpRetryReceipt } from "@thoughtloom/contracts";
import { WeavingAbandonmentService, type AbandonmentInterruptOutcome, type AbandonmentDispatchOutcome } from "./weaving-abandonment";

export type WeavingRun = {
  readonly jobId: string;
  readonly sourceId: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly promptId: string;
  // Worker-created identities always carry the database kind. Legacy scripted
  // port inputs may omit it; domain authority still requires the immutable join.
  readonly kind?: WeavingJobKind;
};

export type WeavingJob = {
  sourceId: string;
  status: WeavingJobStatus;
  run: WeavingRun | null;
};

type Admission = { kind: "admitted" } | { kind: "uncertain" };
// Submission authority belongs to the worker's exact live claim, never a lease
// owner re-read after an external ownership check. It is not part of public IDs.
export type WeavingAdmissionClaim = { readonly owner: string; readonly leaseMs: number; readonly now: () => number };
export type CanonicalAssistant = { messageId: string; text: string };
export type Observation = { kind: "pending" } | { kind: "completed"; recordedChanges: number; assistant?: CanonicalAssistant } |
  { kind: "failed" | "interrupted"; assistant?: CanonicalAssistant };

// Native implementations attach to the selected operator-owned service. Preparing
// verifies/creates only this session: it must never submit a prompt. Inspection
// reports completion only from canonical evidence for this particular prompt.
export interface WeavingAdapter {
  prepareSession(run: WeavingRun): Promise<void>;
  admit(run: WeavingRun, claim: WeavingAdmissionClaim): Promise<Admission>;
  inspect(run: WeavingRun): Promise<Observation>;
  stop?(run: WeavingRun): Promise<void>;
  readPreview?(runId: string): DialoguePreview | undefined;
  releasePreview?(run: WeavingRun): Promise<void>;
  // Called once after a durable operator abandonment, with domain writes already
  // fenced. "requested" acknowledges the RPC, never native settlement.
  interruptAbandoned?(run: WeavingRun, receiptId: string): Promise<AbandonmentInterruptOutcome>;
  close?(): Promise<void>;
}

type AttemptError = "preparation_failed" | "admission_unknown" | "inspection_failed" | "invalid_adapter_result";
type RunState = "preparing" | "admitting" | "admitted" | "uncertain" | "completed" | "not_admitted";
type OpenState = Exclude<RunState, "completed" | "not_admitted">;
type RunRow = WeavingRun & { state: OpenState; attempt: number; jobKind: WeavingJobKind };
type Claim = { run: WeavingRun; state: OpenState; attempt: number; owner: string; kind: WeavingJobKind };
type StatusRun = { id: string; attempt: number; state: string; outcome: string | null; lastError: string | null;
  leaseOwner: string | null; leaseUntil: number | null; attempted: number | null };
type StatusJob = { id: string; status: string; kind: WeavingJobKind };
type StatusSnapshot = { job: StatusJob; run: StatusRun | null; attempts: number };
type RetryResult = { kind: "accepted"; receipt: WeavingRetryReceipt } | { kind: "conflict" | "unavailable" | "not_found" };
type FollowUpRetryResult = { kind: "accepted"; receipt: FollowUpRetryReceipt } | { kind: "conflict" | "unavailable" | "not_found" };

function snapshot(db: Database, sourceId: string): StatusSnapshot | null {
  if (!db.query("SELECT 1 FROM sources WHERE id=?").get(sourceId)) return null;
  const job = db.query<StatusJob, [string]>("SELECT id,status,kind FROM jobs WHERE source_id=? AND kind='capture' ORDER BY rowid DESC LIMIT 1").get(sourceId);
  if (!job) return null;
  return jobSnapshot(db, job);
}
function jobSnapshot(db: Database, job: StatusJob): StatusSnapshot {
  const run = db.query<StatusRun, [string]>(`SELECT r.id,r.attempt,r.state,r.outcome,r.last_error AS lastError,
    r.lease_owner AS leaseOwner,r.lease_until AS leaseUntil,c.attempted FROM weaving_runs r
    LEFT JOIN native_commands c ON c.run_id=r.id WHERE r.job_id=? ORDER BY r.attempt DESC LIMIT 1`).get(job.id);
  return { job, run, attempts: run?.attempt ?? 0 };
}

function recordedChanges(db: Database, runId: string): number {
  const row = db.query<{ count: number }, [string, string, string]>(`SELECT COUNT(*) AS count FROM knowledge_receipts receipt JOIN (
    SELECT operation_id FROM formulations WHERE run_id=? AND author='ai'
    UNION SELECT operation_id FROM relationship_revisions WHERE run_id=? AND author='ai'
    UNION SELECT operation_id FROM search_aliases WHERE run_id=? AND author='ai'
  ) written ON written.operation_id=receipt.operation_id`).get(runId, runId, runId);
  if (!row) throw new WeavingError("invalid_state");
  return row.count;
}

export class WeavingError extends Error {
  constructor(readonly code: "storage_error" | "invalid_state" | "invalid_configuration") {
    super(code);
    this.name = "WeavingError";
  }
}

export type WeavingWorkerOptions = {
  databasePath: string;
  adapter: WeavingAdapter | null;
  now?: () => number;
  leaseMs?: number;
  maxAttempts?: number;
  recoveryLimit?: number;
};

const runColumns = `r.id AS runId, r.job_id AS jobId, j.source_id AS sourceId,
  r.session_id AS sessionId, r.prompt_id AS promptId, r.state, r.attempt,j.kind AS jobKind`;

function identity(row: WeavingRun, kind: WeavingJobKind): WeavingRun {
  return Object.freeze({ jobId: row.jobId, sourceId: row.sourceId, runId: row.runId,
    sessionId: row.sessionId, promptId: row.promptId, kind });
}

export class WeavingWorker {
  private readonly databasePath: string;
  private readonly adapter: WeavingAdapter | null;
  private readonly now: () => number;
  private readonly leaseMs: number;
  private readonly maxAttempts: number;
  private readonly recoveryLimit: number;
  private readonly abandonments: WeavingAbandonmentService;

  constructor(options: WeavingWorkerOptions) {
    this.databasePath = options.databasePath;
    this.adapter = options.adapter;
    this.now = options.now ?? Date.now;
    this.leaseMs = options.leaseMs ?? 30_000;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.recoveryLimit = options.recoveryLimit ?? 50;
    this.abandonments = new WeavingAbandonmentService({ databasePath: this.databasePath, now: () => this.time() });
    for (const value of [this.leaseMs, this.maxAttempts, this.recoveryLimit]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new WeavingError("invalid_configuration");
    }
  }

  get configured(): boolean { return this.adapter !== null; }

  private workerView(worker: WeavingWorkerView): WeavingWorkerView {
    const configured = this.configured && worker.configured;
    const parsed = parseWeavingWorkerView({ configured, state: configured ? worker.state : "unavailable" });
    if (!parsed) throw new WeavingError("invalid_configuration");
    return parsed;
  }

  private retryEligible(db: Database, current: StatusSnapshot): boolean {
    const { job, run, attempts } = current;
    if (!run || attempts >= this.maxAttempts || run.leaseOwner !== null || run.leaseUntil !== null) return false;
    const definitive = (job.status === "failed" && ((run.state === "admitted" && run.outcome === "failed") ||
      (run.state === "not_admitted" && run.outcome === null && run.lastError === "preparation_failed" && run.attempted !== 1))) ||
      (job.status === "interrupted" && run.state === "admitted" && run.outcome === "interrupted");
    if (!definitive) return false;
    const receipts = job.kind === "follow_up" ? "follow_up_retry_receipts" : "weaving_retry_receipts";
    if (job.kind === "dialogue" || db.query(`SELECT 1 FROM ${receipts} WHERE expected_run_id=?`).get(run.id)) return false;
    return !db.query(`SELECT 1 FROM weaving_runs WHERE job_id=? AND outcome IS NULL
      AND state IN ('preparing','admitting','admitted','uncertain') LIMIT 1`).get(job.id);
  }

  readStatus(sourceId: string, worker: WeavingWorkerView): WeavingStatusView | null {
    if (!isRecordId(sourceId)) throw new WeavingError("invalid_configuration");
    const availability = this.workerView(worker);
    return this.storage("status.read", false, (db) => {
      const current = snapshot(db, sourceId);
      if (!current) return null;
      // A queued retry has no current run yet. Earlier outcomes/changes remain
      // durable history, but must not masquerade as this queued attempt's result.
      const run = current.job.status === "queued" ? null : current.run;
      const view = parseWeavingStatusView({ sourceId, worker: availability,
        job: { ...current.job, attempts: current.attempts, recordedChanges: run ? recordedChanges(db, run.id) : null },
        run: run ? { id: run.id } : null,
        actions: { retry: weavingWorkerAvailable(availability) && this.retryEligible(db, current) } });
      if (!view) throw new WeavingError("invalid_state");
      return view;
    });
  }

  retry(sourceId: string, key: string, input: WeavingRetryInput, worker: WeavingWorkerView): RetryResult {
    if (!isRecordId(sourceId) || !isIdempotencyKey(key) || !isRecordId(input.expectedRunId)) throw new WeavingError("invalid_configuration");
    const hash = createHash("sha256").update(JSON.stringify(["weaving_retry", sourceId, input.expectedRunId])).digest("hex");
    // One short write transaction commits both the requeue and immutable command
    // receipt. The supervisor may claim only after commit; HTTP never calls it.
    return this.storage("retry.queue", true, (db) => {
      const existing = db.query<{ hash: string; id: string; sourceId: string; jobId: string; expectedRunId: string }, [string]>(
        `SELECT payload_hash AS hash,id,source_id AS sourceId,job_id AS jobId,expected_run_id AS expectedRunId
         FROM weaving_retry_receipts WHERE idempotency_key=?`,
      ).get(key);
      if (existing) {
        if (existing.hash !== hash) return { kind: "conflict" };
        const receipt = parseWeavingRetryReceipt({ ...existing, status: "queued" });
        if (!receipt || receipt.sourceId !== sourceId || receipt.expectedRunId !== input.expectedRunId) throw new WeavingError("invalid_state");
        return { kind: "accepted", receipt };
      }
      const current = snapshot(db, sourceId);
      if (!current) return { kind: "not_found" };
      if (!weavingWorkerAvailable(this.workerView(worker))) return { kind: "unavailable" };
      if (!current.run || current.run.id !== input.expectedRunId || !this.retryEligible(db, current)) return { kind: "conflict" };
      const receipt = parseWeavingRetryReceipt({ id: randomUUID(), sourceId, jobId: current.job.id, expectedRunId: input.expectedRunId, status: "queued" });
      if (!receipt) throw new WeavingError("invalid_state");
      const changed = db.query<{ id: string }, [string, string]>("UPDATE jobs SET status='queued' WHERE id=? AND status=? RETURNING id").get(current.job.id, current.job.status);
      if (!changed) throw new WeavingError("invalid_state");
      db.run(`INSERT INTO weaving_retry_receipts(idempotency_key,payload_hash,id,source_id,job_id,expected_run_id) VALUES (?,?,?,?,?,?)`,
        [key, hash, receipt.id, sourceId, current.job.id, input.expectedRunId]);
      return { kind: "accepted", receipt };
    });
  }

  readFollowUps(sourceId: string, worker: WeavingWorkerView, overrides?: Partial<FollowUpLimits>): FollowUpStatusView | null {
    if (!isRecordId(sourceId)) throw new WeavingError("invalid_configuration");
    const availability = this.workerView(worker), limits = { ...FOLLOW_UP_LIMITS, ...overrides };
    for (const value of Object.values(limits)) if (!Number.isSafeInteger(value) || value < 1 || value > 1024) throw new WeavingError("invalid_configuration");
    return this.storage("follow_up.status", false, (db) => {
      if (!db.query("SELECT 1 FROM sources WHERE id=?").get(sourceId)) return null;
      // Active and pending intent cannot be pushed off-screen by recent history.
      const rows = db.query<StatusJob, [string, number]>(`SELECT id,status,kind FROM jobs WHERE source_id=? AND kind='follow_up'
        ORDER BY CASE WHEN status IN ('running','uncertain') THEN 0 WHEN status='queued' THEN 1 ELSE 2 END,rowid DESC LIMIT ?`).all(sourceId, limits.jobs + 1);
      const jobs = rows.slice(0, limits.jobs).map((job) => {
        const current = jobSnapshot(db, job), run = job.status === "queued" ? null : current.run;
        const origins = followUpOrigins(db, job.id, limits.origins + 1), targets = followUpTargets(db, job.id, limits.targets + 1), changes = followUpChanges(db, job.id, limits.changes + 1);
        return { id: job.id, status: job.status, attempts: current.attempts, run: run ? { id: run.id } : null, recordedChanges: followUpChangeCount(db, job.id),
          origins: origins.slice(0, limits.origins), originsTruncated: origins.length > limits.origins,
          targets: targets.slice(0, limits.targets), targetsTruncated: targets.length > limits.targets,
          changes: changes.slice(0, limits.changes), changesTruncated: changes.length > limits.changes,
          actions: { retry: weavingWorkerAvailable(availability) && this.retryEligible(db, current) } };
      });
      const view = parseFollowUpStatusView({ sourceId, worker: availability, jobs, truncated: rows.length > limits.jobs });
      if (!view) throw new WeavingError("invalid_state");
      return view;
    });
  }

  retryFollowUp(sourceId: string, jobId: string, key: string, input: FollowUpRetryInput, worker: WeavingWorkerView): FollowUpRetryResult {
    if (![sourceId, jobId, input.expectedRunId].every(isRecordId) || !isIdempotencyKey(key)) throw new WeavingError("invalid_configuration");
    const hash = createHash("sha256").update(JSON.stringify(["follow_up_retry", sourceId, jobId, input.expectedRunId])).digest("hex");
    return this.storage("follow_up.retry", true, (db) => {
      // Replay acknowledgment before availability/current-state checks, including
      // after restart, configuration loss, later attempts and exhausted budgets.
      const prior = db.query<{ hash: string; id: string; sourceId: string; jobId: string; expectedRunId: string }, [string]>(
        `SELECT payload_hash AS hash,id,source_id AS sourceId,job_id AS jobId,expected_run_id AS expectedRunId FROM follow_up_retry_receipts WHERE idempotency_key=?`).get(key);
      if (prior) {
        if (prior.hash !== hash) return { kind: "conflict" };
        const receipt = parseFollowUpRetryReceipt({ ...prior, status: "queued" });
        if (!receipt) throw new WeavingError("invalid_state");
        return { kind: "accepted", receipt };
      }
      const job = db.query<StatusJob, [string, string]>("SELECT id,status,kind FROM jobs WHERE id=? AND source_id=? AND kind='follow_up'").get(jobId, sourceId);
      if (!job) return { kind: "not_found" };
      if (!weavingWorkerAvailable(this.workerView(worker))) return { kind: "unavailable" };
      const current = jobSnapshot(db, job);
      if (current.run?.id !== input.expectedRunId || !this.retryEligible(db, current)) return { kind: "conflict" };
      const receipt = parseFollowUpRetryReceipt({ id: randomUUID(), sourceId, jobId, expectedRunId: input.expectedRunId, status: "queued" });
      if (!receipt) throw new WeavingError("invalid_state");
      const changed = db.query<{ id: string }, [string, string]>("UPDATE jobs SET status='queued' WHERE id=? AND status=? RETURNING id").get(jobId, job.status);
      if (!changed) throw new WeavingError("invalid_state");
      db.run("INSERT INTO follow_up_retry_receipts(idempotency_key,payload_hash,id,source_id,job_id,expected_run_id) VALUES (?,?,?,?,?,?)", [key, hash, receipt.id, sourceId, jobId, input.expectedRunId]);
      return { kind: "accepted", receipt };
    });
  }

  async startNext(): Promise<{ kind: "started"; run: WeavingRun } | { kind: "empty" } | { kind: "unavailable" }> {
    const adapter = this.adapter;
    if (!adapter) {
      console.info("weaving.start unavailable", { category: "unconfigured" });
      return { kind: "unavailable" };
    }
    const claim = this.claimNext();
    if (!claim) return { kind: "empty" };
    const { run } = claim;
    console.info("weaving.job claimed", { jobId: run.jobId, sourceId: run.sourceId, runId: run.runId, attempt: claim.attempt });
    console.info("weaving.prepare attempt", { runId: run.runId });
    try {
      await adapter.prepareSession(run);
    } catch {
      console.error("weaving.prepare failed", { runId: run.runId, category: "preparation_failed" });
      // Preparation cannot submit. Retain its receipt and bound future attempts;
      // an expired/replaced owner cannot requeue a newer owner's work.
      this.settle(claim, "not_admitted", claim.attempt < this.maxAttempts ? "queued" : "failed", "preparation_failed");
      await this.releasePreview(run);
      return { kind: "unavailable" };
    }
    console.info("weaving.prepare succeeded", { runId: run.runId });

    // Commit the possible-admission marker before crossing the external boundary.
    // Losing a lease never authorizes another submission of these or fresh IDs.
    if (!this.beginAdmission(claim)) { await this.releasePreview(run); return { kind: "started", run }; }
    const admitting = { ...claim, state: "admitting" } satisfies Claim;
    let admission: Admission | undefined;
    let category: AttemptError | null = null;
    console.info("weaving.admit attempt", { runId: run.runId });
    try {
      admission = await adapter.admit(run, { owner: claim.owner, leaseMs: this.leaseMs, now: () => this.time() });
    } catch {
      category = "admission_unknown";
    }
    const admitted = admission?.kind === "admitted";
    if (!admitted && admission?.kind !== "uncertain" && !category) category = "invalid_adapter_result";
    console.info("weaving.admit outcome", { runId: run.runId, outcome: admitted ? "admitted" : "uncertain", category });
    if (!this.settle(admitting, admitted ? "admitted" : "uncertain", admitted ? "running" : "uncertain", category)) await this.releasePreview(run);
    return { kind: "started", run };
  }

  async recover(): Promise<void> {
    const adapter = this.adapter;
    if (!adapter) {
      console.info("weaving.recover unavailable", { category: "unconfigured" });
      return;
    }
    await this.dispatchAbandonments();
    await this.dispatchStops();
    const candidates = this.storage("recovery.list", false, (db) => db.query<{ id: string }, [number, number]>(
      `SELECT r.id FROM weaving_runs r JOIN jobs j ON j.id=r.job_id
        WHERE j.kind IN ('capture','dialogue','follow_up') AND j.status IN ('running','uncertain') AND r.outcome IS NULL AND r.state IN ('preparing','admitting','admitted','uncertain')
         AND (r.lease_owner IS NULL OR r.lease_until <= ?)
       ORDER BY r.updated_at, r.rowid LIMIT ?`,
    ).all(this.time(), this.recoveryLimit));

    for (const candidate of candidates) {
      const claim = this.claimRecovery(candidate.id);
      if (!claim) continue;
      let observation: Observation | undefined;
      let category: AttemptError | null = null;
      console.info("weaving.inspect attempt", { runId: claim.run.runId });
      try {
        observation = await adapter.inspect(claim.run);
      } catch {
        category = "inspection_failed";
      }
      if (observation?.kind === "completed" && Number.isSafeInteger(observation.recordedChanges) && observation.recordedChanges >= 0 &&
          (claim.kind !== "dialogue" || (typeof observation.assistant?.text === "string" && typeof observation.assistant.messageId === "string" && observation.assistant.messageId.startsWith("msg_")))) {
        console.info("weaving.inspect completed", { runId: claim.run.runId, recordedChanges: observation.recordedChanges });
        this.settle(claim, "completed", "completed", null, observation.recordedChanges, "succeeded", observation.assistant);
        await this.releasePreview(claim.run);
      } else if ((observation?.kind === "failed" || observation?.kind === "interrupted") &&
          (observation.assistant === undefined || (typeof observation.assistant.text === "string" && typeof observation.assistant.messageId === "string" && observation.assistant.messageId.startsWith("msg_")))) {
        this.settle(claim, "admitted", observation.kind, null, null, observation.kind, observation.assistant);
        await this.releasePreview(claim.run);
      } else {
        if (observation?.kind !== "pending" && !category) category = "invalid_adapter_result";
        console.info("weaving.inspect unresolved", { runId: claim.run.runId, category });
        // Missing evidence is not failure or non-admission. Only a previously
        // acknowledged admission may stay running; interrupted preparation or
        // admission becomes uncertain and is never automatically resubmitted.
        const state = claim.state === "admitted" ? "admitted" : "uncertain";
        if (!this.settle(claim, state, state === "admitted" ? "running" : "uncertain", category)) await this.releasePreview(claim.run);
      }
    }
  }

  async dispatchStops(turnId?: string): Promise<void> {
    const adapter = this.adapter;
    if (!adapter?.stop) return;
    const candidates = this.storage("stop.list", false, (db) => db.query<{ id: string }, [string | null, string | null, number]>(
      `SELECT s.id FROM dialogue_stop_requests s JOIN dialogue_stop_dispatch d ON d.stop_id=s.id
       JOIN weaving_runs r ON r.id=s.expected_run_id JOIN jobs j ON j.id=r.job_id
       WHERE d.state='queued' AND r.outcome IS NULL AND r.state IN ('admitting','admitted','uncertain')
         AND j.status IN ('running','uncertain') AND (? IS NULL OR s.turn_id=?) ORDER BY s.rowid LIMIT ?`,
    ).all(turnId ?? null, turnId ?? null, this.recoveryLimit));
    for (const candidate of candidates) {
      const run = this.storage("stop.claim", true, (db) => {
        const row = db.query<WeavingRun, [string]>(`SELECT ${runColumns} FROM dialogue_stop_requests s
          JOIN dialogue_stop_dispatch d ON d.stop_id=s.id JOIN weaving_runs r ON r.id=s.expected_run_id JOIN jobs j ON j.id=r.job_id
          WHERE s.id=? AND d.state='queued' AND r.outcome IS NULL AND r.state IN ('admitting','admitted','uncertain') AND j.status IN ('running','uncertain')`).get(candidate.id);
        if (!row) return null;
        db.run("UPDATE dialogue_stop_dispatch SET state='attempted' WHERE stop_id=? AND state='queued'", [candidate.id]);
        return identity(row, "dialogue");
      });
      if (!run) continue;
      console.info("weaving.stop attempt", { runId: run.runId });
      let state: "requested" | "uncertain" = "uncertain";
      try { await adapter.stop(run); state = "requested"; }
      catch { /* Attempt may have crossed the boundary; reconcile, never resend. */ }
      this.storage("stop.outcome", true, (db) => db.run("UPDATE dialogue_stop_dispatch SET state=? WHERE stop_id=? AND state='attempted'", [state, candidate.id]));
      console.info("weaving.stop outcome", { runId: run.runId, outcome: state });
    }
  }

  async dispatchAbandonments(): Promise<void> {
    const adapter = this.adapter;
    if (!adapter) return;
    for (let count = 0; count < this.recoveryLimit; count++) {
      const dispatch = this.abandonments.claimInterrupt();
      if (!dispatch) break;
      const { run, receiptId } = dispatch;
      // The durable attempted marker precedes preview cleanup and every native
      // await. A crash is unconfirmed, not permission to replay this RPC.
      await this.releasePreview(run);
      console.info("weaving.abandonment interrupt attempt", { runId: run.runId, receiptId });
      let outcome: AbandonmentDispatchOutcome;
      try {
        outcome = adapter.interruptAbandoned ? await adapter.interruptAbandoned(run, receiptId) :
          { state: "not_requested", category: "unsupported" } satisfies AbandonmentInterruptOutcome;
      } catch {
        outcome = { state: "uncertain", category: "request_failed" };
      }
      // A storage failure is not a native request failure. Leave the durable
      // attempt unconfirmed and surface it; never retry the RPC to repair audit.
      this.abandonments.finishInterrupt(receiptId, outcome);
      console.info("weaving.abandonment interrupt outcome", { runId: run.runId, receiptId, outcome: outcome.state });
    }
  }

  async close(): Promise<void> { await this.adapter?.close?.(); }

  readPreview(runId: string): DialoguePreview | undefined {
    try {
      const preview = parseDialoguePreview(this.adapter?.readPreview?.(runId));
      return preview?.runId === runId ? preview : undefined;
    } catch {
      console.warn("weaving.preview unavailable", { runId });
      return undefined;
    }
  }

  private async releasePreview(run: WeavingRun): Promise<void> {
    try { await this.adapter?.releasePreview?.(run); }
    catch { console.warn("weaving.preview release unavailable", { runId: run.runId }); }
  }

  async getJob(sourceId: string): Promise<WeavingJob | null> {
    return this.storage("job.read", false, (db) => {
      const job = db.query<{ id: string; status: WeavingJob["status"] }, [string]>(
        "SELECT id,status FROM jobs WHERE source_id=? AND kind='capture' ORDER BY rowid DESC LIMIT 1",
      ).get(sourceId);
      if (!job) return null;
      if (job.status === "queued") return { sourceId, status: job.status, run: null };
      const row = db.query<WeavingRun, [string]>(
        `SELECT ${runColumns} FROM weaving_runs r JOIN jobs j ON j.id=r.job_id
         WHERE r.job_id=? ORDER BY r.attempt DESC LIMIT 1`,
      ).get(job.id);
      if (!row) throw new WeavingError("invalid_state");
      return { sourceId, status: job.status, run: identity(row, "capture") };
    });
  }

  private claimNext(): Claim | null {
    return this.storage("job.claim", true, (db) => {
      if (db.query("SELECT 1 FROM jobs WHERE status IN ('running','uncertain') LIMIT 1").get()) return null;
      // Covers an abandonment committed after recover's outbox scan but before
      // this claim. Attempted/unconfirmed interrupts never permanently gate work.
      if (db.query("SELECT 1 FROM weaving_abandonment_dispatch WHERE state='queued' LIMIT 1").get()) return null;
      const job = db.query<{ jobId: string; sourceId: string; kind: WeavingJobKind }, []>(
        `SELECT id AS jobId,source_id AS sourceId,kind FROM jobs WHERE status='queued' AND kind IN ('capture','dialogue','follow_up')
          ORDER BY CASE kind WHEN 'dialogue' THEN 1 ELSE 0 END DESC,priority DESC,rowid LIMIT 1`,
      ).get();
      if (!job) return null;
      if (job.kind !== "capture" && job.kind !== "dialogue" && job.kind !== "follow_up") throw new WeavingError("invalid_state");
      const previous = db.query<{ attempt: number }, [string]>(
        "SELECT COALESCE(MAX(attempt),0) AS attempt FROM weaving_runs WHERE job_id=?",
      ).get(job.jobId);
      if (!previous) throw new WeavingError("invalid_state");
      if (previous.attempt >= this.maxAttempts) {
        db.run("UPDATE jobs SET status='failed' WHERE id=? AND status='queued'", [job.jobId]);
        console.info("weaving.job exhausted", { jobId: job.jobId, attempts: previous.attempt });
        return null;
      }
      if (job.kind === "follow_up") freezeFollowUpInput(db, job.jobId);
      const now = this.time();
      const owner = randomUUID();
      const run = identity({ ...job, runId: randomUUID(),
        sessionId: `ses_thoughtloom_${randomBytes(12).toString("hex")}`,
        promptId: `msg_thoughtloom_${randomBytes(12).toString("hex")}` }, job.kind);
      const attempt = previous.attempt + 1;
      const changed = db.query<{ id: string }, [string]>("UPDATE jobs SET status='running' WHERE id=? AND status='queued' RETURNING id").get(job.jobId);
      if (!changed) throw new WeavingError("invalid_state");
      db.run(`INSERT INTO weaving_runs(id,job_id,attempt,session_id,prompt_id,state,lease_owner,lease_until,created_at,updated_at)
        VALUES (?,?,?,?,?,'preparing',?,?,?,?)`,
      [run.runId, run.jobId, attempt, run.sessionId, run.promptId, owner, now + this.leaseMs, now, now]);
      return { run, state: "preparing", attempt, owner, kind: job.kind };
    });
  }

  private beginAdmission(claim: Claim): boolean {
    const updated = this.storage("admission.begin", true, (db) => {
      const now = this.time();
      return !!db.query<{ id: string }, [number, number, string, string, number]>(`UPDATE weaving_runs SET state='admitting',lease_until=?,updated_at=?
        WHERE id=? AND state='preparing' AND lease_owner=? AND lease_until>?
          AND EXISTS (SELECT 1 FROM jobs j WHERE j.id=weaving_runs.job_id AND j.status='running' AND j.kind IN ('capture','dialogue','follow_up'))
          AND NOT EXISTS (SELECT 1 FROM dialogue_stop_requests s WHERE s.job_id=weaving_runs.job_id) RETURNING id`,
      ).get(now + this.leaseMs, now, claim.run.runId, claim.owner, now);
    });
    console.info("weaving.run transition", { runId: claim.run.runId, from: "preparing", to: "admitting", applied: updated });
    return updated;
  }

  private claimRecovery(runId: string): Claim | null {
    return this.storage("recovery.claim", true, (db) => {
      const now = this.time();
      const row = db.query<RunRow, [string, number]>(
        `SELECT ${runColumns} FROM weaving_runs r JOIN jobs j ON j.id=r.job_id
         WHERE r.id=? AND r.outcome IS NULL AND r.state IN ('preparing','admitting','admitted','uncertain')
             AND j.kind IN ('capture','dialogue','follow_up') AND j.status IN ('running','uncertain') AND (r.lease_owner IS NULL OR r.lease_until<=?)`,
      ).get(runId, now);
      if (!row || (row.jobKind !== "capture" && row.jobKind !== "dialogue" && row.jobKind !== "follow_up")) return null;
      const owner = randomUUID();
      db.run("UPDATE weaving_runs SET lease_owner=?,lease_until=?,updated_at=? WHERE id=?",
        [owner, now + this.leaseMs, now, runId]);
      return { run: identity(row, row.jobKind), state: row.state, attempt: row.attempt, owner, kind: row.jobKind };
    });
  }

  private settle(claim: Claim, state: RunState, status: WeavingJob["status"], error: AttemptError | null, changes: number | null = null,
    outcome: "succeeded" | "failed" | "interrupted" | null = state === "completed" ? "succeeded" : null, assistant?: CanonicalAssistant): boolean {
    const updated = this.storage("run.settle", true, (db) => {
      const now = this.time();
      // Bun's change count includes trigger writes. RETURNING fences the actual
      // target row even when settlement also revokes one or more grants.
      const result = db.query<{ id: string }, [string, number, AttemptError | null, number | null, string | null, string, string, string, number]>(
        `UPDATE weaving_runs SET state=?,lease_owner=NULL,lease_until=NULL,updated_at=?,last_error=?,recorded_changes=?,outcome=?
          WHERE id=? AND state=? AND outcome IS NULL AND lease_owner=? AND lease_until>?
            AND EXISTS (SELECT 1 FROM jobs j WHERE j.id=weaving_runs.job_id AND j.status IN ('running','uncertain'))
            AND NOT EXISTS (SELECT 1 FROM weaving_abandonments a WHERE a.run_id=weaving_runs.id) RETURNING id`,
      ).get(state, now, error, state === "completed" ? recordedChanges(db, claim.run.runId) : changes, outcome, claim.run.runId, claim.state, claim.owner, now);
      if (!result) return false;
      const job = db.query<{ id: string }, [string, string]>(
        "UPDATE jobs SET status=? WHERE id=? AND status IN ('running','uncertain') RETURNING id",
      ).get(status, claim.run.jobId);
      if (!job) throw new WeavingError("invalid_state");
      if (claim.kind === "dialogue" && outcome !== null) {
        const turn = db.query<{ id: string }, [string]>("SELECT id FROM dialogue_turns WHERE job_id=?").get(claim.run.jobId);
        if (!turn || (outcome === "succeeded" && (typeof assistant?.text !== "string" || !assistant.messageId.startsWith("msg_")))) throw new WeavingError("invalid_state");
        db.run("INSERT INTO dialogue_outcomes(turn_id,run_id,outcome,assistant_message_id,assistant_text) VALUES (?,?,?,?,?)",
          [turn.id, claim.run.runId, outcome, assistant?.messageId ?? null, assistant?.text ?? null]);
        if (outcome === "succeeded") enqueueDialogueFollowUp(db, claim.run);
      }
      return true;
    });
    console.info("weaving.run transition", { runId: claim.run.runId, from: claim.state, to: state, applied: updated, category: error });
    return updated;
  }

  private time(): number {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(now + this.leaseMs)) {
      throw new WeavingError("invalid_configuration");
    }
    return now;
  }

  // Connections and short write transactions always end before an adapter await.
  private storage<T>(operation: string, write: boolean, action: (db: Database) => T): T {
    console.info("weaving.storage attempt", { operation });
    let connection: Database | undefined;
    try {
      const db = openDatabase(this.databasePath);
      connection = db;
      const transaction = db.transaction(() => action(db));
      const result = write ? transaction.immediate() : transaction.deferred();
      console.info("weaving.storage succeeded", { operation });
      return result;
    } catch (error) {
      const failure = error instanceof WeavingError ? error : new WeavingError("storage_error");
      console.error("weaving.storage failed", { operation, category: failure.code });
      throw failure;
    } finally { connection?.close(); }
  }
}
