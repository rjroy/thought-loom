import type { WebConfig } from "./config";

/** Checks the actual Host and, for mutations, the browser Origin. */
export function isTrustedRequest(config: WebConfig, request: Request): boolean {
  if (request.headers.get("host") !== new URL(config.webOrigin).host) return false;
  if (request.method === "GET" || request.method === "HEAD") return true;
  return request.headers.get("origin") === config.webOrigin;
}
