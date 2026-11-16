import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { captureBackup } from "../src/backup/capture";
import { decodeManifest, decodeTable } from "../src/backup/decode";
import { encodeManifest, encodeTable, type RawCell, type RawRow } from "../src/backup/format";
import { shapesForSchema } from "../src/backup/schema";
import { stageRestoreSnapshot, recoverRestoreStage, restoreBackup } from "../src/backup/restore-staging";
import { createBackgroundWorkRoutes } from "../src/daemon/background-work-routes";
import { RunAdmissionService } from "../src/domain/run";
import { protocolJson } from "../src/domain/run-protocol";
import type { BackgroundItem } from "../src/domain/background-work";
import type { Actor } from "../src/domain/rejection";
import { createLogger } from "../src/logging";
import { SqliteBackgroundWork } from "../src/storage/background-work";
import { SqliteAgenticExports } from "../src/storage/agentic-export";
import { SqliteMarkdownImports } from "../src/storage/markdown-import";
import { SqliteRunOperations } from "../src/storage/run-operations";
import { SqliteRunRepository } from "../src/storage/run";
import { recordedSubjectCancellationSafe } from "../src/storage/run-cancellation";
import { readSearchCleanupSnapshot } from "../src/storage/search-cleanup-snapshot";
import { purgeSearchSessionContent } from "../src/storage/search-purge";
import { RejectionService } from "../src/domain/rejection";
import { SqliteRejectionRepository } from "../src/storage/rejection";
import { SqliteStore } from "../src/storage/sqlite";
import { SqliteSharedResponses } from "../src/storage/shared-response";
import { SqliteSearchCleanup } from "../src/storage/search-cleanup";
import { body, mediaApiFixture, object, type MediaApiFixture } from "./fixtures/media-import-api";
import { confirmedLocalStop, heldLocalStop, localStopCommand, localStopIdentity, localStopLookup, localStopPath, workPath } from "./fixtures/background-local-stop";
import { sealDailyReview } from "./fixtures/seal-daily-review";

const logger = createLogger("error", () => {});
const stamp = "2031-01-01T00:00:00.000Z";
const settledCleanupStatus = "settled" satisfies BackgroundItem["status"];
type WorkItem = {
  target: { type: "run" | "import-file"; id: string };
  kind: "weave" | "evolve" | "search" | "export" | "import";
  status: string;
  createdAt: string | null;
  owner: { type: string; id: string | null; title: string | null };
  reason: string | null;
  actions: { checkStatus: boolean; stopLocalTracking: boolean };
};
type Page = { items: WorkItem[]; nextCursor: string | null };

function seed(f: MediaApiFixture) {
  const db = new Database(f.dbPath);
  try {
    db.exec("PRAGMA foreign_keys=ON");
    let sequence = 0;
    let clock = Date.parse(stamp);
    const sources = { id: () => `owned-${String(++sequence).padStart(3,"0")}`,
      now: () => new Date(clock).toISOString(), logger };
    const advance = () => { clock += 1_000; };
    const store = new SqliteStore(db);
    const runs = new SqliteRunRepository(db, sources);
    const operations = new SqliteRunOperations(db, sources);
    const imports = new SqliteMarkdownImports(db, sources);
    const exports = new SqliteAgenticExports(db, sources);
    const rejection = new RejectionService(new SqliteRejectionRepository(db, logger));
    store.saveThought({ id:"visible", text:"PRIVATE THOUGHT BODY", title:"Visible title", titleAuthor:"user",
      author:"user", kind:"captured-original", createdAt:stamp, origin:"fixture", parentId:null, sourceIds:[] });
    store.saveThought({ id:"hidden", text:"PRIVATE REJECTED BODY", title:"PRIVATE REJECTED TITLE", titleAuthor:"user",
      author:"user", kind:"captured-original", createdAt:stamp, origin:"fixture", parentId:null, sourceIds:[] });
    const weave = operations.admitWeave("user",{subjectId:"hidden",triggerId:"owned-weave"});
    db.run("UPDATE run_steps SET input=?,state='uncertain' WHERE run_id=?",["PRIVATE PROMPT",weave.id]);
    db.run("UPDATE runs SET status='uncertain' WHERE id=?",[weave.id]);
    rejection.rejectThought("user","hidden");
    // This legacy-style uncertain journal has no exposure witness for rejection to fence.
    expect(db.query("SELECT status,cancellation_state FROM runs WHERE id=?").get(weave.id))
      .toEqual({status:"uncertain",cancellation_state:"none"});
    advance();
    const admission = new RunAdmissionService({repository:runs,...sources}).admit("user","evolve",{parentId:"visible",text:"PRIVATE CONTRIBUTION"});
    const evolve = admission.run, contribution = admission.contribution;
    if (!contribution) throw new Error("Expected owned Evolve contribution");
    const discovery = db.query<{id:string;weave_trigger_id:string},[string]>(
      "SELECT id,weave_trigger_id FROM runs WHERE kind='weave' AND weave_subject_id=?").get(contribution.id);
    if (!discovery) throw new Error("Expected contribution-owned connection discovery");
    expect(discovery.weave_trigger_id).toBe(`connection-discovery:${evolve.id}`);
    advance();
    const report = exports.admit("user",{request:"PRIVATE EXPORT REQUEST",effort:"quick"});
    advance();
    const sessions = store.searchSessions(sources);
    const session = sessions.create("user","search-session",{}).session;
    const composer = sessions.openComposer("user",session.id);
    const search = sessions.admitTurn("user",session.id,"search-turn",{text:"PRIVATE SEARCH QUERY",startingThoughtIds:[],
      requestClock:{at:stamp,timeZone:"UTC"},composerId:composer.composerId,contextToken:composer.contextToken}).run;
    advance();
    const batch = imports.createBatch("user","owned-batch");
    const bytes = new TextEncoder().encode("PRIVATE IMPORT CONTENT");
    const holder = imports.admitFile("user",batch.id,"holder","PRIVATE-PATH/holder.md",bytes);
    advance();
    const waiter = imports.admitFile("user",batch.id,"waiter","PRIVATE-PATH/waiter.md",bytes);
    if (!holder.runId || waiter.runId !== null || waiter.state !== "waiting") throw new Error("Expected holder and runless waiter");

    // Seal an actual search cleanup journal before erasing its local session content.
    advance();
    const erased = sessions.create("user","erased-session",{}).session;
    const erasedComposer = sessions.openComposer("user",erased.id);
    const erasedRun = sessions.admitTurn("user",erased.id,"erased-turn",{text:"PRIVATE DELETED QUERY",startingThoughtIds:[],
      requestClock:{at:stamp,timeZone:"UTC"},composerId:erasedComposer.composerId,contextToken:erasedComposer.contextToken}).run;
    const native = db.query<{session_id:string;prompt_id:string},[string]>("SELECT session_id,prompt_id FROM runs WHERE id=?").get(erasedRun.id);
    if (!native) throw new Error("Expected owned search run");
    db.run("INSERT INTO agent_bindings(run_id,session_id,service_url,directory,model_json,permissions_json,protocol_version) VALUES (?,?,?,?,?,?,?)",
      [erasedRun.id,native.session_id,"http://127.0.0.1:44991","/PRIVATE/NATIVE/PATH",'{"providerID":"owned","id":"model"}',
        '[{"action":"*","resource":"*","effect":"deny"}]',1]);
    db.run("UPDATE run_steps SET input=?,state='uncertain' WHERE run_id=?",["PRIVATE DELETED PROMPT",erasedRun.id]);
    runs.stop(erasedRun.id);
    db.transaction(() => {
      db.run("UPDATE search_sessions SET title=NULL,deleted_at=?,revision=revision+1 WHERE id=?",[sources.now(),erased.id]);
      const snap = readSearchCleanupSnapshot(db,erasedRun.id);
      db.run(`INSERT INTO search_native_cleanup(run_id,session_id,binding_json,last_prompt_id,submit_owner,drain_state,admission_state,prompt_sha256,evidence_json,state,prompt_manifest_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`,[snap.runId,snap.sessionId,snap.bindingJson,snap.lastPromptId,snap.submitOwner,
        snap.drainState,snap.admissionState,snap.promptSha256,snap.evidenceJson,snap.state,snap.promptManifestJson]);
      purgeSearchSessionContent(db,erased.id);
    }).immediate();
    expect(db.query("SELECT id FROM runs WHERE id=?").get(erasedRun.id)).toBeNull();
    expect(db.query("SELECT state FROM search_native_cleanup WHERE run_id=?").get(erasedRun.id)).toEqual({state:"pending"});
    advance();
    const complete = exports.admit("user",{request:"PRIVATE COMPLETED REQUEST",effort:"quick"});
    db.run("UPDATE runs SET status='completed' WHERE id=?",[complete.id]);
    const restored = exports.admit("user",{request:"PRIVATE RESTORED REQUEST",effort:"quick"});
    db.run("INSERT INTO restore_fences(entity_kind,entity_id,snapshot_sha256,restored_at,original_state_json) VALUES ('run',?,?,?,?)",
      [restored.id,"a".repeat(64),sources.now(),"{}"]);
    return {weave,evolve,contribution,discovery,report,search,holder,waiter,erasedRun,native};
  } finally { db.close(); }
}

