import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { Agent } from "@opencode/schema/agent";
import { Session } from "@opencode/schema/session";
import { SessionMessage } from "@opencode/schema/session-message";
import { Tool } from "@opencode/schema/tool";
import plugin, { type NativePluginContext, type NativeToolContext } from "../../../packages/agent-tools/src/plugin";
import { LEGACY_NATIVE_ACTIONS, nativeCapabilityDefinition, NATIVE_PLUGIN_BUILD_ID, type LegacyNativeAction } from "../../../packages/contracts/src/native-capabilities";
import { DOMAIN_ACTIONS } from "../../../packages/contracts/src/tools";

type Editor = Parameters<Parameters<NativePluginContext["tool"]["transform"]>[0]>[0];
type Registered = Parameters<Editor["add"]>[0];
const baseline: LegacyNativeAction[] = ["read_source", "read_item", "read_relationship", "search", "record_interpretation", "record_alias", "record_relationship", "revise_interpretation", "revise_relationship", "record_idea"];
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

// Match the pinned OpenCode Rpc.parse JSON Schema path, using the Effect version
// resolved from the installed schema package rather than a different copy.
function decodePortableRpc(schema: unknown, value: unknown): unknown {
  const requireFromSchema = createRequire(import.meta.resolve("@opencode/schema/rpc"));
  const effect: unknown = requireFromSchema("effect");
  if (typeof effect !== "object" || effect === null || !("JsonSchema" in effect) || !("SchemaRepresentation" in effect) || !("Schema" in effect)) throw new Error("Effect schema modules unavailable");
  const { JsonSchema, SchemaRepresentation, Schema } = effect;
  if (typeof JsonSchema !== "object" || JsonSchema === null || !("fromSchemaDraft2020_12" in JsonSchema) || typeof JsonSchema.fromSchemaDraft2020_12 !== "function" ||
      typeof SchemaRepresentation !== "object" || SchemaRepresentation === null || !("fromJsonSchemaDocument" in SchemaRepresentation) || typeof SchemaRepresentation.fromJsonSchemaDocument !== "function" ||
      typeof Schema !== "object" || Schema === null || !("make" in Schema) || typeof Schema.make !== "function" || !("decodeUnknownSync" in Schema) || typeof Schema.decodeUnknownSync !== "function") throw new Error("Effect schema functions unavailable");
  const document: unknown = Reflect.apply(JsonSchema.fromSchemaDraft2020_12, JsonSchema, [schema]);
  const represented: unknown = Reflect.apply(SchemaRepresentation.fromJsonSchemaDocument, SchemaRepresentation, [document]);
  if ((typeof represented !== "object" && typeof represented !== "function") || represented === null || !("ast" in represented)) throw new Error("Missing schema AST");
  const codec: unknown = Reflect.apply(Schema.make, Schema, [represented.ast]);
  const decode: unknown = Reflect.apply(Schema.decodeUnknownSync, Schema, [codec]);
  if (typeof decode !== "function") throw new Error("Missing schema decoder");
  return Reflect.apply(decode, undefined, [value]);
}

test("CAP-01 native Effect converter accepts valid capability RPC input", () => {
  const input = { nonce: "fixture-nonce-1" };
  expect(decodePortableRpc(nativeCapabilityDefinition.methods.inspect.input, input)).toEqual(input);
});

test("CAP-01 native Effect converter accepts valid capability RPC output", () => {
  const output = { protocol: 1, nonce: "fixture-nonce-1", buildId: "fixture-reviewed-build", setupId: "fixture-setup", nativePid: 42, directory: "/fixture/location", actions: ["read_source"] };
  expect(decodePortableRpc(nativeCapabilityDefinition.methods.inspect.output, output)).toEqual(output);
});

test("phase3-contract registered search schema accepts an optional bounded integer limit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "thoughtloom-search-plugin-")); directories.push(directory);
  const connectionFile = join(directory, "connection.json");
  await writeFile(connectionFile, JSON.stringify({ url: "http://127.0.0.1:4321", transportCredential: "fixture-only-secret", location: directory }), { mode: 0o600 });
  const registered: Registered[] = [], editor = { add(tool: Registered) { registered.push(tool); } } as Editor;
  const context = { options: { connectionFile }, location: { directory }, permission: { async assert() {} },
    tool: { async transform(callback: (value: Editor) => void) { callback(editor); return { async dispose() {} }; }, async list() { return registered.map((tool) => ({ ...tool, id: tool.name })); } },
    rpc: { async register(_definition: unknown, _handlers: unknown) { return { async dispose() {}, events: { async emit() {} } }; } } };
  await Reflect.apply(plugin.setup, undefined, [context]);
  const tool = registered.find((entry) => entry.name === "search"); if (!tool) throw new Error("Missing registered search tool");
  expect(tool.input).toMatchObject({ type: "object", required: ["query"], additionalProperties: false, properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 200 } } });
});

