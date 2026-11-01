import { expect, test } from "bun:test";
import { fixtureConversation, ORIGINAL, INTERPRETATION, FINAL, USER_INPUT, IDEA, DIALOGUE_FINAL, READ_CALL, WRITE_CALL, TURN_READ_CALL, IDEA_CALL, PROVIDER_LIMITS,
  type DialogueFixture } from "../../../tests/native/fixture-provider";
import { titleFixtureConversation, titleFixtureProvider, TITLE_READ_CALL, TITLE_WRITE_CALL, TITLE_TEXT, TITLE_FINAL } from "../../../tests/native/title-fixture-provider";
import { readinessFromOutput } from "../../../tests/native/plugin-isolation";

const sourceId = "source_fixture_root";

test("title provider requires exact tool catalog and read receipt before its single fixed write", () => {
  const head = "fixture-head", machine = titleFixtureConversation(sourceId, head), tools = [...captureTools, "record_title_v1"];
  const requestTitle = (body: unknown) => machine.reply("POST", "/v1/chat/completions", body);
  expect(requestTitle(payload(tools)).delta).toMatchObject({ tool_calls: [{ id: TITLE_READ_CALL, function: { name: "read_source" } }] });
  expect(requestTitle(payload(tools, [result(TITLE_READ_CALL, { text: ORIGINAL, titleState: { headRevisionId: head } })])).delta).toMatchObject({ tool_calls: [{ id: TITLE_WRITE_CALL, function: { name: "record_title_v1", arguments: JSON.stringify({ rootSourceId: sourceId, target: { kind: "source" }, text: TITLE_TEXT, expectedTitleRevisionId: head }) } }] });
  expect(requestTitle(payload(tools, [result(TITLE_WRITE_CALL, { text: TITLE_TEXT })]))).toEqual({ delta: { content: TITLE_FINAL }, finish: "stop" });
  expect(() => requestTitle(payload(tools))).toThrow("title_provider_turn_budget");
  const denied = titleFixtureConversation(sourceId, head);
  expect(() => denied.reply("POST", "/v1/chat/completions", payload([...tools, "bash"]))).toThrow("title_provider_tools_rejected");
  const missing = titleFixtureConversation(sourceId, head); missing.reply("POST", "/v1/chat/completions", payload(tools));
  expect(() => missing.reply("POST", "/v1/chat/completions", payload(tools, [result(TITLE_READ_CALL, { text: ORIGINAL })]))).toThrow("title_provider_read_missing");
});

