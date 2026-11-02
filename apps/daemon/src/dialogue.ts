import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { DIALOGUE_LIMITS, isIdempotencyKey, isRecordId, parseDialogueInput, parseDialogueTurnInput, parseDialogueTurnReceipt, parseDialogueView,
  parseDialogueStopInput, parseDialogueStopReceipt, type DialogueStopInput, type DialogueStopReceipt,
  type DialogueInput, type DialogueTurnInput, type DialogueTurnReceipt, type DialogueView, type DialoguePreview } from "@thoughtloom/contracts";
import { openDatabase, sourceOrigin } from "./storage";
import { dialogueHeader, snapshotContext, dialogueChanges } from "./dialogue-data";
import { KnowledgeError } from "./knowledge";
import { refreshSourceSearch } from "./search-projection";

export class DialogueError extends Error {
  constructor(readonly code: "invalid_input" | "invalid_selection" | "not_found" | "turn_conflict" | "operation_conflict" | "storage_error") {
    super(code); this.name = "DialogueError";
  }
}
type TurnRow = { id: string; dialogueId: string; sourceId: string; jobId: string; createdAt: string; text: string; provenance: string; status: string; assistant: string | null; outcome: string | null;
  runId: string | null; stopRequested: number };
type TurnResult = { kind: "created" | "replayed"; receipt: DialogueTurnReceipt };
const turnColumns = `t.id,t.dialogue_id AS dialogueId,t.source_id AS sourceId,t.job_id AS jobId,t.created_at AS createdAt,s.text,s.provenance,j.status`;

type PreviewReader = (runId: string) => DialoguePreview | undefined;
function view(db: Database, id: string, readPreview?: PreviewReader): DialogueView | null {
  const row = dialogueHeader(db, id);
  if (!row) return null;
  const rows = db.query<TurnRow, [string]>(`SELECT ${turnColumns},o.assistant_text AS assistant,o.outcome,
    (SELECT r.id FROM weaving_runs r WHERE r.job_id=t.job_id ORDER BY r.attempt DESC LIMIT 1) AS runId,
    EXISTS(SELECT 1 FROM dialogue_stop_requests stop WHERE stop.turn_id=t.id) AS stopRequested FROM dialogue_turns t JOIN sources s ON s.id=t.source_id
    JOIN jobs j ON j.id=t.job_id LEFT JOIN dialogue_outcomes o ON o.turn_id=t.id WHERE t.dialogue_id=? AND j.kind='dialogue' ORDER BY t.position DESC LIMIT ${DIALOGUE_LIMITS.turns + 1}`).all(id);
  const result = parseDialogueView({ ...row,
    turns: rows.slice(0, DIALOGUE_LIMITS.turns).reverse().map((turn) => {
      const preview = turn.assistant === null && turn.outcome === null && turn.runId && ["running", "uncertain"].includes(turn.status)
        ? readPreview?.(turn.runId) : undefined;
      return { id: turn.id, jobId: turn.jobId, createdAt: turn.createdAt, status: turn.status,
      stopRequested: !!turn.stopRequested, actions: { stop: { eligible: !turn.stopRequested && ["queued", "running", "uncertain"].includes(turn.status),
         expectedRunId: turn.status === "queued" || turn.status === "abandoned" ? null : turn.runId }, retry: false },
      source: { id: turn.sourceId, text: turn.text, provenance: turn.provenance, createdAt: turn.createdAt, origin: sourceOrigin(db, turn.sourceId) }, changes: dialogueChanges(db, turn.jobId),
      ...(preview && preview.runId === turn.runId ? { preview } : {}),
      ...(turn.assistant !== null ? { assistant: { text: turn.assistant } } : {}), ...(turn.outcome ? { outcome: turn.outcome } : {}) };
    }), turnsTruncated: rows.length > DIALOGUE_LIMITS.turns });
  if (!result) throw new DialogueError("storage_error");
  return result;
}
function receipt(turn: Pick<TurnRow, "id" | "dialogueId" | "sourceId" | "jobId" | "createdAt">): DialogueTurnReceipt {
  const result = parseDialogueTurnReceipt({ ...turn, status: "queued" });
  if (!result) throw new DialogueError("storage_error");
  return result;
}

export class DialogueService {
  constructor(private readonly databasePath: string, private readonly readPreview?: PreviewReader) {}

