import { isRecordId, parseInquiryView, parseSourceRecord } from "@thoughtloom/contracts";

export type ThoughtTextTarget = { kind: "source"; sourceId: string }
  | { kind: "item"; sourceId: string; itemId: string; versionId: string };

export function thoughtTextIdentity(target: ThoughtTextTarget): string {
  return JSON.stringify(target.kind === "source" ? [target.kind, target.sourceId] : [target.kind, target.sourceId, target.itemId, target.versionId]);
}

// Return only the represented body. A disclosure never accepts new inquiry
// metadata, current versions, or staged findings into the surrounding page.
export async function readThoughtText(target: ThoughtTextTarget, signal: AbortSignal): Promise<string> {
  if (!isRecordId(target.sourceId) || (target.kind === "item" && (!isRecordId(target.itemId) || !isRecordId(target.versionId)))) throw new Error("Invalid thought reference");
  const path = `/api/sources/${encodeURIComponent(target.sourceId)}` + (target.kind === "item" ? `/inquiry?${new URLSearchParams({ itemId: target.itemId, versionId: target.versionId })}` : "");
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
  console.info("thought-text.read attempt", { target: thoughtTextIdentity(target) });
  try {
    const response = await fetch(path, { cache: "no-store", redirect: "error", signal: bounded });
    if (!response.ok) throw new Error("Full text unavailable");
    const body: unknown = await response.json();
    let text: string;
    if (target.kind === "source") {
      const source = parseSourceRecord(body);
      if (!source || source.id !== target.sourceId) throw new Error("Source identity changed");
      text = source.text;
    } else {
      const view = parseInquiryView(body), selected = view?.selectedTarget;
      if (!view || view.source.id !== target.sourceId || !selected || selected.id !== target.itemId || selected.versionId !== target.versionId) throw new Error("Represented version unavailable");
      text = selected.text;
    }
    if (bounded.aborted) throw new Error("Read cancelled");
    console.info("thought-text.read succeeded", { target: thoughtTextIdentity(target) });
    return text;
  } catch (error) {
    console.warn("thought-text.read unavailable", { target: thoughtTextIdentity(target), category: bounded.aborted ? "cancelled_or_timed_out" : "read_unavailable" });
    throw error;
  }
}
