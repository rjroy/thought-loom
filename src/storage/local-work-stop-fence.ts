import type { Database } from "bun:sqlite";
import { RunFenceError } from "../domain/run";

export const localRunStoppedSql = (id:string):string => `EXISTS(SELECT 1 FROM main.local_work_stops local_stop WHERE local_stop.run_id=${id})`;
export const localFileStoppedSql = (id:string):string => `EXISTS(SELECT 1 FROM main.local_work_stops local_stop WHERE local_stop.import_file_id=${id})`;
const bytes=(id:string):Uint8Array => new TextEncoder().encode(id);
export function isRunLocallyStopped(db:Database,id:string):boolean {
  return db.query(`SELECT 1 FROM main.local_work_stops WHERE run_id=CAST(? AS TEXT)`).get(bytes(id)) !== null;
}
export function isFileLocallyStopped(db:Database,id:string):boolean {
  return db.query(`SELECT 1 FROM main.local_work_stops WHERE import_file_id=CAST(? AS TEXT)`).get(bytes(id)) !== null;
}
export function assertRunLocallyTracked(db:Database,id:string):void {
  if (isRunLocallyStopped(db,id)) throw new RunFenceError("Local tracking has permanently stopped");
}
