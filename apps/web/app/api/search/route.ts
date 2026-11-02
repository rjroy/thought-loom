import { privateJSON, readSearch } from "../../../lib/daemon";
import { parseSearchParameters } from "@thoughtloom/contracts";

export async function GET(request: Request): Promise<Response> {
  const input = parseSearchParameters(new URL(request.url).searchParams);
  const result = input ? await readSearch(input) : { kind: "invalid" as const };
  if (result.kind === "found") return privateJSON(result.value, 200);
  return result.kind === "invalid" ? privateJSON({ error: "Use up to 512 characters and a result limit from 1 to 200" }, 400) : privateJSON({ error: "Search unavailable" }, 503);
}
