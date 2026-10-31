import { privateJSON, readSearch } from "../../../lib/daemon";

export async function GET(request: Request): Promise<Response> {
  const result = await readSearch(new URL(request.url).searchParams.get("q") ?? "");
  if (result.kind === "found") return privateJSON({ results: result.results }, 200);
  return result.kind === "invalid" ? privateJSON({ error: "Use up to 16 words and 512 characters" }, 400) : privateJSON({ error: "Search unavailable" }, 503);
}
