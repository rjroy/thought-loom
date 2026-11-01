import { privateJSON, readInquiry } from "../../../../../lib/daemon";
import { isRecordId } from "@thoughtloom/contracts";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const query = new URL(request.url).searchParams, items = query.getAll("itemId"), versions = query.getAll("versionId");
  if (items.length > 1 || versions.length > 1 || items.length !== versions.length || (items.length === 1 && (!isRecordId(items[0]) || !isRecordId(versions[0])))) return privateJSON({ error: "Invalid selected target" }, 400);
  const result = await readInquiry((await params).id, items.length ? { itemId: items[0], versionId: versions[0] } : undefined);
  if (result.kind === "found") return privateJSON(result.value, 200);
  return result.kind === "not-found" ? privateJSON({ error: "Source not found" }, 404) : privateJSON({ error: "Inquiry unavailable" }, 503);
}
