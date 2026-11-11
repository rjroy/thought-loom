import { expect, test } from "bun:test";
import { createExportController } from "../apps/web/src/features/export/controller";
import { admitExport } from "../apps/web/src/features/export/request";
import type { ExportHistoryItem } from "../apps/web/src/features/export/types";

const item: ExportHistoryItem = { id:"owned-export", status:"interrupted", createdAt:"2032-01-01T00:00:00Z",
  request:"Owned retained question", effort:"quick", restored:false, deletionState:"ready" };
const run = {id:item.id,kind:"export",status:"queued",confirmedThoughtIds:[],responseId:null};
const json = (value: unknown, status = 200) => Response.json(value,{status});
const missing = () => new Response(null,{status:404});
const fetcher = (fn: (url: string, init?: RequestInit) => Promise<Response>): typeof fetch => Object.assign(
  (input: string | URL | Request, init?: RequestInit) => fn(String(input),init), {preconnect: () => {}},
);
async function until(check: () => boolean): Promise<void> {
  for (let n = 0; n < 100; n++) { if (check()) return; await Bun.sleep(0); }
  throw new Error("Owned controller state did not arrive");
}

test("BTR-EXP-001: stale deletion recovery cannot resurrect an export confirmed deleted after re-entry", async () => {
  const held = Promise.withResolvers<Response>(); let reads = 0, deletes = 0;
  const controller = createExportController({fetch:fetcher(async (url,init) => {
    if (url === "/api/export/agentic/owned-export" && init?.method === "DELETE") { deletes++; return new Response(null,{status:500}); }
    if (url === "/api/export/agentic/owned-export/metadata") {
      reads++;
      if (reads === 1) return json(item);
      if (reads === 2) return held.promise;
      return missing();
    }
    throw new Error(`Unexpected owned request: ${url}`);
  })});
  let unwatch = controller.watch(item.id);
  try {
    await until(() => controller.get(item.id)?.verified === true);
    await controller.remove(item.id);
    expect(controller.get(item.id)?.deletion).toBe("uncertain");
    const older = controller.checkDeletion(item.id);
    expect(reads).toBe(2);
    unwatch(); unwatch = controller.watch(item.id);
    await until(() => controller.get(item.id)?.missing === true && controller.get(item.id)?.checking === false);
    await controller.checkDeletion(item.id);
    expect(controller.get(item.id)).toMatchObject({deletion:"deleted",verified:false});
    held.resolve(json(item)); await older;
    expect(controller.get(item.id)).toMatchObject({deletion:"deleted",verified:false});
    await controller.remove(item.id);
    expect(deletes).toBe(1);
  } finally { held.resolve(json(item)); unwatch(); }
});

for (const outcome of ["admitted", "uncertain"] as const) {
  test(`BTR-EXP-002: catalog re-entry supersedes a pre-admission read after ${outcome} admission`, async () => {
    const old = Promise.withResolvers<Response>(); let lists = 0, writes = 0;
    const admittedItem: ExportHistoryItem = {...item,request:"Owned new question",status:"queued",deletionState:"stop-required"};
    const fetch = fetcher(async (url,init) => {
      if (url === "/api/export/agentic" && init?.method === "GET") {
        lists++;
        return lists === 1 ? old.promise : json({items:[admittedItem],nextCursor:null});
      }
      if (url === "/api/export/agentic" && init?.method === "POST") {
        writes++;
        return outcome === "admitted" ? json({run},201) : new Response(null,{status:500});
      }
      throw new Error(`Unexpected owned request: ${url}`);
    });
    const controller = createExportController({fetch});
    const first = controller.loadCatalog();
    try {
      expect(lists).toBe(1);
      const admission = await admitExport({request:"Owned new question",effort:"quick"},{fetch});
      expect(admission.kind).toBe(outcome);
      // Leaving and returning mounts the catalog again while the original read is still held.
      const reentry = controller.loadCatalog();
      await until(() => lists === 2);
      await reentry;
      expect(controller.getCatalog().items).toEqual([admittedItem]);
      old.resolve(json({items:[],nextCursor:null})); await first;
      expect(controller.getCatalog()).toMatchObject({loaded:true,pending:false,items:[admittedItem]});
      expect(writes).toBe(1);
    } finally { old.resolve(json({items:[],nextCursor:null})); await first; }
  });
}
