import { expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { parseConfig } from "../../src/daemon/config";
import { startDaemon, type DaemonEvent, type RunningDaemon, type RuntimeDependencies } from "../../src/daemon/runtime";
import { createThought, type MediaThought } from "../../src/domain/thought";
import type { LogRecord } from "../../src/logging";
import { ScriptedClient } from "../agentic-search-capability-fixture";

export const mediaApiMaxBytes = 4096;
export const mediaApiCredentials = {user:"owned-media-user-0123456789-abcdef012345",ai:"owned-media-agent-0123456789-abcdef01234"};
export const mediaClarification = "  Compare the red and blue regions.\r\nKeep this exact user clarification.  ";

export function object(value: unknown): Record<string,unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an HTTP object");
  return Object.fromEntries(Object.entries(value));
}
export function text(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new Error("Expected a nonempty HTTP string");
  return value;
}
export async function body(response: Response): Promise<Record<string,unknown>> {
  const value: unknown = await response.json();
  return object(value);
}
export async function receipt(response: Response, status = 202): Promise<{
  readonly thought: MediaThought; readonly run: Record<string,unknown>; readonly runId: string;
}> {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toContain("no-store");
  const data = await body(response), thought = createThought(data.thought), run = object(data.run);
  if (thought.kind !== "media-original") throw new Error("Expected a retained media root");
  expect(Object.keys(data).sort()).toEqual(["run","thought"]);
  expect(data.thought).toEqual(thought);
  expect(run.kind).toBe("weave");
  expect(Object.keys(run).sort()).toEqual(["id","kind","status","confirmedThoughtIds","responseId"].sort());
  return {thought,run,runId:text(run.id)};
}
export function upload(bytes: Uint8Array, key: string, options: {
  readonly name?: string; readonly mime?: string; readonly metadata?: string | object;
} = {}): RequestInit {
  const form = new FormData(), ownedBytes = new Uint8Array(bytes.length);
  ownedBytes.set(bytes);
  form.append("metadata",typeof options.metadata === "string" ? options.metadata : JSON.stringify(options.metadata ?? {}));
  form.append("file",new Blob([ownedBytes.buffer],{type:options.mime ?? "image/png"}),options.name ?? "owned-image.png");
  return {method:"POST",headers:{"Idempotency-Key":key},body:form};
}
export function retry(key: string): RequestInit {
  return {method:"POST",headers:{"content-type":"application/json","Idempotency-Key":key},body:"{}"};
}
export async function bounded<T>(promise: Promise<T>, label: string, ms = 5000): Promise<T> {
  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(() => timeout.reject(new Error(`${label} timed out`)),ms);
  try { return await Promise.race([promise,timeout.promise]); }
  finally { clearTimeout(timer); }
}
/** Inspect only the private context already produced by the normal worker. */
export function originalPath(input: string, thoughtId: string): string {
  const parsed: unknown = JSON.parse(input), originals = object(parsed).originals;
  if (!Array.isArray(originals)) throw new Error("Expected managed original paths in the normal prompt");
  const item = originals.map(object).find(value => value.thoughtId === thoughtId);
  if (!item) throw new Error("Expected this source's original path");
  return text(item.path);
}

