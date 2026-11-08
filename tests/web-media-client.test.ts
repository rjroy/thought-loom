import { expect, test } from "bun:test";
import { createMediaImportController } from "../apps/web/src/features/media/controller";
import { createMediaClient } from "../apps/web/src/features/media/request";
import type { MediaClient, MediaReceipt } from "../apps/web/src/features/media/types";
import { readWebConfig } from "../apps/web/src/server/config";
import { createImportBoundary } from "../apps/web/src/server/import";
import { createLogger } from "../src/logging";
import { ownedMedia } from "./fixtures/web-media";

const bytes = new Uint8Array([1,2,3,4]);
const clarification = "  Exact wording.\r\nKeep it.  ";
const run = {id:"run-1",kind:"weave",status:"queued",confirmedThoughtIds:[],responseId:null} as const;
const fakeFetch = (fn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): typeof fetch => fn as typeof fetch;

test("media client confirms browser-serialized quoted filenames and recovers the original key through the Next boundary", async () => {
  const receipts = new Map<string,MediaReceipt>();
  const received: Array<{key:string;name:string;bytes:Uint8Array;clarification:unknown}> = [];
  const daemonFetch = fakeFetch(async (input,init) => {
    const url = new URL(String(input));
    if (url.pathname === "/imports/media" && init?.method === "POST") {
      const request = new Request(url,init), key = request.headers.get("idempotency-key");
      if (!key) throw new Error("Expected the original upload key");
      const form = await request.formData(), file = form.get("file"), metadata = form.get("metadata");
      if (!(file instanceof File) || typeof metadata !== "string") throw new Error("Expected serialized media multipart");
      const parsed: unknown = JSON.parse(metadata);
      if (typeof parsed !== "object" || parsed === null || !("clarification" in parsed)) throw new Error("Expected clarification");
      received.push({key,name:file.name,bytes:new Uint8Array(await file.arrayBuffer()),clarification:parsed.clarification});
      const receipt: MediaReceipt = {thought:{...ownedMedia,mediaSource:{...ownedMedia.mediaSource,name:file.name,byteLength:file.size,
        clarification,clarificationAuthor:"user"}},run};
      receipts.set(key,receipt);
      return Response.json(receipt,{status:202});
    }
    const key = decodeURIComponent(url.pathname.split("/").at(-1) ?? ""), receipt = receipts.get(key);
    return receipt ? Response.json(receipt) : new Response(null,{status:404});
  });
  const boundary = createImportBoundary({config:readWebConfig({THOUGHTLOOM_USER_TOKEN:"owned-token"}),fetch:daemonFetch,
    logger:createLogger("verbose",() => {}),timeoutMs:1000,maxFileBytes:1024});
  let loseNextResponse = false;
  const browserFetch = fakeFetch(async (input,init) => {
    const headers = new Headers(init?.headers);
    headers.set("host","127.0.0.1:3000"); headers.set("origin","http://127.0.0.1:3000");
    const response = await boundary(new Request(new URL(String(input),"http://127.0.0.1:3000"),{...init,headers}));
    if (loseNextResponse && init?.method === "POST") { loseNextResponse = false; await response.body?.cancel(); throw new Error("Owned lost response"); }
    return response;
  });
  const client = createMediaClient(browserFetch);
  for (const [index,name] of ['a"b.png','a%22b.png'].entries()) {
    const snapshot = {file:new File([bytes],name,{type:"image/png"}),clarification,key:`direct-${index}`};
    const result = await client.upload(snapshot);
    expect(result.kind).toBe("confirmed");
    if (result.kind !== "confirmed") throw new Error("Expected serialized upload receipt");
    expect(result.receipt.thought.mediaSource.name).toBe("a%22b.png");
    expect(received[index]).toEqual({key:snapshot.key,name:"a%22b.png",bytes,clarification});
  }
  loseNextResponse = true;
  const file = new File([bytes],'recover"quoted.png',{type:"image/png"});
  const controller = createMediaImportController(client,() => "recover:quoted");
  controller.select(file); controller.setClarification(clarification);
  await controller.submit();
  expect(controller.getSnapshot().admission).toBe("uncertain");
  expect(controller.getSnapshot().snapshot?.file).toBe(file);
  await controller.checkUpload();
  expect(controller.getSnapshot().admission).toBe("saved");
  expect(controller.getSnapshot().receipt?.thought.mediaSource.name).toBe("recover%22quoted.png");
  expect(received[2]).toEqual({key:"recover:quoted",name:"recover%22quoted.png",bytes,clarification});

  // A literal percent sequence is not URL-decoded into a quote when checking a receipt.
  const incorrect = receipts.get("direct-1");
  if (!incorrect) throw new Error("Expected the literal-percent receipt");
  const wrongName: MediaReceipt = { ...incorrect,thought:{...incorrect.thought,mediaSource:{...incorrect.thought.mediaSource,name:'a"b.png'}} };
  const mismatchClient = createMediaClient(fakeFetch(async () => Response.json(wrongName,{status:202})));
  expect((await mismatchClient.upload({file:new File([bytes],"a%22b.png",{type:"image/png"}),clarification,key:"mismatch"})).kind).toBe("uncertain");
});

test("confirmed media uploads release file references while pending and recovery retain them", async () => {
  const file = new File([bytes],"owned.png",{type:"image/png"});
  const receipt: MediaReceipt = {thought:{...ownedMedia,mediaSource:{...ownedMedia.mediaSource,name:file.name,byteLength:file.size,
    clarification:null,clarificationAuthor:null}},run};
  const pending = Promise.withResolvers<Awaited<ReturnType<MediaClient["upload"]>>>();
  const client: MediaClient = {upload:() => pending.promise,byKey:async () => ({kind:"confirmed",receipt})};
  const controller = createMediaImportController(client,() => "owned-key");
  controller.select(file);
  const sending = controller.submit();
  expect(controller.getSnapshot().admission).toBe("pending");
  expect(controller.getSnapshot().file).toBe(file); expect(controller.getSnapshot().snapshot?.file).toBe(file);
  pending.resolve({kind:"uncertain",problem:{status:null,code:null}}); await sending;
  expect(controller.getSnapshot().admission).toBe("uncertain");
  expect(controller.getSnapshot().file).toBe(file); expect(controller.getSnapshot().snapshot?.file).toBe(file);
  await controller.checkUpload();
  expect(controller.getSnapshot()).toMatchObject({admission:"saved",file:null,snapshot:null,receipt});

  const direct = createMediaImportController({upload:async () => ({kind:"confirmed",receipt}),byKey:async () => ({kind:"error"})},() => "direct-key");
  direct.select(file); await direct.submit();
  expect(direct.getSnapshot()).toMatchObject({admission:"saved",file:null,snapshot:null,receipt});
});
