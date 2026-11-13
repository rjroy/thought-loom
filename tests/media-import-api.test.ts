import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFile, cp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { body, bounded, mediaApiCredentials, mediaApiFixture, mediaApiMaxBytes, mediaClarification, object, originalPath, receipt, retry, text, upload } from "./fixtures/media-import-api";
import { classicPdf } from "./fixtures/media-pdfs";
import { corruptPngPixels, independentPng } from "./fixtures/media-rasters";
import { pathComplete, pathRequest, promptStrings } from "./fixtures/media-path-worker";
import { admitWeave } from "../src/storage/weave-admission";
import { SqliteStore } from "../src/storage/sqlite";
import { connectionDiscoveryOrigin, resolveWeavePurpose } from "../src/domain/weave-scheduling";

test("owned media upload retains its original and queues normal weaving without agent configuration", async () => mediaApiFixture(async f => {
  expect((await f.request("/thoughts")).status).toBe(200);
  const bytes = independentPng(), result = await receipt(await f.request("/imports/media",upload(bytes,"first-image",{
    name:"private-display-image.png",metadata:{clarification:mediaClarification},
  })));
  expect(result.thought).toMatchObject({author:"source",kind:"media-original",text:null,parentId:null,sourceIds:[],
    mediaSource:{name:"private-display-image.png",mimeType:"image/png",byteLength:bytes.length,clarification:mediaClarification,clarificationAuthor:"user"}});
  expect(result.run).toEqual({id:result.runId,kind:"weave",status:"queued",confirmedThoughtIds:[],responseId:null});
  expect(await body(await f.request(`/runs/${result.runId}`))).toEqual(result.run);
  const lookup = await receipt(await f.request("/imports/media/by-key/first-image"),200);
  expect(lookup).toEqual(result);
  const inspection = await f.request(`/media-sources/${result.thought.mediaSource.id}`);
  expect(inspection.status).toBe(200);
  expect(await body(inspection)).toEqual({thought:result.thought,run:result.run,retry:{eligible:false,reason:"work-active"}});
  const retained = await realpath(join(f.mediaDirectory,"objects",result.thought.mediaSource.id));
  expect(isAbsolute(retained)).toBe(true);
  expect((await stat(retained)).mode & 0o777).toBe(0o600);
  expect((await stat(f.mediaDirectory)).mode & 0o777).toBe(0o700);
  expect(Array.from(await readFile(retained))).toEqual(Array.from(bytes));
  expect(JSON.stringify(result)).not.toContain(f.directory);
  expect(f.nativeCalls).toEqual({resolutions:0,clients:0});
  expect(f.read(db => db.query("SELECT count(*) AS n FROM media_sources").get())).toEqual({n:1});
  expect(f.read(db => db.query("SELECT count(*) AS n FROM agent_bindings").get())).toEqual({n:0});
}),20000);

test("media routes deny unauthorized roles before awaiting an upload body", async () => mediaApiFixture(async f => {
  expect(await f.headersOnly("anonymous")).toBe(401);
  expect(await f.headersOnly("ai")).toBe(403);
  const admitted = await receipt(await f.request("/imports/media",upload(independentPng(),"auth-source")));
  const source = admitted.thought.mediaSource.id, before = f.graph();
  for (const endpoint of ["/imports/media/by-key/auth-source",`/media-sources/${source}`,`/media-sources/${source}/raw?scope=history`]) {
    expect((await f.request(endpoint,{},"anonymous")).status).toBe(401);
    expect((await f.request(endpoint,{},"ai")).status).toBe(403);
  }
  expect((await f.request(`/media-sources/${source}/retry`,retry("ai-retry"),"ai")).status).toBe(403);
  expect(f.graph()).toEqual(before);
}),20000);

