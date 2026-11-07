import { expect } from "bun:test";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { OpenCodeAdapter, type AgentBinding } from "../../src/agent/opencode-adapter";
import { RunWorker } from "../../src/agent/worker";
import { RejectionService } from "../../src/domain/rejection";
import { RunAdmissionService, type RunRecord } from "../../src/domain/run";
import type { MediaThought } from "../../src/domain/thought";
import { TitleService } from "../../src/domain/title";
import { SqliteAgenticExports } from "../../src/storage/agentic-export";
import { SqliteCapabilityDispatcher } from "../../src/storage/capability";
import { SqliteMarkdownImports } from "../../src/storage/markdown-import";
import { SqliteRejectionRepository } from "../../src/storage/rejection";
import { SqliteRunRepository } from "../../src/storage/run";
import { SqliteRunOperations } from "../../src/storage/run-operations";
import { SqliteRunProtocolRepository } from "../../src/storage/run-protocol";
import { SqliteTitleRepository } from "../../src/storage/title";
import { ScriptedClient } from "../agentic-search-capability-fixture";
import { bounded, fileChunks, fileSourceId, mediaFileFixture, type MediaFileFixture } from "./media-files";
import { independentPng } from "./media-rasters";

export const pathRequest = (capability: string, arguments_: object) =>
  ({version:1,kind:"request",request:{capability,arguments:arguments_}});
export const pathComplete = (reply: string) => ({version:1,kind:"complete",reply});

export function pathBinding(run: RunRecord, directory: string): AgentBinding {
  return {sessionId:run.sessionId,serviceUrl:"http://127.0.0.1:44991",location:{directory},
    model:{providerID:"fixture",id:"shared-file-model"},
    permissions:[{action:"*",resource:"*",effect:run.kind === "weave" || run.kind === "evolve" ? "allow" : "deny"}],protocolVersion:1};
}

/** Inspect model-bound text without depending on the prompt's JSON layout. */
export function promptStrings(input: string): string[] {
  const result: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === "string") result.push(value);
    else if (Array.isArray(value)) for (const item of value) visit(item);
    else if (value !== null && typeof value === "object") for (const item of Object.values(value)) visit(item);
  };
  const value: unknown = JSON.parse(input);
  visit(value);
  return result;
}

