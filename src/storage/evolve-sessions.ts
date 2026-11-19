import type { Database } from "bun:sqlite";
import { createLogger } from "../logging";
import { evolveKey, evolveReplyText, evolveTurnText, evolveValue, EvolveConflictError, EvolveNotFoundError,
  type EvolveAdmissionView, type EvolvePassage, type EvolveSave, type EvolveSession, type EvolveSessions, type EvolveTurn } from "../domain/evolve-sessions";
import type { RunRecord, RunSources } from "../domain/run";
import { oneOf } from "../domain/validation";
import { evolveOwner, evolveTurnById, evolveSaves, evolveSaveDto, evolveSaveSql, evolveTurnView, evolveTurnSql, evolveRunView, evolveUtf8,
  type EvolveSaveRow, type EvolveTurnRow } from "./evolve-records";
import { insertRun } from "./run-record";
import { evolveContextEligible, evolveThoughtEligible } from "./evolve-context";
import { saveEvolveIdea } from "./evolve-save";
import { immediate } from "./transaction";

export class SqliteEvolveSessions implements EvolveSessions {
  private readonly logger;
  constructor(private readonly db: Database, private readonly sources: RunSources, private readonly configured = false) {
    this.logger = sources.logger ?? createLogger();
  }
  private session(id: string): EvolveSession {
    const owner = evolveOwner(this.db,evolveValue(id,"session id"));
    if (!owner) throw new EvolveNotFoundError();
    return owner;
  }
  private turn(sessionId: string, turnId: string): EvolveTurnRow {
    const turn = evolveTurnById(this.db,evolveValue(turnId,"turn id"));
    if (!turn || turn.session_id !== sessionId) throw new EvolveNotFoundError();
    return turn;
  }
  private byRequest(id: string, key: string): EvolveTurnRow | null {
    return this.db.query<EvolveTurnRow,[Uint8Array,string]>(`${evolveTurnSql} WHERE t.session_id=CAST(? AS TEXT) AND t.request_key=?`).get(evolveUtf8(id),key);
  }
  private view(row: EvolveTurnRow): EvolveAdmissionView {
    return {receipt:{sessionId:row.session_id,turnId:row.id,admittedAt:row.admitted_at},
      turn:evolveTurnView(row,evolveSaves(this.db,row.id)),run:row.run_id && row.runStatus ? evolveRunView(this.db,row.run_id,row.runStatus) : null};
  }
  private requireContinuation(owner: EvolveSession, thoughtId: string): void {
    if (!evolveThoughtEligible(this.db,owner.anchorThoughtId) || !evolveThoughtEligible(this.db,thoughtId)) throw new EvolveNotFoundError();
    if (thoughtId !== owner.anchorThoughtId && !this.db.query(`SELECT 1 FROM evolve_saves s JOIN evolve_turns t ON t.id=s.turn_id
      WHERE t.session_id=CAST(? AS TEXT) AND s.thought_id=CAST(? AS TEXT)`).get(evolveUtf8(owner.id),evolveUtf8(thoughtId))) {
      throw new EvolveConflictError("invalid-continuation");
    }
  }
  private active(id: string): boolean {
    return !!this.db.query(`SELECT 1 FROM evolve_turns WHERE session_id=CAST(? AS TEXT) AND open_slot=1 AND run_id IS NOT NULL`).get(evolveUtf8(id));
  }
  private setContinuation(id: string, thoughtId: string): void {
    this.db.run("UPDATE evolve_sessions SET continuation_id=CAST(? AS TEXT) WHERE id=CAST(? AS TEXT)",[evolveUtf8(thoughtId),evolveUtf8(id)]);
  }
  create(anchor: string): EvolveSession {
    evolveValue(anchor,"anchorThoughtId");
    return immediate(this.db, () => {
      if (!evolveThoughtEligible(this.db,anchor)) throw new EvolveNotFoundError();
      const id = evolveValue(this.sources.id(),"session id"), at = evolveValue(this.sources.now(),"createdAt");
      this.db.run("INSERT INTO evolve_sessions(id,anchor_id,continuation_id,created_at) VALUES (CAST(? AS TEXT),CAST(? AS TEXT),CAST(? AS TEXT),CAST(? AS TEXT))",
        [evolveUtf8(id),evolveUtf8(anchor),evolveUtf8(anchor),evolveUtf8(at)]);
      return this.session(id);
    });
  }
  read(id: string): { session: EvolveSession; turns: EvolveTurn[] } {
    return this.db.transaction(() => {
      const session = this.session(id);
      const saves = new Map<string,EvolveSave[]>();
      const rows = this.db.query<EvolveSaveRow,[Uint8Array]>(`${evolveSaveSql}
        JOIN evolve_turns e ON e.id=s.turn_id WHERE e.session_id=CAST(? AS TEXT) ORDER BY s.position`).all(evolveUtf8(id));
      for (const row of rows) {
        const list = saves.get(row.turnId) ?? [];
        list.push(evolveSaveDto(row)); saves.set(row.turnId,list);
      }
      const turns = this.db.query<EvolveTurnRow,[Uint8Array]>(`${evolveTurnSql} WHERE t.session_id=CAST(? AS TEXT) ORDER BY t.rowid`).all(evolveUtf8(id));
      return {session,turns:turns.map(row => evolveTurnView(row,saves.get(row.id) ?? []))};
    })();
  }
  byKey(id: string, key: string): EvolveAdmissionView | null {
    evolveKey(key);
    return this.db.transaction(() => {
      this.session(id);
      const row = this.byRequest(id,key);
      return row ? this.view(row) : null;
    })();
  }
  admit(id: string, key: string, input: { parentId: string; text: string }): EvolveAdmissionView & { replayed: boolean } {
    evolveKey(key); evolveValue(input.parentId,"parentId"); evolveTurnText(input.text);
    const result = immediate(this.db, () => {
      const owner = this.session(id);
      const existing = this.byRequest(id,key);
      if (existing) {
        if (existing.parent_id !== input.parentId || existing.text !== input.text) throw new EvolveConflictError("idempotency-conflict");
        return {...this.view(existing),replayed:true};
      }
      this.requireContinuation(owner,input.parentId);
      if (this.active(id)) throw new EvolveConflictError("turn-active");
      const turnId = evolveValue(this.sources.id(),"turn id"), at = evolveValue(this.sources.now(),"admittedAt");
      const run: RunRecord | null = this.configured ? {
        id:this.sources.id(),kind:"evolve",status:"queued",createdAt:at,generation:0,inputThoughtId:null,nativeState:"unknown",
        sessionId:this.sources.sessionId?.() ?? `ses_${this.sources.id()}`,promptId:this.sources.promptId?.() ?? `msg_${this.sources.id()}`,
      } : null;
      // Insert the separate owner first. Its deferred FK requires the native run identity before commit.
      this.db.run(`INSERT INTO evolve_turns(id,session_id,request_key,parent_id,text,admitted_at,status,open_slot,run_id)
        VALUES (CAST(? AS TEXT),CAST(? AS TEXT),?,CAST(? AS TEXT),CAST(? AS TEXT),CAST(? AS TEXT),'pending',1,?)`,
        [evolveUtf8(turnId),evolveUtf8(id),key,evolveUtf8(input.parentId),evolveUtf8(input.text),evolveUtf8(at),run?.id ?? null]);
      if (run) {
        insertRun(this.db,run);
        for (const thoughtId of new Set([owner.anchorThoughtId,input.parentId])) {
          this.db.run("INSERT INTO run_context(run_id,kind,ref_id) VALUES (?,'thought',CAST(? AS TEXT))",[run.id,evolveUtf8(thoughtId)]);
        }
      }
      this.setContinuation(id,input.parentId);
      return {...this.view(this.turn(id,turnId)),replayed:false};
    });
    this.logger.info("[evolve] turn admission confirmed",{sessionId:id,turnId:result.turn.id,runId:result.turn.runId,replayed:result.replayed});
    return result;
  }
  continueAt(id: string, thoughtId: string): EvolveSession {
    evolveValue(thoughtId,"thoughtId");
    const session = immediate(this.db,() => {
      const owner = this.session(id);
      this.requireContinuation(owner,thoughtId);
      if (this.active(id)) throw new EvolveConflictError("turn-active");
      this.setContinuation(id,thoughtId);
      return this.session(id);
    });
    this.logger.info("[evolve] continuation selected",{sessionId:id,thoughtId});
    return session;
  }
  private manualReceipt(turnId: string, key: string): EvolveSave | null {
    const row = this.db.query<EvolveSaveRow,[Uint8Array,string]>(`${evolveSaveSql} WHERE s.turn_id=CAST(? AS TEXT) AND s.request_key=?`).get(evolveUtf8(turnId),key);
    return row ? evolveSaveDto(row) : null;
  }
  saveByKey(id: string, turnId: string, key: string): EvolveSave | null {
    evolveKey(key);
    return this.db.transaction(() => { this.session(id); this.turn(id,turnId); return this.manualReceipt(turnId,key); })();
  }
  keep(id: string, turnId: string, key: string, input: EvolvePassage): { receipt: EvolveSave; replayed: boolean } {
    evolveKey(key); evolveValue(input.parentId,"parentId"); evolveReplyText(input.text); oneOf(input.speaker,"speaker",["user","ai"]);
    const result = immediate(this.db,() => {
      const owner = this.session(id), turn = this.turn(id,turnId);
      const existing = this.manualReceipt(turnId,key);
      if (existing) {
        if (existing.speaker !== input.speaker || existing.text !== input.text || existing.parentId !== input.parentId) throw new EvolveConflictError("idempotency-conflict");
        return {receipt:existing,replayed:true};
      }
      if (input.parentId !== turn.parent_id) throw new EvolveConflictError("invalid-continuation");
      this.requireContinuation(owner,turn.parent_id);
      if (!evolveContextEligible(this.db,turn.id)) throw new EvolveConflictError("invalid-passage");
      return {receipt:saveEvolveIdea(this.db,this.sources,turn,input,"passage",{selectedBy:"user",key}),replayed:false};
    });
    this.logger.info("[evolve] manual idea confirmed",{sessionId:id,turnId,thoughtId:result.receipt.thoughtId,replayed:result.replayed});
    return result;
  }
}
