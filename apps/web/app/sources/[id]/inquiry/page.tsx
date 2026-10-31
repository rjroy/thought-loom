import type { Metadata } from "next";
import { isRecordId } from "@thoughtloom/contracts";
import Link from "next/link";
import { notFound } from "next/navigation";
import { readInquiry, readWeaving, validSearchQuery } from "../../../../lib/daemon";
import { firstParameter, inquiryHref, searchHref } from "../../../../lib/links";
import InquiryContext from "../../../ui/inquiry-context";
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
  const weaving = await readWeaving(id);
  return <main id="main" className="workspace inquiry-workspace" tabIndex={-1}>
    <div className="inquiry-heading"><h1>Explore this thought</h1><Link className="text-link" href={searchHref(query)}>{query ? "Back to results" : "Find another thought"}</Link></div>
    <p className="inquiry-intro">An unchanged original. Possible readings. Connections you can inspect.</p>
    <InquiryContext key={id} initial={result.value} weaving={weaving.kind === "found" ? weaving.value : null} query={query} selectedId={selectedId} />
  </main>;
}
