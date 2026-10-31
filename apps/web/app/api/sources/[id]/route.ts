import { privateJSON, readSource } from "../../../../lib/daemon";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  const result = await readSource(id);
  if (result.kind === "found") return privateJSON(result.source, 200);
  if (result.kind === "not-found") return privateJSON({ error: "Source not found" }, 404);
  return privateJSON({ error: "Source could not be read" }, 503);
}
