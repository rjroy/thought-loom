"use client";

import Link from "next/link";
import Image from "next/image";
import { useSearchParams } from "next/navigation";
import {
  useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent,
} from "react";
import {
  clearSearchFilters, datePreset, decodeSearchQuery, encodeSearchQuery, ideaHref,
  type DatePreset, type SearchAuthor, type SearchMaterialKind, type SearchQuery,
} from "../features/explore/query";
import { fetchSearch } from "../features/explore/request";
import type { SearchResult } from "../features/explore/results";
import { searchEntryHref, searchCatalogHref } from "../features/agentic-search/location";
import { useExploreMemory, type ExploreState } from "./explore-provider";
import styles from "./explore.module.css";
import { ContentGlyph } from "./content-glyph";
import { MediaSourceDetails } from "./media-source-details";

const authorOptions = [
  { value: "user", label: "You" },
  { value: "ai", label: "AI" },
  { value: "source", label: "Imported source" },
] as const;
const kindOptions = [
  { value: "captured-original", label: "Original captures", singular: "Original capture" },
  { value: "user-contribution", label: "Contributions", singular: "Contribution" },
  { value: "ai-interpretation", label: "AI interpretations", singular: "Interpretation" },
  { value: "developing-idea", label: "Developing ideas", singular: "Developing idea" },
  { value: "imported-original", label: "Imported Markdown", singular: "Imported Markdown" },
  { value: "media-original", label: "Images and PDFs", singular: "Image or PDF" },
] as const;

function emptyState(): ExploreState {
  return {
    query: { q: "", author: [], kind: [], sort: "relevance", scope: "normal" },
    draft: "",
    dateChoice: "anytime",
    phase: "initial",
    page: null,
    message: null,
    validation: null,
    expanded: [],
  };
}

function queryUrl(query: SearchQuery) {
  return `/explore?${encodeSearchQuery(query)}`;
}

function toggle<T extends string>(items: readonly T[], value: T) {
  return items.includes(value) ? items.filter(item => item !== value) : [...items, value];
}

function createdDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : new Intl.DateTimeFormat("en", {
    month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
  }).format(date);
}

function relationship(result: SearchResult): string {
  if (!result.context || result.context.kind === "predecessor") return "Developed from";
  const { connection } = result.context;
  const outgoing = connection.fromId === result.thoughtId;
  switch (connection.category) {
    case "supports": return outgoing ? "Supports" : "Supported by";
    case "contradicts": return outgoing ? "Contradicts" : "Contradicted by";
    case "extends": return outgoing ? "Extends" : "Extended by";
    case "related": return "Related";
  }
}