interface Options {
  readonly configured?: boolean;
  readonly derivedDirectory?: boolean;
  readonly script?: (index: number, input: string) => object;
  readonly now?: () => string;
}
async function setup(options: Options) {
  const directory = await mkdtemp(join("/tmp/opencode","media-http-")), dbPath = join(directory,"owned.sqlite");
  const agent = {service:{url:"http://127.0.0.1:44991"},directory,model:{providerID:"fixture",id:"shared-file-model"},
    effort:{quick:null,standard:null,thorough:null}};
  const environment: Readonly<Record<string,string | undefined>> = {
    THOUGHTLOOM_PORT:"0",THOUGHTLOOM_DB_PATH:dbPath,THOUGHTLOOM_USER_TOKEN:mediaApiCredentials.user,THOUGHTLOOM_AI_TOKEN:mediaApiCredentials.ai,
    THOUGHTLOOM_MEDIA_DIR:options.derivedDirectory ? undefined : join(directory,"media"),
    THOUGHTLOOM_MEDIA_MAX_BYTES:String(mediaApiMaxBytes),THOUGHTLOOM_LOG_LEVEL:"verbose",
    THOUGHTLOOM_AGENT_CONFIG:options.configured ? JSON.stringify(agent) : undefined,
  };
  const client = new ScriptedClient(options.script ?? (() => { throw new Error("Unexpected native execution in a configless fixture"); }));
  const logs: LogRecord[] = [], events: DaemonEvent[] = [];
  let daemon: RunningDaemon | undefined, poll: (() => void) | undefined, resolutions = 0, clients = 0;
  let activeDbPath = dbPath, mediaDirectory = environment.THOUGHTLOOM_MEDIA_DIR ?? `${dbPath}.media`;
  const dependencies: RuntimeDependencies = {
    ...(options.now ? {now:options.now} : {}),
    logSink:record => logs.push(record),
    resolveAgentService:async () => { resolutions++; return {url:"http://127.0.0.1:44991"}; },
    createPublicClient:() => { clients++; return client; },
    startTimer:callback => { poll = callback; return () => { if (poll === callback) poll = undefined; }; },
  };
  async function start(overrides: Readonly<Record<string,string | undefined>> = {}): Promise<void> {
    if (daemon) throw new Error("Fixture daemon is already running");
    const env = {...environment,...overrides}, config = parseConfig(env);
    daemon = await bounded(startDaemon(config,event => events.push(event),dependencies),"owned media daemon startup");
    activeDbPath = config.dbPath;
    mediaDirectory = env.THOUGHTLOOM_MEDIA_DIR ?? `${config.dbPath}.media`;
  }
  async function stop(): Promise<void> {
    const running = daemon;
    if (!running) return;
    await bounded(running.stop(),"owned media daemon shutdown");
    if (daemon === running) daemon = undefined;
  }
  function running(): RunningDaemon {
    if (!daemon) throw new Error("Fixture daemon is not running");
    return daemon;
  }
  async function request(path: string, init: RequestInit = {}, actor: "user" | "ai" | "anonymous" = "user"): Promise<Response> {
    const headers = new Headers(init.headers);
    if (actor !== "anonymous") headers.set("authorization",`Bearer ${mediaApiCredentials[actor]}`);
    return fetch(new URL(path,running().url),{...init,headers,signal:AbortSignal.timeout(10000)});
  }
  function read<T>(inspect: (db: Database) => T): T {
    const db = new Database(activeDbPath,{readonly:true});
    try { return inspect(db); } finally { db.close(); }
  }
  function graph() {
    return read(db => ["media_store","media_sources","thoughts","thought_titles","thought_source_seals","runs","run_steps",
      "run_context","run_operation_receipts","run_issued_thoughts","run_replies","agent_bindings"].map(table => ({table,rows:db.query(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all()})));
  }
  async function until(predicate: () => boolean | Promise<boolean>, label: string): Promise<void> {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      poll?.();
      await Bun.sleep(5);
    }
    throw new Error(`Owned media fixture did not reach ${label}`);
  }
  /** Withhold the entire body: a response proves the handler did not await it before denying authority. */
  async function headersOnly(actor: "ai" | "anonymous"): Promise<number> {
    const result = Promise.withResolvers<number>();
    const pending = httpRequest(new URL("/imports/media",running().url),{method:"POST",headers:{
      "content-type":"multipart/form-data; boundary=owned-auth-body", "content-length":"1024",connection:"close",
      ...(actor === "ai" ? {authorization:`Bearer ${mediaApiCredentials.ai}`} : {}),
    }},response => {
      response.resume();
      const status = response.statusCode;
      if (status === undefined) result.reject(new Error("Expected an authentication response status"));
      else result.resolve(status);
    });
    pending.on("error",result.reject);
    pending.flushHeaders();
    try { return await bounded(result.promise,"authentication before withheld media body"); }
    finally { pending.destroy(); }
  }
  try { await start(); }
  catch (error) { await rm(directory,{recursive:true,force:true}); throw error; }
  return {directory,dbPath,client,logs,events,agent,request,read,graph,until,start,stop,headersOnly,
    get mediaDirectory() { return mediaDirectory; },
    get nativeCalls() { return {resolutions,clients}; },
    async close() { try { await stop(); } finally { await rm(directory,{recursive:true,force:true}); } }};
}
export type MediaApiFixture = Awaited<ReturnType<typeof setup>>;
export async function mediaApiFixture(action: (fixture: MediaApiFixture) => Promise<void>, options: Options = {}): Promise<void> {
  const fixture = await setup(options);
  try { await action(fixture); } finally { await fixture.close(); }
}
