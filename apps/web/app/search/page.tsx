import type { Metadata } from "next";
import Link from "next/link";
import { readSearch } from "../../lib/daemon";
import { firstParameter, inquiryHref, readableDate, searchHref } from "../../lib/links";
import StatusIcon from "../ui/status-icon";

export const metadata: Metadata = { title: "Find a thought" };

export default async function SearchPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = firstParameter((await searchParams).q);
  if (!query.trim()) return (
    <main id="main" className="workspace" tabIndex={-1}>
      <div className="page-intro"><h1>Find a thought</h1><p>Search your originals and recorded interpretations.</p></div>
      <p className="empty-guidance">Start with a word you remember, an unfinished term, or an idea from a recorded note. You do not need to formulate a question first.</p>
      <Link className="text-link" href="/">Or capture a new thought</Link>
    </main>
  );
  const result = await readSearch(query);
  return (
    <main id="main" className="workspace search-workspace" tabIndex={-1}>
      <div className="page-intro"><h1>Find a thought</h1><p>Original words and recorded readings, kept distinct.</p></div>
      {result.kind === "invalid" ? <div className="notice error-notice" role="alert"><StatusIcon kind="error" /><p>That search is too long. Use up to 16 words and 512 characters, then search again.</p></div>
        : result.kind === "unavailable" ? <div className="search-recovery"><div className="notice error-notice" role="alert"><StatusIcon kind="error" /><p>Search is temporarily unavailable. Your saved originals have not been changed.</p></div><a className="text-link" href={searchHref(query)}>Try this search again</a></div>
        : <section aria-label="Search results" className="search-results">
          {result.results.length === 0 ? <div role="status" className="empty-guidance"><h2>No thoughts found</h2><p>Try a different word, a shorter fragment, or wording from an original. No connection is inferred from a search match.</p></div>
            : <><h2 className="result-count">{result.results.length} {result.results.length === 1 ? "match" : "matches"} for “{query}”</h2>
              {result.results.map((hit) => <article className="search-result" key={hit.item ? `item-${hit.item.id}` : `source-${hit.sourceId}`}>
                <p className="match-origin">{hit.matchOrigin === "source" ? "Matched original" : hit.matchOrigin === "alias" ? "Matched recorded alias" : hit.item?.author === "ai" ? "Matched AI note" : "Matched formulation"}</p>
                {hit.item && <><p className="attribution">{hit.item.author === "ai" ? hit.item.kind === "interpretation" ? "AI interpretation" : "AI developing idea" : "Your recorded formulation"}</p><p className="result-formulation">{hit.item.text}</p><p className="excerpt-label">Original excerpt</p></>}
                <p className="result-excerpt">{hit.source.excerpt}</p>
                {hit.matchOrigin === "alias" && <p className="match-explanation">Retrieved through a recorded alias, not a recorded connection.</p>}
                <p className="result-provenance"><span>{hit.source.provenance}</span><time dateTime={hit.source.createdAt}>{readableDate(hit.source.createdAt)}</time></p>
                <Link className="text-link result-open" aria-label={`Open thought: ${(hit.item?.text ?? hit.source.excerpt).slice(0, 100)}`} href={inquiryHref(hit.sourceId, query, hit.item?.id)}>Open thought</Link>
              </article>)}</>}
        </section>}
    </main>
  );
}