  create(sourceId: string, input: DialogueInput, key?: string): DialogueView {
    if (!isRecordId(sourceId) || !parseDialogueInput(input) || (key !== undefined && !isIdempotencyKey(key))) throw new DialogueError("invalid_input");
    const hash = createHash("sha256").update(JSON.stringify([sourceId, input.selection])).digest("hex");
    const result = this.storage("create", true, { sourceId }, (db) => {
      if (key) {
        const prior = db.query<{ hash: string; response: string }, [string]>("SELECT payload_hash AS hash,response FROM dialogue_creation_receipts WHERE idempotency_key=?").get(key);
        if (prior) {
          if (prior.hash !== hash) throw new DialogueError("operation_conflict");
          const response = parseDialogueView(JSON.parse(prior.response));
          if (!response) throw new DialogueError("storage_error");
          return response;
        }
      }
      if (!db.query("SELECT 1 FROM sources WHERE id=?").get(sourceId)) throw new DialogueError("not_found");
      const selectedContext = snapshotContext(db, sourceId, input.selection);
      const id = randomUUID(), createdAt = new Date().toISOString();
      const valid = parseDialogueView({ id, sourceId, createdAt, selection: input.selection, selectedContext, turns: [], turnsTruncated: false });
      if (!valid) throw new DialogueError("invalid_selection");
      // Versions and their evidence are append-only. Retain the exact selected
      // snapshot too; later corrections never retarget this dialogue to latest.
      const selected = input.selection;
      db.run(`INSERT INTO dialogues(id,source_id,selection_kind,item_id,version_id,relationship_id,relationship_version_id,from_version_id,to_version_id,context,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [id, sourceId, selected.kind, selected.kind === "item" ? selected.id : null, selected.kind === "item" ? selected.versionId : null,
          selected.kind === "relationship" ? selected.id : null, selected.kind === "relationship" ? selected.versionId : null,
          selected.kind === "relationship" ? selected.fromVersionId : null, selected.kind === "relationship" ? selected.toVersionId : null, JSON.stringify(valid.selectedContext), createdAt]);
      if (key) db.run("INSERT INTO dialogue_creation_receipts(idempotency_key,payload_hash,dialogue_id,response) VALUES (?,?,?,?)", [key, hash, id, JSON.stringify(valid)]);
      return valid;
    });
    console.info("dialogue.created", { dialogueId: result.id, sourceId });
    return result;
  }

  get(id: string): DialogueView | null {
    if (!isRecordId(id)) throw new DialogueError("invalid_input");
    return this.storage("read", false, { dialogueId: id }, (db) => view(db, id, this.readPreview));
  }

  stop(id: string, turnId: string, key: string, input: DialogueStopInput): DialogueStopReceipt {
    if (!isRecordId(id) || !isRecordId(turnId) || !isIdempotencyKey(key) || !parseDialogueStopInput(input)) throw new DialogueError("invalid_input");
    const hash = createHash("sha256").update(JSON.stringify(["dialogue_stop", id, turnId, input.expectedRunId])).digest("hex");
    return this.storage("turn.stop", true, { dialogueId: id }, (db) => {
      const prior = db.query<{ id: string; dialogueId: string; turnId: string; expectedRunId: string | null; createdAt: string; hash: string }, [string]>(
        `SELECT id,dialogue_id AS dialogueId,turn_id AS turnId,expected_run_id AS expectedRunId,created_at AS createdAt,payload_hash AS hash
         FROM dialogue_stop_requests WHERE idempotency_key=?`).get(key);
      if (prior) {
        if (prior.hash !== hash) throw new DialogueError("operation_conflict");
        const saved = parseDialogueStopReceipt({ ...prior, status: "stop_requested" });
        if (!saved) throw new DialogueError("storage_error");
        return saved;
      }
      const turn = db.query<{ jobId: string; status: string }, [string, string]>(`SELECT t.job_id AS jobId,j.status FROM dialogue_turns t JOIN jobs j ON j.id=t.job_id
        WHERE t.id=? AND t.dialogue_id=? AND j.kind='dialogue'`).get(turnId, id);
      if (!turn) throw new DialogueError("not_found");
      if (!["queued", "running", "uncertain"].includes(turn.status) || db.query("SELECT 1 FROM dialogue_stop_requests WHERE turn_id=?").get(turnId)) throw new DialogueError("turn_conflict");
      const run = db.query<{ id: string; state: string }, [string]>(`SELECT id,state FROM weaving_runs WHERE job_id=? AND outcome IS NULL
        AND state IN ('preparing','admitting','admitted','uncertain') ORDER BY attempt DESC LIMIT 1`).get(turn.jobId);
      if ((run?.id ?? null) !== input.expectedRunId || (turn.status !== "queued" && !run) || (turn.status === "queued" && run)) throw new DialogueError("turn_conflict");
      const saved = parseDialogueStopReceipt({ id: randomUUID(), dialogueId: id, turnId, expectedRunId: input.expectedRunId,
        createdAt: new Date().toISOString(), status: "stop_requested" });
      if (!saved) throw new DialogueError("storage_error");
      db.run(`INSERT INTO dialogue_stop_requests(id,idempotency_key,payload_hash,dialogue_id,turn_id,job_id,expected_run_id,created_at) VALUES (?,?,?,?,?,?,?,?)`,
        [saved.id, key, hash, id, turnId, turn.jobId, input.expectedRunId, saved.createdAt]);
      if (!run || run.state === "preparing") {
        // Preparation cannot submit. Fence the in-flight preparer as well as the
        // queue before returning; it may not later requeue or gain a grant.
        if (run) db.run("UPDATE weaving_runs SET state='not_admitted',lease_owner=NULL,lease_until=NULL,updated_at=? WHERE id=? AND state='preparing'", [Date.now(), run.id]);
        db.run("UPDATE jobs SET status='interrupted' WHERE id=?", [turn.jobId]);
      } else {
        db.run("INSERT INTO dialogue_stop_dispatch(stop_id,state) VALUES (?,'queued')", [saved.id]);
      }
      return saved;
    });
  }

  submit(id: string, key: string, input: DialogueTurnInput): TurnResult {
    if (!isRecordId(id) || !isIdempotencyKey(key) || !parseDialogueTurnInput(input)) throw new DialogueError("invalid_input");
    const hash = createHash("sha256").update(JSON.stringify([id, input.text])).digest("hex");
    const result = this.storage("turn.save", true, { dialogueId: id }, (db): TurnResult => {
      const prior = db.query<{ hash: string; turnId: string }, [string]>("SELECT payload_hash AS hash,turn_id AS turnId FROM dialogue_turn_receipts WHERE idempotency_key=?").get(key);
      if (prior) {
        if (prior.hash !== hash) throw new DialogueError("operation_conflict");
        const turn = db.query<TurnRow, [string]>(`SELECT ${turnColumns} FROM dialogue_turns t JOIN sources s ON s.id=t.source_id JOIN jobs j ON j.id=t.job_id WHERE t.id=?`).get(prior.turnId);
        if (!turn || turn.dialogueId !== id || turn.text !== input.text) throw new DialogueError("storage_error");
        return { kind: "replayed", receipt: receipt(turn) };
      }
      const dialogue = view(db, id);
      if (!dialogue) throw new DialogueError("not_found");
      // One pending interactive command per root, including other selections on
      // that root. Lease expiry or an uncertain admission never opens this gate.
      const pending = db.query(`SELECT 1 FROM dialogue_turns t JOIN dialogues d ON d.id=t.dialogue_id JOIN jobs j ON j.id=t.job_id
         WHERE d.source_id=? AND j.status NOT IN ('completed','failed','interrupted','abandoned') LIMIT 1`).get(dialogue.sourceId);
      if (pending) throw new DialogueError("turn_conflict");
      const sourceId = randomUUID(), turnId = randomUUID(), jobId = randomUUID(), createdAt = new Date().toISOString();
      const position = db.query<{ next: number }, [string]>("SELECT COALESCE(MAX(position),0)+1 AS next FROM dialogue_turns WHERE dialogue_id=?").get(id)?.next;
      if (!position || !Number.isSafeInteger(position)) throw new DialogueError("storage_error");
      const saved = receipt({ id: turnId, dialogueId: id, sourceId, jobId, createdAt });
      // Server-owned root + turn scope travels with this immutable command,
      // never a model-provided role or a session's mutable "current turn".
      const command = JSON.stringify({ dialogueId: id, turnId, rootSourceId: dialogue.sourceId, turnSourceId: sourceId,
        sourceIds: [dialogue.sourceId, sourceId], selection: dialogue.selection, selectedContext: dialogue.selectedContext, text: input.text });
      db.run("INSERT INTO sources(id,text,provenance,created_at) VALUES (?,?,'discussion-turn',?)", [sourceId, input.text, createdAt]);
      db.run("INSERT INTO jobs(id,source_id,status,priority,kind) VALUES (?,?,'queued',1,'dialogue')", [jobId, dialogue.sourceId]);
      db.run("INSERT INTO dialogue_turns(id,dialogue_id,source_id,job_id,position,created_at) VALUES (?,?,?,?,?,?)", [turnId, id, sourceId, jobId, position, createdAt]);
      db.run("INSERT INTO dialogue_turn_receipts(idempotency_key,payload_hash,turn_id,command) VALUES (?,?,?,?)", [key, hash, turnId, command]);
      refreshSourceSearch(db, sourceId);
      return { kind: "created", receipt: saved };
    });
    console.info("dialogue.turn saved", { dialogueId: id, turnId: result.receipt.id, sourceId: result.receipt.sourceId, jobId: result.receipt.jobId, outcome: result.kind });
    return result;
  }

  private storage<T>(operation: string, write: boolean, identity: { sourceId?: string; dialogueId?: string }, action: (db: Database) => T): T {
    console.info("dialogue.storage attempt", { operation, ...identity });
    let db: Database | undefined;
    try {
      db = openDatabase(this.databasePath);
      const connection = db;
      const transaction = connection.transaction(() => action(connection));
      const result = write ? transaction.immediate() : transaction.deferred();
      console.info("dialogue.storage outcome", { operation, ...identity, outcome: "succeeded" });
      return result;
    } catch (error) {
      const failure = error instanceof DialogueError ? error : new DialogueError(error instanceof KnowledgeError && error.code === "invalid_reference" ? "invalid_selection" : "storage_error");
      console.error("dialogue.storage outcome", { operation, ...identity, outcome: "failed", category: failure.code });
      throw failure;
    } finally { db?.close(); }
  }
}
