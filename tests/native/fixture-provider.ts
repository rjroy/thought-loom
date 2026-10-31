import { WitnessGuardError } from "./plugin-isolation";

export const ORIGINAL = "Controlled fixture original: a pause can make an idea clearer.";
export const INTERPRETATION = "A pause may support clarification.";
export const FINAL = "fixture-plugin-complete";
export const READ_CALL = "call_witness_read", WRITE_CALL = "call_witness_write";
export const USER_INPUT = "Controlled dialogue input: develop the pause into a deliberate thinking practice.";
export const IDEA = "A deliberate pause can preserve an emerging thought before acting.";
export const DIALOGUE_FINAL = "fixture-dialogue-complete";
export const TURN_READ_CALL = "call_witness_turn_read", IDEA_CALL = "call_witness_idea";
export const PROVIDER_LIMITS = { captureRequests: 9, dialogueRequests: 5, totalRequests: 14, domainTurns: 6, requestBytes: 1_048_576 } as const;
export type DialogueFixture = { dialogueId: string; turnId: string; turnSourceId: string; derivedFrom: { itemId: string; versionId: string } };
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function check(value: unknown, code: string): asserts value { if (!value) throw new WitnessGuardError(code); }

// Pure fixture state, shared with ordinary tests. It is exactly two fixed flows,
// not a model/SDK emulator: capture read/write/final, then turn read/idea/final.
export function fixtureConversation(sourceId: string) {
  let requests = 0, captureRequests = 0, dialogueRequests = 0, captureTurns = 0, dialogueTurns = 0, failed = false;
  let dialogue: DialogueFixture | undefined;
  function attempt<T>(action: () => T): T {
    try { check(!failed, "provider_already_failed"); return action(); }
    catch (error) { failed = true; throw error; }
  }
  return {
    beginRequest(method: string, path: string) {
      attempt(() => {
        check(++requests <= PROVIDER_LIMITS.totalRequests, "provider_request_budget");
        check(dialogue ? ++dialogueRequests <= PROVIDER_LIMITS.dialogueRequests : ++captureRequests <= PROVIDER_LIMITS.captureRequests, "provider_phase_request_budget");
        check(method === "POST" && path === "/v1/chat/completions", "provider_route_rejected");
      });
    },
    beginDialogue(context: DialogueFixture) {
      attempt(() => {
        check(captureTurns === 3 && !dialogue, "provider_dialogue_order_rejected");
        const ids = [sourceId, context.dialogueId, context.turnId, context.turnSourceId, context.derivedFrom.itemId, context.derivedFrom.versionId];
        check(ids.every((id) => /^[A-Za-z0-9._~-]{1,128}$/.test(id)) && new Set(ids).size === ids.length, "provider_dialogue_scope_rejected");
        dialogue = { ...context, derivedFrom: { ...context.derivedFrom } };
      });
    },
    reply(body: unknown): { delta: unknown; finish: string } {
      return attempt(() => {
        check(record(body) && body.model === "fixture-model" && Array.isArray(body.messages) && body.stream === true, "provider_payload_rejected");
        const messages = body.messages;
        const tools = body.tools === undefined ? [] : body.tools;
        check(Array.isArray(tools), "provider_tools_rejected");
        if (!tools.length) return { delta: { content: "fixture auxiliary" }, finish: "stop" };
        const names = tools.map((entry: unknown) => record(entry) && record(entry.function) ? entry.function.name : null).sort();
        check(JSON.stringify(names) === JSON.stringify(dialogue ? ["read_source", "record_idea"] : ["read_source", "record_interpretation"]), "provider_tool_surface_rejected");
        if (!dialogue) {
          check(captureTurns < 3, "provider_turn_budget");
          if (captureTurns === 0) { captureTurns++; return { delta: tool(READ_CALL, "read_source", { sourceId }), finish: "tool_calls" }; }
          if (captureTurns === 1) {
            check(hasToolResult(messages, READ_CALL, ORIGINAL), "native_read_result_missing");
            captureTurns++; return { delta: tool(WRITE_CALL, "record_interpretation", { sourceId, text: INTERPRETATION, evidenceSourceIds: [sourceId] }), finish: "tool_calls" };
          }
          check(hasToolResult(messages, WRITE_CALL, INTERPRETATION), "native_write_result_missing");
          captureTurns++; return { delta: { content: FINAL }, finish: "stop" };
        }
        check(dialogueTurns < 3, "provider_turn_budget");
        if (dialogueTurns === 0) {
          const prompt = messages.filter((message) => record(message) && message.role === "user").map((message) => JSON.stringify(message)).join("\n");
          check([ORIGINAL, USER_INPUT, INTERPRETATION, sourceId, dialogue.dialogueId, dialogue.turnId, dialogue.turnSourceId, dialogue.derivedFrom.itemId, dialogue.derivedFrom.versionId]
            .every((value) => prompt.includes(value)), "native_dialogue_prompt_missing");
          dialogueTurns++; return { delta: tool(TURN_READ_CALL, "read_source", { sourceId: dialogue.turnSourceId }), finish: "tool_calls" };
        }
        if (dialogueTurns === 1) {
          check(hasToolResult(messages, TURN_READ_CALL, USER_INPUT), "native_turn_read_result_missing");
          dialogueTurns++;
          return { delta: tool(IDEA_CALL, "record_idea", { rootSourceId: sourceId, turnSourceId: dialogue.turnSourceId, dialogueId: dialogue.dialogueId,
            turnId: dialogue.turnId, text: IDEA, evidenceSourceIds: [sourceId, dialogue.turnSourceId], derivedFrom: dialogue.derivedFrom }), finish: "tool_calls" };
        }
        check([IDEA, "developing-idea", sourceId, dialogue.dialogueId, dialogue.turnId, dialogue.turnSourceId, dialogue.derivedFrom.itemId, dialogue.derivedFrom.versionId]
          .every((value) => hasToolResult(messages, IDEA_CALL, value)), "native_idea_result_missing");
        dialogueTurns++; return { delta: { content: DIALOGUE_FINAL }, finish: "stop" };
      });
    },
    fail() { failed = true; },
    counts: () => ({ requests, captureRequests, dialogueRequests, turns: captureTurns + dialogueTurns, captureTurns, dialogueTurns, failed }),
  };
}

