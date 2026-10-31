import { WitnessGuardError } from "./plugin-isolation";

export const ORIGINAL = "Controlled fixture original: a pause can make an idea clearer.";
export const INTERPRETATION = "A pause may support clarification.";
export const FINAL = "fixture-plugin-complete";
export const READ_CALL = "call_witness_read", WRITE_CALL = "call_witness_write";
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function check(value: unknown, code: string): asserts value { if (!value) throw new WitnessGuardError(code); }

// Deterministic, test-owned OpenAI-compatible streaming replies. No proxy,
// credentials, outbound fetch or model implementation lives in this server.
export function fixtureProvider(sourceId: string, signal: AbortSignal) {
  let requests = 0, stage = 0, failed = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, maxRequestBodySize: 1_048_576,
    async fetch(request) {
      try {
        signal.throwIfAborted();
        check(++requests <= 9, "provider_request_budget");
        check(request.method === "POST" && new URL(request.url).pathname === "/v1/chat/completions", "provider_route_rejected");
        const reader = request.body?.getReader();
        check(reader, "provider_body_required");
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        try {
          for (;;) {
            signal.throwIfAborted();
            const part = await reader.read();
            if (part.done) break;
            check((bytes += part.value.byteLength) <= 1_048_576, "provider_body_budget");
            chunks.push(part.value);
          }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        check(record(body) && body.model === "fixture-model" && Array.isArray(body.messages) && body.stream === true, "provider_payload_rejected");
        const tools = body.tools === undefined ? [] : body.tools;
        check(Array.isArray(tools), "provider_tools_rejected");
        let delta: unknown = { content: "fixture auxiliary" }, finish = "stop";
        if (tools.length) {
          const names = tools.map((tool: unknown) => record(tool) && record(tool.function) ? tool.function.name : null).sort();
          check(JSON.stringify(names) === JSON.stringify(["read_source", "record_interpretation"]), "provider_tool_surface_rejected");
          check(stage < 3, "provider_turn_budget");
          if (stage === 0) {
            delta = tool(READ_CALL, "read_source", { sourceId }); finish = "tool_calls";
          } else if (stage === 1) {
            check(hasToolResult(body.messages, READ_CALL, ORIGINAL), "native_read_result_missing");
            delta = tool(WRITE_CALL, "record_interpretation", { sourceId, text: INTERPRETATION, evidenceSourceIds: [sourceId] }); finish = "tool_calls";
          } else {
            check(hasToolResult(body.messages, WRITE_CALL, INTERPRETATION), "native_write_result_missing");
            delta = { content: FINAL };
          }
          stage++;
        }
        const chunk = (part: unknown, reason: string | null) => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture-model",
          choices: [{ index: 0, delta: part, finish_reason: reason }], ...(reason ? { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } : {}) })}\n\n`;
        return new Response(chunk(delta, null) + chunk({}, finish) + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
      } catch {
        failed = true;
        return new Response("fixture request rejected", { status: 400 });
      }
    },
    error() { failed = true; return new Response("fixture failure", { status: 500 }); },
  });
  return { origin: `http://127.0.0.1:${server.port}`, counts: () => ({ requests, turns: stage, failed }), close: () => server.stop(true) };
}
function hasToolResult(messages: unknown[], id: string, expected: string) {
  return messages.some((message) => record(message) && message.role === "tool" && message.tool_call_id === id && JSON.stringify(message.content).includes(expected));
}
function tool(id: string, name: string, args: unknown) {
  return { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] };
}
