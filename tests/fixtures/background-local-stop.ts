import { expect } from "bun:test";
import type { RunKind } from "../../src/domain/run";
import type { BackgroundTarget } from "../../src/domain/background-work";
import { body, object, type MediaApiFixture } from "./media-import-api";

/** Phase-two wire contract; these are test-owned inputs, not a replacement production codec. */
export type LocalStopIdentity =
  | { readonly type:"run"; readonly id:string; readonly kind:RunKind; readonly generation:string|null }
  | { readonly type:"import-file"; readonly id:string; readonly importId:string; readonly runId:string|null;
      readonly generation:string|null; readonly waitingOnFileId:string|null; readonly outcome:string|null };
export const workPath = (target: BackgroundTarget): string =>
  `/background-work/${target.type === "run" ? "runs" : "import-files"}/${encodeURIComponent(target.id)}`;
export const localStopPath = (target: BackgroundTarget): string => `${workPath(target)}/local-stop`;
export const localStopLookup = (target: BackgroundTarget, key: string): string =>
  `${localStopPath(target)}/by-key/${encodeURIComponent(key)}`;
export const localStopCommand = (key: string, expected: LocalStopIdentity): RequestInit => ({
  method:"POST",headers:{"content-type":"application/json","Idempotency-Key":key},
  body:JSON.stringify({acknowledgeRemoteUncertainty:true,expected}),
});

/** Read current public detail, then compare its future identity contract with exact test-owned SQL metadata.
 * Building the command from owned metadata lets missing POST routes fail as HTTP 404, not missing imports.
 */
export async function localStopIdentity(f: MediaApiFixture, target: BackgroundTarget): Promise<LocalStopIdentity> {
  const response = await f.request(workPath(target));
  expect(response.status).toBe(200);
  expect(object((await body(response)).item).target).toEqual(target);
  return f.read(db => {
    if (target.type === "run") {
      const row = db.query<{kind:RunKind;generation:string},[string]>(
        "SELECT kind,CAST(generation AS TEXT) AS generation FROM runs WHERE id=?").get(target.id);
      if (row) return {type:"run",id:target.id,kind:row.kind,generation:row.generation};
      expect(db.query("SELECT run_id FROM search_native_cleanup WHERE run_id=?").get(target.id)).not.toBeNull();
      return {type:"run",id:target.id,kind:"search",generation:null};
    }
    const row = db.query<{importId:string;runId:string|null;generation:string|null;waitingOnFileId:string|null;outcome:string|null},[string]>(
      `SELECT f.import_id AS importId,f.run_id AS runId,CAST(r.generation AS TEXT) AS generation,
       f.waiting_on_file_id AS waitingOnFileId,f.outcome FROM markdown_import_files f
       LEFT JOIN runs r ON r.id=f.run_id WHERE f.id=?`).get(target.id);
    if (!row) throw new Error("Missing owned import reservation");
    return {type:"import-file",id:target.id,...row};
  });
}

export async function confirmedLocalStop(f: MediaApiFixture, target: BackgroundTarget, key: string) {
  const identity = await localStopIdentity(f,target);
  const response = await f.request(localStopPath(target),localStopCommand(key,identity));
  expect(response.status).toBe(201);
  expect(response.headers.get("cache-control")).toContain("no-store");
  const receipt = object((await body(response)).receipt);
  expect(receipt).toEqual({target,requestKey:key,identity,stoppedAt:expect.any(String),
    state:"local-tracking-stopped",remoteState:"unknown"});
  return {identity,receipt};
}

/** Observe the real HTTP command boundary without a sleep-only claim that a request has entered. */
export async function heldLocalStop(f: MediaApiFixture, target: BackgroundTarget, key: string) {
  const identity = await localStopIdentity(f,target);
  let returned = false;
  const pending = f.request(localStopPath(target),localStopCommand(key,identity)).then(response => { returned=true; return response; });
  const entered = () => f.logs.some(record => record.message === "[background work] local stop attempt" && record.context?.targetId === target.id);
  const deadline = Date.now()+4000;
  while (!returned && !entered() && Date.now()<deadline) await Bun.sleep(1);
  if (returned) {
    expect((await pending).status).toBe(201);
    throw new Error("Local stop confirmed before the entered native flight joined");
  }
  expect(entered()).toBe(true);
  expect(await body(await f.request(localStopLookup(target,key)))).toEqual({receipt:null});
  return {pending,returned:() => returned,identity};
}

/** Trusted lane seam, deliberately reached through an existing module.
 * Absence is an authority assertion failure, never a nonexistent production import.
 */
export function localStopLane(worker: object): {stopLocalTracking(runId:string, commit:()=>void):Promise<void>} {
  const method: unknown = Reflect.get(worker,"stopLocalTracking");
  expect(typeof method).toBe("function");
  if (typeof method !== "function") throw new Error("Worker does not expose joined local-stop authority");
  return {stopLocalTracking:(runId,commit) => Reflect.apply(method,worker,[runId,commit]) as Promise<void>};
}
