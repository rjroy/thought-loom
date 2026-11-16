import type { Database } from "bun:sqlite";
import type { BackgroundTarget } from "../domain/background-work";
import { localStopKey, localStopReceipt, parseLocalStopIdentity, type LocalStopIdentity, type LocalStopReceipt, type LocalStopRecord, type LocalStopSnapshot } from "../domain/local-work-stop";
import { RunConflictError, RunNotFoundError, type RunKind, type RunSources } from "../domain/run";
import { protocolJson } from "../domain/run-protocol";
import { createLogger } from "../logging";
import { isRunRestoreFenced } from "./restore-fences";
import { isImportOwnerRestoreFenced } from "./import-authority";
import { immediate } from "./transaction";

const bytes=(id:string):Uint8Array => new TextEncoder().encode(id);
interface FileIdentity {readonly id:string;readonly importId:string;readonly runId:string|null;readonly generation:string|null;readonly waitingOnFileId:string|null;readonly outcome:string|null}
export class SqliteLocalWorkStops {
  private readonly logger;
  constructor(private readonly db:Database,private readonly sources:RunSources) { this.logger=sources.logger ?? createLogger(); }
  private file(id:string):FileIdentity|null {
    return this.db.query<FileIdentity,[Uint8Array]>(`SELECT f.id,f.import_id AS importId,f.run_id AS runId,
      CAST(r.generation AS TEXT) AS generation,f.waiting_on_file_id AS waitingOnFileId,f.outcome
      FROM markdown_import_files f LEFT JOIN runs r ON r.id=f.run_id WHERE f.id=CAST(? AS TEXT)`).get(bytes(id));
  }
  closed(target:BackgroundTarget):LocalStopRecord|null {
    return this.db.query<LocalStopRecord,[string,Uint8Array]>(`SELECT * FROM local_work_stops WHERE
      (target_kind=?1 AND target_id=CAST(?2 AS TEXT)) OR
      (?1='run' AND run_id=CAST(?2 AS TEXT)) OR (?1='import-file' AND import_file_id=CAST(?2 AS TEXT))`).get(target.type,bytes(target.id));
  }
  identity(target:BackgroundTarget):LocalStopIdentity|null {
    if (target.type === "import-file") {
      const file=this.file(target.id);
      return file ? parseLocalStopIdentity({type:"import-file",...file}) : null;
    }
    const run=this.db.query<{kind:RunKind;generation:string},[Uint8Array]>("SELECT kind,CAST(generation AS TEXT) AS generation FROM runs WHERE id=CAST(? AS TEXT)").get(bytes(target.id));
    if (run) return parseLocalStopIdentity({type:"run",id:target.id,...run});
    if (this.db.query("SELECT 1 FROM search_native_cleanup WHERE run_id=CAST(? AS TEXT)").get(bytes(target.id))) return {type:"run",id:target.id,kind:"search",generation:null};
    return null;
  }
  snapshot(target:BackgroundTarget):LocalStopSnapshot|null {
    const closed=this.closed(target), current=this.identity(target);
    const identity=current ?? (closed ? localStopReceipt(closed).identity : null);
    if (!identity) return null;
    let reason:LocalStopSnapshot["reason"]=closed ? "already-stopped" : null;
    const runId=identity.type === "run" ? identity.id : identity.runId;
    const file=identity.type === "import-file" ? this.file(identity.id) : identity.kind === "import"
      ? this.db.query<{id:string},[Uint8Array]>("SELECT id FROM markdown_import_files WHERE run_id=CAST(? AS TEXT)").get(bytes(identity.id)) : null;
    const ownedFile=file ? this.file(file.id) : null;
    if (!reason && ((runId !== null && isRunRestoreFenced(this.db,runId)) ||
        (ownedFile && isImportOwnerRestoreFenced(this.db,ownedFile)))) reason="already-inert";
    if (!reason && identity.type === "run" && identity.kind === "import" && !ownedFile) reason="owner-unavailable";
    if (!reason && identity.type === "run") {
      const row=this.db.query<{status:string;cancellation:string},[Uint8Array]>("SELECT status,cancellation_state AS cancellation FROM runs WHERE id=CAST(? AS TEXT)").get(bytes(identity.id));
      const cleanup=this.db.query<{state:string},[Uint8Array]>("SELECT state FROM search_native_cleanup WHERE run_id=CAST(? AS TEXT)").get(bytes(identity.id));
      if (row?.status === "completed" && row.cancellation !== "pending" && (!cleanup || cleanup.state === "settled")) reason="nothing-outstanding";
      if (!row && cleanup?.state === "settled") reason="nothing-outstanding";
    }
    if (!reason && identity.type === "import-file" && identity.outcome !== null &&
        !["failed","interrupted"].includes(identity.outcome) && (runId === null ||
          !this.db.query("SELECT 1 FROM runs WHERE id=CAST(? AS TEXT) AND cancellation_state='pending'").get(bytes(runId)))) reason="nothing-outstanding";
    return {identity,eligible:reason === null,reason};
  }
  byKey(target:BackgroundTarget,key:string):LocalStopReceipt|null {
    localStopKey(key);
    const row=this.closed(target);
    if (row?.target_kind === target.type && row.target_id === target.id && row.request_key === key) return localStopReceipt(row);
    if (!row && !this.identity(target)) throw new RunNotFoundError();
    return null;
  }
  /** Called before entering the exclusive lane and rechecked after it joins. Never obtains native authority. */
  prepare(target:BackgroundTarget,key:string,input:LocalStopIdentity):{runId:string|null;commit:()=>{receipt:LocalStopReceipt;replayed:boolean}} {
    localStopKey(key); const expected=parseLocalStopIdentity(input);
    if (expected.type !== target.type || expected.id !== target.id) throw new RunConflictError();
    this.logger.info("[background work] local stop attempt",{targetType:target.type,targetId:target.id});
    const validate=() => {
      const old=this.closed(target);
      if (old) {
        const receipt=localStopReceipt(old);
        if (receipt.target.type !== target.type || receipt.target.id !== target.id || receipt.requestKey !== key ||
            protocolJson(receipt.identity) !== protocolJson(expected)) throw new RunConflictError("Local-stop request conflicts");
        return receipt;
      }
      const current=this.snapshot(target);
      if (!current) throw new RunNotFoundError();
      if (!current.eligible || protocolJson(current.identity) !== protocolJson(expected)) throw new RunConflictError("Local-stop identity changed");
      return null;
    };
    validate();
    const runId=expected.type === "run" ? expected.id : expected.runId;
    return {runId,commit:() => {
      if (this.db.inTransaction) throw new RunConflictError("Local stop requires a root transaction");
      try {
        const result=immediate(this.db,() => {
          const replay=validate();
          if (replay) return {receipt:replay,replayed:true};
          const fileId=expected.type === "import-file" ? expected.id : expected.kind === "import"
            ? this.db.query<{id:string},[Uint8Array]>("SELECT id FROM markdown_import_files WHERE run_id=CAST(? AS TEXT)").get(bytes(expected.id))?.id ?? null : null;
          const row:LocalStopRecord={target_kind:target.type,target_id:target.id,request_key:key,identity_json:protocolJson(expected),
            stopped_at:this.sources.now(),run_id:runId,import_file_id:fileId};
          const receipt=localStopReceipt(row);
          // Dedicated local transitions: no draft publication, native cancellation intent, sibling cascade or journal rewriting.
          if (runId !== null) this.db.run(`UPDATE runs SET status='interrupted' WHERE id=CAST(? AS TEXT)
            AND status IN ('queued','submitting','running','uncertain')`,[bytes(runId)]);
          if (fileId !== null) this.db.run(`UPDATE markdown_import_files SET outcome='interrupted',reason_code='interrupted'
            WHERE id=CAST(? AS TEXT) AND outcome IS NULL`,[bytes(fileId)]);
          this.db.run(`INSERT INTO local_work_stops(target_kind,target_id,request_key,identity_json,stopped_at,run_id,import_file_id)
            VALUES (?,CAST(? AS TEXT),?,?,?,CAST(? AS TEXT),CAST(? AS TEXT))`,
          [row.target_kind,bytes(row.target_id),row.request_key,row.identity_json,row.stopped_at,runId === null ? null : bytes(runId),fileId === null ? null : bytes(fileId)]);
          return {receipt,replayed:false};
        });
        this.logger.info("[background work] local stop recorded",{targetType:target.type,targetId:target.id,replayed:result.replayed,remoteState:"unknown"});
        return result;
      } catch (error) { this.logger.warning("[background work] local stop refused",{targetType:target.type,targetId:target.id}); throw error; }
    }};
  }
}
