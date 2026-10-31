import { privateJSON, readInquiry } from "../../../../../lib/daemon";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const result = await readInquiry((await params).id);
  if (result.kind === "found") return privateJSON(result.value, 200);
  return result.kind === "not-found" ? privateJSON({ error: "Source not found" }, 404) : privateJSON({ error: "Inquiry unavailable" }, 503);
}
