import { privateJSON, readSpringboard } from "../../../lib/daemon";

export async function GET(): Promise<Response> {
  const result = await readSpringboard();
  return result.kind === "found" ? privateJSON(result.value, 200) : privateJSON({ error: "Thoughts unavailable" }, 503);
}
