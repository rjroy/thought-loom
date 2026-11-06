import type { Logger } from "../../../../src/logging";
import type { WebConfig } from "./config";

export interface DaemonRequest {
  readonly path: string;
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly body?: string | FormData;
  readonly idempotencyKey?: string;
}

export interface DaemonDependencies {
  readonly fetch: typeof fetch;
  readonly logger: Logger;
  readonly timeoutMs: number;
}

/** Pure transport seam. Production callers must import through a server-only wrapper. */
export async function requestDaemon(config: WebConfig, request: DaemonRequest, deps: DaemonDependencies): Promise<Response> {
  const [pathname] = request.path.split("?");
  if (!pathname || !/^\/(?!\/)[A-Za-z0-9._~/-]*$/.test(pathname)
      || pathname.split("/").some(segment => segment === "." || segment === "..")
      || /[\\#\x00-\x1f\x7f]/.test(request.path)) {
    throw new Error("Invalid daemon path");
  }
  if (!config.userToken || !/^[\x21-\x7e]+$/.test(config.userToken)) throw new Error("Valid user token is required");
  const headers = new Headers({ authorization: `Bearer ${config.userToken}` });
  if (typeof request.body === "string") headers.set("content-type", "application/json");
  if (request.idempotencyKey !== undefined) {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(request.idempotencyKey)) throw new Error("Invalid idempotency key");
    headers.set("idempotency-key", request.idempotencyKey);
  }
  deps.logger.verbose("Daemon request started", { method: request.method });
  try {
    const response = await deps.fetch(`${config.daemonOrigin}${request.path}`, {
      method: request.method, headers, body: request.body, cache: "no-store", redirect: "error",
      signal: AbortSignal.timeout(deps.timeoutMs),
    });
    deps.logger.verbose("Daemon request completed", { method: request.method, status: response.status });
    if (!response.ok) {
      return new Response(null, { status: response.status, headers: { "cache-control": "private, no-store" } });
    }
    return response;
  } catch {
    deps.logger.warning("Daemon request failed", { method: request.method });
    throw new Error("Daemon request failed");
  }
}