test("phase3-portable registered search converter and forwarder preserve input without model authority", async () => {
  const directory = await mkdtemp(join(tmpdir(), "thoughtloom-portable-search-")); directories.push(directory);
  const connectionFile = join(directory, "connection.json");
  await writeFile(connectionFile, JSON.stringify({ url: "http://127.0.0.1:4321", transportCredential: "fixture-only-secret", location: directory }), { mode: 0o600 });
  const registered: Registered[] = [], editor = { add(tool: Registered) { registered.push(tool); } } as Editor;
  const permissions: unknown[] = [], forwarded: unknown[] = [];
  const context = { options: { connectionFile }, location: { directory }, permission: { async assert(input: unknown) { permissions.push(input); } },
    tool: { async transform(callback: (value: Editor) => void) { callback(editor); return { async dispose() {} }; }, async list() { return registered.map((tool) => ({ ...tool, id: tool.name })); } },
    rpc: { async register(_definition: unknown, _handlers: unknown) { return { async dispose() {}, events: { async emit() {} } }; } } };
  await Reflect.apply(plugin.setup, undefined, [context]);
  const tool = registered.find((entry) => entry.name === "search"); if (!tool) throw new Error("Missing registered search tool");
  const query = "  Café sdk\t ";
  expect(decodePortableRpc(tool.input, { query })).toEqual({ query });
  expect(decodePortableRpc(tool.input, { query, limit: 2 })).toEqual({ query, limit: 2 });
  let projectedUnknown: unknown;
  try { projectedUnknown = decodePortableRpc(tool.input, { query, limit: 2, runId: "forged" }); }
  catch { /* Strict rejection also prevents unknown authority from passing. */ }
  if (projectedUnknown !== undefined) expect(projectedUnknown).toEqual({ query, limit: 2 });
  expect(() => decodePortableRpc(tool.input, { query, limit: 0 })).toThrow();
  expect(() => decodePortableRpc(tool.input, { query, limit: 201 })).toThrow();
  const native: NativeToolContext = { sessionID: Session.ID.make("ses_fixture_search"), agent: Agent.ID.make("weaver"), messageID: SessionMessage.ID.make("msg_fixture_search"), id: Tool.CallID.make("call_fixture_search"), signal: new AbortController().signal, async progress() {} };
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    expect(String(url)).toBe("http://127.0.0.1:4321/internal/tools/search");
    if (typeof init?.body !== "string") throw new Error("Missing forwarded search body");
    forwarded.push(JSON.parse(init.body)); return Response.json({ results: [], engineVersion: 2, hasMore: false, searchTruncated: false, aliasExpansionTruncated: false });
  }, { preconnect: globalThis.fetch.preconnect }));
  try {
    const output = await tool.execute({ query, limit: 2, runId: "forged-run", sourceId: "forged-source", transportCredential: "forged-secret" }, native);
    expect(forwarded).toEqual([{ action: "search", native: { sessionID: native.sessionID, agent: native.agent, messageID: native.messageID, callID: native.id }, input: { query, limit: 2 } }]);
    expect(permissions).toEqual([expect.objectContaining({ action: "search", sessionID: native.sessionID, agent: native.agent, resources: ["*"] })]);
    if (typeof output.content !== "string") throw new Error("Expected JSON search tool content");
    expect(JSON.parse(output.content)).toEqual({ results: [], engineVersion: 2, hasMore: false, searchTruncated: false, aliasExpansionTruncated: false });
    await tool.execute({ query }, native);
    expect(forwarded[1]).toEqual({ action: "search", native: { sessionID: native.sessionID, agent: native.agent, messageID: native.messageID, callID: native.id }, input: { query } });
    await expect(tool.execute({ query: "bad\ud800", limit: 2 }, native)).rejects.toThrow();
    expect(forwarded).toHaveLength(2); expect(permissions).toHaveLength(2);
  } finally { fetchSpy.mockRestore(); }
});