async function setup(base: MediaFileFixture, clarification: string | null) {
  const bytes = independentPng();
  const files = await base.open({limits:{...base.options.limits,maxBytes:4096}});
  const source: MediaThought = {id:"retained-image",text:null,title:null,titleAuthor:null,author:"source",kind:"media-original",
    createdAt:"2030-01-02T03:04:05.000Z",origin:"media-import",parentId:null,sourceIds:[],
    mediaSource:{id:fileSourceId,name:"two pixels.png",mimeType:"image/png",byteLength:bytes.byteLength,
      fileAuthorship:"unverified",clarification,clarificationAuthor:clarification === null ? null : "user"}};
  await files.publish(source.mediaSource.id,fileChunks(bytes),artifact => {
    base.store.saveMediaSource({thought:source,requestKey:"shared-image",sha256:artifact.sha256});
  });
  const path = await realpath(join(base.directory,"objects",source.mediaSource.id));
  expect(isAbsolute(path)).toBe(true);
  expect(path).not.toContain("/proc/self/fd/");
  expect(Array.from(await readFile(path))).toEqual(Array.from(bytes));
  expect(base.store.getThought(source.id)).toEqual(source);

  let sequence = 0;
  const sources = {id:() => `path-${++sequence}`,sessionId:() => `ses_path-${++sequence}`,
    promptId:() => `msg_path-${++sequence}`,now:() => source.createdAt,logger:base.options.logger};
  const runs = new SqliteRunRepository(base.db,sources);
  const steps = new SqliteRunProtocolRepository(base.db,sources.logger);
  const ops = new SqliteRunOperations(base.db,sources);
  const capabilities = new SqliteCapabilityDispatcher(base.db,sources);
  const rejection = new RejectionService(new SqliteRejectionRepository(base.db,sources.logger));
  const titles = new TitleService(new SqliteTitleRepository(base.db,sources));
  const admissions = new RunAdmissionService({...sources,repository:runs});
  const exports = new SqliteAgenticExports(base.db,sources);
  const imports = new SqliteMarkdownImports(base.db,sources);
  const subjectId = "text-subject";
  base.store.saveThought({id:subjectId,text:"Compare my thinking with the retained source",title:null,titleAuthor:null,
    author:"user",kind:"captured-original",createdAt:sources.now(),origin:"fixture",parentId:null,sourceIds:[]});

  const workers: RunWorker[] = [], requestedSources: string[] = [];
  let held: {readonly entered: ReturnType<typeof Promise.withResolvers<void>>;
    readonly release: ReturnType<typeof Promise.withResolvers<void>>} | undefined;
  const mediaPath = async (sourceId: string): Promise<string> => {
    expect(base.db.inTransaction).toBe(false);
    requestedSources.push(sourceId);
    if (sourceId !== source.mediaSource.id) throw new Error("Source ID is not owned by this fixture store");
    const gate = held;
    if (gate) { gate.entered.resolve(); await gate.release.promise; }
    expect(await files.readOriginal(sourceId)).toEqual(bytes);
    expect(Array.from(await readFile(path))).toEqual(Array.from(bytes));
    return path;
  };
  const worker = (script: (index: number, input: string) => object) => {
    const client = new ScriptedClient(script);
    const instance = new RunWorker({db:base.db,...sources,mediaPath,
      bindingFor:run => pathBinding(run,base.dir),
      native:bindings => new OpenCodeAdapter(client,bindings,bindings.assertActive.bind(bindings),sources.logger)});
    workers.push(instance);
    return {instance,client};
  };
  const run = (runId: string): RunRecord => {
    const value = runs.get(runId);
    if (!value) throw new Error("Expected an admitted ordinary run");
    return value;
  };
  const until = async (instance: RunWorker, runId: string, reached: () => boolean): Promise<void> => {
    // Test-only tick bound, not a product effort limit or a wall-clock race.
    for (let tick = 0; tick < 48 && !reached() && !["completed","failed","interrupted"].includes(run(runId).status); tick++) {
      await bounded(instance.tick(runId),"ordinary shared-file worker tick");
    }
    expect(reached()).toBe(true);
  };
  const finish = async (instance: RunWorker, runId: string): Promise<void> => {
    await until(instance,runId,() => ["completed","failed","interrupted"].includes(run(runId).status));
  };
  return {db:base.db,store:base.store,directory:base.directory,source,bytes,path,subjectId,sources,runs,steps,ops,
    capabilities,rejection,titles,admissions,exports,imports,requestedSources,worker,run,until,finish,
    holdPath() {
      if (held) throw new Error("A fixture path resolution is already held");
      const gate = {entered:Promise.withResolvers<void>(),release:Promise.withResolvers<void>()};
      held = gate;
      return {entered:gate.entered.promise,release:() => { gate.release.resolve(); if (held === gate) held = undefined; }};
    },
    async close() {
      held?.release.resolve(); held = undefined;
      for (const instance of workers) instance.pause();
      await bounded(Promise.all(workers.map(instance => instance.drain())),"shared-file worker drain");
    }};
}

export type MediaPathFixture = Awaited<ReturnType<typeof setup>>;

export async function mediaPathFixture(action: (fixture: MediaPathFixture) => Promise<void>,
  clarification: string | null = "  Compare the red and blue regions.\r\nKeep this exact clarification.  "): Promise<void> {
  await mediaFileFixture(async base => {
    const fixture = await setup(base,clarification);
    try { await action(fixture); } finally { await fixture.close(); }
  });
}