async function page(f: MediaApiFixture, query = ""): Promise<Page> {
  const response = await f.request(`/background-work${query}`);
  expect(response.status).toBe(200);
  return await response.json() as Page;
}

test("background work summary and pages include all kinds, rowless cleanup and runless waiters without duplicate import work", async () => mediaApiFixture(async f => {
  const owned = seed(f);
  const summary = await f.request("/background-work/summary");
  expect(summary.status).toBe(200);
  expect(await body(summary)).toEqual({counts:{"needs-attention":2,"in-progress":6,"locally-closed":0}});
  const attention = await page(f);
  expect(attention.items.map(item => item.target)).toEqual(expect.arrayContaining([
    {type:"run",id:owned.weave.id},{type:"run",id:owned.erasedRun.id},
  ]));
  expect(attention.items).toHaveLength(2);
  expect(attention.items.find(item => item.target.id === owned.erasedRun.id)?.createdAt).toBeNull();
  const first = await page(f,"?view=needs-attention&limit=1");
  expect(first.items.map(item => item.target.id)).toEqual([owned.weave.id]);
  if (!first.nextCursor) throw new Error("Expected continuation to unknown-time cleanup");
  const last = await page(f,`?view=needs-attention&limit=1&cursor=${encodeURIComponent(first.nextCursor)}`);
  expect(last.items.map(item => item.target.id)).toEqual([owned.erasedRun.id]);
  expect(last.items[0]?.createdAt).toBeNull();
  expect(last.nextCursor).toBeNull();
  const progress = await page(f,"?view=in-progress");
  expect(progress.items.map(item => item.kind).sort()).toEqual(["evolve","export","import","import","search","weave"]);
  expect(progress.items.map(item => item.target)).toEqual(expect.arrayContaining([
    {type:"run",id:owned.evolve.id},{type:"run",id:owned.report.id},{type:"run",id:owned.search.id},
    {type:"run",id:owned.holder.runId},{type:"import-file",id:owned.waiter.id},{type:"run",id:owned.discovery.id},
  ]));
  expect(progress.items).toHaveLength(6);
  expect(progress.items.find(item => item.target.id === owned.discovery.id)).toMatchObject({
    kind:"weave",status:"queued",owner:{type:"thought",id:owned.contribution.id,title:null},
  });
  expect(progress.nextCursor).toBeNull();
  expect(await page(f,"?view=locally-closed")).toEqual({items:[],nextCursor:null});
  for (const item of [...attention.items,...progress.items]) {
    expect(item.actions).toEqual({checkStatus:true,stopLocalTracking:true});
    expect(item.reason === null || typeof item.reason === "string").toBe(true);
  }
}));

test("background work pagination is bounded and cursors bind view and limit", async () => mediaApiFixture(async f => {
  const db = new Database(f.dbPath);
  try {
    let sequence = 0;
    const exports = new SqliteAgenticExports(db,{id:() => `page-${String(++sequence).padStart(3,"0")}`,now:() => stamp,logger});
    for (let i=0;i<30;i++) exports.admit("user",{request:`PRIVATE REQUEST ${i}`,effort:"quick"});
  } finally { db.close(); }
  const first = await page(f,"?view=in-progress");
  expect(first.items).toHaveLength(25);
  expect(first.nextCursor).toBeTruthy();
  const second = await page(f,`?view=in-progress&cursor=${encodeURIComponent(first.nextCursor ?? "")}`);
  expect(second.items).toHaveLength(5);
  expect(second.nextCursor).toBeNull();
  expect(new Set([...first.items,...second.items].map(item => item.target.id)).size).toBe(30);
  const ids = [...first.items,...second.items].map(item => item.target.id);
  expect(ids).toEqual([...ids].sort());
  const small = await page(f,"?view=in-progress&limit=2");
  if (!small.nextCursor) throw new Error("Expected owned continuation");
  const cursor = encodeURIComponent(small.nextCursor);
  for (const query of [`?view=needs-attention&limit=2&cursor=${cursor}`,`?view=in-progress&limit=3&cursor=${cursor}`,
    "?view=in-progress&cursor=bad","?view=in-progress&limit=0","?view=in-progress&limit=101","?view=other"]) {
    expect((await f.request(`/background-work${query}`)).status).toBe(400);
  }
  expect((await page(f,"?view=in-progress&limit=100")).items).toHaveLength(30);
}));