test("V2 setup registers direct domain tools with native runtime permission checks and no authority arguments", async () => {
  const directory = await mkdtemp(join(tmpdir(), "thoughtloom-plugin-registration-"));
  directories.push(directory);
  const connectionFile = join(directory, "connection.json");
  await writeFile(connectionFile, JSON.stringify({ url: "http://127.0.0.1:4321", transportCredential: "fixture-only-secret", location: directory }), { mode: 0o600 });
  const registered: Registered[] = [];
  const actions: string[] = [];
  const editor = { add(tool: Registered) { registered.push(tool); } } as Editor;
  const context = {
    options: { connectionFile }, location: { directory },
    permission: { async assert(input: { action: string }) { actions.push(input.action); throw new Error("fixture permission denied"); } },
    tool: { async transform(callback: (value: Editor) => void) { callback(editor); return { async dispose() {} }; }, async list() { return registered.map((tool) => ({ ...tool, id: tool.name })); } },
    rpc: { async register(_definition: unknown, _handlers: unknown) { return { async dispose() {}, events: { async emit() {} } }; } },
  };
  await Reflect.apply(plugin.setup, undefined, [context]);
  expect([...DOMAIN_ACTIONS].sort()).toEqual([...baseline].sort());
  expect([...LEGACY_NATIVE_ACTIONS].sort()).toEqual([...baseline].sort());
  expect(registered.map((tool) => tool.name).sort()).toEqual([...baseline, "record_title_v1"].sort());
  const native: NativeToolContext = { sessionID: Session.ID.make("ses_fixture_plugin"), agent: Agent.ID.make("weaver"), messageID: SessionMessage.ID.make("msg_fixture_plugin"), id: Tool.CallID.make("call_fixture_plugin"), signal: new AbortController().signal, async progress() {} };
  for (const action of ["record_alias", "record_relationship", "record_idea"]) {
    const tool = registered.find((entry) => entry.name === action);
    expect(tool).toBeDefined();
    if (!tool) throw new Error(`Missing ${action}`);
    expect(tool.options).toMatchObject({ codemode: false, permission: action });
    expect(tool.input).not.toHaveProperty("properties.runId");
    expect(tool.input).not.toHaveProperty("properties.transportCredential");
    const input = action === "record_alias" ? { alias: "SDK", expansion: "software development kit", evidenceSourceIds: ["source-1"] } : action === "record_relationship" ? { fromItemId: "item-1", toItemId: "item-2", fromVersionId: "version-1", toVersionId: "version-2", type: "suggests", rationale: "Evidence", evidenceSourceIds: ["source-1"] } : { rootSourceId: "source-1", turnSourceId: "source-2", dialogueId: "dialogue-1", turnId: "turn-1", text: "Developed idea", evidenceSourceIds: ["source-1", "source-2"], derivedFrom: { itemId: "item-1", versionId: "version-1" } };
    await expect(tool.execute(input, native)).rejects.toThrow("fixture permission denied");
  }
  expect(actions).toEqual(["record_alias", "record_relationship", "record_idea"]);
});

test("generated title tool is registered as a scoped native action without model-supplied build authority", async () => {
  const directory = await mkdtemp(join(tmpdir(), "thoughtloom-generated-title-plugin-")); directories.push(directory);
  const connectionFile = join(directory, "connection.json");
  await writeFile(connectionFile, JSON.stringify({ url: "http://127.0.0.1:4321", transportCredential: "fixture-only-secret", location: directory }), { mode: 0o600 });
  const registered: Registered[] = [], editor = { add(tool: Registered) { registered.push(tool); } } as Editor;
  const context = { options: { connectionFile }, location: { directory },
    permission: { async assert() { throw new Error("fixture permission denied"); } },
    tool: { async transform(callback: (value: Editor) => void) { callback(editor); return { async dispose() {} }; }, async list() { return registered.map((tool) => ({ ...tool, id: tool.name })); } },
    rpc: { async register(_definition: unknown, _handlers: unknown) { return { async dispose() {}, events: { async emit() {} } }; } } };
  await Reflect.apply(plugin.setup, undefined, [context]);
  const tool = registered.find((entry) => entry.name === "record_title_v1");
  expect(tool).toBeDefined();
  if (!tool) throw new Error("Missing generated title tool");
  expect(tool.options).toMatchObject({ codemode: false, permission: "record_title_v1" });
  expect(tool.input).toHaveProperty("properties.rootSourceId");
  expect(tool.input).toHaveProperty("properties.target");
  expect(tool.input).toHaveProperty("properties.text");
  expect(tool.input).toHaveProperty("properties.expectedTitleRevisionId");
  expect(tool.input).not.toHaveProperty("properties.buildId");
  expect(tool.input).not.toHaveProperty("properties.pluginBuildId");
  expect(tool.input).not.toHaveProperty("properties.runId");
  expect(tool.input).not.toHaveProperty("properties.transportCredential");
});

