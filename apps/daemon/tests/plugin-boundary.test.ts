import { expect, test } from "bun:test";
import { Agent } from "@opencode/schema/agent";
import { Session } from "@opencode/schema/session";
import { SessionMessage } from "@opencode/schema/session-message";
import { Tool } from "@opencode/schema/tool";
import { forwardInterpretation, type NativeToolContext, type ToolEnvelope } from "../../../packages/agent-tools/src/plugin";

function nativeContext(): NativeToolContext {
  return {
    sessionID: Session.ID.make("ses_fixture_owned"), agent: Agent.ID.make("weaver"),
    messageID: SessionMessage.ID.make("msg_fixture_assistant"), id: Tool.CallID.make("call_fixture_1"),
    signal: new AbortController().signal, async progress() {},
  };
}

test("native tool permission assertion precedes forwarding and forged context fields cannot override native identity", async () => {
  const native = nativeContext();
  const events: string[] = [];
  let sent: ToolEnvelope | undefined;
  const result = await forwardInterpretation({ sourceId: "source-1", text: "Tentative", evidenceSourceIds: ["source-1"], sessionID: "forged", runId: "forged", agent: "forged" }, native, {
    async assertPermission(input) {
      events.push("permission");
      expect(input).toMatchObject({ sessionID: native.sessionID, agent: native.agent, source: { type: "tool", messageID: native.messageID, id: native.id } });
    },
    async send(envelope, signal) {
      events.push("send"); sent = envelope;
      expect(signal).toBe(native.signal);
      return { ok: true };
    },
  });
  expect(result).toEqual({ ok: true });
  expect(events).toEqual(["permission", "send"]);
  expect(sent).toEqual({ native: { sessionID: native.sessionID, agent: native.agent, messageID: native.messageID, callID: native.id }, action: "record_interpretation", input: { sourceId: "source-1", text: "Tentative", evidenceSourceIds: ["source-1"] } });
});

test("native permission rejection prevents transport", async () => {
  let forwarded = false;
  await expect(forwardInterpretation({ sourceId: "source-1", text: "Tentative", evidenceSourceIds: ["source-1"] }, nativeContext(), {
    async assertPermission() { throw new Error("denied"); },
    async send() { forwarded = true; return {}; },
  })).rejects.toThrow("denied");
  expect(forwarded).toBe(false);
});
