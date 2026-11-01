import Link from "next/link";
import type { EvidenceSource } from "@thoughtloom/contracts";
import { sourceHref } from "../../lib/links";
import { ThoughtTextDisclosure } from "./text-disclosure";

export default function EvidenceLinks({ ids, sources, prefix = "Evidence:", query = "" }: { ids: string[]; sources: EvidenceSource[]; prefix?: string; query?: string }) {
  return <ul className="evidence-links">{ids.map((id) => {
    const source = sources.find((entry) => entry.id === id);
    const href = sourceHref(id, source?.origin?.kind === "discussion-turn" ? query : "");
    return <li key={id} className="source-excerpt-disclosure">{source ? <ThoughtTextDisclosure target={{ kind: "source", sourceId: id }} preview={{
      collapsed: <Link href={href}>{prefix} {source.excerpt.slice(0, 90)}{source.excerpt.length > 90 ? "…" : ""}</Link>,
      expanded: <Link href={href}>{prefix} Open source</Link>,
    }} /> : <span>Evidence source unavailable</span>}</li>;
  })}</ul>;
}
