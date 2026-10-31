import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { isIdempotencyKey, isRecordId, type WeavingJobKind } from "@thoughtloom/contracts";
import { CURRENT_DATABASE_VERSION } from "./storage";
import type { WeavingRun } from "./weaving";

export const ABANDONMENT_ACKNOWLEDGEMENT = "native-may-continue-and-charge";
export type AbandonUncertainInput = {
  expectedJobId: string; expectedRunId: string; expectedSessionId: string; expectedPromptId: string;
  expectedStatus: "uncertain"; acknowledgement: typeof ABANDONMENT_ACKNOWLEDGEMENT;
};
export type AbandonmentReceipt = {
  id: string; jobId: string; runId: string; sessionId: string; promptId: string; createdAt: number;
  status: "abandoned"; nativeSettlement: "unconfirmed";
};
export type AbandonmentInterruptOutcome = { state: "requested" } |
  { state: "not_requested"; category: "unsupported" | "ownership_unverified" };
export type AbandonmentDispatchOutcome = AbandonmentInterruptOutcome | { state: "uncertain"; category: "request_failed" };
export type AbandonmentDispatch = { receiptId: string; run: WeavingRun };
type ReceiptRow = Omit<AbandonmentReceipt, "status" | "nativeSettlement"> & { hash: string };
type CurrentRun = WeavingRun & { status: string; state: string; outcome: string | null };
type Eligibility = { kind: "eligible"; run: CurrentRun } | { kind: "replayed"; receipt: AbandonmentReceipt };
type LogDetails = { operation: string; category?: string };
type Options = { databasePath: string; now?: () => number; log?: (state: "attempt" | "succeeded" | "failed", details: LogDetails) => void };

export class WeavingAbandonmentError extends Error {
  constructor(readonly code: "invalid_input" | "schema_mismatch" | "not_found" | "conflict" | "already_settled" | "storage_error", options?: ErrorOptions) {
    super(code, options); this.name = "WeavingAbandonmentError";
  }
}
function receipt(row: ReceiptRow): AbandonmentReceipt {
  return { id: row.id, jobId: row.jobId, runId: row.runId, sessionId: row.sessionId, promptId: row.promptId,
    createdAt: row.createdAt, status: "abandoned", nativeSettlement: "unconfirmed" };
}
function payloadHash(input: AbandonUncertainInput, key: string): string {
  if (![input.expectedJobId, input.expectedRunId, input.expectedSessionId, input.expectedPromptId].every(isRecordId) ||
      !isIdempotencyKey(key) || input.expectedStatus !== "uncertain" || input.acknowledgement !== ABANDONMENT_ACKNOWLEDGEMENT) throw new WeavingAbandonmentError("invalid_input");
  return createHash("sha256").update(JSON.stringify(["weaving_abandonment_v1", input.expectedJobId, input.expectedRunId,
    input.expectedSessionId, input.expectedPromptId, input.expectedStatus, input.acknowledgement])).digest("hex");
}

// Operator-only application disposition. This module performs no native/network
// calls and never creates or migrates a database, including in apply mode.
export class WeavingAbandonmentService {
  constructor(private readonly options: Options) {
    if (!isAbsolute(options.databasePath)) throw new WeavingAbandonmentError("invalid_input");
  }

  preview(input: AbandonUncertainInput, key: string): Eligibility {
    const hash = payloadHash(input, key);
    return this.storage("preview", false, (db) => this.eligibility(db, input, key, hash));
  }

  abandon(input: AbandonUncertainInput, key: string): AbandonmentReceipt {
    const hash = payloadHash(input, key);
    return this.storage("apply", true, (db) => {
      const eligible = this.eligibility(db, input, key, hash);
      if (eligible.kind === "replayed") return eligible.receipt;
      const run = eligible.run, now = this.time();
      db.run("UPDATE owned_grants SET revoked=1 WHERE run_id IN (SELECT id FROM weaving_runs WHERE job_id=?)", [run.jobId]);
      db.run("UPDATE weaving_runs SET lease_owner=NULL,lease_until=NULL WHERE id=? AND state='uncertain' AND outcome IS NULL", [run.runId]);
      const saved: AbandonmentReceipt = { id: randomUUID(), jobId: run.jobId, runId: run.runId, sessionId: run.sessionId,
        promptId: run.promptId, createdAt: now, status: "abandoned", nativeSettlement: "unconfirmed" };
      db.run(`INSERT INTO weaving_abandonments(id,idempotency_key,payload_hash,job_id,run_id,session_id,prompt_id,created_at,acknowledgement)
        VALUES (?,?,?,?,?,?,?,?,?)`, [saved.id, key, hash, run.jobId, run.runId, run.sessionId, run.promptId, now, input.acknowledgement]);
      const changed = db.query<{ id: string }, [string]>("UPDATE jobs SET status='abandoned' WHERE id=? AND status='uncertain' RETURNING id").get(run.jobId);
      if (!changed) throw new WeavingAbandonmentError("conflict");
      db.run("INSERT INTO weaving_abandonment_dispatch(abandonment_id,state) VALUES (?,'queued')", [saved.id]);
      return saved;
    });
  }