test("media multipart and actual format validation reject bounded invalid uploads without admission", async () => mediaApiFixture(async f => {
  await receipt(await f.request("/imports/media",upload(independentPng(),"validation-control")));
  const before = f.graph();
  const duplicate = upload(independentPng(),"two-files");
  if (!(duplicate.body instanceof FormData)) throw new Error("Expected a controlled multipart form");
  duplicate.body.append("file",new Blob([new Uint8Array([1,2,3]).buffer]),"second.png");
  const invalid: readonly {request:RequestInit;status:number}[] = [
    {request:upload(independentPng(),"bad-clarification",{metadata:{clarification:42}}),status:400},
    {request:upload(independentPng(),"oversized-metadata",{metadata:{clarification:"x".repeat(4097)}}),status:400},
    {request:upload(independentPng(),"caller-path",{metadata:{path:"/tmp/opencode/not-a-source",clarification:null}}),status:400},
    {request:upload(independentPng(),"duplicate-metadata",{metadata:'{"clarification":"one","clarification":"two"}'}),status:400},
    {request:duplicate,status:400},
    {request:upload(new Uint8Array(mediaApiMaxBytes+1),"too-large"),status:413},
    {request:upload(new TextEncoder().encode("<html>not an image</html>"),"unsupported",{mime:"text/html",name:"page.html"}),status:415},
    {request:upload(corruptPngPixels(),"corrupt-pixels"),status:422},
  ];
  for (const entry of invalid) {
    const response = await f.request("/imports/media",entry.request);
    expect(response.status).toBe(entry.status);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.text()).not.toContain(f.directory);
    expect(f.graph()).toEqual(before);
  }
  const missingKey = upload(independentPng(),"unused");
  expect((await f.request("/imports/media",{...missingKey,headers:{}})).status).toBe(400);
  expect((await f.request("/imports/media",{method:"POST",headers:{"content-type":"application/json","Idempotency-Key":"wrong-body"},body:"{}"})).status).toBe(415);
  expect(f.graph()).toEqual(before);
}),30000);

test("media upload replay and by-key receipts preserve identity and reject changed immutable input", async () => mediaApiFixture(async f => {
  const bytes = independentPng(), options = {name:"unchanged.png",metadata:{clarification:mediaClarification}};
  const first = await receipt(await f.request("/imports/media",upload(bytes,"receipt-key",options)));
  const before = f.graph();
  expect(await receipt(await f.request("/imports/media",upload(bytes,"receipt-key",options)),200)).toEqual(first);
  expect(await receipt(await f.request("/imports/media/by-key/receipt-key"),200)).toEqual(first);
  for (const request of [upload(independentPng(true),"receipt-key",options),
    upload(bytes,"receipt-key",{...options,name:"changed.png"}),
    upload(bytes,"receipt-key",{...options,metadata:{clarification:"Changed user wording"}})]) {
    const conflict = await f.request("/imports/media",request);
    expect(conflict.status).toBe(409);
    expect(await body(conflict)).toMatchObject({code:"idempotency-conflict"});
    expect(f.graph()).toEqual(before);
  }
  expect((await f.request("/imports/media/by-key/missing-key")).status).toBe(404);
  const independent = await receipt(await f.request("/imports/media",upload(bytes,"independent-key",options)));
  expect(independent.thought.id).not.toBe(first.thought.id);
  expect(independent.thought.mediaSource.id).not.toBe(first.thought.mediaSource.id);
  expect(independent.runId).not.toBe(first.runId);
}),30000);

