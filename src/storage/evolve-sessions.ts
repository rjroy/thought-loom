import type { Database } from "bun:sqlite";
import { evolveKey, evolveTurnText, evolveValue, EvolveConflictError, EvolveNotFoundError, type EvolveReceipt, type EvolveSession, type EvolveSessions, type EvolveTurn } from "../domain/evolve-sessions";
import { immediate } from "./transaction";

export function migrateEvolveSessions(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS evolve_sessions (
      id TEXT PRIMARY KEY NOT NULL,
      anchor_id TEXT NOT NULL REFERENCES thoughts(id),
      continuation_id TEXT NOT NULL REFERENCES thoughts(id),
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS evolve_turns (
      id TEXT PRIMARY KEY NOT NULL,
      session_id TEXT NOT NULL REFERENCES evolve_sessions(id),
      request_key TEXT NOT NULL,
      parent_id TEXT NOT NULL REFERENCES thoughts(id),
      text TEXT NOT NULL,
      admitted_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending')),
      open_slot INTEGER NOT NULL CHECK(open_slot=1),
      UNIQUE(session_id,request_key), UNIQUE(session_id,open_slot)
    );
    CREATE TRIGGER IF NOT EXISTS evolve_sessions_identity_immutable BEFORE UPDATE OF id,anchor_id,created_at ON evolve_sessions
      BEGIN SELECT RAISE(ABORT,'evolve session identity is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS evolve_sessions_immutable_delete BEFORE DELETE ON evolve_sessions
      BEGIN SELECT RAISE(ABORT,'evolve sessions are retained'); END;
    CREATE TRIGGER IF NOT EXISTS evolve_turns_immutable_update BEFORE UPDATE ON evolve_turns
      BEGIN SELECT RAISE(ABORT,'evolve turn admission is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS evolve_turns_immutable_delete BEFORE DELETE ON evolve_turns
      BEGIN SELECT RAISE(ABORT,'evolve turns are retained'); END;
  `);
}

interface SessionRow { id: string; anchor_id: string; continuation_id: string; created_at: string }
interface TurnRow { id: string; session_id: string; parent_id: string; text: string; admitted_at: string; status: "pending" }
const sessionDto = (row: SessionRow): EvolveSession => ({ id:row.id, anchorThoughtId:row.anchor_id, continuationThoughtId:row.continuation_id, mode:"ideas-only", createdAt:row.created_at });
const turnDto = (row: TurnRow): EvolveTurn => ({ id:row.id, parentId:row.parent_id, text:row.text, status:row.status, admittedAt:row.admitted_at });
const view = (row: TurnRow): { receipt:EvolveReceipt; turn:EvolveTurn } => ({
  receipt:{sessionId:row.session_id,turnId:row.id,admittedAt:row.admitted_at}, turn:turnDto(row),
});
const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);

/** User-only durable admission. Pending turns are not run identities or worker jobs. */
export class SqliteEvolveSessions implements EvolveSessions {
  constructor(private readonly db: Database, private readonly sources: { id: () => string; now: () => string }) {}
  private session(id: string): SessionRow {
    const row = this.db.query<SessionRow,[Uint8Array]>("SELECT * FROM evolve_sessions WHERE id=CAST(? AS TEXT)").get(utf8(id));
    if (!row) throw new EvolveNotFoundError();
    return row;
  }
  private eligible(id: string): boolean {
    return this.db.query("SELECT 1 FROM thoughts t WHERE t.id=CAST(? AS TEXT) AND NOT EXISTS(SELECT 1 FROM rejected_thoughts r WHERE r.thought_id=t.id)").get(utf8(id)) !== null;
  }
  create(anchor: string): EvolveSession {
    evolveValue(anchor,"anchorThoughtId");
    return immediate(this.db, () => {
      if (!this.eligible(anchor)) throw new EvolveNotFoundError();
      const row = {id:this.sources.id(),anchor_id:anchor,continuation_id:anchor,created_at:this.sources.now()};
      this.db.run("INSERT INTO evolve_sessions(id,anchor_id,continuation_id,created_at) VALUES (CAST(? AS TEXT),CAST(? AS TEXT),CAST(? AS TEXT),CAST(? AS TEXT))",
        [utf8(evolveValue(row.id,"session id")),utf8(row.anchor_id),utf8(row.continuation_id),utf8(evolveValue(row.created_at,"createdAt"))]);
      return sessionDto(row);
    });
  }
  read(id: string): { session: EvolveSession; turns: EvolveTurn[] } {
    evolveValue(id,"session id");
    return this.db.transaction(() => ({
      session:sessionDto(this.session(id)),
      turns:this.db.query<TurnRow,[Uint8Array]>("SELECT * FROM evolve_turns WHERE session_id=CAST(? AS TEXT) ORDER BY rowid").all(utf8(id)).map(turnDto),
    }))();
  }
  byKey(id: string, key: string): { receipt: EvolveReceipt; turn: EvolveTurn } | null {
    evolveValue(id,"session id"); evolveKey(key);
    this.session(id);
    const row = this.db.query<TurnRow,[Uint8Array,string]>("SELECT * FROM evolve_turns WHERE session_id=CAST(? AS TEXT) AND request_key=?").get(utf8(id),key);
    return row ? view(row) : null;
  }
  admit(id: string, key: string, input: { parentId: string; text: string }): { receipt: EvolveReceipt; turn: EvolveTurn; replayed: boolean } {
    evolveValue(id,"session id"); evolveKey(key); evolveValue(input.parentId,"parentId"); evolveTurnText(input.text);
    return immediate(this.db, () => {
      const owner = this.session(id);
      const existing = this.db.query<TurnRow,[Uint8Array,string]>("SELECT * FROM evolve_turns WHERE session_id=CAST(? AS TEXT) AND request_key=?").get(utf8(id),key);
      if (existing) {
        if (existing.parent_id !== input.parentId || existing.text !== input.text) throw new EvolveConflictError("idempotency-conflict");
        return {...view(existing),replayed:true};
      }
      if (!this.eligible(owner.anchor_id) || !this.eligible(input.parentId)) throw new EvolveNotFoundError();
      if (input.parentId !== owner.anchor_id) throw new EvolveConflictError("invalid-continuation");
      if (this.db.query("SELECT 1 FROM evolve_turns WHERE session_id=CAST(? AS TEXT) AND open_slot=1").get(utf8(id))) throw new EvolveConflictError("turn-active");
      const row: TurnRow = {id:this.sources.id(),session_id:id,parent_id:input.parentId,text:input.text,admitted_at:this.sources.now(),status:"pending"};
      this.db.run("INSERT INTO evolve_turns(id,session_id,request_key,parent_id,text,admitted_at,status,open_slot) VALUES (CAST(? AS TEXT),CAST(? AS TEXT),?,CAST(? AS TEXT),CAST(? AS TEXT),CAST(? AS TEXT),'pending',1)",
        [utf8(evolveValue(row.id,"turn id")),utf8(id),key,utf8(row.parent_id),utf8(row.text),utf8(evolveValue(row.admitted_at,"admittedAt"))]);
      return {...view(row),replayed:false};
    });
  }
}