test("generated title forwarder uses native permission and embedded build, not forged model authority", async () => {
  const directory = await mkdtemp(join(tmpdir(), "thoughtloom-title-forwarder-")); directories.push(directory);
  const connectionFile = join(directory, "connection.json");
  await writeFile(connectionFile, JSON.stringify({ url: "http://127.0.0.1:4321", transportCredential: "fixture-only-secret", location: directory }), { mode: 0o600 });
  const registered: Registered[] = [], events: string[] = [], editor = { add(tool: Registered) { registered.push(tool); } } as Editor;
  const context = { options: { connectionFile, buildId: "forged-option-build" }, location: { directory },
    permission: { async assert(input: unknown) { events.push("permission"); expect(input).toMatchObject({ action: "record_title_v1", resources: ["fixture-root"] }); } },
    tool: { async transform(callback: (value: Editor) => void) { callback(editor); return { async dispose() {} }; }, async list() { return registered.map((tool) => ({ ...tool, id: tool.name })); } },
    rpc: { async register(_definition: unknown, _handlers: unknown) { return { async dispose() {}, events: { async emit() {} } }; } } };
  await Reflect.apply(plugin.setup, undefined, [context]);
  const tool = registered.find((entry) => entry.name === "record_title_v1"); if (!tool) throw new Error("Missing title tool");
  const native: NativeToolContext = { sessionID: Session.ID.make("ses_fixture_title"), agent: Agent.ID.make("weaver"), messageID: SessionMessage.ID.make("msg_fixture_title"), id: Tool.CallID.make("call_fixture_title"), signal: new AbortController().signal, async progress() {} };
  let forwarded: unknown;
  const mockFetch: typeof fetch = Object.assign(async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    events.push("send"); expect(String(url)).toBe("http://127.0.0.1:4321/internal/tools/record-title-v1");
    if (typeof init?.body !== "string") throw new Error("Missing fixture body");
    forwarded = JSON.parse(init.body); return Response.json({ ok: true });
  }, { preconnect: globalThis.fetch.preconnect });
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(mockFetch);
  try {
    const input = { rootSourceId: "fixture-root", target: { kind: "source" }, text: "A short title", expectedTitleRevisionId: null };
    await tool.execute({ ...input, buildId: "forged-model-build", pluginBuildId: "forged-model-build", runId: "forged-run", transportCredential: "forged-secret" }, native);
    expect(events).toEqual(["permission", "send"]);
    expect(forwarded).toEqual({ native: { sessionID: native.sessionID, agent: native.agent, messageID: native.messageID, callID: native.id }, action: "record_title_v1", input, pluginBuildId: NATIVE_PLUGIN_BUILD_ID });
    expect(NATIVE_PLUGIN_BUILD_ID).not.toBe("forged-option-build");
  } finally { fetchSpy.mockRestore(); }
});

