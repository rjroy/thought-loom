import type { Metadata } from "next";
import { isRecordId } from "@thoughtloom/contracts";
import Link from "next/link";
import { notFound } from "next/navigation";
import { readInquiry, readWeaving } from "../../../../lib/daemon";
import { pageSearchRequest } from "../../../../lib/search-query";
import { firstParameter, inquiryHref, searchHref } from "../../../../lib/links";
import InquiryContext from "../../../ui/inquiry-context";
import StatusIcon from "../../../ui/status-icon";
import { readDialogue } from "../../../../lib/development-server";
import { discussionHref, sourceHref } from "../../../../lib/links";

export const metadata: Metadata = { title: "Explore a thought" };
export const dynamic = "force-dynamic";

function SelectedUnavailable({ id, query }: { id: string; query: string }) {
  return <main id="main" className="workspace" tabIndex={-1}><h1>The selected thought is unavailable</h1><div className="recovery-actions"><Link className="button primary" href="/">Return to capture</Link><Link className="text-link" href={sourceHref(id, query)}>Open saved original</Link><Link className="text-link" href={searchHref(query)}>Back to results</Link></div></main>;
}

export default async function InquiryPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await params;
  const parameters = await searchParams;
  const rawItem = firstParameter(parameters.item), rawVersion = firstParameter(parameters.version), rawDialogue = firstParameter(parameters.dialogue);
  const query = pageSearchRequest({ q: parameters.q })?.query ?? "", selectedId = isRecordId(rawItem) ? rawItem : "";
  const requestedItem = parameters.item !== undefined, requestedVersion = parameters.version !== undefined;
  if (Array.isArray(parameters.item) || Array.isArray(parameters.version) || (requestedItem && !isRecordId(rawItem)) || (requestedVersion && (!requestedItem || !isRecordId(rawVersion)))) return <SelectedUnavailable id={id} query={query} />;
  const target = requestedVersion ? { itemId: selectedId, versionId: rawVersion } : undefined;
  const result = await readInquiry(id, target);
  if (result.kind !== "found" && (requestedItem || requestedVersion)) return <SelectedUnavailable id={id} query={query} />;
  if (result.kind === "not-found") notFound();
  if (result.kind === "unavailable") return <main id="main" className="workspace" tabIndex={-1}><h1>This context is temporarily unavailable</h1><div className="notice error-notice" role="alert"><StatusIcon kind="error" /><p>The recorded context could not be loaded. This does not mean your original or its history was deleted.</p></div><div className="recovery-actions"><a className="button primary" href={inquiryHref(id, query)}>Try again</a><Link className="text-link" href={`/sources/${encodeURIComponent(id)}`}>Open saved original</Link><Link className="text-link" href={searchHref(query)}>Back to results</Link></div></main>;
  const origin = result.value.source.origin;
  if (requestedItem && !result.value.items.some((item) => item.id === selectedId && item.sourceId === id)) return <SelectedUnavailable id={id} query={query} />;
  if (origin?.kind === "discussion-turn") return <main id="main" className="workspace" tabIndex={-1}><h1>Discussion input</h1><p className="record-identity">Your words · Unchanged</p><article className="original-text" aria-label="Discussion input">{result.value.source.text}</article><div className="recovery-actions"><Link className="text-link" href={sourceHref(id, query)}>Open saved input</Link><Link className="text-link" href={discussionHref(origin.rootSourceId, origin.dialogueId, query, origin.turnId)}>Return to discussion</Link><Link className="text-link" href={searchHref(query)}>Back to results</Link></div></main>;
  const weaving = await readWeaving(id);
  const discussion = isRecordId(rawDialogue) ? await readDialogue(rawDialogue) : null;
  const initialDialogue = discussion?.kind === "found" && discussion.value.sourceId === id && (!target || (discussion.value.selection.kind === "item" && discussion.value.selection.id === target.itemId && discussion.value.selection.versionId === target.versionId)) ? discussion.value : null;
  const dialogueError = rawDialogue && !initialDialogue ? "That discussion could not be opened for this original. It may belong to another thought or be unavailable. Your original and its recorded context remain below." : "";
  return <main id="main" className="workspace inquiry-workspace" tabIndex={-1}>
    <nav className="inquiry-heading" aria-label="Inquiry trail"><Link className="text-link" href={searchHref(query)}>{query ? `Search: ${query}` : "Find a thought"}</Link><span>Original thought</span></nav>
    <InquiryContext key={id} initial={result.value} weaving={weaving.kind === "found" ? weaving.value : null} query={query} selectedId={selectedId} initialDialogue={initialDialogue} dialogueError={dialogueError} />
  </main>;
}
