import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { searchPageLimit, searchRevision, searchString } from "../domain/agentic-search";
import type { SearchWorkspaceCollection } from "../domain/agentic-search-workspace";
import { protocolJson, uniqueKeys } from "../domain/run-protocol";
import { record, ValidationError } from "../domain/validation";

interface WorkspaceCursor {
  readonly version: 1; readonly purpose: "search-workspace-page"; readonly kind: SearchWorkspaceCollection;
  readonly sessionId: string; readonly scope: "normal"; readonly order: "position-asc";
  readonly limit: number; readonly after: number; readonly highWater: number;
}
// Separate purpose/key from composer claims. These page positions never authorize content or reset a ledger.
const key = randomBytes(32);
const mac = (payload: string): Buffer => createHmac("sha256", key).update(payload).digest();

export function signWorkspaceCursor(kind: SearchWorkspaceCollection, sessionId: string, limit: number, after: number, highWater: number): string {
  const cursor: WorkspaceCursor = { version: 1, purpose: "search-workspace-page", kind, sessionId, scope: "normal", order: "position-asc", limit, after, highWater };
  const payload = Buffer.from(protocolJson(cursor)).toString("base64url");
  return `${payload}.${mac(payload).toString("base64url")}`;
}
export function workspaceContinuation(token: string | null, kind: SearchWorkspaceCollection, sessionId: string,
  requestedLimit: number | null): { readonly limit: number; readonly cursor: WorkspaceCursor | null } {
  if (token === null) return { limit: requestedLimit ?? 50, cursor: null };
  try {
    if (token.length > 16384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw new Error();
    const [payload, signature] = token.split(".");
    const received = Buffer.from(signature, "base64url"), expected = mac(payload);
    if (received.length !== expected.length || received.toString("base64url") !== signature || !timingSafeEqual(received, expected)) throw new Error();
    const bytes = Buffer.from(payload, "base64url");
    if (bytes.toString("base64url") !== payload) throw new Error();
    const json = bytes.toString("utf8");
    uniqueKeys(json);
    const data = record(JSON.parse(json)), keys = ["version", "purpose", "kind", "sessionId", "scope", "order", "limit", "after", "highWater"];
    if (Object.keys(data).length !== keys.length || keys.some(field => !Object.hasOwn(data, field)) ||
        data.version !== 1 || data.purpose !== "search-workspace-page" || data.kind !== kind || data.scope !== "normal" ||
        data.order !== "position-asc" || searchString(data.sessionId, "sessionId") !== sessionId) throw new Error();
    const limit = searchPageLimit(data.limit), after = searchRevision(data.after), highWater = searchRevision(data.highWater);
    if (after > highWater || (requestedLimit !== null && requestedLimit !== limit)) throw new Error();
    return { limit, cursor: { version: 1, purpose: "search-workspace-page", kind, sessionId, scope: "normal", order: "position-asc", limit, after, highWater } };
  } catch { throw new ValidationError("Invalid search workspace continuation"); }
}
