import { privateJSON } from "../../../../../lib/daemon";
import { readFollowUps } from "../../../../../lib/follow-up-server";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const result = await readFollowUps((await params).id);
  if (result.kind === "found") return privateJSON(result.value, 200);
  return privateJSON({ error: result.kind === "not-found" ? "Source not found" : "Follow-up status unavailable" }, result.kind === "not-found" ? 404 : 503);
}
