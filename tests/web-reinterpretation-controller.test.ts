import { expect, test } from "bun:test";
import { createReinterpretationController, reinterpretationStorageKey } from "../apps/web/src/features/idea/reinterpretation-controller";
import { createReinterpretationClient, type ReinterpretationClient } from "../apps/web/src/features/idea/reinterpretation-request";
import type { ReinterpretationRun, ReinterpretationSnapshot } from "../apps/web/src/features/idea/reinterpretation";

const run: ReinterpretationRun = { id: "owned-run", kind: "weave", status: "queued", confirmedThoughtIds: [], responseId: null };
const eligible: ReinterpretationSnapshot = { receipt: null, run: null, eligibility: { eligible: true, reason: null, blockingRun: null } };
const confirmed = (key: string): ReinterpretationSnapshot => ({ receipt: { subjectId: "subject", requestKey: key, runId: run.id }, run,
  eligibility: { eligible: false, reason: "work-active", blockingRun: run } });
function storage() {
  const data = new Map<string,string>();
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key,value); } };
}
const responseFetch = (response: Response): typeof fetch => Object.assign(
  async (_input: RequestInfo | URL, _init?: RequestInit) => response,
  { preconnect: () => {} },
);
function client(overrides: Partial<ReinterpretationClient> = {}): ReinterpretationClient {
  return { lookup: async () => ({kind:"found",snapshot:eligible}), send: async () => ({kind:"uncertain"}),
    readRun: async () => ({kind:"error"}), stop: async () => ({kind:"uncertain"}), ...overrides };
}
const options = (store: ReturnType<typeof storage>, keys = ["probe", "request-key"]) => {
  let index = 0;
  return { storage: () => store, newKey: () => keys[index++] ?? "unexpected-key", schedule: () => () => {} };
};

test("identity is verified before one synchronous guarded submission", async () => {
  const store = storage(), held = Promise.withResolvers<Awaited<ReturnType<ReinterpretationClient["send"]>>>();
  const calls: string[] = [];
  const c = createReinterpretationController("subject", client({ send: async (subject,key) => {
    calls.push(key);
    expect(JSON.parse(store.getItem(reinterpretationStorageKey) ?? "null")).toEqual({version:1,entries:[{subjectId:subject,requestKey:key,kind:"pending"}]});
    return held.promise;
  }}), options(store));
  await c.prepare();
  const first = c.request(), duplicate = c.request();
  expect(calls).toEqual(["request-key"]);
  held.resolve({kind:"confirmed",snapshot:confirmed("request-key")});
  await Promise.all([first,duplicate]);
  expect(c.getSnapshot()).toMatchObject({request:"confirmed",requestKey:"request-key",run});
});

test("storage denial or unverifiable writes forbid dispatch", async () => {
  for (const fail of ["throw", "lost"] as const) {
    let calls = 0;
    const store = storage();
    store.setItem = () => { if (fail === "throw") throw new Error("owned storage denied"); };
    const c = createReinterpretationController("subject",client({send:async () => {calls++; return {kind:"uncertain"};}}),options(store));
    await c.prepare(); await c.request();
    expect(calls).toBe(0); expect(c.getSnapshot()).toMatchObject({phase:"storage-error",notice:"storage-error"});
  }
});

test("unknown admission survives reload and an absent receipt until explicit same-key resend", async () => {
  const store = storage(), sent: string[] = [], looked: string[] = [];
  let accepted = false;
  const api = client({ lookup: async (_subject,key) => {looked.push(key); return {kind:"found",snapshot:accepted ? confirmed(key) : eligible};},
    send: async (_subject,key) => {sent.push(key); return sent.length === 1 ? {kind:"uncertain"} : {kind:"confirmed",snapshot:confirmed(key)};} });
  const first = createReinterpretationController("subject",api,options(store));
  await first.prepare(); await first.request();
  expect(first.getSnapshot()).toMatchObject({request:"uncertain",requestKey:"request-key"});
  const reloaded = createReinterpretationController("subject",api,options(store,["unused"]));
  await reloaded.prepare();
  expect(sent).toEqual(["request-key"]); expect(looked.at(-1)).toBe("request-key");
  expect(reloaded.getSnapshot()).toMatchObject({request:"uncertain",requestKey:"request-key"});
  expect(store.getItem(reinterpretationStorageKey)).toContain("request-key");
  accepted = true; await reloaded.resend();
  expect(sent).toEqual(["request-key","request-key"]);
  expect(reloaded.getSnapshot()).toMatchObject({request:"confirmed",requestKey:"request-key"});
});