  claimInterrupt(): AbandonmentDispatch | null {
    return this.storage("interrupt.claim", true, (db) => {
      const row = db.query<WeavingRun & { receiptId: string; kind: WeavingJobKind }, []>(
        `SELECT a.id AS receiptId,r.id AS runId,r.job_id AS jobId,j.source_id AS sourceId,r.session_id AS sessionId,r.prompt_id AS promptId,j.kind
         FROM weaving_abandonment_dispatch d JOIN weaving_abandonments a ON a.id=d.abandonment_id
         JOIN weaving_runs r ON r.id=a.run_id JOIN jobs j ON j.id=r.job_id
         WHERE d.state='queued' AND j.status='abandoned' AND r.state='uncertain' AND r.outcome IS NULL ORDER BY a.rowid LIMIT 1`,
      ).get();
      if (!row) return null;
      const claimed = db.query<{ abandonment_id: string }, [number, string]>(
        "UPDATE weaving_abandonment_dispatch SET state='attempted',attempted_at=? WHERE abandonment_id=? AND state='queued' RETURNING abandonment_id",
      ).get(this.time(), row.receiptId);
      if (!claimed) return null;
      return { receiptId: row.receiptId, run: { runId: row.runId, jobId: row.jobId, sourceId: row.sourceId,
        sessionId: row.sessionId, promptId: row.promptId, kind: row.kind } };
    });
  }

  finishInterrupt(receiptId: string, outcome: AbandonmentDispatchOutcome): void {
    if (!isRecordId(receiptId)) throw new WeavingAbandonmentError("invalid_input");
    this.storage("interrupt.finish", true, (db) => db.run(
      `UPDATE weaving_abandonment_dispatch SET state=?,category=?,finished_at=MAX(attempted_at,?) WHERE abandonment_id=? AND state='attempted'`,
      [outcome.state, outcome.state === "requested" ? null : outcome.category, this.time(), receiptId],
    ));
  }

  private eligibility(db: Database, input: AbandonUncertainInput, key: string, hash: string): Eligibility {
    const prior = db.query<ReceiptRow, [string]>(`SELECT id,payload_hash AS hash,job_id AS jobId,run_id AS runId,
      session_id AS sessionId,prompt_id AS promptId,created_at AS createdAt FROM weaving_abandonments WHERE idempotency_key=?`).get(key);
    if (prior) {
      if (prior.hash !== hash) throw new WeavingAbandonmentError("conflict");
      return { kind: "replayed", receipt: receipt(prior) };
    }
    const run = db.query<CurrentRun, [string]>(`SELECT r.id AS runId,r.job_id AS jobId,j.source_id AS sourceId,
      r.session_id AS sessionId,r.prompt_id AS promptId,j.kind,j.status,r.state,r.outcome FROM jobs j
      JOIN weaving_runs r ON r.job_id=j.id WHERE j.id=? ORDER BY r.attempt DESC LIMIT 1`).get(input.expectedJobId);
    if (!run) throw new WeavingAbandonmentError("not_found");
    if (run.runId !== input.expectedRunId || run.sessionId !== input.expectedSessionId || run.promptId !== input.expectedPromptId) throw new WeavingAbandonmentError("conflict");
    if (run.outcome !== null || ["completed", "failed", "interrupted", "abandoned"].includes(run.status)) throw new WeavingAbandonmentError("already_settled");
    if (run.status !== input.expectedStatus || run.state !== "uncertain" || !["capture", "dialogue", "follow_up"].includes(run.kind ?? "")) throw new WeavingAbandonmentError("conflict");
    return { kind: "eligible", run };
  }

  private time(): number {
    const now = (this.options.now ?? Date.now)();
    if (!Number.isSafeInteger(now) || now < 0) throw new WeavingAbandonmentError("invalid_input");
    return now;
  }

  private storage<T>(operation: string, write: boolean, action: (db: Database) => T): T {
    const log = this.options.log ?? ((state, details) => { (state === "failed" ? console.error : console.info)(`weaving.abandonment ${state}`, details); });
    log("attempt", { operation });
    let db: Database | undefined;
    try {
      db = new Database(this.options.databasePath, write ? { readwrite: true, create: false } : { readonly: true });
      if (db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version !== CURRENT_DATABASE_VERSION) throw new WeavingAbandonmentError("schema_mismatch");
      if (write) { db.run("PRAGMA foreign_keys=ON"); db.run("PRAGMA busy_timeout=5000"); }
      const connection = db, transaction = connection.transaction(() => action(connection));
      const result = write ? transaction.immediate() : transaction.deferred();
      log("succeeded", { operation }); return result;
    } catch (cause) {
      const error = cause instanceof WeavingAbandonmentError ? cause : new WeavingAbandonmentError("storage_error", { cause });
      log("failed", { operation, category: error.code }); throw error;
    } finally { db?.close(); }
  }
}

export function abandonedInterruptAuthorized(db: Database, run: WeavingRun, receiptId: string): boolean {
  return !!db.query(`SELECT 1 FROM weaving_abandonments a JOIN weaving_abandonment_dispatch d ON d.abandonment_id=a.id
    JOIN weaving_runs r ON r.id=a.run_id JOIN jobs j ON j.id=r.job_id JOIN owned_grants g ON g.run_id=r.id AND g.session_id=r.session_id
    WHERE a.id=? AND a.job_id=? AND a.run_id=? AND a.session_id=? AND a.prompt_id=? AND j.source_id=?
      AND r.session_id=a.session_id AND r.prompt_id=a.prompt_id AND r.job_id=a.job_id AND j.status='abandoned'
      AND r.state='uncertain' AND r.outcome IS NULL AND r.lease_owner IS NULL AND r.lease_until IS NULL
      AND g.revoked=1 AND d.state='attempted'`).get(receiptId, run.jobId, run.runId, run.sessionId, run.promptId, run.sourceId);
}
