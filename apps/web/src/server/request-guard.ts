import type { WebConfig } from "./config";

/** Checks the actual Host and, for mutations, the browser Origin. */
export function isTrustedRequest(config: WebConfig, request: Request): boolean {
  const host = request.headers.get("host");
  const read = request.method === "GET" || request.method === "HEAD";
  return config.webOrigins.some(origin => host === new URL(origin).host
    && (read || request.headers.get("origin") === origin));
}
