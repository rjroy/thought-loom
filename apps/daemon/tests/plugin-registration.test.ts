import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@opencode/schema/agent";
import { Session } from "@opencode/schema/session";
import { SessionMessage } from "@opencode/schema/session-message";
import { Tool } from "@opencode/schema/tool";
import plugin, { type NativePluginContext, type NativeToolContext } from "../../../packages/agent-tools/src/plugin";

type Editor = Parameters<Parameters<NativePluginContext["tool"]["transform"]>[0]>[0];
type Registered = Parameters<Editor["add"]>[0];
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

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
    tool: { async transform(callback: (value: Editor) => void) { callback(editor); return { async dispose() {} }; } },
  };
  await Reflect.apply(plugin.setup, undefined, [context]);
  const expected = ["read_source", "read_item", "read_relationship", "search", "record_interpretation", "record_alias", "record_relationship", "revise_interpretation", "revise_relationship"];
  expect(registered.map((tool) => tool.name).sort()).toEqual([...expected].sort());
  const native: NativeToolContext = { sessionID: Session.ID.make("ses_fixture_plugin"), agent: Agent.ID.make("weaver"), messageID: SessionMessage.ID.make("msg_fixture_plugin"), id: Tool.CallID.make("call_fixture_plugin"), signal: new AbortController().signal, async progress() {} };
  for (const action of ["record_alias", "record_relationship"]) {
    const tool = registered.find((entry) => entry.name === action);
    expect(tool).toBeDefined();
    if (!tool) throw new Error(`Missing ${action}`);
    expect(tool.options).toMatchObject({ codemode: false, permission: action });
    expect(tool.input).not.toHaveProperty("properties.runId");
    expect(tool.input).not.toHaveProperty("properties.transportCredential");
    const input = action === "record_alias" ? { alias: "SDK", expansion: "software development kit", evidenceSourceIds: ["source-1"] } : { fromItemId: "item-1", toItemId: "item-2", fromVersionId: "version-1", toVersionId: "version-2", type: "suggests", rationale: "Evidence", evidenceSourceIds: ["source-1"] };
    await expect(tool.execute(input, native)).rejects.toThrow("fixture permission denied");
  }
  expect(actions).toEqual(["record_alias", "record_relationship"]);
});
