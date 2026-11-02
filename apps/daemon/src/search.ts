import { resolveSearchInput, SEARCH_ENGINE_VERSION, type SearchInput, type SearchResponse } from "@thoughtloom/contracts";
import { createFuzzyRetriever, FuzzySearchError, type FuzzyRetrieverOptions } from "./fuzzy-retrieval";

export type SearchService = { search(input: SearchInput, signal?: AbortSignal): Promise<SearchResponse> };

// Construct once per daemon and inject the SAME service into user/tool routes.
// Its immutable policy, default K, ranker and active scan slot cannot diverge.
export function createSearchService(options: FuzzyRetrieverOptions): SearchService {
  const retriever = createFuzzyRetriever(options);
  return { async search(value, signal): Promise<SearchResponse> {
    const input = resolveSearchInput(value);
    if (!input) throw new FuzzySearchError("invalid", "Invalid search input");
    const metadata = { engineVersion: SEARCH_ENGINE_VERSION, queryLength: input.query.length, limit: input.limit };
    console.info("search.request attempt", metadata);
    try {
      const result = await retriever.search({ ...input, signal });
      console.info("search.request succeeded", { ...metadata, resultCount: result.matches.length,
        hasMore: result.hasMore, aliasExpansionTruncated: result.aliasExpansionTruncated });
      return { engineVersion: SEARCH_ENGINE_VERSION, results: result.matches.map(({ target: _target, ...match }) => match),
        hasMore: result.hasMore, aliasExpansionTruncated: result.aliasExpansionTruncated };
    } catch (error) {
      console.warn("search.request failed", { ...metadata, category: error instanceof FuzzySearchError ? error.code : "unavailable" });
      throw error;
    }
  } };
}
