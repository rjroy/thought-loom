import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { readSource, readWeaving } from "../../../lib/daemon";
import StatusIcon from "../../ui/status-icon";
import WeavingStatus from "../../ui/weaving-status";

export const metadata: Metadata = { title: "Original thought" };
export const dynamic = "force-dynamic";

export default async function SourcePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await readSource(id);
  if (result.kind === "not-found") notFound();
  if (result.kind === "unavailable") {
    return (
      <main id="main" className="workspace" tabIndex={-1}>
        <h1>This original is temporarily unavailable</h1>
        <div role="alert" className="notice error-notice"><StatusIcon kind="error" /><p>The local capture service could not be reached. This does not mean your original was deleted.</p></div>
        <div className="recovery-actions"><a className="button primary" href={`/sources/${encodeURIComponent(id)}`}>Try again</a><Link className="text-link" href="/">Capture another thought</Link></div>
      </main>
    );
  }
  const { source } = result;
  const weaving = await readWeaving(id);
  const date = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(source.createdAt));
  return (
    <main id="main" className="workspace source-workspace" tabIndex={-1}>
      <div className="source-heading">
        <div><h1>Original thought</h1><p className="saved-receipt"><StatusIcon kind="saved" /><span>Original saved</span></p></div>
        <Link className="button secondary" href="/">Capture another</Link>
      </div>
      <dl className="source-meta">
        <div><dt>Captured</dt><dd><time dateTime={source.createdAt}>{date} UTC</time></dd></div>
        <div><dt>Origin</dt><dd>{source.provenance}</dd></div>
      </dl>
      <article className="original-text" aria-label="Original thought">{source.text}</article>
      <p className="source-preservation">This is your unchanged source, not an AI interpretation. Bookmark this page to return to it.</p>
      <Link className="text-link" href={`/sources/${source.id}/inquiry`}>Explore recorded context</Link>
      <WeavingStatus key={id} sourceId={id} initial={weaving.kind === "found" ? weaving.value : null} />
    </main>
  );
}