test("media source inspection and exact downloads respect normal history and rejection scopes", async () => mediaApiFixture(async f => {
  const bytes = independentPng(), admitted = await receipt(await f.request("/imports/media",upload(bytes,"scoped-source",{
    name:'source";private.png',metadata:{clarification:mediaClarification},
  })));
  const source = admitted.thought.mediaSource.id, base = `/media-sources/${source}`;
  const raw = await f.request(`${base}/raw`);
  expect(raw.status).toBe(200);
  expect(raw.headers.get("content-type")).toBe("image/png");
  expect(raw.headers.get("content-disposition")).toMatch(/^attachment;\s*filename="[^"\r\n]+"$/);
  expect(raw.headers.get("x-content-type-options")).toBe("nosniff");
  expect(raw.headers.get("cache-control")).toContain("no-store");
  expect(Array.from(new Uint8Array(await raw.arrayBuffer()))).toEqual(Array.from(bytes));
  expect((await f.request(`/thoughts/${admitted.thought.id}/reject`,{method:"POST"})).status).toBe(204);
  expect((await f.request(base)).status).toBe(404);
  expect((await f.request(`${base}/raw`)).status).toBe(404);
  const history = await f.request(`${base}?scope=history`);
  expect(history.status).toBe(200);
  expect(await body(history)).toEqual({thought:{...admitted.thought,rejected:true},run:{...admitted.run,status:"interrupted"},
    retry:{eligible:false,reason:"source-rejected"}});
  const original = await f.request(`${base}/raw?scope=history`);
  expect(original.status).toBe(200);
  expect(Array.from(new Uint8Array(await original.arrayBuffer()))).toEqual(Array.from(bytes));
  expect((await f.request(`${base}?scope=history`,{},"ai")).status).toBe(403);
  expect((await f.request(`${base}?scope=normal&scope=history`)).status).toBe(400);
  expect((await f.request(`${base}/raw?unexpected=1`)).status).toBe(400);
  expect((await f.request(`/media-sources/missing-source/raw?scope=history`)).status).toBe(404);
}),20000);

test("source status and retry admission agree across active, uncertain and settled work", async () => mediaApiFixture(async f => {
  const first = await receipt(await f.request("/imports/media",upload(independentPng(),"status-gate")));
  const base = `/media-sources/${first.thought.mediaSource.id}`, db = new Database(f.dbPath);
  try {
    const states = [
      {status:"queued",cancellation:"none",reason:"work-active"},
      {status:"uncertain",cancellation:"none",reason:"work-unsettled"},
      {status:"failed",cancellation:"pending",reason:"work-unsettled"},
    ];
    for (const state of states) {
      db.query("UPDATE runs SET status=?,cancellation_state=? WHERE id=?").run(state.status,state.cancellation,first.runId);
      const inspection = await body(await f.request(base));
      expect(inspection).toEqual({thought:first.thought,run:await body(await f.request(`/runs/${first.runId}`)),
        retry:{eligible:false,reason:state.reason}});
      expect((await f.request(`${base}/retry`,retry(`blocked-${state.status}`))).status).toBe(409);
    }
    db.query("UPDATE runs SET status='failed',cancellation_state='settled' WHERE id=?").run(first.runId);
    // A settled bit alone cannot prove the failed legacy row was never submitted.
    expect(object((await body(await f.request(base))).retry)).toEqual({eligible:false,reason:"work-unsettled"});
    expect((await f.request(`${base}/retry`,retry("unverified-settled"))).status).toBe(409);
    // This fixture never dispatched: retain its exact prepared input to prove the local case.
    db.query("UPDATE run_steps SET input=? WHERE run_id=?").run("test-owned prepared input",first.runId);
    expect(await body(await f.request(base))).toEqual({thought:first.thought,run:await body(await f.request(`/runs/${first.runId}`)),
      retry:{eligible:true,reason:null}});
    const accepted = await f.request(`${base}/retry`,retry("settled-retry"));
    expect(accepted.status).toBe(202);
    const retriedRun = object((await body(accepted)).run), retryId = text(retriedRun.id);
    expect(retryId).not.toBe(first.runId);

    let sequence = 0;
    const titleRun = admitWeave(db,{id:() => `fixture-title-${++sequence}`,now:() => "2026-01-01T00:00:00.000Z"},
      {subjectId:first.thought.id,triggerId:"title-clear:fixture-invitation"});
    expect(titleRun.id).not.toBe(retryId);
    expect(await body(await f.request(base))).toEqual({thought:first.thought,run:retriedRun,
      retry:{eligible:false,reason:"work-active"}});
    expect((await receipt(await f.request("/imports/media/by-key/status-gate"),200)).runId).toBe(first.runId);
  } finally { db.close(); }
}),20000);