export function ExploreView({ presentationOnly = false }: { presentationOnly?: boolean } = {}) {
  const params = useSearchParams().toString();
  const memory = useExploreMemory();
  const [view, setView] = useState<ExploreState>(() => {
    const saved = memory.current;
    if (presentationOnly) return saved?.state ?? emptyState();
    const decoded = decodeSearchQuery(new URLSearchParams(params));
    const returning = params === "" && saved?.state.query.q.trim();
    const matching = decoded && saved && queryUrl(decoded) === saved.url && queryUrl(saved.state.query) === saved.url;
    return saved && (returning || matching)
      ? { ...saved.state, query: decoded ?? saved.state.query, validation: returning ? saved.state.validation : null }
      : emptyState();
  });
  const current = useRef(view);
  const lastUrl = useRef("/explore");
  const handledUrl = useRef<string | null>(null);
  const alive = useRef(false);
  const generation = useRef(0);
  const request = useRef<AbortController | null>(null);
  const scrollY = useRef(0);
  const restoreScroll = useRef<number | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filterButton = useRef<HTMLButtonElement>(null);
  const filterHeading = useRef<HTMLHeadingElement>(null);
  const queryField = useRef<HTMLInputElement>(null);

  const commit = useCallback((next: ExploreState) => {
    if (presentationOnly) return;
    current.current = next;
    setView(next);
    memory.current = { state: next, url: lastUrl.current, scrollY: scrollY.current };
  }, [memory, presentationOnly]);

  const runSearch = useCallback(async (query: SearchQuery, options: {
    updateUrl?: boolean;
    draft?: string;
    dateChoice?: ExploreState["dateChoice"];
  } = {}) => {
    const id = ++generation.current;
    request.current?.abort();
    const before = current.current;
    const next = {
      ...before, query,
      draft: options.draft ?? before.draft,
      dateChoice: options.dateChoice ?? before.dateChoice,
      page: null, message: null,
    };
    if (!query.q.trim()) {
      commit({ ...next, phase: "initial", validation: "query" });
      queryField.current?.focus();
      return;
    }
    if (!decodeSearchQuery(encodeSearchQuery(query))) {
      commit({ ...next, phase: "initial", validation: "dates" });
      return;
    }
    const url = queryUrl(query);
    lastUrl.current = url;
    if (options.updateUrl !== false) {
      handledUrl.current = encodeSearchQuery(query).toString();
      if (`${window.location.pathname}${window.location.search}` !== url) window.history.pushState(null, "", url);
    }
    commit({
      ...next, phase: "loading", validation: null,
      expanded: query.q === before.query.q ? before.expanded : [],
    });
    const controller = new AbortController();
    request.current = controller;
    const result = await fetchSearch(query, { fetch: window.fetch.bind(window), signal: controller.signal });
    if (!alive.current || controller.signal.aborted || generation.current !== id) return;
    const latest = current.current;
    commit(result.kind === "success"
      ? { ...latest, phase: "success", page: result.page, message: null }
      : { ...latest, phase: "error", page: null, message: result.message });
  }, [commit]);

  useLayoutEffect(() => {
    if (presentationOnly) return;
    alive.current = true;
    const rememberScroll = () => {
      // Do not record Next's incoming-route scroll reset as a reading position.
      if (window.location.pathname !== "/explore" || restoreScroll.current !== null) return;
      scrollY.current = window.scrollY;
      if (memory.current) memory.current.scrollY = scrollY.current;
    };
    window.addEventListener("scroll", rememberScroll, { passive: true });
    return () => {
      alive.current = false;
      generation.current++;
      request.current?.abort();
      window.removeEventListener("scroll", rememberScroll);
    };
  }, [memory, presentationOnly]);

  useEffect(() => {
    if (presentationOnly) return;
    if (handledUrl.current === params) return;
    handledUrl.current = params;
    const decoded = decodeSearchQuery(new URLSearchParams(params));
    const saved = memory.current;
    // A bare header return restores this mounted workspace. Explicit URLs always win.
    const returning = params === "" && saved && saved.state.query.q.trim();
    const matching = decoded && saved && queryUrl(decoded) === saved.url && queryUrl(saved.state.query) === saved.url;
    if ((returning || matching) && saved) {
      lastUrl.current = saved.url;
      const restored = returning ? saved.state : { ...saved.state, query: decoded!, draft: decoded!.q, validation: null };
      restoreScroll.current = saved.scrollY;
      scrollY.current = saved.scrollY;
      if (returning) {
        handledUrl.current = saved.url.split("?")[1] ?? "";
        window.history.replaceState(null, "", saved.url);
      }
      commit(restored);
      if (restored.phase === "loading") void runSearch(restored.query, { updateUrl: false });
    } else if (decoded) {
      restoreScroll.current = null;
      void runSearch(decoded, {
        updateUrl: false, draft: decoded.q,
        dateChoice: decoded.from || decoded.to ? "custom" : "anytime",
      });
    } else {
      generation.current++;
      request.current?.abort();
      lastUrl.current = "/explore";
      commit({
        ...emptyState(), draft: new URLSearchParams(params).get("q") ?? "",
        validation: params ? "link" : null,
      });
    }
  }, [params, memory, commit, runSearch, presentationOnly]);

  useLayoutEffect(() => {
    if (presentationOnly) {
      // Align only after fonts/layout settle under the still-opaque fixed intro.
      // This snapshot never installs scroll listeners or writes shared memory.
      let active = true;
      let frame = 0;
      void document.fonts.ready.then(() => {
        if (active) frame = requestAnimationFrame(() => {
          if (active && memory.current) window.scrollTo(0, memory.current.scrollY);
        });
      });
      return () => { active = false; cancelAnimationFrame(frame); };
    }
    if (restoreScroll.current === null || view.phase === "loading") return;
    const y = restoreScroll.current;
    const frame = requestAnimationFrame(() => {
      // A restored state must be committed before its reading position is used.
      if (view !== current.current) return;
      window.scrollTo(0, y);
      scrollY.current = window.scrollY;
      if (memory.current) memory.current.scrollY = scrollY.current;
      restoreScroll.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [view, memory, presentationOnly]);

  useEffect(() => {
    if (filtersOpen) filterHeading.current?.focus();
  }, [filtersOpen]);

  function closeFilters() {
    setFiltersOpen(false);
    filterButton.current?.focus();
  }

  function updateQuery(patch: Partial<SearchQuery>, dateChoice?: ExploreState["dateChoice"]) {
    void runSearch({ ...current.current.query, ...patch }, { dateChoice });
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void runSearch({ ...current.current.query, q: current.current.draft });
  }
  function clearFilters() {
    void runSearch(clearSearchFilters(current.current.query), { dateChoice: "anytime" });
  }

  const { query, page } = view;
  const ready = Boolean(query.q.trim());
  const counts = view.phase === "success" && !view.validation ? page?.counts : undefined;
  const selectedCount = query.author.length + query.kind.length
    + (query.from || query.to ? 1 : 0) + (query.scope === "show-rejected" ? 1 : 0);
  const selectionSummary = [
    ...query.author.map(value => value === "source" ? "Imported source" : authorOptions.find(option => option.value === value)?.label ?? value),
    ...query.kind.map(value => value === "imported-original" ? "Imported source" : kindOptions.find(option => option.value === value)?.label ?? value),
    ...(query.from || query.to ? [view.dateChoice === "custom" ? "Custom dates" : "Date filter"] : []),
    ...(query.scope === "show-rejected" ? ["Show rejected"] : []),
  ].join(" · ");
  const returnTo = lastUrl.current;

  return (
    <section className={styles.view}>
      <h1 className={styles.srOnly}>Explore</h1>
      <form className={styles.searchForm} role="search" onSubmit={submit} noValidate>
        <label className={styles.queryLabel} htmlFor="explore-query">Search thoughts</label>
        <div className={styles.queryBox}>
          <svg className={styles.searchIcon} viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            <circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.5 15.5 4.5 4.5" />
          </svg>
          <input
            id="explore-query" ref={queryField} className={styles.queryInput}
            type="text" placeholder="Search your thinking" value={view.draft}
            aria-invalid={view.validation === "query" ? true : undefined}
            aria-describedby={view.validation === "query" ? "explore-query-error" : undefined}
            onChange={event => commit({
              ...current.current, draft: event.target.value,
              validation: current.current.validation === "query" ? null : current.current.validation,
            })}
          />
        </div>
        <button className={`${styles.button} ${styles.primary}`} type="submit"
          aria-busy={view.phase === "loading"}>Search</button>
        {view.validation === "query" && (
          <p className={styles.fieldError} id="explore-query-error" role="alert">
            Enter a few words to search.
          </p>
        )}
      </form>

      <div className={styles.conversationalEntry} aria-label="Conversational search">
        <Link href={searchEntryHref} prefetch={false}>Ask your library</Link>
        <Link href={searchCatalogHref} prefetch={false}>Saved searches</Link>
        <Link href="/exports" prefetch={false}>Exports</Link>
      </div>

      <div className={styles.narrowTools}>
        <button className={styles.button} type="button" ref={filterButton}
          aria-expanded={filtersOpen} aria-controls="explore-filters"
          onClick={() => setFiltersOpen(open => !open)}>
          Filters{selectedCount ? ` (${selectedCount})` : ""}
        </button>
        {selectedCount > 0 && <p className={styles.selectionSummary}>{selectionSummary}</p>}
      </div>

      <div className={styles.columns}>
        <aside className={styles.filters} id="explore-filters" data-open={filtersOpen}
          aria-labelledby="explore-filters-heading" onKeyDown={event => {
            if (event.key === "Escape" && filtersOpen) {
              event.preventDefault();
              closeFilters();
            }
          }}>
          <div className={styles.filterHeading}>
            <h2 id="explore-filters-heading" ref={filterHeading} tabIndex={-1}>Filters</h2>
            <button className={`${styles.textButton} ${styles.closeFilters}`}
              type="button" onClick={closeFilters}>Close filters</button>
          </div>
          <fieldset className={styles.filterGroup} disabled={!ready}>
            <legend>Authorship</legend>
            {authorOptions.map(option => (
              <label className={styles.facet} key={option.value}>
                <input type="checkbox" checked={query.author.includes(option.value)}
                  onChange={() => updateQuery({
                    author: toggle<SearchAuthor>(current.current.query.author, option.value),
                  })} />
                <span>{option.label}</span>
                <span className={styles.count}>{counts?.authors[option.value] ?? "—"}</span>
              </label>
            ))}
          </fieldset>
          <fieldset className={styles.filterGroup} disabled={!ready}>
            <legend>Kind of material</legend>
            {kindOptions.map(option => (
              <label className={styles.facet} key={option.value}>
                <input type="checkbox" checked={query.kind.includes(option.value)}
                  onChange={() => updateQuery({
                    kind: toggle<SearchMaterialKind>(current.current.query.kind, option.value),
                  })} />
                <span>{option.label}</span>
                <span className={styles.count}>{counts?.kinds[option.value] ?? "—"}</span>
              </label>
            ))}
          </fieldset>
          <div className={styles.filterGroup}>
            <label className={styles.fieldLabel} htmlFor="explore-date">Created (UTC)</label>
            <select id="explore-date" className={styles.control} disabled={!ready}
              value={view.dateChoice} onChange={event => {
                const choice = event.target.value as DatePreset | "custom";
                if (choice === "custom") commit({ ...current.current, dateChoice: choice });
                else {
                  const bounds = datePreset(choice, new Date());
                  updateQuery({ from: bounds.from, to: bounds.to }, choice);
                }
              }}>
              <option value="anytime">Any time</option>
              <option value="last-7-days">Last 7 days</option>
              <option value="last-30-days">Last 30 days</option>
              <option value="this-year">This year</option>
              <option value="custom">Custom range</option>
            </select>
            {view.dateChoice === "custom" && (
              <div className={styles.dateFields}>
                {(["from", "to"] as const).map(bound => (
                  <label key={bound}>
                    {bound === "from" ? "From" : "To"}
                    <input className={styles.control} type="text" placeholder="YYYY-MM-DD"
                      value={query[bound] ?? ""}
                      aria-invalid={view.validation === "dates" ? true : undefined}
                      aria-describedby={view.validation === "dates" ? "explore-date-error" : undefined}
                      onChange={event => updateQuery({ [bound]: event.target.value || undefined })} />
                  </label>
                ))}
              </div>
            )}
            {view.validation === "dates" && (
              <p className={styles.fieldError} id="explore-date-error" role="alert">
                Choose valid UTC dates. From must not be after To.
              </p>
            )}
          </div>
          <div className={styles.filterFooter}>
            <label className={styles.facet}>
              <input type="checkbox" disabled={!ready} checked={query.scope === "show-rejected"}
                onChange={event => updateQuery({ scope: event.target.checked ? "show-rejected" : "normal" })} />
              <span>Show rejected</span>
            </label>
            <button className={styles.textButton} type="button" disabled={!ready}
              onClick={clearFilters}>Clear filters</button>
          </div>
        </aside>

        <div className={styles.results}>
          <div className={styles.resultsHeading}>
            <div role="status" aria-atomic="true">
              {view.validation === "link" ? (
                <><h2>Search link not valid</h2><p>Enter a query and choose your filters to search again.</p></>
              ) : view.phase === "initial" ? (
                <><h2 className={styles.initialHeading}>{!view.validation && <Image src="/glyphs/lantern.svg" alt="" aria-hidden="true" width={24} height={24} unoptimized className={styles.headingGlyph} />}Find your recorded thinking</h2><p>Enter a few words you remember, then search.</p></>
              ) : view.phase === "loading" ? (
                <h2>Searching…</h2>
              ) : view.phase === "error" ? (
                <><h2>{view.message}</h2><p>Your query and filters are still here.</p></>
              ) : (
                <h2>{page?.results.length ?? 0} {page?.results.length === 1 ? "result" : "results"} for “{query.q}”</h2>
              )}
            </div>
            <label className={styles.sort}>
              Sort
              <select className={styles.control} disabled={!ready} value={query.sort}
                onChange={event => updateQuery({ sort: event.target.value as SearchQuery["sort"] })}>
                <option value="relevance">Relevance</option>
                <option value="newest">Newest first</option>
                <option value="oldest">Oldest first</option>
              </select>
            </label>
          </div>
          {view.phase === "initial" && !view.validation && (
            <div className={styles.clearing} aria-hidden="true">
              <Image src="/backgrounds/explore-clearing.png" alt="" aria-hidden="true"
                width={1122} height={374} unoptimized loading="eager" draggable={false}
                className={styles.clearingImage} />
            </div>
          )}
          {view.phase === "error" && (
            <button className={`${styles.button} ${styles.primary}`} type="button"
              onClick={() => void runSearch(current.current.query)}>Retry search</button>
          )}
          {view.phase === "success" && page?.results.length === 0 && (
            <div className={styles.empty}>
              <h3>No results</h3>
              <p>Try another query or adjust your filters.</p>
              <button className={styles.textButton} type="button" onClick={clearFilters}>Clear filters</button>
            </div>
          )}
          <div className={styles.resultList}>
            {view.phase === "success" && page?.results.map(result => {
              const key = `${result.kind}:${result.id}`;
              return (
                <ResultCard key={key} result={result} returnTo={returnTo}
                  expanded={view.expanded.includes(key)}
                  inspectRejection={query.scope === "show-rejected"}
                  rejected={page.rejectionStatus[result.thoughtId]}
                  onToggle={() => commit({
                    ...current.current, expanded: toggle(current.current.expanded, key),
                  })} />
              );
            })}
          </div>
          {view.phase === "success" && page?.results.some(result => result.materialKind === "media-original" || result.context?.thought.kind === "media-original") && (
            <p className={styles.mediaPolicy}>Media sources match their clarification or recorded titles, not original file contents or fallback filenames. Recorded interpretations and full replies are searchable separately.</p>
          )}
        </div>
      </div>
    </section>
  );
}

function ResultCard({ result, returnTo, expanded, inspectRejection, rejected, onToggle }: {
  result: SearchResult;
  returnTo: string;
  expanded: boolean;
  inspectRejection: boolean;
  rejected: boolean | null | undefined;
  onToggle: () => void;
}) {
  const classification = kindOptions.find(option => option.value === result.materialKind)!.singular;
  const date = createdDate(result.createdAt);
  const context = result.context?.thought;

  return (
    <article className={styles.card}>
      <div className={styles.cardBody}>
        <div className={styles.byline}>
          <span className={result.author === "user" ? styles.user : result.author === "ai" ? styles.ai : styles.source}>
            {result.author === "user" ? "You" : result.author === "ai" ? "AI" : "Imported source"}
          </span>
          <span className={styles.materialLabel}><ContentGlyph kind={result.kind === "response" ? "full-reply" : result.materialKind} size={20} />{result.kind === "response" ? `Full reply · ${classification}` : classification}</span>
          {result.kind === "thought" && inspectRejection && (
            rejected === true ? <span className={styles.rejected}>Rejected</span>
              : rejected !== false ? <span className={styles.unknown}>Status unknown</span> : null
          )}
          {date && <time dateTime={result.createdAt}>{date}</time>}
        </div>
        <h3><Link href={ideaHref(result, returnTo)} prefetch={false}>{result.title}</Link></h3>
        {result.text === null ? <div className={styles.mediaDetails}><MediaSourceDetails source={result.mediaSource} compact /></div> : <p className={styles.excerpt}>
          {expanded && result.text !== null ? result.text : result.snippet}
          {result.text !== null && result.text.length > result.snippet.length && (
            <> <button className={styles.expandButton} type="button" aria-expanded={expanded}
              aria-label={`${expanded ? "Collapse" : "Expand"} original text for ${result.title}`}
              onClick={onToggle}>{expanded ? "Show less" : "…"}</button></>
          )}
        </p>}
      </div>
      {context && (
        <div className={styles.context}>
          <strong className={styles.relationLabel}><ContentGlyph kind={result.context?.kind === "connection" ? "connection" : "evolution"} size={16} />{relationship(result)}:</strong>{" "}
          <Link href={ideaHref({ kind: "thought", id: context.id, thoughtId: context.id }, returnTo)}
            prefetch={false}>
            {context.title ?? (context.kind === "media-original" ? context.mediaSource.name : context.text.trim().split(/\s+/).slice(0, 5).join(" "))}
          </Link>
          {result.context?.kind === "connection" && (
            <> — {result.context.connection.explanation}
              <span className={styles.srOnly}>
                {" "}Recorded direction: {result.context.connection.fromId === result.thoughtId
                  ? "from this thought to the context thought" : "from the context thought to this thought"}.
              </span>
            </>
          )}
          {context.kind === "media-original" && <div className={styles.contextMedia}><MediaSourceDetails source={context.mediaSource} compact /></div>}
        </div>
      )}
    </article>
  );
}
