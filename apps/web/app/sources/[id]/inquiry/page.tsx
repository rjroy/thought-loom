import type { Metadata } from "next";
import { isRecordId } from "@thoughtloom/contracts";
import Link from "next/link";
import { notFound } from "next/navigation";
import { readInquiry, validSearchQuery } from "../../../../lib/daemon";
import { firstParameter, inquiryHref, readableDate, searchHref } from "../../../../lib/links";
import { InterpretationReading, ConnectionReading } from "../../../ui/knowledge-reading";
import StatusIcon from "../../../ui/status-icon";

export const metadata: Metadata = { title: "Explore a thought" };
export const dynamic = "force-dynamic";

export default async function InquiryPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await params;
  const parameters = await searchParams;
  const rawQuery = firstParameter(parameters.q), rawItem = firstParameter(parameters.item);
  const query = validSearchQuery(rawQuery) ? rawQuery : "", selectedId = isRecordId(rawItem) ? rawItem : "";
  const result = await readInquiry(id);
  if (result.kind === "not-found") notFound();
  if (result.kind === "unavailable") return <main id="main" className="workspace" tabIndex={-1}><h1>This context is temporarily unavailable</h1><div className="notice error-notice" role="alert"><StatusIcon kind="error" /><p>The recorded context could not be loaded. This does not mean your original or its history was deleted.</p></div><div className="recovery-actions"><a className="button primary" href={inquiryHref(id, query)}>Try again</a><Link className="text-link" href={`/sources/${encodeURIComponent(id)}`}>Open saved original</Link><Link className="text-link" href={searchHref(query)}>Back to results</Link></div></main>;
  const model = result.value, source = model.source;
  const interpretations = model.items.filter((item) => item.sourceId === source.id);
  return <main id="main" className="workspace inquiry-workspace" tabIndex={-1}>
    <div className="inquiry-heading"><h1>Explore this thought</h1><Link className="text-link" href={searchHref(query)}>{query ? "Back to results" : "Find another thought"}</Link></div>
    <p className="inquiry-intro">An unchanged original. Possible readings. Connections you can inspect.</p>
    {model.truncated && <p className="context-limit" role="status">This view shows a bounded neighborhood. Some recorded context is not shown; your full original remains available.</p>}
    <div className="inquiry-grid">
      <section className="inquiry-source" aria-label="Original source">
        <h2>Original source</h2><p className="record-identity">Your words · Unchanged</p>
        <dl className="inquiry-source-meta"><div><dt>Origin</dt><dd>{source.provenance}</dd></div><div><dt>Captured</dt><dd><time dateTime={source.createdAt}>{readableDate(source.createdAt)}</time></dd></div></dl>
        <p className="source-preview">{source.text.slice(0, 240)}{source.text.length > 240 ? "…" : ""}</p>
        <details className="source-disclosure"><summary role="button">Read full original</summary><article className="original-text inquiry-original" aria-label="Original thought">{source.text}</article></details>
        <Link className="text-link" href={`/sources/${source.id}`}>Open saved original</Link>
      </section>
      <div className="recorded-context">
        <section aria-label="Interpretations" className="interpretations-section"><h2>Interpretations</h2><p className="section-context">Recorded readings, not established facts or a statement of what you believe.</p>{interpretations.length ? interpretations.map((item) => <InterpretationReading key={item.id} item={item} sources={model.evidenceSources} selected={item.id === selectedId} />) : <p className="empty-reading">No interpretations recorded yet.</p>}</section>
        <section aria-label="Connections" className="connections-section"><h2>Connections</h2><p className="section-context">A recorded relationship needs a reason. Similar search wording alone is not evidence.</p>{model.relationships.length ? model.relationships.map((relation) => <ConnectionReading key={relation.id} relation={relation} items={model.items} sources={model.evidenceSources} sourceId={source.id} query={query} />) : <p className="empty-reading">No connections recorded yet.</p>}</section>
        <section className="scope-note inquiry-next" aria-label="Discussion availability"><h2>Develop this through discussion</h2><p>Dialogue is not available yet.</p><p>For now, review the original, compare the recorded readings, and follow their evidence. Automated weaving is not connected yet.</p></section>
      </div>
    </div>
  </main>;
}