test("a confirmed interpretation blocks retry even after the child is rejected", async () => mediaApiFixture(async f => {
  const first = await receipt(await f.request("/imports/media",upload(independentPng(),"status-child")));
  const base = `/media-sources/${first.thought.mediaSource.id}`, db = new Database(f.dbPath);
  try {
    db.query("UPDATE runs SET status='failed',cancellation_state='settled' WHERE id=?").run(first.runId);
    new SqliteStore(db).saveThought({id:"fixture-confirmed-interpretation",text:"Owned source interpretation",title:null,titleAuthor:null,
      author:"ai",kind:"ai-interpretation",createdAt:"2026-01-01T00:00:00.000Z",origin:"weave",parentId:first.thought.id,sourceIds:[]});
    for (const rejected of [false,true]) {
      if (rejected) expect((await f.request("/thoughts/fixture-confirmed-interpretation/reject",{method:"POST"})).status).toBe(204);
      expect(await body(await f.request(base))).toEqual({thought:first.thought,run:await body(await f.request(`/runs/${first.runId}`)),
        retry:{eligible:false,reason:"interpretation-exists"}});
      expect((await f.request(`${base}/retry`,retry(`child-${rejected}`))).status).toBe(409);
    }
  } finally { db.close(); }
}),20000);

test("configured media admission gives the normal worker real PNG and PDF paths and saves canonical replies", async () => mediaApiFixture(async f => {
  for (const item of [{bytes:independentPng(),name:"diagram.png",mime:"image/png",metadata:{clarification:mediaClarification}},
    {bytes:classicPdf(),name:"document.pdf",mime:"application/pdf",metadata:{}}]) {
    const admitted = await receipt(await f.request("/imports/media",upload(item.bytes,item.name,item)));
    await f.until(async () => (await body(await f.request(`/runs/${admitted.runId}`))).status === "completed","normal media interpretation");
    const status = await body(await f.request(`/runs/${admitted.runId}`)), ids = status.confirmedThoughtIds;
    if (!Array.isArray(ids) || ids.length !== 1) throw new Error("Expected exactly one canonical interpretation");
    const childId = text(ids[0]), child = await body(await f.request(`/thoughts/${childId}`));
    expect(child).toMatchObject({parentId:admitted.thought.id,author:"ai",kind:"ai-interpretation",text:"Owned searchable media interpretation."});
    const reply = await body(await f.request(`/responses/${text(status.responseId)}`));
    expect(reply).toMatchObject({text:"Saved the owned media interpretation.",state:"complete",thoughtIds:[admitted.thought.id,childId]});
    const initial = f.client.prompts.find(prompt => {
      const value: unknown = JSON.parse(prompt.text);
      return object(value).kind === "job" && promptStrings(prompt.text).includes(admitted.thought.id);
    });
    if (!initial) throw new Error("Expected the actual configured worker's initial prompt");
    const path = originalPath(initial.text,admitted.thought.id);
    expect(path).toBe(await realpath(join(f.mediaDirectory,"objects",admitted.thought.mediaSource.id)));
    expect(Array.from(await readFile(path))).toEqual(Array.from(item.bytes));
    expect(f.client.sessions.get(initial.sessionID)?.permissions).toEqual([{action:"*",resource:"*",effect:"allow"}]);
    const instructions = promptStrings(initial.text).join(" ");
    if ("clarification" in item.metadata) expect(promptStrings(initial.text)).toContain(mediaClarification);
    else expect(instructions).toMatch(/summari[sz]e|summary/i);
    expect(JSON.stringify(admitted)).not.toContain(f.directory);
  }
  expect(f.client.scriptErrors).toEqual([]);
  const diagnostics = JSON.stringify([f.events,f.logs]);
  for (const privateValue of [mediaApiCredentials.user,mediaApiCredentials.ai,mediaClarification,f.directory]) expect(diagnostics).not.toContain(privateValue);
},{configured:true,script:(_index,input) => object(JSON.parse(input)).kind === "job"
  ? pathRequest("interpretation",{text:"Owned searchable media interpretation.",sourceIds:[]}) : pathComplete("Saved the owned media interpretation.")}),30000);

