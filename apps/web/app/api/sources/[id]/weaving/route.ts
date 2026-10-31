import { privateJSON, readWeaving } from "../../../../../lib/daemon";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const result = await readWeaving((await params).id);
  if (result.kind === "found") return privateJSON(result.value, 200);
  return privateJSON({ error: result.kind === "not-found" ? "Source not found" : "Status unavailable" }, result.kind === "not-found" ? 404 : 503);
}
