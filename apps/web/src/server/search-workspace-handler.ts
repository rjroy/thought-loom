import "server-only";
import { createLogger } from "../../../../src/logging";
import { readWebConfig } from "./config";
import { createSearchWorkspaceBoundary } from "./search-workspace";

export async function handleSearchWorkspace(request: Request): Promise<Response> {
  try { return await createSearchWorkspaceBoundary({config:readWebConfig(process.env),fetch,logger:createLogger("verbose"),timeoutMs:10_000})(request); }
  catch { return Response.json({message:"Search unavailable."},{status:503,headers:{"cache-control":"private, no-store"}}); }
}
