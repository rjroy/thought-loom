import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Service } from "@opencode/client/service";
import type { OpenCodeClient } from "@opencode/client";
import { createApp } from "../src/app";
import { createMaintainedClient, type MaintainedClientHooks } from "../src/native-adapter";
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
