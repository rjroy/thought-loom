import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { startDaemon, type DaemonEvent, type RunningDaemon } from "../src/daemon/runtime";
import type { LogRecord } from "../src/logging";
import { migrate } from "../src/storage/sqlite";

const path = "/settings/agent-instructions";
const credentials = { user: "settings-user-0123456789-0123456789", ai: "settings-agent-0123456789-0123456789" };
const empty = { weaver: "", evolve: "", search: "", export: "", revision: 0 };
type Settings = typeof empty;

async function fixture(action: (f: {
  dbPath: string;
  request: (init?: RequestInit, actor?: "user" | "ai" | "none") => Promise<Response>;
  restart: () => Promise<void>;
  events: DaemonEvent[];
  logs: LogRecord[];
}) => Promise<void>, legacy = false): Promise<void> {
  const dir = await mkdtemp(join("/tmp/opencode", "agent-instructions-"));
  const dbPath = join(dir, "knowledge.sqlite"), events: DaemonEvent[] = [], logs: LogRecord[] = [];
  let daemon: RunningDaemon | undefined;
  try {
    if (legacy) {
      const db = new Database(dbPath);
      try {
        db.exec(readFileSync(new URL("./fixtures/pre-media-schema.sql", import.meta.url), "utf8"));
        db.exec(`INSERT INTO thoughts(id,text,author,kind,created_at,origin,parent_id,import_document_id)
          VALUES ('legacy-settings-thought','unchanged legacy wording','user','captured-original','2030','fixture',NULL,NULL);
          INSERT INTO thought_titles VALUES ('legacy-settings-thought','existing title','user');
          INSERT INTO thought_source_seals VALUES ('legacy-settings-thought');`);
      } finally { db.close(); }
    }
    const start = async () => startDaemon({dbPath,port:0,credentials,logLevel:"verbose"}, event => events.push(event),
      {logSink: record => logs.push(record)});
    daemon = await start();
    await action({dbPath,events,logs,
      request: async (init = {}, actor = "user") => {
        if (!daemon) throw new Error("Owned daemon is stopped");
        const headers = new Headers(init.headers);
        if (actor !== "none") headers.set("authorization", `Bearer ${credentials[actor]}`);
        return fetch(new URL(path,daemon.url), {...init,headers,signal:AbortSignal.timeout(5000)});
      },
      restart: async () => { await daemon?.stop(); daemon = undefined; daemon = await start(); },
    });
  } finally {
    try { await daemon?.stop(); } finally { await rm(dir,{recursive:true,force:true}); }
  }
}

const put = (value: unknown): RequestInit => ({method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify(value)});
function privateResponse(response: Response): void {
  const cache = response.headers.get("cache-control") ?? "";
  expect(cache).toContain("private");
  expect(cache).toContain("no-store");
}
async function readSettings(request: (init?: RequestInit) => Promise<Response>): Promise<Settings> {
  const response = await request();
  expect(response.status).toBe(200);
  privateResponse(response);
  return await response.json() as Settings;
}

test("default, atomic save, exact text, clearing, repeated migration and daemon restart", async () => fixture(async f => {
  expect(await readSettings(f.request)).toEqual(empty);
  const input = {weaver:"\uFEFF  weave café\r\n",evolve:" \t\n",search:"  search 漢字  ",export:"PRIVATE-GUIDANCE-SENTINEL\n",revision:0};
  const saved = await f.request(put(input));
  expect(saved.status).toBe(200); privateResponse(saved);
  const first = await saved.json() as Settings;
  expect(first).toEqual({...input,revision:1});
  expect(await readSettings(f.request)).toEqual(first);
  await f.restart();
  expect(await readSettings(f.request)).toEqual(first);
  const db = new Database(f.dbPath);
  try { migrate(db); migrate(db); } finally { db.close(); }
  expect(await readSettings(f.request)).toEqual(first);
  const cleared = await f.request(put({...empty,revision:first.revision}));
  expect(cleared.status).toBe(200); privateResponse(cleared);
  expect(await cleared.json()).toEqual({...empty,revision:2});
  await f.restart();
  expect(await readSettings(f.request)).toEqual({...empty,revision:2});
  expect(JSON.stringify({events:f.events,logs:f.logs})).not.toContain("PRIVATE-GUIDANCE-SENTINEL");
}));

