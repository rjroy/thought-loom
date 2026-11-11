import { downloadBytes } from "./request";
import type { MarkdownArtifact } from "./types";

export function downloadMarkdown(artifact: MarkdownArtifact, filename: string) {
  const bytes = downloadBytes(artifact);
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "text/markdown;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = filename;
  document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
