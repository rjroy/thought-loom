import "server-only";
import { createLogger } from "../../../../../../../../src/logging";
import { readWebConfig } from "../../../../../server/config";
import { createImportBoundary } from "../../../../../server/import";

async function handle(request: Request): Promise<Response> {
  try {
    const config = readWebConfig(process.env);
    const maxFileBytes = Number(process.env.THOUGHTLOOM_IMPORT_MAX_BYTES ?? 1048576);
    return await createImportBoundary({ config, fetch, logger: createLogger("verbose"), timeoutMs: 10_000, maxFileBytes })(request);
  } catch {
    return Response.json({ message: "Import unavailable." }, { status: 503, headers: { "cache-control": "private, no-store" } });
  }
}
export const GET = handle;
