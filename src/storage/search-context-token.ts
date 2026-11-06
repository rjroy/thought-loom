import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { SearchConflictError, searchRevision, searchString, type SearchContextClaims } from "../domain/agentic-search";
import { protocolJson } from "../domain/run-protocol";
import { record } from "../domain/validation";

// Process-local, shared by facets/connections. Never persisted in admitted intent or emitted in diagnostics.
const signingKey = randomBytes(32);
const signature = (payload: string): Buffer => createHmac("sha256", signingKey).update(payload).digest();

export function signSearchContext(claims: SearchContextClaims): string {
  const payload = Buffer.from(protocolJson({ version: 1, ...claims })).toString("base64url");
  return `${payload}.${signature(payload).toString("base64url")}`;
}
export function verifySearchContext(token: string): SearchContextClaims {
  try {
    if (token.length > 16384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw new Error();
    const [payload, mac] = token.split(".");
    const received = Buffer.from(mac, "base64url"), expected = signature(payload);
    if (received.length !== expected.length || received.toString("base64url") !== mac || !timingSafeEqual(received, expected)) throw new Error();
    const data = record(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
    const keys = ["version", "sessionId", "composerId", "composerRevision", "eligibilityRevision"];
    if (data.version !== 1 || Object.keys(data).length !== keys.length || keys.some(key => !Object.hasOwn(data, key))) throw new Error();
    return Object.freeze({ sessionId: searchString(data.sessionId, "sessionId"), composerId: searchString(data.composerId, "composerId"),
      composerRevision: searchRevision(data.composerRevision), eligibilityRevision: searchRevision(data.eligibilityRevision) });
  } catch { throw new SearchConflictError("context-changed"); }
}