// Deterministic, test-owned OpenAI-compatible streaming replies. No proxy,
// credentials, outbound fetch or model implementation lives in this server.
export function fixtureProvider(sourceId: string, signal: AbortSignal) {
  const conversation = fixtureConversation(sourceId);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, maxRequestBodySize: PROVIDER_LIMITS.requestBytes,
    async fetch(request) {
      try {
        signal.throwIfAborted();
        conversation.beginRequest(request.method, new URL(request.url).pathname);
        const reader = request.body?.getReader();
        check(reader, "provider_body_required");
        const onAbort = () => { void reader.cancel().catch(() => {}); };
        signal.addEventListener("abort", onAbort, { once: true });
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        try {
          for (;;) {
            signal.throwIfAborted();
            const part = await reader.read();
            if (part.done) break;
            check((bytes += part.value.byteLength) <= PROVIDER_LIMITS.requestBytes, "provider_body_budget");
            chunks.push(part.value);
          }
        } finally { signal.removeEventListener("abort", onAbort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const { delta, finish } = conversation.reply(body);
        const chunk = (part: unknown, reason: string | null) => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture-model",
          choices: [{ index: 0, delta: part, finish_reason: reason }], ...(reason ? { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } : {}) })}\n\n`;
        return new Response(chunk(delta, null) + chunk({}, finish) + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
      } catch {
        conversation.fail();
        return new Response("fixture request rejected", { status: 400 });
      }
    },
    error() { conversation.fail(); return new Response("fixture failure", { status: 500 }); },
  });
  return { origin: `http://127.0.0.1:${server.port}`, counts: conversation.counts, beginDialogue: conversation.beginDialogue, close: () => server.stop(true) };
}
function hasToolResult(messages: unknown[], id: string, expected: string) {
  return messages.some((message) => record(message) && message.role === "tool" && message.tool_call_id === id && JSON.stringify(message.content).includes(expected));
}
function tool(id: string, name: string, args: unknown) {
  return { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] };
}
