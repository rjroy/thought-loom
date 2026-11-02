import type { Metadata } from "next";
import Link from "next/link";
import { readSearch } from "../../lib/daemon";
import { searchHref } from "../../lib/links";
import { pageSearchRequest } from "../../lib/search-query";
import StatusIcon from "../ui/status-icon";
import SearchResultReading from "../ui/search-result";

export const metadata: Metadata = { title: "Find a thought" };

export default async function SearchPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const input = pageSearchRequest(await searchParams), query = input?.query ?? "";
  if (input && query.length === 0) return (
    <main id="main" className="workspace" tabIndex={-1}>
      <div className="page-intro"><h1>Find a thought</h1></div>
      <p className="empty-guidance">Search a word, a fragment, or an idea. No question needed.</p>
      <Link className="text-link" href="/">Or capture a new thought</Link>
    </main>
  );
  const result = input ? await readSearch(input) : { kind: "invalid" as const };
  return (
    <main id="main" className="workspace search-workspace" tabIndex={-1}>
      <div className="page-intro"><h1>Find a thought</h1></div>
      {result.kind === "invalid" ? <div className="notice error-notice" role="alert"><StatusIcon kind="error" /><p>This search is invalid. Use up to 512 characters and a result limit from 1 to 200.</p></div>
        : result.kind === "unavailable" ? <div className="search-recovery"><div className="notice error-notice" role="alert"><StatusIcon kind="error" /><p>Search is temporarily unavailable. Your saved originals have not been changed.</p></div><a className="text-link" href={searchHref(query)}>Try this search again</a></div>
        : <section aria-label="Search results" className="search-results">
          {result.value.hasMore && <p className="section-context" role="status">More matches available. Narrow the search to see others.</p>}
          {result.value.aliasExpansionTruncated && <p className="section-context" role="status">Some recorded alias expansions were not searched.</p>}
          {result.value.results.length === 0 ? <div role="status" className="empty-guidance"><h2>No thoughts found</h2><p>Try a shorter fragment or wording from an original.</p></div>
            : <><h2 className="result-count">{result.value.hasMore ? "First " : ""}{result.value.results.length} {result.value.results.length === 1 ? "match" : "matches"} for “{query}”</h2>
              {result.value.results.map((hit) => <SearchResultReading key={hit.item ? `item-${hit.item.id}` : `source-${hit.sourceId}`} hit={hit} query={query} />)}</>}
        </section>}
    </main>
  );
}
