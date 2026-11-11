import { reinterpretationId, reinterpretationKey, reinterpretationRun, reinterpretationSnapshot, interpretationRetirement, confirmedInterpretationRetirement,
  type ReinterpretationRun, type ReinterpretationSnapshot, type InterpretationRetirement, type ConfirmedInterpretationRetirement } from "./reinterpretation";

export type ReinterpretationRead = {readonly kind:"found";readonly snapshot:ReinterpretationSnapshot} | {readonly kind:"error"};
export type ReinterpretationWrite = {readonly kind:"confirmed";readonly snapshot:ReinterpretationSnapshot}
  | {readonly kind:"conflict";readonly snapshot:ReinterpretationSnapshot;readonly code:"interpretation-active" | "interpretation-unsettled"}
  | {readonly kind:"refused" | "uncertain"};
export interface ReinterpretationClient {
  lookup(subjectId:string,key:string,signal?:AbortSignal): Promise<ReinterpretationRead>;
  send(subjectId:string,key:string): Promise<ReinterpretationWrite>;
  readRun(id:string,signal?:AbortSignal): Promise<{readonly kind:"found";readonly run:ReinterpretationRun} | {readonly kind:"error"}>;
  stop(id:string): Promise<{readonly kind:"confirmed";readonly run:ReinterpretationRun} | {readonly kind:"uncertain"}>;
  readRetirement(subjectId:string,runId:string,signal?:AbortSignal): Promise<{readonly kind:"found";readonly retirement:InterpretationRetirement} | {readonly kind:"error"}>;
  retire(subjectId:string,runId:string): Promise<{readonly kind:"confirmed";readonly retirement:ConfirmedInterpretationRetirement} | {readonly kind:"uncertain" | "refused"}>;
}
const object = (v:unknown): v is Record<string,unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
// Cancellation is best-effort and must never delay or change the classified outcome.
function discard(response:Response): void {
  try { void response.body?.cancel().catch(() => {}); } catch { /* An unusable body remains an error. */ }
}

/** Fixed same-origin routes. Observations never submit a command. */
export function createReinterpretationClient(fetcher: typeof fetch = fetch): ReinterpretationClient {
  const base = (id:string) => `/api/ideas/${encodeURIComponent(id)}/reinterpret`;
  return {
    async readRetirement(subjectId,runId,signal) {
      if (!reinterpretationId(subjectId) || !reinterpretationId(runId)) return {kind:"error"};
      try {
        const response = await fetcher(`${base(subjectId)}/retire/${encodeURIComponent(runId)}`,{method:"GET",cache:"no-store",redirect:"error",signal});
        if (response.status !== 200) { discard(response); return {kind:"error"}; }
        const value:unknown = await response.json();
        return interpretationRetirement(value,runId) ? {kind:"found",retirement:value} : {kind:"error"};
      } catch { return {kind:"error"}; }
    },
    async retire(subjectId,runId) {
      if (!reinterpretationId(subjectId) || !reinterpretationId(runId)) return {kind:"uncertain"};
      try {
        const response = await fetcher(`${base(subjectId)}/retire/${encodeURIComponent(runId)}`,{method:"POST",headers:{"content-type":"application/json"},
          body:JSON.stringify({acknowledgeRemoteUncertainty:true}),cache:"no-store",redirect:"error"});
        if (response.status !== 200) { discard(response); return {kind:[400,401,403,404,409,413,415].includes(response.status) ? "refused" : "uncertain"}; }
        const value:unknown = await response.json();
        return confirmedInterpretationRetirement(value,runId) ? {kind:"confirmed",retirement:value} : {kind:"uncertain"};
      } catch { return {kind:"uncertain"}; }
    },
    async lookup(subjectId,key,signal) {
      if (!reinterpretationId(subjectId) || !reinterpretationKey(key)) return {kind:"error"};
      try {
        const response = await fetcher(`${base(subjectId)}/by-key/${encodeURIComponent(key)}`,{method:"GET",cache:"no-store",redirect:"error",signal});
        if (response.status !== 200) { discard(response); return {kind:"error"}; }
        const value: unknown = await response.json();
        return reinterpretationSnapshot(value,subjectId,key) ? {kind:"found",snapshot:value} : {kind:"error"};
      } catch { return {kind:"error"}; }
    },
    async send(subjectId,key) {
      if (!reinterpretationId(subjectId) || !reinterpretationKey(key)) return {kind:"refused"};
      try {
        const response = await fetcher(base(subjectId),{method:"POST",headers:{"content-type":"application/json","idempotency-key":key},body:"{}",cache:"no-store",redirect:"error"});
        if (response.status === 200 || response.status === 202) {
          const value: unknown = await response.json();
          return reinterpretationSnapshot(value,subjectId,key) && value.receipt !== null ? {kind:"confirmed",snapshot:value} : {kind:"uncertain"};
        }
        if (response.status === 409) {
          const value: unknown = await response.json();
          if (object(value) && Object.keys(value).length === 5 && value.error === "Conflict" && (value.code === "interpretation-active" || value.code === "interpretation-unsettled")) {
            const snapshot:unknown = {receipt:value.receipt,run:value.run,eligibility:value.eligibility};
            if (reinterpretationSnapshot(snapshot,subjectId,key) && snapshot.receipt === null && !snapshot.eligibility.eligible
              && (value.code === "interpretation-active" ? snapshot.eligibility.reason === "work-active" : snapshot.eligibility.reason === "work-unsettled" || snapshot.eligibility.reason === "work-unverified")) return {kind:"conflict",snapshot,code:value.code};
          }
          return {kind:"uncertain"};
        }
        discard(response);
        return {kind:[400,401,403,404,413,415].includes(response.status) ? "refused" : "uncertain"};
      } catch { return {kind:"uncertain"}; }
    },
    async readRun(id,signal) {
      if (!reinterpretationId(id)) return {kind:"error"};
      try {
        const response = await fetcher(`/api/imports/media-runs/${encodeURIComponent(id)}`,{method:"GET",cache:"no-store",redirect:"error",signal});
        if (response.status !== 200) { discard(response); return {kind:"error"}; }
        const value:unknown = await response.json();
        return reinterpretationRun(value) && value.id === id ? {kind:"found",run:value} : {kind:"error"};
      } catch { return {kind:"error"}; }
    },
    async stop(id) {
      if (!reinterpretationId(id)) return {kind:"uncertain"};
      try {
        const response = await fetcher(`/api/imports/media-runs/${encodeURIComponent(id)}/stop`,{method:"POST",headers:{"content-type":"application/json"},body:"{}",cache:"no-store",redirect:"error"});
        if (response.status !== 200) { discard(response); return {kind:"uncertain"}; }
        const value:unknown = await response.json();
        return reinterpretationRun(value) && value.id === id ? {kind:"confirmed",run:value} : {kind:"uncertain"};
      } catch { return {kind:"uncertain"}; }
    },
  };
}
