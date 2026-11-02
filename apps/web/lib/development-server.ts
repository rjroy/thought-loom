import "server-only";
import { isAllowedRequestOrigin, isIdempotencyKey, isRecordId, parseDialogueInput, parseDialogueStopInput, parseDialogueStopReceipt, parseDialogueTurnInput, parseDialogueTurnReceipt,
  parseDialogueView, parseItemCorrectionInput, parseItemRestoreInput, parseItemView, parseRelationshipRejectInput, parseRelationshipRestoreInput, parseRelationshipView } from "@thoughtloom/contracts";
import { daemonURL, privateJSON, readProjection } from "./daemon";

export async function readDialogue(id: string) {
  if (!isRecordId(id)) return { kind: "not-found" as const };
  return readProjection("bff.dialogue.read", `/dialogues/${encodeURIComponent(id)}`, (body) => {
    const parsed = parseDialogueView(body); return parsed?.id === id ? parsed : null;
  });
}

type Command = "create" | "turn" | "stop" | "correct-item" | "restore-item" | "reject-relationship" | "restore-relationship";

// Closed command set: neither paths, upstream origins nor authority come from
// browser input. Hono assigns user authority and owns all mutations/fences.
export async function developmentCommand(request: Request, command: Command, id: string, turnId?: string): Promise<Response> {
  if (!isAllowedRequestOrigin(request)) return privateJSON({ error: "Cross-origin mutation is not allowed" }, 403);
  if (request.headers.get("sec-fetch-site") === "cross-site") return privateJSON({ error: "Cross-site mutation is not allowed" }, 403);
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") return privateJSON({ error: "JSON required" }, 415);
  const key = request.headers.get("idempotency-key");
  if (!isRecordId(id) || !isIdempotencyKey(key) || (command === "stop" && !isRecordId(turnId))) return privateJSON({ error: "Invalid command identity" }, 400);
  let body: unknown;
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).length > 132_096) return privateJSON({ error: "Input is too long" }, 413);
    body = JSON.parse(raw);
  } catch { return privateJSON({ error: "Invalid JSON" }, 400); }
  const encoded = encodeURIComponent(id);
  let input: object | null, path: string, parse: (value: unknown) => object | null;
  switch (command) {
    case "create":
      input = parseDialogueInput(body); path = `/sources/${encoded}/dialogues`;
      parse = (value) => { const view = parseDialogueView(value); return view?.sourceId === id && JSON.stringify(view.selection) === JSON.stringify(parseDialogueInput(body)?.selection) ? view : null; }; break;
    case "turn":
      input = parseDialogueTurnInput(body); path = `/dialogues/${encoded}/turns`;
      parse = (value) => { const receipt = parseDialogueTurnReceipt(value); return receipt?.dialogueId === id ? receipt : null; }; break;
    case "stop":
      input = parseDialogueStopInput(body); path = `/dialogues/${encoded}/turns/${encodeURIComponent(turnId!)}/stop`;
      parse = (value) => { const receipt = parseDialogueStopReceipt(value); return receipt?.dialogueId === id && receipt.turnId === turnId && receipt.expectedRunId === parseDialogueStopInput(body)?.expectedRunId ? receipt : null; }; break;
    case "correct-item": case "restore-item":
      input = command === "correct-item" ? parseItemCorrectionInput(body) : parseItemRestoreInput(body);
      path = `/items/${encoded}/${command === "correct-item" ? "correct" : "restore"}`;
      parse = (value) => { const item = parseItemView(value); return item?.id === id ? item : null; }; break;
    case "reject-relationship": case "restore-relationship":
      input = command === "reject-relationship" ? parseRelationshipRejectInput(body) : parseRelationshipRestoreInput(body);
      path = `/relationships/${encoded}/${command === "reject-relationship" ? "reject" : "restore"}`;
      parse = (value) => { const relation = parseRelationshipView(value); return relation?.id === id ? relation : null; }; break;
  }
  if (!input) return privateJSON({ error: "Invalid command input" }, 400);
  console.info("bff.development.command attempt", { command, id });
  try {
    const response = await fetch(daemonURL(path), { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify(input), cache: "no-store", redirect: "error", signal: AbortSignal.timeout(8_000) });
    if ([400, 403, 404, 409, 413, 503].includes(response.status)) {
      let code = "command_unavailable";
      if (response.status === 409) {
        const error: unknown = await response.json().catch(() => null);
        code = typeof error === "object" && error !== null && "error" in error && error.error === "turn_conflict" ? "turn_conflict" : "version_or_command_conflict";
      }
      console.info("bff.development.command declined", { command, status: response.status });
      return privateJSON({ error: code }, response.status);
    }
    if (![200, 201, 202].includes(response.status)) throw new Error("Unacknowledged command");
    const value = parse(await response.json());
    if (!value) throw new Error("Invalid command receipt");
    console.info("bff.development.command acknowledged", { command, status: response.status });
    return privateJSON(value, response.status);
  } catch {
    console.warn("bff.development.command unconfirmed", { command, id });
    return privateJSON({ error: "command_unconfirmed" }, 503);
  }
}
