import { isRecordId } from "@thoughtloom/contracts";
import { privateJSON } from "../../../../../lib/daemon";
import { readThoughtTitle, titleCommand } from "../../../../../lib/title-server";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params, query = new URL(request.url).searchParams, items = query.getAll("itemId"), versions = query.getAll("versionId");
  if (!isRecordId(id) || items.length !== versions.length || items.length > 1 || (items.length === 1 && (!isRecordId(items[0]) || !isRecordId(versions[0])))) return privateJSON({ error: "invalid_input" }, 400);
  const result = await readThoughtTitle(id, items.length ? { kind: "item", itemId: items[0], versionId: versions[0] } : { kind: "source" });
  return result.kind === "found" ? privateJSON(result.value, 200) : privateJSON({ error: "title_unavailable" }, result.kind === "not-found" ? 404 : 503);
}
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return titleCommand(request, (await params).id);
}
