import "server-only";
import { createLogger } from "../../../../src/logging";
import { readWebConfig } from "./config";
import { createSearchSessionBoundary } from "./search-sessions";

export async function handleSearchSession(request: Request): Promise<Response> {
  try {
    return await createSearchSessionBoundary({config:readWebConfig(process.env),fetch,logger:createLogger("verbose"),timeoutMs:10_000})(request);
  } catch {
    return Response.json({message:"Search sessions unavailable."},{status:503,headers:{"cache-control":"private, no-store"}});
  }
}
