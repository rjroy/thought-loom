// Fixed synthetic source-title flow. Importing this module starts no server.
import { WitnessGuardError } from "./plugin-isolation";
import { ORIGINAL } from "./fixture-provider";

export const TITLE_TEXT = "A deliberate pause";
export const TITLE_FINAL = "fixture-title-complete";
export const TITLE_READ_CALL = "call_title_read", TITLE_WRITE_CALL = "call_title_write";
const MAX_REQUESTS = 8, MAX_BYTES = 1_048_576;
function check(value: unknown, code: string): asserts value { if (!value) throw new WitnessGuardError(code); }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function result(messages: unknown[], id: string, expected: string) {
  return messages.some((message) => record(message) && message.role === "tool" && message.tool_call_id === id && JSON.stringify(message.content).includes(expected));
}
function tool(id: string, name: string, args: unknown) {
  return { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] };
}

export function titleFixtureConversation(sourceId: string, expectedHead: string) {
  check(/^[A-Za-z0-9._~-]{1,128}$/.test(sourceId) && /^[A-Za-z0-9._~-]{1,128}$/.test(expectedHead), "title_fixture_scope_invalid");
  let requests = 0, turns = 0, failed = false;
  return {
    reply(method: string, path: string, body: unknown): { delta: unknown; finish: string } {
      try {
        check(!failed && ++requests <= MAX_REQUESTS && method === "POST" && path === "/v1/chat/completions", "title_provider_request_rejected");
        check(record(body) && body.model === "fixture-model" && body.stream === true && Array.isArray(body.messages), "title_provider_payload_rejected");
        const tools = body.tools === undefined ? [] : body.tools;
        check(Array.isArray(tools), "title_provider_tools_rejected");
        if (!tools.length) return { delta: { content: "fixture auxiliary" }, finish: "stop" };
        const names = tools.map((entry: unknown) => record(entry) && record(entry.function) ? entry.function.name : null).sort();
        check(JSON.stringify(names) === JSON.stringify(["read_source", "record_interpretation", "record_title_v1"].sort()), "title_provider_tools_rejected");
        check(turns < 3, "title_provider_turn_budget");
        if (turns++ === 0) return { delta: tool(TITLE_READ_CALL, "read_source", { sourceId }), finish: "tool_calls" };
        if (turns === 2) {
          check(result(body.messages, TITLE_READ_CALL, ORIGINAL) && result(body.messages, TITLE_READ_CALL, expectedHead), "title_provider_read_missing");
          return { delta: tool(TITLE_WRITE_CALL, "record_title_v1", { rootSourceId: sourceId, target: { kind: "source" }, text: TITLE_TEXT, expectedTitleRevisionId: expectedHead }), finish: "tool_calls" };
        }
        check(result(body.messages, TITLE_WRITE_CALL, TITLE_TEXT), "title_provider_write_missing");
        return { delta: { content: TITLE_FINAL }, finish: "stop" };
      } catch (error) { failed = true; throw error; }
    },
    fail() { failed = true; },
    counts() { return { requests, turns, failed }; },
  };
}

export function titleFixtureProvider(sourceId: string, head: string, signal: AbortSignal) {
  const conversation = titleFixtureConversation(sourceId, head);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, maxRequestBodySize: MAX_BYTES,
    async fetch(request) {
      try {
        signal.throwIfAborted();
        const reader = request.body?.getReader(); check(reader, "title_provider_body_required");
        const onAbort = () => { void reader.cancel().catch(() => {}); };
        signal.addEventListener("abort", onAbort, { once: true });
        const chunks: Uint8Array[] = []; let bytes = 0;
        try { for (;;) { signal.throwIfAborted(); const part = await reader.read(); if (part.done) break; check((bytes += part.value.byteLength) <= MAX_BYTES, "title_provider_body_budget"); chunks.push(part.value); } }
        finally { signal.removeEventListener("abort", onAbort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const { delta, finish } = conversation.reply(request.method, new URL(request.url).pathname, body);
        const chunk = (part: unknown, reason: string | null) => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [{ index: 0, delta: part, finish_reason: reason }], ...(reason ? { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } : {}) })}\n\n`;
        return new Response(chunk(delta, null) + chunk({}, finish) + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
      } catch { conversation.fail(); return new Response("fixture request rejected", { status: 400 }); }
    }, error() { conversation.fail(); return new Response("fixture failure", { status: 500 }); },
  });
  return { origin: `http://127.0.0.1:${server.port}`, counts: conversation.counts, close: () => server.stop(true) };
}
