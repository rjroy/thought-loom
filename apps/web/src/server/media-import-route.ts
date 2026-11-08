import "server-only";
import { createLogger } from "../../../../src/logging";
import { readWebConfig } from "./config";
import { createImportBoundary } from "./import";

/** Fixed media route adapters share the same trusted server-only boundary. */
export async function handleMediaImport(request: Request): Promise<Response> {
  try {
    const config = readWebConfig(process.env);
    const maxFileBytes = Number(process.env.THOUGHTLOOM_MEDIA_MAX_BYTES ?? 16777216);
    return await createImportBoundary({config,fetch,logger:createLogger("verbose"),timeoutMs:10000,maxFileBytes})(request);
  } catch {
    return Response.json({message:"Import unavailable."},{status:503,headers:{"cache-control":"private, no-store"}});
  }
}