test("invalidated delayed lookup and failed reads cannot overwrite last confirmed work", async () => {
  const store = storage(), held = Promise.withResolvers<Awaited<ReturnType<ReinterpretationClient["lookup"]>>>();
  let delayed = false;
  const c = createReinterpretationController("subject",client({lookup:async (_id,key) => delayed ? held.promise : {kind:"found",snapshot:key === "probe" ? eligible : confirmed(key)},
    send:async (_id,key) => ({kind:"confirmed",snapshot:confirmed(key)}),readRun:async () => ({kind:"error"})}),options(store));
  await c.prepare(); await c.request();
  delayed = true; const stale = c.checkReceipt(); c.invalidate();
  held.resolve({kind:"found",snapshot:eligible}); await stale;
  expect(c.getSnapshot()).toMatchObject({request:"confirmed",run});
  await c.checkRun();
  expect(c.getSnapshot()).toMatchObject({request:"confirmed",run,notice:"read-error"});
});

test("unwatch or invalidation aborts a held run read and fences its late result", async () => {
  for (const action of ["unwatch", "invalidate"] as const) {
    const store = storage(), held = Promise.withResolvers<Awaited<ReturnType<ReinterpretationClient["readRun"]>>>();
    let signal: AbortSignal | undefined;
    const c = createReinterpretationController("subject", client({
      lookup: async (_id,key) => ({kind:"found",snapshot:key === "probe" ? eligible : confirmed(key)}),
      send: async (_id,key) => ({kind:"confirmed",snapshot:confirmed(key)}),
      readRun: async (id, readSignal) => { expect(id).toBe(run.id); signal = readSignal; return held.promise; },
    }), options(store));
    await c.prepare(); await c.request();
    const unwatch = c.watch(); await c.checkReceipt();
    const revision = c.getSnapshot().outputRevision;
    const read = c.checkRun();
    if (action === "unwatch") unwatch(); else c.invalidate();
    const aborted = signal?.aborted;
    held.resolve({kind:"found",run:{...run,status:"completed",confirmedThoughtIds:["late-output"]}});
    await read;
    expect(aborted).toBe(true);
    expect(c.getSnapshot()).toMatchObject({request:"confirmed",run,checking:false,fresh:false,outputRevision:revision});
    if (action === "invalidate") unwatch();
  }
});

test("unwatch leaves an admitted write running and preserves unknown-outcome recovery", async () => {
  const store = storage(), held = Promise.withResolvers<Awaited<ReturnType<ReinterpretationClient["send"]>>>();
  const sent: string[] = [];
  const c = createReinterpretationController("subject",client({send:async (_id,key) => {sent.push(key); return held.promise;}}),options(store));
  const unwatch = c.watch(); await c.checkReceipt();
  const write = c.request();
  unwatch();
  held.resolve({kind:"uncertain"}); await write;
  expect(sent).toEqual(["request-key"]);
  expect(c.getSnapshot()).toMatchObject({request:"uncertain",requestKey:"request-key",notice:"request-uncertain",fresh:false});
  expect(store.getItem(reinterpretationStorageKey)).toContain("request-key");
});