test("title provider HTTP is loopback bounded and fails closed on unexpected tools", async () => {
  const controller = new AbortController(), provider = titleFixtureProvider(sourceId, "fixture-head", controller.signal);
  try {
    expect(readinessFromOutput(`server listening on ${provider.origin}\n`)).toBe(provider.origin);
    const post = (body: unknown) => fetch(`${provider.origin}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), redirect: "error" });
    const first = await post(payload([...captureTools, "record_title_v1"]));
    expect(first.status).toBe(200); expect(await first.text()).toContain(TITLE_READ_CALL);
    const denied = await post(payload([...captureTools, "record_title_v1", "bash"]));
    expect(denied.status).toBe(400); await denied.body?.cancel();
    const after = await post(payload([...captureTools, "record_title_v1"]));
    expect(after.status).toBe(400); await after.body?.cancel();
    expect(provider.counts().failed).toBe(true);
  } finally { controller.abort(); await provider.close(); }
});
const captureTools = ["read_source", "record_interpretation"], dialogueTools = ["read_source", "record_idea"];
function context(): DialogueFixture { return { dialogueId: "dialogue_fixture", turnId: "turn_fixture", turnSourceId: "source_fixture_turn", derivedFrom: { itemId: "item_fixture", versionId: "version_fixture" } }; }
type Conversation = ReturnType<typeof fixtureConversation>;
function payload(tools: string[], messages: unknown[] = []) {
  return { model: "fixture-model", stream: true, messages, tools: tools.map((name) => ({ type: "function", function: { name } })) };
}
function request(machine: Conversation, body: unknown) { machine.beginRequest("POST", "/v1/chat/completions"); return machine.reply(body); }
function result(id: string, content: unknown) { return { role: "tool", tool_call_id: id, content: JSON.stringify(content) }; }
function capture(machine: Conversation) {
  expect(request(machine, payload(captureTools)).delta).toMatchObject({ tool_calls: [{ id: READ_CALL, function: { name: "read_source", arguments: JSON.stringify({ sourceId }) } }] });
  expect(request(machine, payload(captureTools, [result(READ_CALL, { id: sourceId, text: ORIGINAL })])).delta).toMatchObject({ tool_calls: [{ id: WRITE_CALL, function: { name: "record_interpretation" } }] });
  expect(request(machine, payload(captureTools, [result(WRITE_CALL, { text: INTERPRETATION })]))).toEqual({ delta: { content: FINAL }, finish: "stop" });
}
function prompt(selected = context()) {
  return { role: "user", content: JSON.stringify({ original: ORIGINAL, input: USER_INPUT, interpretation: INTERPRETATION, sourceId, ...selected }) };
}
function ideaResult(selected = context()) { return { kind: "developing-idea", text: IDEA, sourceId, derivation: { ...selected, ...selected.derivedFrom } }; }

test("fixed capture and dialogue flows preserve exact scope, require results and finish within separate request budgets", () => {
  const machine = fixtureConversation(sourceId), selected = context();
  capture(machine);
  machine.beginDialogue(selected);
  expect(request(machine, payload(dialogueTools, [prompt(selected)])).delta).toMatchObject({ tool_calls: [{ id: TURN_READ_CALL, function: { name: "read_source", arguments: JSON.stringify({ sourceId: selected.turnSourceId }) } }] });
  expect(request(machine, payload(dialogueTools, [result(TURN_READ_CALL, { text: USER_INPUT })])).delta).toMatchObject({ tool_calls: [{ id: IDEA_CALL, function: { name: "record_idea", arguments: JSON.stringify({ rootSourceId: sourceId, turnSourceId: selected.turnSourceId,
    dialogueId: selected.dialogueId, turnId: selected.turnId, text: IDEA, evidenceSourceIds: [sourceId, selected.turnSourceId], derivedFrom: selected.derivedFrom }) } }] });
  expect(request(machine, payload(dialogueTools, [result(IDEA_CALL, ideaResult(selected))]))).toEqual({ delta: { content: DIALOGUE_FINAL }, finish: "stop" });
  expect(machine.counts()).toEqual({ requests: 6, captureRequests: 3, dialogueRequests: 3, turns: 6, captureTurns: 3, dialogueTurns: 3, failed: false });
  expect(() => request(machine, payload(dialogueTools))).toThrow("provider_turn_budget");
});

test("capture never accepts idea advertisement and dialogue never accepts the capture or a widened catalog", () => {
  for (const tools of [dialogueTools, [...captureTools, "record_idea"], [...captureTools, "bash"]]) {
    const machine = fixtureConversation(sourceId);
    expect(() => request(machine, payload(tools))).toThrow("provider_tool_surface_rejected");
  }
  for (const tools of [captureTools, [...dialogueTools, "record_interpretation"], [...dialogueTools, "bash"]]) {
    const machine = fixtureConversation(sourceId); capture(machine); machine.beginDialogue(context());
    expect(() => request(machine, payload(tools, [prompt()]))).toThrow("provider_tool_surface_rejected");
  }
});

test("dialogue requires completed capture, an immutable distinct scope and the actual current input/pinned prompt", () => {
  expect(() => fixtureConversation(sourceId).beginDialogue(context())).toThrow("provider_dialogue_order_rejected");
  const duplicate = fixtureConversation(sourceId); capture(duplicate); duplicate.beginDialogue(context());
  expect(() => duplicate.beginDialogue(context())).toThrow("provider_dialogue_order_rejected");
  const invalid = fixtureConversation(sourceId); capture(invalid);
  expect(() => invalid.beginDialogue({ ...context(), turnSourceId: sourceId })).toThrow("provider_dialogue_scope_rejected");
  const missing = fixtureConversation(sourceId); capture(missing); missing.beginDialogue(context());
  expect(() => request(missing, payload(dialogueTools, [{ role: "user", content: ORIGINAL }]))).toThrow("native_dialogue_prompt_missing");
  const copied = fixtureConversation(sourceId), selected = context(); capture(copied); copied.beginDialogue(selected);
  selected.turnSourceId = "source_forged"; selected.derivedFrom.itemId = "item_forged";
  expect(request(copied, payload(dialogueTools, [prompt()])).delta).toMatchObject({ tool_calls: [{ function: { arguments: JSON.stringify({ sourceId: context().turnSourceId }) } }] });
});

test("missing/wrong read, write and idea receipts fail closed rather than advancing to a fabricated final", () => {
  const read = fixtureConversation(sourceId); request(read, payload(captureTools));
  expect(() => request(read, payload(captureTools, [result("wrong-call", { text: ORIGINAL })]))).toThrow("native_read_result_missing");
  const write = fixtureConversation(sourceId); request(write, payload(captureTools)); request(write, payload(captureTools, [result(READ_CALL, { text: ORIGINAL })]));
  expect(() => request(write, payload(captureTools))).toThrow("native_write_result_missing");
  const turn = fixtureConversation(sourceId); capture(turn); turn.beginDialogue(context()); request(turn, payload(dialogueTools, [prompt()]));
  expect(() => request(turn, payload(dialogueTools, [result(TURN_READ_CALL, { text: "unrelated" })]))).toThrow("native_turn_read_result_missing");
  const idea = fixtureConversation(sourceId); capture(idea); idea.beginDialogue(context()); request(idea, payload(dialogueTools, [prompt()])); request(idea, payload(dialogueTools, [result(TURN_READ_CALL, { text: USER_INPUT })]));
  expect(() => request(idea, payload(dialogueTools, [result(IDEA_CALL, { ...ideaResult(), derivation: {} })]))).toThrow("native_idea_result_missing");
});

test("auxiliary requests cannot exhaustlessly bypass per-flow or total caps, or advance domain turns", () => {
  const captureOnly = fixtureConversation(sourceId);
  for (let i = 0; i < PROVIDER_LIMITS.captureRequests; i++) request(captureOnly, payload([]));
  expect(captureOnly.counts().turns).toBe(0);
  expect(() => request(captureOnly, payload([]))).toThrow("provider_phase_request_budget");
  const dialogueOnly = fixtureConversation(sourceId); capture(dialogueOnly); dialogueOnly.beginDialogue(context());
  for (let i = 0; i < PROVIDER_LIMITS.dialogueRequests; i++) request(dialogueOnly, payload([]));
  expect(dialogueOnly.counts().dialogueTurns).toBe(0);
  expect(() => request(dialogueOnly, payload([]))).toThrow("provider_phase_request_budget");
  const combined = fixtureConversation(sourceId); capture(combined);
  for (let i = 3; i < PROVIDER_LIMITS.captureRequests; i++) request(combined, payload([]));
  combined.beginDialogue(context());
  for (let i = 0; i < PROVIDER_LIMITS.dialogueRequests; i++) request(combined, payload([]));
  expect(combined.counts().requests).toBe(PROVIDER_LIMITS.totalRequests);
  expect(() => request(combined, payload([]))).toThrow("provider_request_budget");
});

test("unexpected routes, models, nonstreaming payloads and failed fixture reuse are rejected", () => {
  const route = fixtureConversation(sourceId);
  expect(() => route.beginRequest("GET", "/v1/models")).toThrow("provider_route_rejected");
  expect(() => request(route, payload(captureTools))).toThrow("provider_already_failed");
  for (const body of [{ ...payload(captureTools), model: "paid-model" }, { ...payload(captureTools), stream: false }, { ...payload(captureTools), messages: "invalid" }]) {
    const machine = fixtureConversation(sourceId);
    expect(() => request(machine, body)).toThrow("provider_payload_rejected");
    expect(machine.counts().failed).toBe(true);
  }
});