test("user-only settings reject unauthorized reads and writes without changing state", async () => fixture(async f => {
  for (const actor of ["ai", "none"] as const) {
    for (const init of [{},put({...empty,weaver:"unauthorized"})]) {
      const response = await f.request(init,actor);
      expect(response.status).toBe(actor === "ai" ? 403 : 401);
      privateResponse(response);
    }
  }
  expect(await readSettings(f.request)).toEqual(empty);
}));

test("two concurrent full saves from one revision produce one winner without mixed fields", async () => fixture(async f => {
  const original = await readSettings(f.request);
  const a = {...original,weaver:"a-weaver",evolve:"a-evolve",search:"a-search",export:"a-export"};
  const b = {...original,weaver:"b-weaver",evolve:"b-evolve",search:"b-search",export:"b-export"};
  const responses = await Promise.all([f.request(put(a)),f.request(put(b))]);
  expect(responses.map(response => response.status).sort()).toEqual([200,409]);
  for (const response of responses) privateResponse(response);
  const winner = responses[0].status === 200 ? a : b;
  expect(await readSettings(f.request)).toEqual({...winner,revision:1});
  expect((await f.request(put({...original,weaver:"late-stale"}))).status).toBe(409);
  expect(await readSettings(f.request)).toEqual({...winner,revision:1});
}));

test("closed JSON input and UTF-8 field limits reject invalid saves without partial updates", async () => fixture(async f => {
  const limit = 16 * 1024;
  const max = {...empty,weaver:"é".repeat(limit/2),evolve:"x".repeat(limit),search:"",export:""};
  const accepted = await f.request(put(max));
  expect(accepted.status).toBe(200);
  const baseline = await accepted.json() as Settings;
  expect(baseline).toEqual({...max,revision:1});
  const invalid: unknown[] = [null,[],{}, {...baseline,weaver:undefined}, {...baseline,extra:"no"},
    {...baseline,evolve:null}, {...baseline,revision:-1}, {...baseline,revision:1.5},
    {...baseline,weaver:"é".repeat(limit/2)+"x"}, {...baseline,search:"x".repeat(limit+1)}];
  for (const value of invalid) {
    const response = await f.request(put(value));
    expect(response.status).toBe(400); privateResponse(response);
    expect(await readSettings(f.request)).toEqual(baseline);
  }
  const malformed = await f.request({method:"PUT",headers:{"content-type":"application/json"},body:"{"});
  expect(malformed.status).toBe(400); privateResponse(malformed);
  const wrongType = await f.request({method:"PUT",headers:{"content-type":"text/plain"},body:JSON.stringify(baseline)});
  expect(wrongType.status).toBe(415); privateResponse(wrongType);
  expect(await readSettings(f.request)).toEqual(baseline);
}));

test("oversized streamed JSON is bounded and leaves settings unchanged", async () => fixture(async f => {
  const chunk = new TextEncoder().encode("x".repeat(64 * 1024));
  const stream = new ReadableStream<Uint8Array>({start(controller) {
    for (let i = 0; i < 16; i++) controller.enqueue(chunk);
    controller.close();
  }});
  const response = await f.request({method:"PUT",headers:{"content-type":"application/json"},body:stream,duplex:"half"} as RequestInit);
  expect(response.status).toBe(413); privateResponse(response);
  expect(await readSettings(f.request)).toEqual(empty);
}));

test("legacy database migrates with empty settings and preserves existing records", async () => fixture(async f => {
  expect(await readSettings(f.request)).toEqual(empty);
  const saved = await f.request(put({...empty,search:"legacy migration guidance"}));
  expect(saved.status).toBe(200);
  await f.restart();
  expect(await readSettings(f.request)).toEqual({...empty,search:"legacy migration guidance",revision:1});
  const db = new Database(f.dbPath,{readonly:true,create:false});
  try {
    expect(db.query("SELECT text,author,kind FROM thoughts WHERE id='legacy-settings-thought'").get())
      .toEqual({text:"unchanged legacy wording",author:"user",kind:"captured-original"});
    expect(db.query("SELECT title,title_author FROM thought_titles WHERE thought_id='legacy-settings-thought'").get())
      .toEqual({title:"existing title",title_author:"user"});
  } finally { db.close(); }
},true));
