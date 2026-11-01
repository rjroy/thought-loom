import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { readInquiry, readSource, readWeaving } from "../../../lib/daemon";
import StatusIcon from "../../ui/status-icon";
import WeavingStatus from "../../ui/weaving-status";
import { discussionHref, firstParameter } from "../../../lib/links";
import { validSearchQuery } from "../../../lib/daemon";
import FollowUpStatus from "../../ui/follow-up-status";

export const metadata: Metadata = { title: "Original thought" };
export const dynamic = "force-dynamic";

export default async function SourcePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
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
  const rawQuery = firstParameter((await searchParams).q), query = validSearchQuery(rawQuery) ? rawQuery : "";
  const origin = source.origin, discussionInput = origin?.kind === "discussion-turn";
  const weaving = discussionInput ? null : await readWeaving(id);
  const context = discussionInput ? null : await readInquiry(id);
  const date = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(source.createdAt));
  return (
    <main id="main" className="workspace source-workspace" tabIndex={-1}>
      <div className="source-heading">
        <div><h1>{discussionInput ? "Discussion input" : source.title?.text ?? "Original thought"}</h1><p className="saved-receipt"><StatusIcon kind="saved" /><span>{discussionInput ? "Discussion input saved · Your words" : "Original saved"}</span></p></div>
        <Link className="button secondary" href="/">Capture another</Link>
      </div>
      <dl className="source-meta">
        <div><dt>Captured</dt><dd><time dateTime={source.createdAt}>{date} UTC</time></dd></div>
        <div><dt>Origin</dt><dd>{discussionInput ? "Your discussion input" : source.provenance}</dd></div>
      </dl>
      <article className="original-text" aria-label={discussionInput ? "Discussion input" : "Original thought"}>{source.text}</article>
      <p className="source-preservation">Your words · Unchanged</p>
      {discussionInput ? <Link className="text-link" href={discussionHref(origin.rootSourceId, origin.dialogueId, query, origin.turnId)}>Return to discussion</Link> : <><Link className="text-link" href={`/sources/${source.id}/inquiry`}>Explore recorded context</Link><WeavingStatus key={id} sourceId={id} initial={weaving?.kind === "found" ? weaving.value : null} /></>}
      {!discussionInput && <FollowUpStatus key={`follow-up-${id}`} sourceId={id} query={query} initialModel={context?.kind === "found" ? context.value : null} />}
    </main>
  );
}
