import type { Metadata } from "next";
import { isRecordId } from "@thoughtloom/contracts";
import Link from "next/link";
import { notFound } from "next/navigation";
import { readInquiry, readWeaving, validSearchQuery } from "../../../../lib/daemon";
import { firstParameter, inquiryHref, searchHref } from "../../../../lib/links";
import InquiryContext from "../../../ui/inquiry-context";
import StatusIcon from "../../../ui/status-icon";
import { readDialogue } from "../../../../lib/development-server";
import { discussionHref, sourceHref } from "../../../../lib/links";

export const metadata: Metadata = { title: "Explore a thought" };
export const dynamic = "force-dynamic";

export default async function InquiryPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await params;
  const parameters = await searchParams;
  const rawQuery = firstParameter(parameters.q), rawItem = firstParameter(parameters.item), rawDialogue = firstParameter(parameters.dialogue);
  const query = validSearchQuery(rawQuery) ? rawQuery : "", selectedId = isRecordId(rawItem) ? rawItem : "";
  const result = await readInquiry(id);
  if (result.kind === "not-found") notFound();
  if (result.kind === "unavailable") return <main id="main" className="workspace" tabIndex={-1}><h1>This context is temporarily unavailable</h1><div className="notice error-notice" role="alert"><StatusIcon kind="error" /><p>The recorded context could not be loaded. This does not mean your original or its history was deleted.</p></div><div className="recovery-actions"><a className="button primary" href={inquiryHref(id, query)}>Try again</a><Link className="text-link" href={`/sources/${encodeURIComponent(id)}`}>Open saved original</Link><Link className="text-link" href={searchHref(query)}>Back to results</Link></div></main>;
  const origin = result.value.source.origin;
  if (origin?.kind === "discussion-turn") return <main id="main" className="workspace" tabIndex={-1}><h1>Discussion input</h1><p className="record-identity">Your words · Unchanged</p><article className="original-text" aria-label="Discussion input">{result.value.source.text}</article><div className="recovery-actions"><Link className="text-link" href={sourceHref(id, query)}>Open saved input</Link><Link className="text-link" href={discussionHref(origin.rootSourceId, origin.dialogueId, query, origin.turnId)}>Return to discussion</Link><Link className="text-link" href={searchHref(query)}>Back to results</Link></div></main>;
  const weaving = await readWeaving(id);
  const discussion = isRecordId(rawDialogue) ? await readDialogue(rawDialogue) : null;
  const initialDialogue = discussion?.kind === "found" && discussion.value.sourceId === id ? discussion.value : null;
  const dialogueError = rawDialogue && !initialDialogue ? "That discussion could not be opened for this original. It may belong to another thought or be unavailable. Your original and its recorded context remain below." : "";
  return <main id="main" className="workspace inquiry-workspace" tabIndex={-1}>
    <nav className="inquiry-heading" aria-label="Inquiry trail"><Link className="text-link" href={searchHref(query)}>{query ? `Search: ${query}` : "Find a thought"}</Link><span>Original thought</span></nav>
    <InquiryContext key={id} initial={result.value} weaving={weaving.kind === "found" ? weaving.value : null} query={query} selectedId={selectedId} initialDialogue={initialDialogue} dialogueError={dialogueError} />
  </main>;
}
