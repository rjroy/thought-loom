import "server-only";
import { createLogger } from "../../../../src/logging";
import { readWebConfig } from "./config";
import { requestDaemon, type DaemonRequest } from "./daemon";

/** Server components and actions own operations and must not accept arbitrary paths from browsers. */
export function callDaemon(request: DaemonRequest): Promise<Response> {
  return requestDaemon(readWebConfig(process.env), request, {
    fetch, logger: createLogger("verbose"), timeoutMs: 10_000,
  });
}
