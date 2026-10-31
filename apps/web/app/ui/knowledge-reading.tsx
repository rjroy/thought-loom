import type { EvidenceSource, ItemView, RelationshipView } from "@thoughtloom/contracts";
import Link from "next/link";
import { inquiryHref } from "../../lib/links";
import EvidenceLinks from "./evidence-links";

export function InterpretationReading({ item, sources, selected }: { item: ItemView; sources: EvidenceSource[]; selected: boolean }) {
  const attribution = item.current.author === "ai" ? item.kind === "interpretation" ? "AI interpretation" : "AI developing idea" : "Your recorded formulation";
  return <article className={`interpretation-reading${selected ? " matched-reading" : ""}`} id={`item-${item.id}`} tabIndex={-1}>
    <p className="attribution"><span>{attribution}</span>{item.current.author === "ai" && <span className="hypothesis-state">Tentative</span>}</p>
    <p className="current-formulation">{item.current.text}</p>
    {selected && <p className="selection-context">Matched in your search</p>}
    <EvidenceLinks ids={item.current.evidenceSourceIds} sources={sources} />
    <details className="reading-history"><summary role="button">View history</summary><section aria-label="Formulation history"><ol>{item.history.map((version, index) => <li key={version.id}><p className="version-meta">{item.historyTruncated ? "Shown version" : "Version"} {index + 1}{version.id === item.current.id ? " · Current" : ""} · {version.author === "ai" ? "AI-authored" : "Written by you"}</p><p>{version.text}</p><EvidenceLinks ids={version.evidenceSourceIds} sources={sources} prefix="Version evidence:" /></li>)}</ol>{item.historyTruncated && <p className="history-limit">Only the latest {item.history.length} versions are shown. Older history remains stored.</p>}</section></details>
  </article>;
}

export function ConnectionReading({ relation, items, sources, sourceId, query }: { relation: RelationshipView; items: ItemView[]; sources: EvidenceSource[]; sourceId: string; query: string }) {
  const from = items.find((item) => item.id === relation.fromItemId);
  const to = items.find((item) => item.id === relation.toItemId);
  if (!from || !to) return <p role="alert">This connection could not be resolved. Open the saved original instead.</p>;
  const connected = from.sourceId === sourceId ? to : from;
  return <article className="connection-reading">
    <p className="attribution"><span>{relation.current.author === "ai" ? "AI suggestion" : "Your recorded connection"}</span><span className="hypothesis-state">{relation.current.status === "rejected" ? "Rejected" : "Active hypothesis"}</span></p>
    <div className="connection-direction"><p><span>From</span> {from.current.text}</p><p><strong>{relation.type === "supports" ? "Supports" : relation.type === "challenges" ? "Challenges" : "Suggests"}</strong> {to.current.text}</p></div>
    <h3>Why this connection was recorded</h3><p className="connection-rationale">{relation.current.rationale}</p>
    <EvidenceLinks ids={relation.current.evidenceSourceIds} sources={sources} />
    <Link className="text-link" href={inquiryHref(connected.sourceId, query, connected.id)}>Open connected thought</Link>
    <details className="reading-history"><summary role="button">View history</summary><section aria-label="Connection history"><ol>{relation.history.map((version, index) => <li key={version.id}><p className="version-meta">{relation.historyTruncated ? "Shown version" : "Version"} {index + 1}{version.id === relation.current.id ? " · Current" : ""} · {version.author === "ai" ? "AI-authored" : "Written by you"} · {version.status}</p><p>{version.rationale}</p><EvidenceLinks ids={version.evidenceSourceIds} sources={sources} prefix="Version evidence:" /></li>)}</ol>{relation.historyTruncated && <p className="history-limit">Only the latest {relation.history.length} versions are shown. Older history remains stored.</p>}</section></details>
  </article>;
}