test("capability witness registers after tools and reports bounded executing metadata without forwarding", async () => {
  const directory = await mkdtemp(join(tmpdir(), "thoughtloom-capability-plugin-")); directories.push(directory);
  const connectionFile = join(directory, "connection.json");
  await writeFile(connectionFile, JSON.stringify({ url: "http://127.0.0.1:4321", transportCredential: "fixture-only-secret", location: directory }), { mode: 0o600 });
  const registered: Registered[] = [], calls: string[] = [], registrations: Array<{ definition: unknown; handlers: unknown }> = [];
  const editor = { add(tool: Registered) { registered.push(tool); } } as Editor;
  const context = { options: { connectionFile, buildId: "untrusted-option-marker" }, location: { directory },
    permission: { async assert() { throw new Error("witness must not request tool permission"); } },
    tool: { async transform(callback: (value: Editor) => void) { callback(editor); calls.push("transform"); return { async dispose() {} }; }, async list() { return registered.map((tool) => ({ ...tool, id: tool.name })); } },
    rpc: { async register(definition: unknown, handlers: unknown) { calls.push("register"); registrations.push({ definition, handlers }); return { async dispose() {}, events: { async emit() {} } }; } },
  };
  await Reflect.apply(plugin.setup, undefined, [context]);
  expect(calls).toEqual(["transform", "register"]);
  expect(registrations).toHaveLength(1);
  const registration = registrations[0]; if (!registration) throw new Error("Missing RPC registration");
  expect(registration.definition).toMatchObject({ id: "thoughtloom.capabilities", methods: { inspect: { input: expect.anything(), output: expect.anything() } }, events: {} });
  const handlers = registration.handlers;
  if (typeof handlers !== "object" || handlers === null || !("inspect" in handlers) || typeof handlers.inspect !== "function") throw new Error("Missing inspect handler");
  const native = { signal: new AbortController().signal, error: () => { throw new Error("RPC error"); } };
  const nonce = "fixture-nonce-1";
  const result: unknown = await Reflect.apply(handlers.inspect, handlers, [{ nonce }, native]);
  if (typeof result !== "object" || result === null || !("buildId" in result) || typeof result.buildId !== "string" || !("setupId" in result) || typeof result.setupId !== "string") throw new Error("Missing witness identity");
  if (!("actions" in result) || !Array.isArray(result.actions)) throw new Error("Missing supported actions");
  expect(registered.map((tool) => tool.name).sort()).toEqual([...baseline, "record_title_v1"].sort());
  expect({ ...result, actions: [...result.actions] }).toMatchObject({ protocol: 1, nonce, nativePid: process.pid, directory, actions: expect.arrayContaining(["read_source", "record_interpretation"]) });
  expect(result.buildId).toBe(NATIVE_PLUGIN_BUILD_ID);
  expect(result.buildId.length).toBeGreaterThan(0); expect(result.buildId).not.toBe("untrusted-option-marker"); expect(result.setupId.length).toBeGreaterThan(0);
  const repeated: unknown = await Reflect.apply(handlers.inspect, handlers, [{ nonce: "fixture-nonce-2" }, native]);
  expect(repeated).toMatchObject({ nonce: "fixture-nonce-2", buildId: result.buildId, setupId: result.setupId });
  expect(JSON.stringify(result)).not.toMatch(/fixture-only-secret|untrusted-option-marker|source text|authorization/i);
  for (const invalid of [{ nonce: "" }, { nonce: "x".repeat(129) }, { nonce: "bad space" }, { nonce: "good", extra: "unknown" }, {}]) {
    await expect(Reflect.apply(handlers.inspect, handlers, [invalid, native])).rejects.toThrow();
  }
  expect([...result.actions].sort()).toEqual([...baseline, "record_title_v1"].sort());
});

test("capability witness build identity is stable and setup identity changes with plugin setup lifetime", async () => {
  const directory = await mkdtemp(join(tmpdir(), "thoughtloom-capability-lifetime-")); directories.push(directory);
  const connectionFile = join(directory, "connection.json");
  await writeFile(connectionFile, JSON.stringify({ url: "http://127.0.0.1:4321", transportCredential: "fixture-only-secret", location: directory }), { mode: 0o600 });
  const handlers: unknown[] = [];
  for (const optionMarker of ["fixture-option-one", "fixture-option-two"]) {
    const registered: Registered[] = [], editor = { add(tool: Registered) { registered.push(tool); } } as Editor;
    const context = { options: { connectionFile, buildId: optionMarker }, location: { directory },
      permission: { async assert() { throw new Error("unexpected permission check"); } },
      tool: { async transform(callback: (value: Editor) => void) { callback(editor); return { async dispose() {} }; }, async list() { return registered.map((tool) => ({ ...tool, id: tool.name })); } },
      rpc: { async register(_definition: unknown, value: unknown) { handlers.push(value); return { async dispose() {}, events: { async emit() {} } }; } } };
    await Reflect.apply(plugin.setup, undefined, [context]);
  }
  expect(handlers).toHaveLength(2);
  const native = { signal: new AbortController().signal, error: () => { throw new Error("RPC error"); } }, results: Array<{ buildId: string; setupId: string }> = [];
  for (const entry of handlers) {
    if (typeof entry !== "object" || entry === null || !("inspect" in entry) || typeof entry.inspect !== "function") throw new Error("Missing inspect handler");
    const result: unknown = await Reflect.apply(entry.inspect, entry, [{ nonce: "fixture-lifetime" }, native]);
    if (typeof result !== "object" || result === null || !("buildId" in result) || typeof result.buildId !== "string" || !("setupId" in result) || typeof result.setupId !== "string") throw new Error("Missing witness identity");
    results.push({ buildId: result.buildId, setupId: result.setupId });
  }
  expect(results[0]?.buildId).toBeTruthy(); expect(results[0]?.buildId).toBe(results[1]?.buildId);
  expect(results[0]?.buildId).not.toMatch(/fixture-option/);
  expect(results[0]?.setupId).toBeTruthy(); expect(results[0]?.setupId).not.toBe(results[1]?.setupId);
});