test("uncertain Stop is not repeated and a failed check retains confirmed work", async () => {
  const store = storage(); let stops = 0;
  const c = createReinterpretationController("subject",client({send:async (_id,key) => ({kind:"confirmed",snapshot:confirmed(key)}),
    stop:async () => {stops++; return {kind:"uncertain"};},readRun:async () => ({kind:"error"})}),options(store));
  await c.prepare(); await c.request(); await c.stop(); await c.stop();
  expect(stops).toBe(1); expect(c.getSnapshot()).toMatchObject({unconfirmedStop:run.id,run,notice:"stop-uncertain"});
  await c.checkRun(); await c.stop();
  expect(stops).toBe(1); expect(c.getSnapshot()).toMatchObject({unconfirmedStop:run.id,run,notice:"read-error"});
});

test("request client rejects mismatched receipt and run identities without exposing them as success", async () => {
  const calls: string[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(`${init?.method} ${String(input)}`);
    if (String(input).includes("media-runs")) return Response.json({...run,id:"other-run"});
    return Response.json(confirmed("wrong-key"),{status:init?.method === "POST" ? 202 : 200});
  }) as typeof fetch;
  const api = createReinterpretationClient(fetcher);
  expect(await api.send("subject","expected-key")).toEqual({kind:"uncertain"});
  expect(await api.lookup("subject","expected-key")).toEqual({kind:"error"});
  expect(await api.readRun("owned-run")).toEqual({kind:"error"});
  expect(calls).toHaveLength(3);
});

test("failed reinterpretation responses release unread bodies across lookup, send, read and Stop", async () => {
  const cases = [
    {status:404, invoke:(api:ReinterpretationClient) => api.lookup("subject","key"), result:{kind:"error"}},
    {status:400, invoke:(api:ReinterpretationClient) => api.send("subject","key"), result:{kind:"refused"}},
    {status:500, invoke:(api:ReinterpretationClient) => api.send("subject","key"), result:{kind:"uncertain"}},
    {status:503, invoke:(api:ReinterpretationClient) => api.readRun("owned-run"), result:{kind:"error"}},
    {status:500, invoke:(api:ReinterpretationClient) => api.stop("owned-run"), result:{kind:"uncertain"}},
  ] as const;
  for (const item of cases) for (const cancellation of ["success","throw","reject"] as const) {
    let cancellations = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("owned private error")); },
      cancel() {
        cancellations++;
        if (cancellation === "throw") throw new Error("owned cleanup failure");
        if (cancellation === "reject") return Promise.reject(new Error("owned cleanup failure"));
      },
    });
    const response = new Response(stream,{status:item.status});
    const api = createReinterpretationClient(responseFetch(response));
    expect(await item.invoke(api)).toEqual(item.result);
    expect(cancellations).toBe(1);
    expect(response.bodyUsed).toBe(true);
  }
});

test("malformed or mismatched successful responses are consumed and never treated as confirmation", async () => {
  const cases = [
    {body:"not-json", invoke:(api:ReinterpretationClient) => api.lookup("subject","key"), result:{kind:"error"}},
    {body:"not-json", status:409, invoke:(api:ReinterpretationClient) => api.send("subject","key"), result:{kind:"uncertain"}},
    {body:JSON.stringify(confirmed("wrong-key")), invoke:(api:ReinterpretationClient) => api.send("subject","key"), result:{kind:"uncertain"}},
    {body:JSON.stringify({...run,id:"wrong-run"}), invoke:(api:ReinterpretationClient) => api.readRun("owned-run"), result:{kind:"error"}},
    {body:JSON.stringify({...run,id:"wrong-run"}), invoke:(api:ReinterpretationClient) => api.stop("owned-run"), result:{kind:"uncertain"}},
  ] as const;
  for (const item of cases) {
    const response = new Response(item.body,{status:"status" in item ? item.status : 200,headers:{"content-type":"application/json"}});
    const api = createReinterpretationClient(responseFetch(response));
    expect(await item.invoke(api)).toEqual(item.result);
    expect(response.bodyUsed).toBe(true);
  }
});
