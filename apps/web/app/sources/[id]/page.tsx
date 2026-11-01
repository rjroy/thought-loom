import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { readInquiry, readSource, readWeaving } from "../../../lib/daemon";
import StatusIcon from "../../ui/status-icon";
import WeavingStatus from "../../ui/weaving-status";
import { discussionHref, firstParameter } from "../../../lib/links";
import { validSearchQuery } from "../../../lib/daemon";
import FollowUpStatus from "../../ui/follow-up-status";
import ThoughtContent from "../../ui/thought-content";

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
        <div><h1>{discussionInput ? "Discussion input" : "Original thought"}</h1></div>
        <Link className="button secondary" href="/">Capture another</Link>
      </div>
      <section className="source-document thought-reading thought-reading-focal" data-role={discussionInput ? "user" : "original"}>
        <ThoughtContent title={!discussionInput && source.title && <p className="thought-title-text">{source.title.text}</p>}
          body={<article className="original-text thought-body" aria-label={discussionInput ? "Discussion input" : "Original thought"}>{source.text}</article>}
          metadata={<><p className="saved-receipt"><StatusIcon kind="saved" /><span>{discussionInput ? "Discussion input saved · Your words" : "Original saved"}</span><span>Your words · Unchanged</span></p><dl className="source-meta">
        <div><dt>Captured</dt><dd><time dateTime={source.createdAt}>{date} UTC</time></dd></div>
        <div><dt>Origin</dt><dd>{discussionInput ? "Your discussion input" : source.provenance}</dd></div>
      </dl></>}
          actions={discussionInput ? <Link className="text-link" href={discussionHref(origin.rootSourceId, origin.dialogueId, query, origin.turnId)}>Return to discussion</Link> : <Link className="text-link" href={`/sources/${source.id}/inquiry`}>Explore recorded context</Link>} />
      </section>
      {!discussionInput && <WeavingStatus key={id} sourceId={id} initial={weaving?.kind === "found" ? weaving.value : null} />}
      {!discussionInput && <FollowUpStatus key={`follow-up-${id}`} sourceId={id} query={query} initialModel={context?.kind === "found" ? context.value : null} />}
    </main>
  );
}