test("media HTTP retry reuses a failed original after normal cancellation without duplicating its interpretation", async () => {
  let interpret = false;
  await mediaApiFixture(async f => {
    let holdTerminalEvidence = true, heldReads = 0;
    f.client.historyPage = async input => {
      const failed = f.read(db => db.query("SELECT 1 FROM runs WHERE session_id=? AND status='failed'").get(input.sessionID)) !== null;
      if (holdTerminalEvidence && failed) { heldReads++; return {data:[],cursor:{}}; }
      return {data:f.client.messages.get(input.sessionID) ?? [],cursor:{}};
    };
    const bytes = independentPng(), first = await receipt(await f.request("/imports/media",upload(bytes,"failed-source")));
    const source = first.thought.mediaSource.id, retryPath = `/media-sources/${source}/retry`;
    await f.until(async () => (await body(await f.request(`/runs/${first.runId}`))).status === "failed","failed source outcome");
    await f.until(() => heldReads > 0,"cancellation without terminal evidence");
    expect(f.read(db => db.query("SELECT cancellation_state AS state FROM runs WHERE id=?").get(first.runId))).toEqual({state:"pending"});
    expect((await f.request(retryPath,retry("deliberate-retry"))).status).toBe(409);
    expect(f.read(db => db.query("SELECT cancellation_state AS state FROM runs WHERE id=?").get(first.runId))).toEqual({state:"pending"});
    holdTerminalEvidence = false;
    await f.until(() => f.read(db => db.query("SELECT 1 FROM runs WHERE id=? AND cancellation_state='settled'").get(first.runId)) !== null,"ordinary cancellation settlement");
    expect(f.client.inboxCancellations).toHaveLength(0); // The fixture never placed a prompt in the native inbox.
    expect(f.client.interrupts.length).toBeGreaterThan(0);
    interpret = true;
    const accepted = await f.request(retryPath,retry("deliberate-retry"));
    expect(accepted.status).toBe(202);
    const runId = text(object((await body(accepted)).run).id);
    const replay = await f.request(retryPath,retry("deliberate-retry"));
    expect(replay.status).toBe(200);
    expect(text(object((await body(replay)).run).id)).toBe(runId);
    await f.until(async () => (await body(await f.request(`/runs/${runId}`))).status === "completed","retried source interpretation");
    expect((await f.request(retryPath,retry("duplicate-summary"))).status).toBe(409);
    expect(f.read(db => db.query("SELECT count(*) AS n FROM thoughts WHERE parent_id=? AND kind='ai-interpretation'").get(first.thought.id))).toEqual({n:1});
    const mediaRuns = f.read(db => db.query<{id:string;status:string;trigger:string},[string]>(
      "SELECT id,status,weave_trigger_id AS trigger FROM runs WHERE kind='weave' AND weave_subject_id=? ORDER BY rowid").all(first.thought.id));
    expect(mediaRuns.map(run => [run.id,run.status,resolveWeavePurpose("media-original",run.trigger)])).toEqual([
      [first.runId,"failed","ordinary"],[runId,"completed","ordinary"],
    ]);
    const initialPrompts = f.client.prompts.filter(prompt => object(JSON.parse(prompt.text)).kind === "job" &&
      mediaRuns.some(run => f.client.sessions.get(prompt.sessionID)?.metadata.runId === run.id));
    expect(initialPrompts).toHaveLength(2);
    expect(initialPrompts.map(prompt => f.client.sessions.get(prompt.sessionID)?.metadata.runId)).toEqual([first.runId,runId]);
    const paths = initialPrompts.map(prompt => originalPath(prompt.text,first.thought.id));
    expect(paths).toEqual([join(f.mediaDirectory,"objects",source),join(f.mediaDirectory,"objects",source)]);
    for (const prompt of initialPrompts) {
      const capabilities = object(JSON.parse(prompt.text)).capabilities;
      if (!Array.isArray(capabilities)) throw new Error("Expected media Weaver capabilities");
      expect(capabilities.map(item => object(item).capability)).toEqual(expect.arrayContaining(["interpretation","title-fill","connection"]));
    }
    const child = f.read(db => db.query<{id:string},[string]>("SELECT id FROM thoughts WHERE parent_id=? AND kind='ai-interpretation'").get(first.thought.id));
    if (!child) throw new Error("Expected the retried media interpretation");
    const discoveryRuns = f.read(db => db.query<{id:string;trigger:string},[string]>(
      "SELECT id,weave_trigger_id AS trigger FROM runs WHERE kind='weave' AND weave_subject_id=? ORDER BY rowid").all(child.id));
    expect(discoveryRuns).toHaveLength(1);
    const discovery = discoveryRuns[0];
    if (!discovery) throw new Error("Expected the interpretation's discovery owner");
    expect(resolveWeavePurpose("ai-interpretation",discovery.trigger)).toBe("connection-only");
    expect(connectionDiscoveryOrigin(discovery.trigger)).toBe(runId);
    const discoveryPrompt = () => f.client.prompts.find(prompt => object(JSON.parse(prompt.text)).kind === "job" &&
      f.client.sessions.get(prompt.sessionID)?.metadata.runId === discovery.id);
    await f.until(() => discoveryPrompt() !== undefined,"interpretation discovery prompt");
    const discoveryInput = discoveryPrompt();
    if (!discoveryInput) throw new Error("Expected the discovery prompt");
    const discoveryCapabilities = object(JSON.parse(discoveryInput.text)).capabilities;
    if (!Array.isArray(discoveryCapabilities)) throw new Error("Expected discovery capabilities");
    expect(discoveryCapabilities.map(item => object(item).capability).sort()).toEqual(["connection","readConnection","readResponse","readThought","search"].sort());
    expect(f.read(db => db.query("SELECT count(*) AS n FROM thoughts WHERE parent_id=? AND kind='ai-interpretation'").get(first.thought.id))).toEqual({n:1});
    expect(Array.from(await readFile(join(f.mediaDirectory,"objects",source)))).toEqual(Array.from(bytes));
    expect(f.read(db => db.query("SELECT count(*) AS n FROM media_sources").get())).toEqual({n:1});
    expect(f.client.scriptErrors).toEqual([]);
  },{configured:true,script:(_index,input) => {
    if (!interpret) return pathComplete("The owned source could not be understood.");
    const prompt = object(JSON.parse(input));
    if (prompt.kind !== "job") return pathComplete("Saved the retried interpretation.");
    if (object(object(prompt.context).job).purpose === "connection-only") return pathComplete("No connection warranted.");
    return pathRequest("interpretation",{text:"Retried owned interpretation.",sourceIds:[]});
  }});
},30000);

