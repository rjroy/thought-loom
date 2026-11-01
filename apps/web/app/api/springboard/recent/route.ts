import { privateJSON, readRecentThoughts } from "../../../../lib/daemon";

export async function GET(): Promise<Response> {
  const result = await readRecentThoughts();
  return result.kind === "found" ? privateJSON(result.value, 200) : privateJSON({ error: "Recent thoughts unavailable" }, 503);
}
