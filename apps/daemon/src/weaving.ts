import type { Database } from "bun:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { openDatabase } from "./storage";
import { isIdempotencyKey, isRecordId, parseWeavingRetryReceipt, parseWeavingStatusView, parseWeavingWorkerView, weavingWorkerAvailable,
  type WeavingJobStatus, type WeavingRetryInput, type WeavingRetryReceipt, type WeavingStatusView, type WeavingWorkerView } from "@thoughtloom/contracts";

export type WeavingRun = {
  readonly jobId: string;
  readonly sourceId: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly promptId: string;
};

export type WeavingJob = {
  sourceId: string;
  status: WeavingJobStatus;
  run: WeavingRun | null;
};

type Admission = { kind: "admitted" } | { kind: "uncertain" };
export type Observation = { kind: "pending" } | { kind: "completed"; recordedChanges: number } | { kind: "failed" } | { kind: "interrupted" };

// Native implementations attach to the selected operator-owned service. Preparing
// verifies/creates only this session: it must never submit a prompt. Inspection
// reports completion only from canonical evidence for this particular prompt.
export interface WeavingAdapter {
  prepareSession(run: WeavingRun): Promise<void>;
  admit(run: WeavingRun): Promise<Admission>;
  inspect(run: WeavingRun): Promise<Observation>;
  close?(): Promise<void>;
}

type AttemptError = "preparation_failed" | "admission_unknown" | "inspection_failed" | "invalid_adapter_result";
type RunState = "preparing" | "admitting" | "admitted" | "uncertain" | "completed" | "not_admitted";
type OpenState = Exclude<RunState, "completed" | "not_admitted">;
type RunRow = WeavingRun & { state: OpenState; attempt: number };
type Claim = { run: WeavingRun; state: OpenState; attempt: number; owner: string };
type StatusRun = { id: string; attempt: number; state: string; outcome: string | null; lastError: string | null;
  leaseOwner: string | null; leaseUntil: number | null; attempted: number | null };
type StatusSnapshot = { job: { id: string; status: string }; run: StatusRun | null; attempts: number };
type RetryResult = { kind: "accepted"; receipt: WeavingRetryReceipt } | { kind: "conflict" | "unavailable" | "not_found" };