test("initial media retry and reinterpretation race to one interpretation admission", async () => mediaApiFixture(async f => {
  const first = await receipt(await f.request("/imports/media", upload(independentPng(), "race-media")));
  const db = new Database(f.dbPath);
  try {
    db.query("UPDATE run_steps SET input=? WHERE run_id=?").run("never dispatched fixture input", first.runId);
    db.query("UPDATE runs SET status='failed',cancellation_state='settled' WHERE id=?").run(first.runId);
  } finally { db.close(); }
  const [retryResponse, reinterpretResponse] = await Promise.all([
    f.request(`/media-sources/${first.thought.mediaSource.id}/retry`, retry("race-retry")),
    f.request(`/thoughts/${first.thought.id}/reinterpret`, retry("race-reinterpret")),
  ]);
  expect([retryResponse.status, reinterpretResponse.status].sort()).toEqual([202, 409]);
  expect(f.read(db => db.query("SELECT count(*) AS n FROM runs WHERE weave_subject_id=?").get(first.thought.id))).toEqual({n:2});
  const lookup = await f.request(`/thoughts/${first.thought.id}/reinterpret/by-key/race-reinterpret`);
  expect(lookup.status).toBe(200);
  const recoveredReceipt = (await body(lookup)).receipt;
  if (reinterpretResponse.status === 202) expect(object(recoveredReceipt).requestKey).toBe("race-reinterpret");
  else expect(recoveredReceipt).toBeNull();
}), 20000);