test("background work reads are user-only, control-only, redacted and do not mutate durable state", async () => mediaApiFixture(async f => {
  const owned = seed(f);
  const tables = ["runs","run_steps","agent_bindings","search_sessions","search_turns","search_native_cleanup","markdown_import_files","markdown_import_payloads","thoughts","thought_titles","rejected_thoughts"];
  const snapshot = () => f.read(db => tables.map(table => db.query(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all()));
  const before = snapshot(), nativeBefore = f.nativeCalls;
  expect(nativeBefore).toEqual({resolutions:0,clients:0});
  // SQLite's total_changes is connection-local; this independent reader instead
  // observes commits from the daemon connection, including writes outside our table snapshot.
  const observer = new Database(f.dbPath,{readonly:true});
  const dataVersion = () => observer.query<{data_version:number},[]>("PRAGMA data_version").get()?.data_version;
  const versionBefore = dataVersion();
  try {
  const routes = ["/background-work/summary","/background-work","/background-work?view=in-progress",
    `/background-work/runs/${owned.weave.id}`,`/background-work/runs/${owned.erasedRun.id}`,
    `/background-work/import-files/${owned.waiter.id}`];
  for (const route of routes) {
    expect((await f.request(route,{},"ai")).status).toBe(403);
    expect((await f.request(route,{},"anonymous")).status).toBe(401);
    const response = await f.request(route);
    expect(response.status).toBe(200);
    const text = JSON.stringify(await response.json());
    for (const secret of ["PRIVATE","/PRIVATE/NATIVE/PATH",owned.native.session_id,owned.native.prompt_id]) expect(text).not.toContain(secret);
  }
  const detail = await body(await f.request(`/background-work/runs/${owned.weave.id}`));
  const item = object(detail.item);
  expect(item.target).toEqual({type:"run",id:owned.weave.id});
  expect(object(item.owner).title).toBeNull();
  expect((await f.request("/background-work/runs/no-such-run")).status).toBe(404);
  expect((await f.request("/background-work/import-files/no-such-file")).status).toBe(404);
  expect(snapshot()).toEqual(before);
  expect(f.nativeCalls).toEqual(nativeBefore);
  expect(dataVersion()).toBe(versionBefore);
  } finally { observer.close(); }
}));

for (const scope of ["import-file","import-batch"] as const) test(`restored ${scope} excludes its holder and runless waiter only when fenced`, async () => mediaApiFixture(async f => {
  const owned = seed(f);
  const db = new Database(f.dbPath);
  try {
    const imports = new SqliteMarkdownImports(db,{id:(() => { let n=0; return () => `other-import-${++n}`; })(),now:() => stamp,logger});
    const batch = imports.createBatch("user","other-batch");
    const bytes = new TextEncoder().encode("PRIVATE OTHER IMPORT");
    const holder = imports.admitFile("user",batch.id,"other-holder","PRIVATE/other-holder.md",bytes);
    const waiter = imports.admitFile("user",batch.id,"other-waiter","PRIVATE/other-waiter.md",bytes);
    if (!holder.runId || waiter.runId !== null || waiter.state !== "waiting" || !owned.holder.runId) throw new Error("Expected independent holder and waiter");
    const fence = (kind: string, id: string) => db.run("INSERT INTO restore_fences VALUES (?,?,?,?,?)",[kind,id,"a".repeat(64),stamp,"{}"]);
    if (scope === "import-file") {
      fence("import-file",owned.holder.id);
      fence("import-file",owned.waiter.id);
    } else fence("import-batch",owned.holder.importId);
    const summary = await body(await f.request("/background-work/summary"));
    expect(object(summary.counts)["in-progress"]).toBe(6);
    const progress = await page(f,"?view=in-progress");
    const targets = progress.items.map(item => item.target);
    expect(targets).not.toContainEqual({type:"run",id:owned.holder.runId});
    expect(targets).not.toContainEqual({type:"import-file",id:owned.waiter.id});
    expect(targets).toContainEqual({type:"run",id:holder.runId});
    expect(targets).toContainEqual({type:"import-file",id:waiter.id});
    const response = await f.request(`/background-work/import-files/${owned.waiter.id}`);
    expect(response.status).toBe(200);
    expect(object((await body(response)).item).target).toEqual({type:"import-file",id:owned.waiter.id});
    expect(f.nativeCalls).toEqual({resolutions:0,clients:0});
  } finally { db.close(); }
}));

test("restore-fenced rowless search cleanup remains readable but is not active background work", async () => mediaApiFixture(async f => {
  const owned = seed(f);
  const db = new Database(f.dbPath);
  try { db.run("INSERT INTO restore_fences VALUES (?,?,?,?,?)",["run",owned.erasedRun.id,"a".repeat(64),stamp,"{}"]); }
  finally { db.close(); }
  const summary = await body(await f.request("/background-work/summary"));
  expect(object(summary.counts)["needs-attention"]).toBe(1);
  expect((await page(f)).items.map(item => item.target)).not.toContainEqual({type:"run",id:owned.erasedRun.id});
  const response = await f.request(`/background-work/runs/${owned.erasedRun.id}`);
  expect(response.status).toBe(200);
  expect(object((await body(response)).item).target).toEqual({type:"run",id:owned.erasedRun.id});
  expect(f.nativeCalls).toEqual({resolutions:0,clients:0});
}));

test("settled rowless search cleanup stays readable without appearing in active lists or counts", async () => mediaApiFixture(async f => {
  const owned = seed(f);
  const db = new Database(f.dbPath);
  try {
    // Model an isolated legacy settled row whose original proof predates the current trigger.
    // Restore the exact trigger immediately; this fixture does not certify native completion.
    const trigger = db.query<{sql:string},[]>("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='search_native_cleanup_proof'").get();
    if (!trigger) throw new Error("Expected cleanup proof trigger");
    db.transaction(() => {
      db.exec("DROP TRIGGER search_native_cleanup_proof");
      db.run("UPDATE search_native_cleanup SET drain_state='drained',admission_state='terminal',evidence_json='{}',state='settled' WHERE run_id=?", [owned.erasedRun.id]);
      db.exec(trigger.sql);
    }).immediate();
  } finally { db.close(); }
  const detail = await f.request(`/background-work/runs/${owned.erasedRun.id}`);
  expect(detail.status).toBe(200);
  expect(object((await body(detail)).item)).toMatchObject({target:{type:"run",id:owned.erasedRun.id},kind:"search",status:settledCleanupStatus});
  const summary = await body(await f.request("/background-work/summary"));
  expect(object(summary.counts)).toEqual({"needs-attention":1,"in-progress":6,"locally-closed":0});
  for (const view of ["needs-attention","in-progress","locally-closed"]) {
    expect((await page(f,`?view=${view}`)).items.map(item => item.target)).not.toContainEqual({type:"run",id:owned.erasedRun.id});
  }
  expect(f.nativeCalls).toEqual({resolutions:0,clients:0});
}));

for (const settled of [false,true]) test(`linked import-file detail remains addressable ${settled ? "after" : "before"} settlement without listing a duplicate`, async () => mediaApiFixture(async f => {
  const owned = seed(f);
  if (!owned.holder.runId) throw new Error("Expected owned linked import");
  if (settled) {
    const db = new Database(f.dbPath);
    try {
      const imports = new SqliteMarkdownImports(db,{id:() => "unused",now:() => stamp,logger});
      imports.fail(imports.claim(owned.holder.id),"parse-failed");
    } finally { db.close(); }
  }
  const detail = async () => {
    const response = await f.request(`/background-work/import-files/${owned.holder.id}`);
    expect(response.status).toBe(200);
    const data = await body(response);
    expect(JSON.stringify(data)).not.toContain("PRIVATE");
    return object(data.item);
  };
  const item = await detail();
  const run = object((await body(await f.request(`/background-work/runs/${owned.holder.runId}`))).item);
  expect(item).toMatchObject({target:{type:"import-file",id:owned.holder.id},kind:"import",status:settled ? "failed" : "queued",
    owner:{type:"import",id:owned.holder.importId,title:null}});
  expect(item.status).toBe(run.status);
  const listing = await page(f,settled ? "?view=needs-attention" : "?view=in-progress");
  expect(listing.items.map(item => item.target)).toContainEqual({type:"run",id:owned.holder.runId});
  expect(listing.items.map(item => item.target)).not.toContainEqual({type:"import-file",id:owned.holder.id});
  expect(f.nativeCalls).toEqual({resolutions:0,clients:0});
}));

for (const kind of ["weave","evolve"] as const) for (const status of ["failed","interrupted"] as const)
  test(`${kind} ${status} settled history requires real journal proof and pending cancellation takes precedence`, async () => mediaApiFixture(async f => {
    const owned = seed(f), id = kind === "weave" ? owned.weave.id : owned.evolve.id;
    const db = new Database(f.dbPath);
    try {
      // Controlled legacy state: the old settled bit exists but its dispatched step lacks native proof.
      db.run("UPDATE run_steps SET input=? WHERE run_id=? AND input IS NULL",["PRIVATE LEGACY INPUT",id]);
      db.run("UPDATE run_steps SET state='uncertain',native_state='unknown' WHERE run_id=?",[id]);
      db.run("UPDATE runs SET status=?,cancellation_state='settled' WHERE id=?",[status,id]);
      expect(recordedSubjectCancellationSafe(db,id)).toBe(false);
      db.run("UPDATE runs SET cancellation_state='pending' WHERE id=?",[id]);
      expect((await page(f)).items.find(item => item.target.id === id)?.reason).toBe("cancellation-pending");
      db.run("UPDATE runs SET cancellation_state='settled' WHERE id=?",[id]);
      // A separate never-authorized prepared journal is the shared proof's positive control.
      let sequence = 0;
      const sources = {id:() => `proof-${++sequence}`,now:() => stamp,logger};
      const admission = new RunAdmissionService({repository:new SqliteRunRepository(db,sources),...sources});
      const safe = kind === "weave" ? admission.admit("user","weave").run
        : admission.admit("user","evolve",{parentId:"visible",text:"owned safe contribution"}).run;
      db.run("UPDATE run_steps SET input=? WHERE run_id=?",["owned prepared input",safe.id]);
      db.run("UPDATE runs SET status=?,cancellation_state='settled' WHERE id=?",[status,safe.id]);
      expect(recordedSubjectCancellationSafe(db,safe.id)).toBe(true);
      const detail = await f.request(`/background-work/runs/${safe.id}`);
      expect(detail.status).toBe(200);
      const data = await body(detail);
      expect(object(data.item).reason).not.toBe("unverified");
      expect(JSON.stringify(data)).not.toContain("PRIVATE");
      expect(f.nativeCalls).toEqual({resolutions:0,clients:0});
      const attention = await page(f);
      expect(attention.items.find(item => item.target.id === id)).toMatchObject({kind,status,reason:"unverified"});
    } finally { db.close(); }
  }));

function nativeFacts(f: MediaApiFixture) {
  return f.read(db => ({
    cancellation:db.query("SELECT id,cancellation_state,weave_retired_at FROM runs ORDER BY id").all(),
    journals:["run_steps","agent_bindings","run_operation_receipts","run_issued_thoughts","run_replies",
      "search_native_cleanup","thoughts","thought_titles","responses","response_thoughts","response_seals"]
      .map(table => ({table,rows:db.query(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all()})),
  }));
}

test("local stop authority is never advertised by a read-only background repository", async () => mediaApiFixture(async f => {
  const owned = seed(f), db = new Database(f.dbPath,{readonly:true});
  try {
    const app = new Hono<{Variables:{actor:Actor}}>();
    app.use("*",async (c,next) => { c.set("actor","user"); await next(); });
    app.route("/",createBackgroundWorkRoutes(new SqliteBackgroundWork(db,logger)));
    const response = await app.request(workPath({type:"run",id:owned.evolve.id}));
    expect(response.status).toBe(200);
    expect(object(object((await body(response)).item).actions).stopLocalTracking).toBe(false);
  } finally { db.close(); }
}));

test("fresh local-stop detail supplies exact run, rowless Search and import reservation identities without native IDs", async () => mediaApiFixture(async f => {
  const owned = seed(f);
  for (const target of [
    {type:"run",id:owned.evolve.id},{type:"run",id:owned.erasedRun.id},
    {type:"import-file",id:owned.waiter.id},{type:"import-file",id:owned.holder.id},
  ] as const) {
    const identity = await localStopIdentity(f,target);
    const detail = object((await body(await f.request(workPath(target)))).item);
    expect(detail.localStop).toEqual({identity,eligible:true,reason:null});
    expect(object(detail.actions).stopLocalTracking).toBe(true);
    const serialized = JSON.stringify(detail);
    for (const secret of ["PRIVATE",owned.native.session_id,owned.native.prompt_id]) expect(serialized).not.toContain(secret);
  }
  expect(f.nativeCalls).toEqual({resolutions:0,clients:0});
}));

test("local stop records exact all-kind, linked-file, waiter and rowless receipts without changing native facts or saved output", async () => mediaApiFixture(async f => {
  const owned = seed(f), db = new Database(f.dbPath);
  try {
    new SqliteSharedResponses(db,logger).save({id:"retained-response",text:"PRIVATE SAVED OUTPUT",role:"fallback",
      state:"interrupted",thoughtIds:[owned.contribution.id]});
    db.run("INSERT INTO run_replies(run_id,response_id) VALUES (?,?)",[owned.evolve.id,"retained-response"]);
  } finally { db.close(); }
  const before = nativeFacts(f);
  const targets = [
    {type:"run",id:owned.weave.id},{type:"run",id:owned.evolve.id},{type:"run",id:owned.report.id},
    {type:"run",id:owned.search.id},{type:"import-file",id:owned.holder.id},
    {type:"import-file",id:owned.waiter.id},{type:"run",id:owned.erasedRun.id},
  ] as const;
  for (const [index,target] of targets.entries()) {
    const key = `close-${index}`, {identity,receipt} = await confirmedLocalStop(f,target,key);
    expect(await body(await f.request(localStopLookup(target,key)))).toEqual({receipt});
    const replay = await f.request(localStopPath(target),localStopCommand(key,identity));
    expect(replay.status).toBe(200);
    expect(await body(replay)).toEqual({receipt});
    const current = object((await body(await f.request(workPath(target)))).item);
    expect(object(current.actions).stopLocalTracking).toBe(false);
    expect(JSON.stringify(receipt)).not.toContain("PRIVATE");
  }
  expect(nativeFacts(f)).toEqual(before);
  expect(f.read(db => db.query("SELECT open_slot FROM search_turns WHERE run_id=?").get(owned.search.id))).toEqual({open_slot:0});
  expect(f.read(db => db.query("SELECT outcome,document_id FROM markdown_import_files WHERE id=?").get(owned.holder.id)))
    .toEqual({outcome:"interrupted",document_id:null});
  expect(f.read(db => db.query("SELECT outcome,run_id FROM markdown_import_files WHERE id=?").get(owned.waiter.id)))
    .toEqual({outcome:"interrupted",run_id:null});
  expect(await body(await f.request("/background-work/summary"))).toEqual({counts:{"needs-attention":0,"in-progress":1,"locally-closed":7}});
  const closed = await page(f,"?view=locally-closed");
  expect(closed.items.filter(item => item.kind === "import")).toHaveLength(2);
  expect(closed.items.filter(item => item.target.id === owned.holder.id || item.target.id === owned.holder.runId)).toHaveLength(1);
  expect(f.nativeCalls).toEqual({resolutions:0,clients:0});
}));

test("local stop validates user authority, acknowledgment, bounded header key and frozen identity before effects", async () => mediaApiFixture(async f => {
  const owned = seed(f), target = {type:"run",id:owned.evolve.id} as const;
  const identity = await localStopIdentity(f,target), url = localStopPath(target), before = nativeFacts(f);
  for (const actor of ["anonymous","ai"] as const) {
    expect((await f.request(url,localStopCommand("denied",identity),actor)).status).toBe(actor === "ai" ? 403 : 401);
    expect((await f.request(localStopLookup(target,"denied"),{},actor)).status).toBe(actor === "ai" ? 403 : 401);
  }
  for (const invalid of [
    {},{acknowledgeRemoteUncertainty:false,expected:identity},{acknowledgeRemoteUncertainty:true},
    {acknowledgeRemoteUncertainty:true,expected:identity,stoppedAt:stamp},
    {acknowledgeRemoteUncertainty:true,expected:{...identity,nativeSessionId:"PRIVATE"}},
  ]) {
    expect((await f.request(url,{method:"POST",headers:{"content-type":"application/json","Idempotency-Key":"invalid"},
      body:JSON.stringify(invalid)})).status).toBe(400);
  }
  for (const key of ["", "a".repeat(129), "bad key"]) {
    expect((await f.request(url,localStopCommand(key,identity))).status).toBe(400);
  }
  const noKey = localStopCommand("unused",identity);
  expect((await f.request(url,{...noKey,headers:{"content-type":"application/json"}})).status).toBe(400);
  expect((await f.request(url,localStopCommand("wrong-kind",{type:"run",id:target.id,kind:"export",generation:"0"}))).status).toBe(409);
  const writer = new Database(f.dbPath);
  try { writer.run("UPDATE runs SET generation=generation+1 WHERE id=?",[target.id]); } finally { writer.close(); }
  expect((await f.request(url,localStopCommand("stale",identity))).status).toBe(409);
  expect(nativeFacts(f)).toEqual(before);
  expect(await body(await f.request(localStopLookup(target,"stale")))).toEqual({receipt:null});
  const accepted = await confirmedLocalStop(f,target,"exact");
  expect((await f.request(url,localStopCommand("exact",identity))).status).toBe(409);
  expect((await f.request(url,localStopCommand("different-key",accepted.identity))).status).toBe(409);
  expect(await body(await f.request(localStopLookup(target,"exact")))).toEqual({receipt:accepted.receipt});
}));

test("null local-stop receipt is only read-time absence; later same-identity POST commits and lost ACK recovers without replay", async () => mediaApiFixture(async f => {
  const owned = seed(f), target = {type:"run",id:owned.weave.id} as const, key = "delayed-command";
  const expected = await localStopIdentity(f,target), before = nativeFacts(f);
  const observer = new Database(f.dbPath,{readonly:true});
  const version = () => observer.query<{data_version:number},[]>("PRAGMA data_version").get()?.data_version;
  try {
    const initial = version();
    for (let i=0;i<3;i++) {
      const lookup = await f.request(localStopLookup(target,key));
      expect(lookup.status).toBe(200);
      expect(await body(lookup)).toEqual({receipt:null});
    }
    expect(version()).toBe(initial);
    expect(nativeFacts(f)).toEqual(before);
    expect((await f.request(localStopLookup({type:"run",id:"missing"},"unknown"))).status).toBe(404);
    // The server later receives the original command. The client deliberately discards its acknowledgment.
    const lost = await f.request(localStopPath(target),localStopCommand(key,expected));
    expect(lost.status).toBe(201);
    await lost.body?.cancel();
    const committed = version();
    const recovered = object((await body(await f.request(localStopLookup(target,key)))).receipt);
    expect(recovered).toMatchObject({target,requestKey:key,identity:expected,state:"local-tracking-stopped",remoteState:"unknown"});
    for (let i=0;i<3;i++) expect(await body(await f.request(localStopLookup(target,key)))).toEqual({receipt:recovered});
    expect(version()).toBe(committed);
    expect(nativeFacts(f)).toEqual(before);
    expect(f.nativeCalls).toEqual({resolutions:0,clients:0});
  } finally { observer.close(); }
}));

test("local stop releases only its own weave blocker and ordinary Stop cannot restart cleanup or create replacement work", async () => mediaApiFixture(async f => {
  const owned = seed(f), db = new Database(f.dbPath);
  let first = "", second = "";
  try {
    let n=0;
    const ops = new SqliteRunOperations(db,{id:() => `blocker-${++n}`,now:() => stamp,logger});
    first = ops.admitWeave("user",{subjectId:"visible",triggerId:"first-blocker"}).id;
    second = ops.admitWeave("user",{subjectId:"visible",triggerId:"second-blocker"}).id;
    for (const id of [first,second]) {
      db.run("UPDATE run_steps SET input=?,state='uncertain' WHERE run_id=?",["PRIVATE UNCERTAIN INPUT",id]);
      db.run("UPDATE runs SET status='interrupted',cancellation_state='pending' WHERE id=?",[id]);
    }
  } finally { db.close(); }
  const count = () => f.read(db => db.query("SELECT count(*) AS n FROM runs").get());
  const beforeCount = count(), before = nativeFacts(f);
  const admission = () => f.request("/thoughts/visible/reinterpret",{method:"POST",headers:{"content-type":"application/json","Idempotency-Key":"fresh-after-close"},body:"{}"});
  expect((await admission()).status).toBe(409);
  await confirmedLocalStop(f,{type:"run",id:first},"close-first");
  expect((await admission()).status).toBe(409);
  await confirmedLocalStop(f,{type:"run",id:second},"close-second");
  expect(count()).toEqual(beforeCount);
  for (const id of [first,second]) expect((await f.request(`/runs/${id}/stop`,{method:"POST",headers:{"content-type":"application/json"},body:"{}"})).status).toBe(200);
  expect(nativeFacts(f)).toEqual(before);
  expect(count()).toEqual(beforeCount);
  expect((await admission()).status).toBe(202);
  expect(f.read(db => db.query("SELECT status FROM runs WHERE id=?").get(owned.discovery.id))).toEqual({status:"queued"});
  expect(f.nativeCalls).toEqual({resolutions:0,clients:0});
}));

test("a waiter confirmation cannot retarget a file that has since acquired a different run reservation", async () => mediaApiFixture(async f => {
  const owned = seed(f), target = {type:"import-file",id:owned.waiter.id} as const;
  const expected = await localStopIdentity(f,target), db = new Database(f.dbPath);
  try {
    let n=0;
    const imports = new SqliteMarkdownImports(db,{id:() => `promoted-${++n}`,now:() => stamp,logger});
    imports.fail(imports.claim(owned.holder.id),"parse-failed");
    expect(imports.resolveWaiters()).toBe(1);
    expect(imports.file("user",owned.waiter.importId,owned.waiter.id)?.runId).not.toBeNull();
  } finally { db.close(); }
  const before = f.read(db => db.query("SELECT * FROM markdown_import_files WHERE id=?").get(owned.waiter.id));
  expect((await f.request(localStopPath(target),localStopCommand("stale-waiter",expected))).status).toBe(409);
  expect(f.read(db => db.query("SELECT * FROM markdown_import_files WHERE id=?").get(owned.waiter.id))).toEqual(before);
  expect(await body(await f.request(localStopLookup(target,"stale-waiter")))).toEqual({receipt:null});
}));

test("local-stop receipts survive explicit Search/export owner deletion without resurrecting cleanup", async () => mediaApiFixture(async f => {
  const owned = seed(f);
  const targets = [{type:"run",id:owned.search.id},{type:"run",id:owned.report.id}] as const;
  for (const [index,target] of targets.entries()) {
    const {receipt} = await confirmedLocalStop(f,target,`delete-owner-${index}`);
    const ownerId = f.read(db => db.query<{session_id:string},[string]>("SELECT session_id FROM search_turns WHERE run_id=?").get(target.id)?.session_id);
    const response = await f.request(index === 0 ? `/search-sessions/${ownerId}` : `/exports/agentic/${target.id}`,{method:"DELETE"});
    expect(response.status).toBe(204);
    expect(f.read(db => db.query("SELECT id FROM runs WHERE id=?").get(target.id))).toBeNull();
    expect(await body(await f.request(localStopLookup(target,`delete-owner-${index}`)))).toEqual({receipt});
  }
  expect(f.nativeCalls).toEqual({resolutions:0,clients:0});
}));

test("all-kind local stops remain fenced after configured restart, including rowless cleanup and waiter promotion", async () => mediaApiFixture(async f => {
  const owned = seed(f);
  const targets = [
    {type:"run",id:owned.weave.id},{type:"run",id:owned.evolve.id},{type:"run",id:owned.discovery.id},
    {type:"run",id:owned.report.id},{type:"run",id:owned.search.id},{type:"run",id:owned.erasedRun.id},
    {type:"import-file",id:owned.holder.id},{type:"import-file",id:owned.waiter.id},
  ] as const;
  const receipts = [];
  for (const [index,target] of targets.entries()) receipts.push(await confirmedLocalStop(f,target,`restart-${index}`));
  await f.stop();
  const writer = new Database(f.dbPath);
  try {
    writer.run("UPDATE thought_titles SET title='Owned test title',title_author='user' WHERE title IS NULL");
    sealDailyReview(writer,stamp);
  } finally { writer.close(); }
  const before = nativeFacts(f);
  await f.start({THOUGHTLOOM_AGENT_CONFIG:JSON.stringify(f.agent)});
  const completedPolls = () => f.logs.filter(log => log.message === "[supervisor] poll succeeded").length;
  const baseline = completedPolls();
  await f.until(() => completedPolls() >= baseline+3,"three real supervisor scans after local stops");
  expect(f.nativeCalls).toEqual({resolutions:0,clients:0});
  expect(nativeFacts(f)).toEqual(before);
  for (const [index,target] of targets.entries()) expect(await body(await f.request(localStopLookup(target,`restart-${index}`)))).toEqual({receipt:receipts[index]?.receipt});
  expect(f.read(db => db.query("SELECT run_id,outcome FROM markdown_import_files WHERE id=?").get(owned.waiter.id)))
    .toEqual({run_id:null,outcome:"interrupted"});
}, {now:() => stamp}));

test("next logical capture and staged recovery preserve append-only local-stop fences including rowless identities", async () => mediaApiFixture(async f => {
  const owned = seed(f), target = {type:"run",id:owned.erasedRun.id} as const;
  const {receipt} = await confirmedLocalStop(f,target,"backup-rowless");
  await confirmedLocalStop(f,{type:"run",id:owned.weave.id},"backup-weave");
  const before = f.read(db => db.query("SELECT * FROM local_work_stops ORDER BY target_kind,target_id").all());
  expect(before).toHaveLength(2);
  const source = new Database(f.dbPath);
  try {
    expect(source.query("PRAGMA foreign_key_list(local_work_stops)").all()).not.toContainEqual(expect.objectContaining({table:"runs"}));
    expect(() => source.run("UPDATE local_work_stops SET stopped_at=?",[stamp])).toThrow();
    expect(() => source.run("DELETE FROM local_work_stops")).toThrow();
  } finally { source.close(); }
  const output = join(f.directory,"stop-backup"), staging = join(f.directory,"stop-stage");
  await mkdir(output,{mode:0o700}); await mkdir(staging,{mode:0o700});
  const captured = await captureBackup({databasePath:f.dbPath,mediaDirectory:f.mediaDirectory,outputDirectory:output,logger});
  const manifest = decodeManifest(await readFile(join(captured.snapshotDirectory,"manifest.json")));
  expect(String(manifest.appSchema)).toBe("thoughtloom-logical-9");
  expect(manifest.tables.find(table => table.name === "local_work_stops")?.rowCount).toBe("2");
  for (const schema of ["thoughtloom-logical-1","thoughtloom-logical-2","thoughtloom-logical-3","thoughtloom-logical-4",
    "thoughtloom-logical-5","thoughtloom-logical-6","thoughtloom-logical-7","thoughtloom-logical-8"] as const) {
    expect(shapesForSchema(schema).some(table => table.name === "local_work_stops")).toBe(false);
  }
  const stage = await stageRestoreSnapshot({snapshotDirectory:captured.snapshotDirectory,stagingParentDirectory:staging,logger});
  try {
    const verify = () => {
      const db = new Database(stage.databasePath,{readonly:true});
      try {
        expect(db.query("SELECT * FROM local_work_stops ORDER BY target_kind,target_id").all()).toEqual(before);
        expect(db.query("SELECT id FROM runs WHERE id=?").get(target.id)).toBeNull();
        expect(db.query("SELECT state FROM search_native_cleanup WHERE run_id=?").get(target.id)).toEqual({state:"pending"});
        expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally { db.close(); }
    };
    verify();
    await recoverRestoreStage(stage,{restoredAt:"2032-01-02T03:04:05.000Z",logger});
    verify();
    expect(await body(await f.request(localStopLookup(target,"backup-rowless")))).toEqual({receipt});
  } finally { await stage.dispose(); }
}, {now:() => stamp}), 20000);

test("hash-consistent malformed local-stop records cannot stage or publish", async () => mediaApiFixture(async f => {
  const owned = seed(f);
  await confirmedLocalStop(f,{type:"run",id:owned.weave.id},"owned-stop-key");
  const output = join(f.directory,"invalid-stop-capture"), parent = join(f.directory,"invalid-stop-stage");
  await mkdir(output,{mode:0o700}); await mkdir(parent,{mode:0o700});
  const captured = await captureBackup({databasePath:f.dbPath,mediaDirectory:f.mediaDirectory,outputDirectory:output,logger});
  const original = decodeManifest(await readFile(join(captured.snapshotDirectory,"manifest.json")));
  const schema = original.appSchema ?? "thoughtloom-logical-1";
  const shape = shapesForSchema(schema).find(item => item.name === "local_work_stops");
  if (!shape) throw new Error("Expected local-stop capture inventory");
  const originalRows = decodeTable(shape.name,await readFile(join(captured.snapshotDirectory,"tables",`${shape.name}.json`)),schema);
  if (originalRows.length !== 1 || !originalRows[0]) throw new Error("Expected one owned local-stop row");
  const text = (value:string):RawCell => ({storage:"text",bytes:new TextEncoder().encode(value)});
  const identityCell = originalRows[0].values.identity_json;
  if (identityCell?.storage !== "text") throw new Error("Expected owned identity text");
  const identity = JSON.parse(new TextDecoder().decode(identityCell.bytes)) as Record<string,unknown>;
  const scenarios = ["target-mismatch","invalid-key","invalid-stopped-at","generation-overflow","extra-identity-field","conflicting-run-owner"] as const;
  for (const scenario of scenarios) {
    const copy = join(f.directory,`invalid-stop-${scenario}`);
    await cp(captured.snapshotDirectory,copy,{recursive:true,errorOnExist:true});
    const base = originalRows[0];
    let rows: RawRow[] = [{...base,values:{...base.values}}];
    const row = rows[0];
    if (!row) throw new Error("Expected local-stop mutation row");
    if (scenario === "target-mismatch") rows = [{...row,values:{...row.values,identity_json:text(protocolJson({...identity,id:"wrong-target"}))}}];
    if (scenario === "invalid-key") rows = [{...row,values:{...row.values,request_key:text("invalid key with spaces")}}];
    if (scenario === "invalid-stopped-at") rows = [{...row,values:{...row.values,stopped_at:text("not-a-date")}}];
    if (scenario === "generation-overflow") rows = [{...row,values:{...row.values,identity_json:text(protocolJson({...identity,generation:"9223372036854775808"}))}}];
    if (scenario === "extra-identity-field") rows = [{...row,values:{...row.values,identity_json:text(protocolJson({...identity,acknowledged:true}))}}];
    if (scenario === "conflicting-run-owner") {
      const fileIdentity = {type:"import-file",id:owned.holder.id,importId:owned.holder.importId,runId:owned.weave.id,
        generation:"1",waitingOnFileId:null,outcome:null};
      rows.push({...row,values:{...row.values,target_kind:text("import-file"),target_id:text(owned.holder.id),
        import_file_id:text(owned.holder.id),identity_json:text(protocolJson(fileIdentity))}});
    }
    const bytes = encodeTable(shape,rows), tablePath = join(copy,"tables",`${shape.name}.json`);
    await writeFile(tablePath,bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const manifest = {...original,tables:original.tables.map(entry => entry.name === shape.name
      ? {...entry,rowCount:String(rows.length),byteLength:String(bytes.length),sha256} : entry)};
    const manifestBytes = encodeManifest(manifest);
    await writeFile(join(copy,"manifest.json"),manifestBytes);
    const before = await readdir(parent);
    const expectedManifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
    const result = await stageRestoreSnapshot({snapshotDirectory:copy,stagingParentDirectory:parent,expectedManifestSha256,logger})
      .then(stage => ({stage,error:null}), (error:unknown) => ({stage:null,error}));
    if (result.stage) await result.stage.dispose();
    expect(result.error).toMatchObject({code:"invalid-records"});
    expect(await readdir(parent)).toEqual(before);
  }
}, {now:() => stamp}), 30000);

test("logical-8 projected restore does not infer local-stop receipts from interrupted or retired work", async () => mediaApiFixture(async f => {
  const owned = seed(f);
  const db = new Database(f.dbPath);
  try { db.run("UPDATE runs SET status='interrupted',cancellation_state='pending',weave_retired_at=? WHERE id=?",[stamp,owned.weave.id]); }
  finally { db.close(); }
  const before = f.read(source => source.query("SELECT status,cancellation_state,weave_retired_at FROM runs WHERE id=?").get(owned.weave.id));
  const output = join(f.directory,"logical8-source"), legacy = join(f.directory,"logical8-frozen");
  await mkdir(output,{mode:0o700});
  const captured = await captureBackup({databasePath:f.dbPath,mediaDirectory:f.mediaDirectory,outputDirectory:output,logger});
  await cp(captured.snapshotDirectory,legacy,{recursive:true,errorOnExist:true});
  const original = decodeManifest(await readFile(join(legacy,"manifest.json")));
  const schema = original.appSchema ?? "thoughtloom-logical-1";
  const tables = [];
  for (const shape of shapesForSchema("thoughtloom-logical-8")) {
    const path = `tables/${shape.name}.json`;
    const current = decodeTable(shape.name,await readFile(join(legacy,path)),schema);
    const rows: RawRow[] = current.map(row => ({rowid:row.rowid,values:Object.fromEntries(shape.columns.map(name => [name,row.values[name]]))}));
    const bytes = encodeTable(shape,rows);
    await writeFile(join(legacy,path),bytes);
    tables.push({name:shape.name,path,rowCount:String(rows.length),byteLength:String(bytes.length),sha256:createHash("sha256").update(bytes).digest("hex")});
  }
  await rm(join(legacy,"tables","local_work_stops.json"));
  await writeFile(join(legacy,"manifest.json"),encodeManifest({...original,appSchema:"thoughtloom-logical-8",tables}));
  const restored = await restoreBackup({snapshotDirectory:legacy,targetDirectory:join(f.directory,"logical8-target"),
    restoredAt:"2032-01-02T03:04:05.000Z",logger});
  const target = new Database(restored.databasePath,{readonly:true});
  try {
    expect(target.query("SELECT * FROM local_work_stops").all()).toEqual([]);
    expect(target.query("SELECT status,cancellation_state,weave_retired_at FROM runs WHERE id=?").get(owned.weave.id)).toEqual(before);
    expect(target.query("SELECT state FROM search_native_cleanup WHERE run_id=?").get(owned.erasedRun.id)).toEqual({state:"pending"});
  } finally { target.close(); }
}, {now:() => stamp}), 30000);

for (const boundary of ["search-ack","search-cleanup","import-driver"] as const)
  test(`local stop joins actual ${boundary} flight and forbids the remaining native/publication tail`, async () => mediaApiFixture(async f => {
    const release = Promise.withResolvers<void>();
    let entered = false, stopRequest: Promise<Response> | undefined;
    const hold = async () => { entered=true; await release.promise; };
    let sequence=0, runId="", fileId="";
    const sources = {id:() => `held-${boundary}-${++sequence}`,now:() => stamp,logger};
    const writer = new Database(f.dbPath);
    try {
      if (boundary === "import-driver") {
        const imports = new SqliteMarkdownImports(writer,sources), batch = imports.createBatch("user","held-import");
        const file = imports.admitFile("user",batch.id,"held-file","PRIVATE/held.md",new TextEncoder().encode("PRIVATE import body"));
        if (!file.runId) throw new Error("Expected held import owner");
        runId=file.runId; fileId=file.id;
      } else {
        const sessions = new SqliteStore(writer).searchSessions(sources), session = sessions.create("user","held-search",{}).session;
        const composer = sessions.openComposer("user",session.id);
        runId=sessions.admitTurn("user",session.id,"held-turn",{text:"PRIVATE held search",startingThoughtIds:[],
          requestClock:{at:stamp,timeZone:"UTC"},composerId:composer.composerId,contextToken:composer.contextToken}).run.id;
      }
    } finally { writer.close(); }
    const target = boundary === "import-driver" ? {type:"import-file",id:fileId} as const : {type:"run",id:runId} as const;
    try {
      if (boundary !== "search-cleanup") f.client.beforePrompt=hold;
      if (boundary === "search-cleanup") {
        await f.until(() => f.client.prompts.length === 1,"Search prompt acknowledged");
        f.client.beforeHistory=hold;
        f.client.historyMode="empty";
        expect((await f.request(`/runs/${runId}/stop`,{method:"POST",headers:{"content-type":"application/json"},body:"{}"})).status).toBe(200);
      }
      await f.until(() => entered,`${boundary} native call entered`);
      if (boundary === "search-ack") {
        expect((await f.request(`/runs/${runId}/stop`,{method:"POST",headers:{"content-type":"application/json"},body:"{}"})).status).toBe(200);
        const db = new Database(f.dbPath);
        try { expect(new SqliteSearchCleanup(db).prepare(runId)).not.toBeNull(); } finally { db.close(); }
      }
      const before = f.read(db => ({
        cancellation:db.query("SELECT cancellation_state FROM runs WHERE id=?").get(runId),
        steps:db.query("SELECT * FROM run_steps WHERE run_id=? ORDER BY position").all(runId),
        bindings:db.query("SELECT * FROM agent_bindings WHERE run_id=?").get(runId),
        messages:db.query("SELECT * FROM search_messages WHERE run_id=? ORDER BY position").all(runId),
        documents:db.query("SELECT * FROM import_documents ORDER BY sequence").all(),
        cleanup:db.query("SELECT binding_json,prompt_manifest_json,state FROM search_native_cleanup WHERE run_id=?").get(runId),
      }));
      const held = await heldLocalStop(f,target,`joined-${boundary}`);
      stopRequest=held.pending;
      expect(held.returned()).toBe(false);
      release.resolve();
      const response = await stopRequest;
      expect(response.status).toBe(201);
      expect(object((await body(response)).receipt)).toMatchObject({target,state:"local-tracking-stopped",remoteState:"unknown"});
      expect(f.read(db => ({
        cancellation:db.query("SELECT cancellation_state FROM runs WHERE id=?").get(runId),
        steps:db.query("SELECT * FROM run_steps WHERE run_id=? ORDER BY position").all(runId),
        bindings:db.query("SELECT * FROM agent_bindings WHERE run_id=?").get(runId),
        messages:db.query("SELECT * FROM search_messages WHERE run_id=? ORDER BY position").all(runId),
        documents:db.query("SELECT * FROM import_documents ORDER BY sequence").all(),
        cleanup:db.query("SELECT binding_json,prompt_manifest_json,state FROM search_native_cleanup WHERE run_id=?").get(runId),
      }))).toEqual(before);
      const reads = f.client.historyRequests.length, prompts = f.client.prompts.length;
      const completed = () => f.logs.filter(record => record.message === "[import driver] local poll succeeded").length;
      const baseline = completed();
      await f.until(() => completed() >= baseline+3,"three real post-close driver scans");
      expect(f.client.historyRequests).toHaveLength(reads);
      expect(f.client.prompts).toHaveLength(prompts);
      expect(f.client.interrupts).toEqual([]);
      expect(f.client.inboxCancellations).toEqual([]);
      expect(f.read(db => db.query("SELECT count(*) AS n FROM search_messages WHERE run_id=? AND role='assistant'").get(runId))).toEqual({n:0});
      expect(f.read(db => db.query("SELECT count(*) AS n FROM import_documents").get())).toEqual({n:0});
      expect(JSON.stringify(f.logs)).not.toContain("PRIVATE");
    } finally {
      release.resolve(); f.client.beforePrompt=undefined; f.client.beforeHistory=undefined;
      if (stopRequest) await stopRequest;
    }
  }, {configured:true,now:() => stamp,script:(_index,input) => {
    const job = object(JSON.parse(input));
    return job.kind === "import-job" ? {version:1,kind:"segmentation",cuts:["b0","b1"]}
      : {version:1,kind:"search-reply",reply:"PRIVATE late Search output",disposition:"done",sourceThoughtIds:[]};
  }}), 20000);
