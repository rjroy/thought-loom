import { privateJSON } from "../../../../lib/daemon";
import { readDialogue } from "../../../../lib/development-server";
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const result = await readDialogue((await params).id);
  return result.kind === "found" ? privateJSON(result.value, 200) : privateJSON({ error: result.kind === "not-found" ? "Discussion not found" : "Discussion unavailable" }, result.kind === "not-found" ? 404 : 503);
}
