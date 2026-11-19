import type { Database } from "bun:sqlite";
import type { OrdinaryAgentRunView } from "../domain/agent";
import type { EvolveSave, EvolveSession, EvolveTurn } from "../domain/evolve-sessions";
import type { RunStatus } from "../domain/run";

export const evolveUtf8 = (value: string): Uint8Array => new TextEncoder().encode(value);
const exact = (expression: string) => `CAST(${expression} AS TEXT)`;
export interface EvolveTurnRow {
  id: string; session_id: string; parent_id: string; text: string; admitted_at: string;
  reply: string | null; run_id: string | null; runStatus: RunStatus | null;
}
export const evolveTurnSql = `SELECT t.id,t.session_id,t.parent_id,t.text,t.admitted_at,t.reply,t.run_id,r.status AS runStatus
  FROM evolve_turns t LEFT JOIN runs r ON r.id=t.run_id`;
export const evolveSaveSql = `SELECT s.turn_id AS turnId,s.thought_id AS thoughtId,s.speaker,s.selected_by AS selectedBy,s.source,s.passage_start AS start,
  s.source_turn_id AS sourceTurnId,t.text,t.parent_id AS parentId FROM evolve_saves s JOIN thoughts t ON t.id=s.thought_id`;
export type EvolveSaveRow = Omit<EvolveSave,"sourceTurnId"> & { readonly turnId: string; readonly sourceTurnId: string | null };
export function evolveSaveDto({turnId: _turnId,sourceTurnId,...save}: EvolveSaveRow): EvolveSave {
  return sourceTurnId === null ? save : {...save,sourceTurnId};
}
export function evolveOwner(db: Database, id: string): EvolveSession | null {
  return db.query<EvolveSession,[Uint8Array]>(`SELECT id,anchor_id AS anchorThoughtId,continuation_id AS continuationThoughtId,
    'ideas-only' AS mode,created_at AS createdAt FROM evolve_sessions WHERE id=${exact("?")}`).get(evolveUtf8(id));
}
export function evolveTurnById(db: Database, id: string): EvolveTurnRow | null {
  return db.query<EvolveTurnRow,[Uint8Array]>(`${evolveTurnSql} WHERE t.id=${exact("?")}`).get(evolveUtf8(id));
}
export function evolveTurnForRun(db: Database, runId: string): EvolveTurnRow | null {
  return db.query<EvolveTurnRow,[string]>(`${evolveTurnSql} WHERE t.run_id=?`).get(runId);
}
export function selectiveRunOwner(db: Database, runId: string): { turnId: string; open: number } | null {
  return db.query<{turnId:string;open:number},[string]>("SELECT id AS turnId,open_slot AS open FROM evolve_turns WHERE run_id=?").get(runId);
}
export function evolveSaves(db: Database, turnId: string): EvolveSave[] {
  return db.query<EvolveSaveRow,[Uint8Array]>(`${evolveSaveSql} WHERE s.turn_id=${exact("?")} ORDER BY s.position`).all(evolveUtf8(turnId)).map(evolveSaveDto);
}
export function evolveRunView(db: Database, runId: string, status: RunStatus): OrdinaryAgentRunView | null {
  const owner = selectiveRunOwner(db,runId);
  if (!owner) return null;
  const ids = db.query<{id:string},[string]>(`SELECT thought_id AS id FROM evolve_saves WHERE turn_id=?
    AND selected_by='ai' ORDER BY position`).all(owner.turnId);
  return {id:runId,kind:"evolve",status,confirmedThoughtIds:ids.map(({id}) => id),responseId:null};
}
export function evolveTurnView(row: EvolveTurnRow, saves: readonly EvolveSave[]): EvolveTurn {
  return {id:row.id,parentId:row.parent_id,text:row.text,status:row.runStatus ?? "pending",admittedAt:row.admitted_at,
    runId:row.run_id,reply:row.reply,saves};
}