function snapshot(db: Database, sourceId: string): StatusSnapshot | null {
  if (!db.query("SELECT 1 FROM sources WHERE id=?").get(sourceId)) return null;
  const job = db.query<{ id: string; status: string }, [string]>("SELECT id,status FROM jobs WHERE source_id=? ORDER BY rowid DESC LIMIT 1").get(sourceId);
  if (!job) throw new WeavingError("invalid_state");
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
  r.session_id AS sessionId, r.prompt_id AS promptId, r.state, r.attempt`;

function identity(row: WeavingRun): WeavingRun {
  return Object.freeze({ jobId: row.jobId, sourceId: row.sourceId, runId: row.runId,
    sessionId: row.sessionId, promptId: row.promptId });
}

export class WeavingWorker {
  private readonly databasePath: string;
  private readonly adapter: WeavingAdapter | null;
  private readonly now: () => number;
  private readonly leaseMs: number;
  private readonly maxAttempts: number;
  private readonly recoveryLimit: number;

  constructor(options: WeavingWorkerOptions) {
    this.databasePath = options.databasePath;
    this.adapter = options.adapter;
    this.now = options.now ?? Date.now;
    this.leaseMs = options.leaseMs ?? 30_000;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.recoveryLimit = options.recoveryLimit ?? 50;
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
    if (db.query("SELECT 1 FROM weaving_retry_receipts WHERE expected_run_id=?").get(run.id)) return false;
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
      return { kind: "unavailable" };
    }
    console.info("weaving.prepare succeeded", { runId: run.runId });

    // Commit the possible-admission marker before crossing the external boundary.
    // Losing a lease never authorizes another submission of these or fresh IDs.
    if (!this.beginAdmission(claim)) return { kind: "started", run };
    const admitting = { ...claim, state: "admitting" } satisfies Claim;
    let admission: Admission | undefined;
    let category: AttemptError | null = null;
    console.info("weaving.admit attempt", { runId: run.runId });
    try {
      admission = await adapter.admit(run);
    } catch {
      category = "admission_unknown";
    }
    const admitted = admission?.kind === "admitted";
    if (!admitted && admission?.kind !== "uncertain" && !category) category = "invalid_adapter_result";
    console.info("weaving.admit outcome", { runId: run.runId, outcome: admitted ? "admitted" : "uncertain", category });
    this.settle(admitting, admitted ? "admitted" : "uncertain", admitted ? "running" : "uncertain", category);
    return { kind: "started", run };
  }

  async recover(): Promise<void> {
    const adapter = this.adapter;
    if (!adapter) {
      console.info("weaving.recover unavailable", { category: "unconfigured" });
      return;
    }
    const candidates = this.storage("recovery.list", false, (db) => db.query<{ id: string }, [number, number]>(
      `SELECT r.id FROM weaving_runs r JOIN jobs j ON j.id=r.job_id
        WHERE j.status IN ('running','uncertain') AND r.outcome IS NULL AND r.state IN ('preparing','admitting','admitted','uncertain')
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
      if (observation?.kind === "completed" && Number.isSafeInteger(observation.recordedChanges) && observation.recordedChanges >= 0) {
        console.info("weaving.inspect completed", { runId: claim.run.runId, recordedChanges: observation.recordedChanges });
        this.settle(claim, "completed", "completed", null, observation.recordedChanges);
      } else if (observation?.kind === "failed" || observation?.kind === "interrupted") {
        this.settle(claim, "admitted", observation.kind, null, null, observation.kind);
      } else {
        if (observation?.kind !== "pending" && !category) category = "invalid_adapter_result";
        console.info("weaving.inspect unresolved", { runId: claim.run.runId, category });
        // Missing evidence is not failure or non-admission. Only a previously
        // acknowledged admission may stay running; interrupted preparation or
        // admission becomes uncertain and is never automatically resubmitted.
        const state = claim.state === "admitted" ? "admitted" : "uncertain";
        this.settle(claim, state, state === "admitted" ? "running" : "uncertain", category);
      }
    }
  }

  async close(): Promise<void> { await this.adapter?.close?.(); }

  async getJob(sourceId: string): Promise<WeavingJob | null> {
    return this.storage("job.read", false, (db) => {
      const job = db.query<{ id: string; status: WeavingJob["status"] }, [string]>(
        "SELECT id,status FROM jobs WHERE source_id=? ORDER BY rowid DESC LIMIT 1",
      ).get(sourceId);
      if (!job) return null;
      if (job.status === "queued") return { sourceId, status: job.status, run: null };
      const row = db.query<WeavingRun, [string]>(
        `SELECT ${runColumns} FROM weaving_runs r JOIN jobs j ON j.id=r.job_id
         WHERE r.job_id=? ORDER BY r.attempt DESC LIMIT 1`,
      ).get(job.id);
      if (!row) throw new WeavingError("invalid_state");
      return { sourceId, status: job.status, run: identity(row) };
    });
  }

  private claimNext(): Claim | null {
    return this.storage("job.claim", true, (db) => {
      if (db.query("SELECT 1 FROM jobs WHERE status IN ('running','uncertain') LIMIT 1").get()) return null;
      const job = db.query<{ jobId: string; sourceId: string }, []>(
        "SELECT id AS jobId,source_id AS sourceId FROM jobs WHERE status='queued' ORDER BY priority DESC,rowid LIMIT 1",
      ).get();
      if (!job) return null;
      const previous = db.query<{ attempt: number }, [string]>(
        "SELECT COALESCE(MAX(attempt),0) AS attempt FROM weaving_runs WHERE job_id=?",
      ).get(job.jobId);
      if (!previous) throw new WeavingError("invalid_state");
      if (previous.attempt >= this.maxAttempts) {
        db.run("UPDATE jobs SET status='failed' WHERE id=? AND status='queued'", [job.jobId]);
        console.info("weaving.job exhausted", { jobId: job.jobId, attempts: previous.attempt });
        return null;
      }
      const now = this.time();
      const owner = randomUUID();
      const run = identity({ ...job, runId: randomUUID(),
        sessionId: `ses_thoughtloom_${randomBytes(12).toString("hex")}`,
        promptId: `msg_thoughtloom_${randomBytes(12).toString("hex")}` });
      const attempt = previous.attempt + 1;
      const changed = db.query<{ id: string }, [string]>("UPDATE jobs SET status='running' WHERE id=? AND status='queued' RETURNING id").get(job.jobId);
      if (!changed) throw new WeavingError("invalid_state");
      db.run(`INSERT INTO weaving_runs(id,job_id,attempt,session_id,prompt_id,state,lease_owner,lease_until,created_at,updated_at)
        VALUES (?,?,?,?,?,'preparing',?,?,?,?)`,
      [run.runId, run.jobId, attempt, run.sessionId, run.promptId, owner, now + this.leaseMs, now, now]);
      return { run, state: "preparing", attempt, owner };
    });
  }

  private beginAdmission(claim: Claim): boolean {
    const updated = this.storage("admission.begin", true, (db) => {
      const now = this.time();
      return !!db.query<{ id: string }, [number, number, string, string, number]>(`UPDATE weaving_runs SET state='admitting',lease_until=?,updated_at=?
        WHERE id=? AND state='preparing' AND lease_owner=? AND lease_until>? RETURNING id`,
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
           AND j.status IN ('running','uncertain') AND (r.lease_owner IS NULL OR r.lease_until<=?)`,
      ).get(runId, now);
      if (!row) return null;
      const owner = randomUUID();
      db.run("UPDATE weaving_runs SET lease_owner=?,lease_until=?,updated_at=? WHERE id=?",
        [owner, now + this.leaseMs, now, runId]);
      return { run: identity(row), state: row.state, attempt: row.attempt, owner };
    });
  }

  private settle(claim: Claim, state: RunState, status: WeavingJob["status"], error: AttemptError | null, changes: number | null = null,
    outcome: "succeeded" | "failed" | "interrupted" | null = state === "completed" ? "succeeded" : null): boolean {
    const updated = this.storage("run.settle", true, (db) => {
      const now = this.time();
      // Bun's change count includes trigger writes. RETURNING fences the actual
      // target row even when settlement also revokes one or more grants.
      const result = db.query<{ id: string }, [string, number, AttemptError | null, number | null, string | null, string, string, string, number]>(
        `UPDATE weaving_runs SET state=?,lease_owner=NULL,lease_until=NULL,updated_at=?,last_error=?,recorded_changes=?,outcome=?
         WHERE id=? AND state=? AND outcome IS NULL AND lease_owner=? AND lease_until>? RETURNING id`,
      ).get(state, now, error, changes, outcome, claim.run.runId, claim.state, claim.owner, now);
      if (!result) return false;
      const job = db.query<{ id: string }, [string, string]>(
        "UPDATE jobs SET status=? WHERE id=? AND status IN ('running','uncertain') RETURNING id",
      ).get(status, claim.run.jobId);
      if (!job) throw new WeavingError("invalid_state");
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