for (const firstCommand of ["retry", "reinterpret"] as const) test(`media ${firstCommand} admitted first blocks the other command without a receipt alias`, async () => mediaApiFixture(async f => {
  const first = await receipt(await f.request("/imports/media", upload(independentPng(), `ordered-${firstCommand}`)));
  const db = new Database(f.dbPath);
  try {
    db.query("UPDATE run_steps SET input=? WHERE run_id=?").run("never dispatched fixture input", first.runId);
    db.query("UPDATE runs SET status='failed',cancellation_state='settled' WHERE id=?").run(first.runId);
  } finally { db.close(); }
  const sendRetry = () => f.request(`/media-sources/${first.thought.mediaSource.id}/retry`, retry("ordered-retry"));
  const sendReinterpret = () => f.request(`/thoughts/${first.thought.id}/reinterpret`, retry("ordered-reinterpret"));
  const admitted = await (firstCommand === "retry" ? sendRetry() : sendReinterpret());
  expect(admitted.status).toBe(202);
  const rejected = await (firstCommand === "retry" ? sendReinterpret() : sendRetry());
  expect(rejected.status).toBe(409);
  const lookup = await f.request(`/thoughts/${first.thought.id}/reinterpret/by-key/ordered-reinterpret`);
  expect(lookup.status).toBe(200);
  const recoveredReceipt = (await body(lookup)).receipt;
  if (firstCommand === "reinterpret") expect(object(recoveredReceipt).requestKey).toBe("ordered-reinterpret");
  else expect(recoveredReceipt).toBeNull();
  expect(f.read(db => db.query("SELECT count(*) AS n FROM runs WHERE weave_subject_id=?").get(first.thought.id))).toEqual({n:2});
}), 20000);

test("media title-only invitation coexists with reinterpretation admission", async () => mediaApiFixture(async f => {
  const first = await receipt(await f.request("/imports/media", upload(independentPng(), "title-coexist")));
  const db = new Database(f.dbPath);
  try {
    db.query("UPDATE runs SET status='completed' WHERE id=?").run(first.runId);
    let sequence = 0;
    admitWeave(db, { id: () => `title-coexist-${++sequence}`, now: () => "2030-01-01T00:00:00Z" },
      { subjectId: first.thought.id, triggerId: "title-clear:coexisting" });
  } finally { db.close(); }
  const response = await f.request(`/thoughts/${first.thought.id}/reinterpret`, retry("with-title"));
  expect(response.status).toBe(202);
  const data = await body(response);
  expect(object(data.receipt).requestKey).toBe("with-title");
  expect(f.read(db => db.query("SELECT weave_trigger_id AS trigger FROM runs WHERE weave_subject_id=? ORDER BY rowid").all(first.thought.id)))
    .toEqual([{trigger:expect.any(String)}, {trigger:"title-clear:coexisting"}, {trigger:"reinterpret:with-title"}]);
}), 20000);

test("a media source with an earlier interpretation can admit explicit reinterpretation", async () => mediaApiFixture(async f => {
  const first = await receipt(await f.request("/imports/media", upload(independentPng(), "media-history")));
  const db = new Database(f.dbPath);
  try {
    db.query("UPDATE runs SET status='completed' WHERE id=?").run(first.runId);
    new SqliteStore(db).saveThought({id:"prior-media-output",text:"Earlier interpretation",title:null,titleAuthor:null,
      author:"ai",kind:"ai-interpretation",createdAt:"2030-01-01T00:00:00Z",origin:"weave",parentId:first.thought.id,sourceIds:[]});
  } finally { db.close(); }
  const response = await f.request(`/thoughts/${first.thought.id}/reinterpret`, retry("fresh-with-history"));
  expect(response.status).toBe(202);
  expect(object((await body(response)).receipt)).toEqual(expect.objectContaining({subjectId:first.thought.id,requestKey:"fresh-with-history"}));
  expect(f.read(db => db.query("SELECT id,parent_id AS parent FROM thoughts WHERE id='prior-media-output'").get()))
    .toEqual({id:"prior-media-output",parent:first.thought.id});
  expect((await f.request(`/media-sources/${first.thought.mediaSource.id}/retry`,retry("initial-again"))).status).toBe(409);
}), 20000);

