import type { IdeaThought } from "../idea/types";
import type { ExportSource } from "./types";
import { thought } from "../idea/validation";

export function sourceCandidates(markdown: string): readonly string[] {
  const marker = "\n\n## Sources\n\n";
  const start = markdown.lastIndexOf(marker);
  if (start < 0 || !markdown.endsWith("\n")) return [];
  const block = markdown.slice(start + marker.length, -1);
  if (block === "No source thoughts were cited; this report has no validated thought citations.") return [];
  const prefix = "Recorded thought identities and attribution (not endorsement):\n\n";
  if (!block.startsWith(prefix)) return [];
  const ids: string[] = [];
  for (const line of block.slice(prefix.length).split("\n")) {
    const match = /^- (.+): ID: (`+)("(?:\\.|[^"\\])*")\2; thought author: (?:user|ai|source); kind: (?:(?:captured-original|user-contribution|ai-interpretation|developing-idea|imported-original)\.|media-original\. Access to the descriptor or clarification does not imply binary file access\.)$/.exec(line);
    if (!match) return [];
    try {
      const id: unknown = JSON.parse(match[3]);
      const longest = (match[3].match(/`+/g) ?? []).reduce((max, ticks) => Math.max(max, ticks.length), 0);
      if (typeof id !== "string" || !id.trim() || JSON.stringify(id) !== match[3] || match[2].length !== longest + 1) return [];
      if (!ids.includes(id)) ids.push(id);
    } catch { return []; }
  }
  return ids;
}
export async function resolveSources(ids: readonly string[], getThought: (id: string, scope: "normal") => Promise<IdeaThought | null>): Promise<readonly ExportSource[]> {
  const result: ExportSource[] = [];
  for (const id of ids) {
    let value: IdeaThought | null = null;
    try { const found = await getThought(id, "normal"); if (thought(found) && found.id === id && found.rejected !== true) value = found; } catch { /* Unavailable stays unavailable. */ }
    result.push({ id, thought: value });
  }
  return result;
}
