import type { Database } from "bun:sqlite";
import type { OrdinaryAgentRunView } from "../domain/agent";
import { evolveValue, type EvolveAdmissionProjection, type EvolveSave, type EvolveSession, type EvolveTurn } from "../domain/evolve-sessions";
import type { RunStatus } from "../domain/run";
import { ValidationError } from "../domain/validation";

export const evolveUtf8 = (value: string): Uint8Array => new TextEncoder().encode(value);
const exact = (expression: string) => `CAST(${expression} AS TEXT)`;
export interface EvolveTurnRow {
  id: string; session_id: string; parent_id: string; text: string; admitted_at: string;
  reply: string | null; run_id: string | null; runStatus: RunStatus | null;
}
const evolveTurnIdentity = "t.id,t.session_id,t.parent_id,t.text,t.admitted_at,t.run_id,r.status AS runStatus";
const evolveTurnColumns = `${evolveTurnIdentity},t.reply`;
const evolveTurnSource = "FROM evolve_turns t LEFT JOIN runs r ON r.id=t.run_id";
export const evolveTurnSql = `SELECT ${evolveTurnColumns} ${evolveTurnSource}`;
export function evolveAdmissionSql(projection: EvolveAdmissionProjection): string {
  return projection === "receipt" ? `SELECT ${evolveTurnIdentity},NULL AS reply ${evolveTurnSource}` : evolveTurnSql;
}
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
export function evolveTurnById(db: Database, id: string, projection: EvolveAdmissionProjection = "full"): EvolveTurnRow | null {
  return db.query<EvolveTurnRow,[Uint8Array]>(`${evolveAdmissionSql(projection)} WHERE t.id=${exact("?")}`).get(evolveUtf8(id));
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
/** Immutable session-local cursors. Read int64 order keys as strings to avoid approximation in JS. */
export function evolveRecentTurns(db: Database, id: string, count: number, before?: string): (EvolveTurnRow & {hasSaves: number})[] {
  let position: string | undefined;
  if (before !== undefined) {
    position = db.query<{position:string},[Uint8Array,Uint8Array]>(`SELECT CAST(rowid AS TEXT) AS position FROM evolve_turns
      WHERE id=${exact("?")} AND session_id=${exact("?")}`).get(evolveUtf8(evolveValue(before,"before")),evolveUtf8(id))?.position;
    if (position === undefined) throw new ValidationError("Invalid turn cursor");
  }
  const query = `SELECT ${evolveTurnColumns}, EXISTS(SELECT 1 FROM evolve_saves s WHERE s.turn_id=t.id) AS hasSaves
    ${evolveTurnSource} WHERE t.session_id=${exact("?")}`;
  const rows = position === undefined
    ? db.query<EvolveTurnRow & {hasSaves:number},[Uint8Array,number]>(`${query} ORDER BY t.rowid DESC LIMIT ?`).all(evolveUtf8(id),count)
    : db.query<EvolveTurnRow & {hasSaves:number},[Uint8Array,string,number]>(`${query} AND t.rowid<CAST(? AS INTEGER) ORDER BY t.rowid DESC LIMIT ?`)
      .all(evolveUtf8(id),position,count);
  return rows;
}
export function evolveReceiptWindow(db: Database, turnId: string, count: number, after?: string): EvolveSave[] {
  let position = "-1"; // Receipt positions are nonnegative.
  if (after !== undefined) {
    const cursor = db.query<{position:string},[Uint8Array,Uint8Array]>(`SELECT CAST(position AS TEXT) AS position FROM evolve_saves
      WHERE thought_id=${exact("?")} AND turn_id=${exact("?")}`).get(evolveUtf8(evolveValue(after,"after")),evolveUtf8(turnId));
    if (!cursor) throw new ValidationError("Invalid save cursor");
    position = cursor.position;
  }
  return db.query<EvolveSaveRow,[Uint8Array,string,number]>(`${evolveSaveSql}
    WHERE s.turn_id=${exact("?")} AND s.position>CAST(? AS INTEGER) ORDER BY s.position LIMIT ?`).all(evolveUtf8(turnId),position,count).map(evolveSaveDto);
}
export function evolveRunView(db: Database, runId: string, status: RunStatus): OrdinaryAgentRunView | null {
  const owner = selectiveRunOwner(db,runId);
  if (!owner) return null;
  const ids = db.query<{id:string},[string]>(`SELECT thought_id AS id FROM evolve_saves WHERE turn_id=?
    AND selected_by='ai' ORDER BY position`).all(owner.turnId);
  return evolveRunDto(runId,status,ids.map(({id}) => id));
}
export function evolveRunDto(id: string, status: RunStatus, confirmedThoughtIds: readonly string[]): OrdinaryAgentRunView {
  return {id,kind:"evolve",status,confirmedThoughtIds,responseId:null};
}
export function evolveTurnView(row: EvolveTurnRow, saves: readonly EvolveSave[]): EvolveTurn {
  return {id:row.id,parentId:row.parent_id,text:row.text,status:row.runStatus ?? "pending",admittedAt:row.admitted_at,
    runId:row.run_id,reply:row.reply,saves};
}
