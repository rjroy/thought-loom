import { Fragment, type ReactNode } from "react";
import Link from "next/link";
import type { SearchPassage, SearchPassageFragment, SearchResult } from "@thoughtloom/contracts";
import { inquiryHref, readableDate, sourceHref } from "../../lib/links";
import { ThoughtTextDisclosure } from "./text-disclosure";

function MarkedFragment({ fragment }: { fragment: SearchPassageFragment }) {
  const content: ReactNode[] = []; let position = 0;
  for (const [index, range] of fragment.highlights.entries()) {
    content.push(fragment.text.slice(position, range.start), <mark key={index}>{fragment.text.slice(range.start, range.end)}</mark>);
    position = range.end;
  }
  content.push(fragment.text.slice(position));
  return <>{content}</>;
}

function MatchingPassage({ passage, href, item }: { passage: SearchPassage; href?: string; item: boolean }) {
  const text = <>{passage.leadingEllipsis && <span aria-hidden="true">… </span>}{passage.fragments.map((fragment, index) => <Fragment key={index}>
    <MarkedFragment fragment={fragment} />
  </Fragment>)}{passage.trailingEllipsis && <span aria-hidden="true"> …</span>}</>;
  return <>{passage.fragments.length > 0 && <p className={`result-passage ${item ? "result-formulation" : "result-excerpt"}`}>{href ? <Link href={href} prefetch={false}>{text}</Link> : text}</p>}
    {passage.omitted && <p className="match-explanation">{passage.fragments.length ? "Preview shortened." : "Preview unavailable."}</p>}</>;
}

export default function SearchResultReading({ hit, query }: { hit: SearchResult; query: string }) {
  const input = hit.source.origin.kind === "discussion-turn";
  const href = hit.item ? inquiryHref(hit.sourceId, query, hit.item.id, hit.item.formulationId) : input ? sourceHref(hit.sourceId, query) : inquiryHref(hit.sourceId, query);
  const titleMatch = hit.match.field === "title";
  const titleFragment = titleMatch && !hit.passage.leadingEllipsis && !hit.passage.trailingEllipsis && hit.passage.fragments.length === 1 && hit.passage.fragments[0].text === hit.title?.text ? hit.passage.fragments[0] : undefined;
  const originalContext = hit.item || titleMatch;
  const target = hit.item ? { kind: "item" as const, sourceId: hit.sourceId, itemId: hit.item.id, versionId: hit.item.formulationId } : { kind: "source" as const, sourceId: hit.sourceId };
  return <article className="search-result">
    {hit.title && <p className="result-formulation result-title"><Link href={href} prefetch={false}>{titleFragment ? <MarkedFragment fragment={titleFragment} /> : hit.title.text}</Link></p>}
    <p className="match-origin">{hit.matchOrigin === "alias" ? "Matched recorded alias" : titleMatch ? "Matched title" : hit.item ? hit.item.author === "ai" ? "Matched AI note" : "Matched formulation" : input ? "Matched discussion input" : "Matched original"}</p>
    {input && <p className="attribution">Your discussion input</p>}
    {!input && !hit.item && hit.matchOrigin !== "source" && <p className="attribution">Original</p>}
    {hit.item && <p className="attribution">{hit.item.author === "user" ? "Your recorded formulation" : hit.item.kind === "interpretation" ? "AI interpretation · Tentative" : "AI developing idea · Tentative"}</p>}
    {hit.alias && <p className="match-explanation">Matched “{hit.alias.expandedQuery}” via a recorded alias · {hit.alias.author === "user" ? "Written by you" : "AI-authored"}</p>}
    {hit.match.kind === "typo" && <p className="match-explanation">Including {hit.match.correctedTerms.map(({ from, to }) => `“${to}” for “${from}”`).join(", ")}.</p>}
    {(!titleMatch || hit.item) && <div className="source-excerpt-disclosure"><ThoughtTextDisclosure target={target} preview={titleMatch ? undefined : {
      collapsed: <MatchingPassage passage={hit.passage} item={!!hit.item} href={hit.title ? undefined : href} />,
      expanded: !hit.title ? <p className="excerpt-label"><Link href={href} prefetch={false}>Open matched thought</Link></p> : undefined,
    }} /></div>}
    {originalContext && <><p className="excerpt-label result-context-label">{input ? "Discussion input context" : "Original context"}</p><div className="source-excerpt-disclosure result-context"><ThoughtTextDisclosure target={{ kind: "source", sourceId: hit.sourceId }} preview={{ collapsed: <p className="result-excerpt">{hit.source.excerpt}</p> }} /></div></>}
    <p className="result-provenance"><span>{hit.source.provenance}</span><time dateTime={hit.source.createdAt}>{readableDate(hit.source.createdAt)}</time></p>
    <Link className="text-link result-open" href={href} prefetch={false}>Open thought</Link>
  </article>;
}
