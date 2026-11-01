// Import-only fixture seams. No discovery, process, provider or model startup.
import type { OpenCodeClient, SessionMessageInfo } from "../../apps/daemon/tests/native-client-support";
import { WitnessGuardError } from "./plugin-isolation";

export type FixtureHistoryClient = { message: Pick<OpenCodeClient["message"], "list"> };
export type TitleHistoryScope = { sessionId: string; agent: string; messageId: string; callId: string; signal: AbortSignal };

function check(value: unknown, code: string): asserts value { if (!value) throw new WitnessGuardError(code); }
function requestOptions(signal: AbortSignal) { return { signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]) }; }

// Extracted unchanged from the baseline witness, including its bounded guards.
export async function canonicalHistory(client: FixtureHistoryClient, sessionId: string, signal: AbortSignal): Promise<SessionMessageInfo[]> {
  const result: SessionMessageInfo[] = [], seen = new Set<string>(), cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const next = await client.message.list({ sessionID: sessionId, limit: 50, ...(cursor ? { cursor } : { order: "asc" as const }) }, requestOptions(signal));
    for (const message of next.data) { check(!seen.has(message.id), "witness_history_duplicate"); seen.add(message.id); result.push(message); }
    if (!next.cursor.next) return result;
    check(!cursors.has(next.cursor.next), "witness_history_cursor_loop");
    cursor = next.cursor.next; cursors.add(cursor);
  }
  throw new WitnessGuardError("witness_history_page_budget");
}

// Native 2.2.2 emits a next cursor for every nonempty page. Collect through EOF
// before checking the exact completed native tool identity.
export async function verifyTitleHistory(client: FixtureHistoryClient, scope: TitleHistoryScope): Promise<void> {
  const history = await canonicalHistory(client, scope.sessionId, scope.signal);
  check(history.some((message) => message.type === "assistant" && message.id === scope.messageId && message.agent === scope.agent && message.content.some((part) => part.type === "tool" && part.id === scope.callId && part.name === "record_title_v1" && part.state.status === "completed")), "title_native_history_missing");
}
