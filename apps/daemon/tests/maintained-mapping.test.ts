import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Service } from "@opencode/client/service";
import type { OpenCodeClient } from "@opencode/client";
import { createApp } from "../src/app";
import { createMaintainedClient, type MaintainedClientHooks, type NativeClientPort } from "../src/native-adapter";
import { WeavingWorker, type WeavingAdapter, type WeavingRun } from "../src/weaving";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

test("maintained client mapping checks discovery, identity and location-scoped plugin before session creation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "thoughtloom-sdk-mapping-"));
  directories.push(directory);
  const databasePath = join(directory, "test.sqlite");
  const registrationFile = join(directory, "registration.json");
  await writeFile(registrationFile, JSON.stringify({ url: "http://127.0.0.1:4321", version: "2.2.2", pid: 42, password: "fixture-only" }), { mode: 0o600 });
  const captured = await createApp({ databasePath }).request("/captures", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "sdk-fixture" }, body: JSON.stringify({ text: "Controlled original", provenance: "manual" }) });
  expect(captured.status).toBe(201);
  let enteredResolve: (run: WeavingRun) => void = () => {};
  const entered = new Promise<WeavingRun>((resolve) => { enteredResolve = resolve; });
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const adapter: WeavingAdapter = { async prepareSession(run) { enteredResolve(run); await gate; }, async admit() { return { kind: "admitted" }; }, async inspect() { return { kind: "pending" }; } };
  const pending = new WeavingWorker({ databasePath, adapter }).startNext();
  try {
    const run = await Promise.race([entered, pending.then(() => { throw new Error("Worker returned before preparation"); })]);
    const calls: string[] = [];
    const sdk = {
      server: { async info() { calls.push("server.info"); return { version: "2.2.2", pid: 42 }; } },
      plugin: { async list(input: { location: { directory: string } }) { calls.push(`plugin.list:${input.location.directory}`); return { data: [] }; } },
      session: { async create() { calls.push("session.create"); throw new Error("unexpected session creation"); } },
    } as unknown as OpenCodeClient;
    const hooks: MaintainedClientHooks = {
      async discover(options) {
        expect(options).toMatchObject({ file: registrationFile, version: "2.2.2" });
        calls.push("Service.discover");
        return { url: "http://127.0.0.1:4321", auth: { type: "basic", username: "fixture", password: "fixture-only" } };
      },
      headers: Service.headers,
      make(options) {
        expect(options.baseUrl).toBe("http://127.0.0.1:4321");
        calls.push("OpenCode.make");
        return sdk;
      },
    };
    const port = createMaintainedClient({ databasePath, registrationFile, location: directory, agent: "weaver", model: { providerID: "fixture", id: "fixture" }, operations: ["record_interpretation"] }, hooks);
    expect(await port.discover(registrationFile, "2.2.2")).toMatchObject({ version: "2.2.2", pid: 42 });
    expect(await port.identity()).toMatchObject({ version: "2.2.2", pid: 42 });
    await expect(port.createSession(run)).rejects.toMatchObject({ code: "plugin_unavailable" });
    expect(calls).toEqual(["Service.discover", "OpenCode.make", "server.info", `plugin.list:${directory}`]);
  } finally { release(); await pending; }
});

type PreviewTextEvent = { id: string; sessionID: string; assistantMessageID: string; ordinal: number } &
  ({ type: "session.text.started" } | { type: "session.text.delta"; delta: string } | { type: "session.text.ended"; text: string });
type PreviewClient = NativeClientPort & { subscribeText(sessionId: string, onEvent: (event: PreviewTextEvent) => void, onGap: () => void): Promise<{ close(): Promise<void> }> };
function supportsPreview(port: NativeClientPort): port is PreviewClient { return "subscribeText" in port && typeof port.subscribeText === "function"; }

test("maintained event mapping exposes only owned ordinary text, not reasoning or tool input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "thoughtloom-preview-mapping-")); directories.push(directory);
  const databasePath = join(directory, "test.sqlite"), registrationFile = join(directory, "registration.json");
  await writeFile(registrationFile, JSON.stringify({ url: "http://127.0.0.1:4321", version: "2.2.2", pid: 42, password: "fixture-only" }), { mode: 0o600 });
  const subscribed: string[][] = [];
  const sdk = { event: { async *subscribe(input: { types: string[] }) {
    subscribed.push(input.types);
    yield { type: "server.connected" };
    yield { id: "evt_start", type: "session.text.started", data: { sessionID: "ses_owned", assistantMessageID: "msg_owned", ordinal: 0 } };
    yield { id: "evt_reason", type: "session.reasoning.delta", data: { sessionID: "ses_owned", assistantMessageID: "msg_owned", ordinal: 0, delta: "private reasoning" } };
    yield { id: "evt_tool", type: "session.tool.input.delta", data: { sessionID: "ses_owned", assistantMessageID: "msg_owned", ordinal: 0, delta: "private tool arguments" } };
    yield { id: "evt_foreign", type: "session.text.delta", data: { sessionID: "ses_foreign", assistantMessageID: "msg_other", ordinal: 0, delta: "foreign text" } };
    yield { id: "evt_text", type: "session.text.delta", data: { sessionID: "ses_owned", assistantMessageID: "msg_owned", ordinal: 0, delta: "visible" } };
    yield { id: "evt_end", type: "session.text.ended", data: { sessionID: "ses_owned", assistantMessageID: "msg_owned", ordinal: 0, text: "visible" } };
  } } } as unknown as OpenCodeClient;
  const hooks: MaintainedClientHooks = { async discover() { return { url: "http://127.0.0.1:4321", auth: { type: "basic", username: "fixture", password: "fixture-only" } }; }, headers: Service.headers, make() { return sdk; } };
  const port = createMaintainedClient({ databasePath, registrationFile, location: directory, agent: "weaver", model: { providerID: "fixture", id: "model" } }, hooks);
  expect(await port.discover(registrationFile, "2.2.2")).not.toBeNull();
  expect(supportsPreview(port)).toBe(true);
  if (!supportsPreview(port)) return;
  const events: PreviewTextEvent[] = [];
  const watch = await port.subscribeText("ses_owned", (event) => events.push(event), () => {});
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await watch.close(); await port.close?.();
  expect(subscribed.flat()).toEqual(expect.arrayContaining(["session.text.started", "session.text.delta", "session.text.ended"]));
  expect(events).toEqual([
    { id: "evt_start", type: "session.text.started", sessionID: "ses_owned", assistantMessageID: "msg_owned", ordinal: 0 },
    { id: "evt_text", type: "session.text.delta", sessionID: "ses_owned", assistantMessageID: "msg_owned", ordinal: 0, delta: "visible" },
    { id: "evt_end", type: "session.text.ended", sessionID: "ses_owned", assistantMessageID: "msg_owned", ordinal: 0, text: "visible" },
  ]);
  expect(JSON.stringify(events)).not.toMatch(/private reasoning|private tool arguments|foreign text/);
});