test("media restart and paired restore preserve file identity while a mismatched store fails without repair", async () => mediaApiFixture(async f => {
  const bytes = independentPng(), admitted = await receipt(await f.request("/imports/media",upload(bytes,"restore-source")));
  const originalDirectory = f.mediaDirectory, marker = await readFile(join(originalDirectory,"store.json")), before = f.graph();
  expect(originalDirectory).toBe(`${f.dbPath}.media`);
  await f.stop();
  await f.start();
  expect(f.graph()).toEqual(before);
  expect(await readFile(join(f.mediaDirectory,"store.json"))).toEqual(marker);
  expect((await receipt(await f.request("/imports/media/by-key/restore-source"),200)).runId).toBe(admitted.runId);
  await f.stop();
  const backupDb = join(f.directory,"restored.sqlite"), backupMedia = join(f.directory,"restored-media");
  await copyFile(f.dbPath,backupDb); await cp(originalDirectory,backupMedia,{recursive:true});
  await f.start({THOUGHTLOOM_DB_PATH:backupDb,THOUGHTLOOM_MEDIA_DIR:backupMedia});
  expect(f.graph()).toEqual(before);
  const raw = await f.request(`/media-sources/${admitted.thought.mediaSource.id}/raw`);
  expect(raw.status).toBe(200);
  expect(Array.from(new Uint8Array(await raw.arrayBuffer()))).toEqual(Array.from(bytes));
  await f.stop();
  const mismatched = join(f.directory,"mismatched-media");
  await cp(originalDirectory,mismatched,{recursive:true});
  const storeId = text(object(JSON.parse(marker.toString("utf8"))).storeId);
  const badMarker = JSON.stringify({version:1,storeId:`${storeId.startsWith("0") ? "1" : "0"}${storeId.slice(1)}`}) + "\n";
  await writeFile(join(mismatched,"store.json"),badMarker);
  await expect(f.start({THOUGHTLOOM_MEDIA_DIR:mismatched})).rejects.toThrow("Daemon startup failed");
  expect(await readFile(join(mismatched,"store.json"),"utf8")).toBe(badMarker);
  await f.start();
  expect(f.graph()).toEqual(before);
  expect(await readFile(join(originalDirectory,"store.json"))).toEqual(marker);
  expect(Array.from(await readFile(join(originalDirectory,"objects",admitted.thought.mediaSource.id)))).toEqual(Array.from(bytes));
},{derivedDirectory:true}),30000);

test("media daemon shutdown joins entered normal native work and reopens retained sources without resending", async () => mediaApiFixture(async f => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  f.client.beforePrompt = async () => { entered.resolve(); await release.promise; };
  let stopping: Promise<void> | undefined;
  try {
    const admitted = await receipt(await f.request("/imports/media",upload(independentPng(),"held-shutdown")));
    let started = false;
    void entered.promise.then(() => { started = true; });
    await f.until(() => started,"entered normal native prompt");
    const marker = await readFile(join(f.mediaDirectory,"store.json"));
    let stopped = false;
    stopping = f.stop().then(() => { stopped = true; });
    await Bun.sleep(10);
    expect(stopped).toBe(false);
    release.resolve();
    await bounded(stopping,"joined media daemon stop");
    expect(f.client.prompts).toHaveLength(1);
    await f.start({THOUGHTLOOM_AGENT_CONFIG:undefined});
    const replay = await receipt(await f.request("/imports/media/by-key/held-shutdown"),200);
    expect(replay.thought).toEqual(admitted.thought);
    expect(replay.runId).toBe(admitted.runId);
    expect(["submitting","uncertain"]).toContain(text(replay.run.status));
    expect(replay.run.confirmedThoughtIds).toEqual([]);
    expect(await readFile(join(f.mediaDirectory,"store.json"))).toEqual(marker);
    const raw = await f.request(`/media-sources/${admitted.thought.mediaSource.id}/raw`);
    expect(raw.status).toBe(200);
    expect(Array.from(new Uint8Array(await raw.arrayBuffer()))).toEqual(Array.from(independentPng()));
    expect(f.client.prompts).toHaveLength(1);
  } finally { release.resolve(); if (stopping) await bounded(stopping,"held native fixture release"); }
},{configured:true,script:() => pathComplete("A late source outcome must not publish during shutdown.")}),30000);
