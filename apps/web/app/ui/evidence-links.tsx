import Link from "next/link";
import type { EvidenceSource } from "@thoughtloom/contracts";
import { sourceHref } from "../../lib/links";

export default function EvidenceLinks({ ids, sources, prefix = "Evidence:", query = "" }: { ids: string[]; sources: EvidenceSource[]; prefix?: string; query?: string }) {
  return <ul className="evidence-links">{ids.map((id) => {
    const source = sources.find((entry) => entry.id === id);
    return <li key={id}>{source ? <Link href={sourceHref(id, source.origin?.kind === "discussion-turn" ? query : "")}>{prefix} {source.excerpt.slice(0, 90)}{source.excerpt.length > 90 ? "…" : ""}</Link> : <span>Evidence source unavailable</span>}</li>;
  })}</ul>;
}
