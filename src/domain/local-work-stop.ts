import type { BackgroundTarget } from "./background-work";
import type { RunKind } from "./run";
import { protocolJson } from "./run-protocol";
import { nonEmpty, record, ValidationError } from "./validation";

export type LocalStopIdentity =
  | {readonly type:"run";readonly id:string;readonly kind:RunKind;readonly generation:string|null}
  | {readonly type:"import-file";readonly id:string;readonly importId:string;readonly runId:string|null;
     readonly generation:string|null;readonly waitingOnFileId:string|null;readonly outcome:string|null};
export interface LocalStopSnapshot {
  readonly identity:LocalStopIdentity;
  readonly eligible:boolean;
  readonly reason:"already-stopped"|"already-inert"|"nothing-outstanding"|"owner-unavailable"|null;
}
export interface LocalStopReceipt {
  readonly target:BackgroundTarget;
  readonly requestKey:string;
  readonly identity:LocalStopIdentity;
  readonly stoppedAt:string;
  readonly state:"local-tracking-stopped";
  readonly remoteState:"unknown";
}
export interface LocalStopController {
  snapshot(target:BackgroundTarget):LocalStopSnapshot|null;
  byKey(target:BackgroundTarget,key:string):LocalStopReceipt|null;
  stop(target:BackgroundTarget,key:string,expected:LocalStopIdentity):Promise<{receipt:LocalStopReceipt;replayed:boolean}>;
}
function fields(data:Record<string,unknown>, names:readonly string[]):void {
  if (Object.keys(data).length !== names.length || names.some(name => !Object.hasOwn(data,name))) throw new ValidationError("Invalid local-stop identity");
}
const nullableId = (value:unknown):string|null => value === null ? null : nonEmpty(value,"identity");
function generation(value:unknown):string|null {
  if (value === null) return null;
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,18})$/.test(value) || BigInt(value)>9223372036854775807n) throw new ValidationError("Invalid local-stop generation");
  return value;
}
export function localStopKey(value:unknown):string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) throw new ValidationError("Invalid local-stop key");
  return value;
}
export function parseLocalStopIdentity(value:unknown):LocalStopIdentity {
  const data=record(value), id=nonEmpty(data.id,"identity"), gen=generation(data.generation);
  if (data.type === "run") {
    fields(data,["type","id","kind","generation"]);
    if (data.kind !== "weave" && data.kind !== "evolve" && data.kind !== "export" && data.kind !== "search" && data.kind !== "import") throw new ValidationError("Invalid local-stop kind");
    if (gen === null && data.kind !== "search") throw new ValidationError("Missing local-stop generation");
    if (data.kind === "search" && gen !== null && BigInt(gen)>BigInt(Number.MAX_SAFE_INTEGER)) throw new ValidationError("Invalid Search local-stop generation");
    return {type:"run",id,kind:data.kind,generation:gen};
  }
  fields(data,["type","id","importId","runId","generation","waitingOnFileId","outcome"]);
  const runId=nullableId(data.runId), waitingOnFileId=nullableId(data.waitingOnFileId), outcome=nullableId(data.outcome);
  if (data.type !== "import-file" || (runId === null) !== (gen === null) || (runId !== null && waitingOnFileId !== null) ||
      (outcome !== null && !["imported","skipped-identical","skipped-changed","failed","interrupted"].includes(outcome))) throw new ValidationError("Invalid import reservation identity");
  return {type:"import-file",id,importId:nonEmpty(data.importId,"import identity"),runId,generation:gen,waitingOnFileId,outcome};
}
/** Exact non-content persisted receipt, also used by the backup codec. */
export interface LocalStopRecord {
  readonly target_kind:string;readonly target_id:string;readonly request_key:string;readonly identity_json:string;
  readonly stopped_at:string;readonly run_id:string|null;readonly import_file_id:string|null;
}
export function localStopReceipt(input:unknown):LocalStopReceipt {
  const data=record(input);
  fields(data,["target_kind","target_id","request_key","identity_json","stopped_at","run_id","import_file_id"]);
  const row:LocalStopRecord={
    target_kind:nonEmpty(data.target_kind,"local-stop target"),target_id:nonEmpty(data.target_id,"local-stop identity"),
    request_key:localStopKey(data.request_key),identity_json:nonEmpty(data.identity_json,"local-stop identity"),
    stopped_at:nonEmpty(data.stopped_at,"local-stop timestamp"),run_id:nullableId(data.run_id),import_file_id:nullableId(data.import_file_id),
  };
  const identity=parseLocalStopIdentity(JSON.parse(row.identity_json));
  if (protocolJson(identity) !== row.identity_json || identity.type !== row.target_kind || identity.id !== row.target_id ||
      !Number.isFinite(Date.parse(row.stopped_at))) throw new ValidationError("Invalid local-stop record");
  if (identity.type === "run") {
    if (row.run_id !== identity.id || (identity.kind === "import" ? !row.import_file_id : row.import_file_id !== null)) throw new ValidationError("Invalid local-stop owner");
  } else if (row.run_id !== identity.runId || row.import_file_id !== identity.id) throw new ValidationError("Invalid local-stop reservation");
  return {target:{type:identity.type,id:identity.id},requestKey:localStopKey(row.request_key),identity,
    stoppedAt:row.stopped_at,state:"local-tracking-stopped",remoteState:"unknown"};
}
