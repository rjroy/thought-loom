"use client";

import { useCallback, useRef, useState } from "react";
import Link from "next/link";
import { parseInquiryView, type InquiryView, type WeavingStatusView } from "@thoughtloom/contracts";
import { readableDate } from "../../lib/links";
import { InterpretationReading, ConnectionReading } from "./knowledge-reading";
import WeavingStatus from "./weaving-status";

export default function InquiryContext({ initial, weaving, query, selectedId }: { initial: InquiryView; weaving: WeavingStatusView | null; query: string; selectedId: string }) {
  const [model, setModel] = useState(initial), [refreshError, setRefreshError] = useState(false);
  // The two initial server reads are not one transaction. Reconcile once even
  // when status is unchanged, in case a run settled between those reads.
  const last = useRef(""), inFlight = useRef(false);
  const source = initial.source;
  const refresh = useCallback(async (snapshot: WeavingStatusView) => {
    const signature = JSON.stringify(snapshot);
    if (signature === last.current || inFlight.current) return;
    inFlight.current = true;
    try {
      const response = await fetch(`/api/sources/${source.id}/inquiry`, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
      const next = response.ok ? parseInquiryView(await response.json()) : null;
      if (!next || next.source.id !== source.id || next.source.text !== source.text || next.source.createdAt !== source.createdAt || next.source.provenance !== source.provenance) throw new Error("Context unavailable");
      setModel(next); setRefreshError(false); last.current = signature;
    } catch { setRefreshError(true); }
    finally { inFlight.current = false; }
  }, [source.id, source.text, source.createdAt, source.provenance]);
  const interpretations = model.items.filter((item) => item.sourceId === source.id);
  return <>
    {model.truncated && <p className="context-limit" role="status">This view shows a bounded neighborhood. Some recorded context is not shown; your full original remains available.</p>}
    <div className="inquiry-grid">
      <section className="inquiry-source" aria-label="Original source">
        <h2>Original source</h2><p className="record-identity">Your words · Unchanged</p>
        <dl className="inquiry-source-meta"><div><dt>Origin</dt><dd>{source.provenance}</dd></div><div><dt>Captured</dt><dd><time dateTime={source.createdAt}>{readableDate(source.createdAt)}</time></dd></div></dl>
        <p className="source-preview">{source.text.slice(0, 240)}{source.text.length > 240 ? "…" : ""}</p>
        <details className="source-disclosure"><summary role="button">Read full original</summary><article className="original-text inquiry-original" aria-label="Original thought">{source.text}</article></details>
        <Link className="text-link" href={`/sources/${source.id}`}>Open saved original</Link>
        <WeavingStatus sourceId={source.id} initial={weaving} onSnapshot={refresh} />
      </section>
      <div className="recorded-context">
        {refreshError && <p className="status-recovery" role="status">Recorded context could not refresh. Existing readings are kept below; checking status will try loading updates again.</p>}
        <section aria-label="Interpretations" className="interpretations-section"><h2>Interpretations</h2><p className="section-context">Recorded readings, not established facts or a statement of what you believe.</p>{interpretations.length ? interpretations.map((item) => <InterpretationReading key={item.id} item={item} sources={model.evidenceSources} selected={item.id === selectedId} />) : <p className="empty-reading">No interpretations recorded yet.</p>}</section>
        <section aria-label="Connections" className="connections-section"><h2>Connections</h2><p className="section-context">A recorded relationship needs a reason. Similar search wording alone is not evidence.</p>{model.relationships.length ? model.relationships.map((relation) => <ConnectionReading key={relation.id} relation={relation} items={model.items} sources={model.evidenceSources} sourceId={source.id} query={query} />) : <p className="empty-reading">No connections recorded yet.</p>}</section>
        <section className="scope-note inquiry-next" aria-label="Discussion availability"><h2>Develop this through discussion</h2><p>Dialogue is not available yet.</p><p>For now, review the original, compare the recorded readings, and follow their evidence. Confirmed weaving changes appear here without closing your original.</p></section>
      </div>
    </div>
  </>;
}
