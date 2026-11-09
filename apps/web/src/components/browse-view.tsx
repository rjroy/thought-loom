"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { browseListHref, decodeBrowseQuery, type BrowseQuery } from "../features/browse/query";
import { createBrowseController } from "../features/browse/controller";
import { fetchBrowsePage } from "../features/browse/request";
import type { IdeaThought } from "../features/idea/types";
import { useBrowseMemory, type BrowseMemory } from "./browse-provider";
import { ContentGlyph } from "./content-glyph";
import { MediaSourceDetails } from "./media-source-details";
import styles from "./browse.module.css";

const defaults = (): BrowseQuery => ({ sort: "newest", author: ["user", "ai"], scope: "normal" });
const material = {
  "captured-original": "Original capture", "user-contribution": "Contribution", "ai-interpretation": "Interpretation",
  "developing-idea": "Developing idea", "imported-original": "Imported source", "media-original": "Image or PDF",
};

export function BrowseView() {
  const params = useSearchParams().toString();
  const workspace = useBrowseMemory();
  const [{ memory, returning }] = useState(() => {
    const saved = workspace.current;
    if (saved) return { memory: saved, returning: true };
    const initial = decodeBrowseQuery(new URLSearchParams(params)) ?? defaults();
    const memory: BrowseMemory = { controller: createBrowseController(initial, {
      read: (request, signal) => fetchBrowsePage(request, { fetch: window.fetch.bind(window), signal }),
    }), url: browseListHref(initial), scrollY: 0 };
    workspace.current = memory;
    return { memory, returning: false };
  });
  const controller = memory.controller;
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const restoreScroll = useRef(returning);
  const [valid, setValid] = useState(() => decodeBrowseQuery(new URLSearchParams(params)) !== undefined);
  // Query, controls and rows share one accepted workspace state. Router params only wake reconciliation.
  const query = state.query;

  const reconcileLocation = useCallback(() => {
    if (window.location.pathname !== "/browse") return;
    const locationParams = new URLSearchParams(window.location.search);
    const parsed = decodeBrowseQuery(locationParams);
    setValid(parsed !== undefined);
    if (!parsed) {
      restoreScroll.current = false;
      return;
    }
    // Bare navigation resumes this document's workspace; explicit filters always win.
    const current = controller.getSnapshot().query;
    const next = locationParams.size === 0 ? current : parsed;
    const url = browseListHref(next);
    if (url !== browseListHref(current)) {
      restoreScroll.current = false;
      memory.scrollY = 0;
    }
    memory.url = url;
    void controller.setQuery(next);
    // Normalization replaces this entry; traversing history never appends another entry.
    if (`${window.location.pathname}${window.location.search}` !== url) {
      window.history.replaceState(null, "", url);
    }
  }, [controller, memory]);

  useLayoutEffect(() => {
    // A real traversal can return to the same hook params before an intermediate transition commits.
    window.addEventListener("popstate", reconcileLocation);
    return () => { window.removeEventListener("popstate", reconcileLocation); };
  }, [reconcileLocation]);

  useLayoutEffect(() => {
    // Mount and Next navigation use the same actual-location input as popstate, never its delayed mirror.
    reconcileLocation();
  }, [params, reconcileLocation]);

  useLayoutEffect(() => {
    const remember = () => {
      if (window.location.pathname === "/browse" && !restoreScroll.current) memory.scrollY = window.scrollY;
    };
    window.addEventListener("scroll", remember, { passive: true });
    return () => { window.removeEventListener("scroll", remember); };
  }, [memory]);

  useLayoutEffect(() => {
    if (!restoreScroll.current || !valid || state.phase === "idle" || state.phase === "loading") return;
    const frame = requestAnimationFrame(() => {
      window.scrollTo(0, memory.scrollY);
      restoreScroll.current = false;
      memory.scrollY = window.scrollY;
    });
    return () => cancelAnimationFrame(frame);
  }, [state, valid, memory]);

  function change(update: (current: BrowseQuery) => BrowseQuery) {
    const next = update(controller.getSnapshot().query);
    const url = browseListHref(next);
    restoreScroll.current = false;
    memory.scrollY = 0;
    memory.url = url;
    setValid(true);
    void controller.setQuery(next);
    if (`${window.location.pathname}${window.location.search}` !== url) window.history.pushState(null, "", url);
  }
  function refresh() {
    if (!valid) {
      const next = defaults();
      const same = browseListHref(next) === browseListHref(controller.getSnapshot().query);
      change(() => next);
      if (same) void controller.refresh();
    } else void controller.refresh();
  }
  const filtered = query.author.length !== 2 || query.scope !== "normal";
  const loading = valid && (state.phase === "idle" || state.phase === "loading");
  const ready = valid && state.phase === "ready";
  const items = valid ? state.items : [];
  const problem = valid ? state.problem : null;

  return <section className={styles.view} aria-labelledby="browse-heading">
    <div className={styles.heading}>
      <h1 id="browse-heading">Browse</h1>
      <div className={styles.tools}>
        <button type="button" className={styles.button} disabled={loading || valid && state.loadingMore} onClick={refresh}>Refresh list</button>
        <label className={styles.sort}>Sort
          <select className={styles.control} value={query.sort} onChange={event => {
            const sort = event.currentTarget.value as BrowseQuery["sort"];
            change(current => ({ ...current, sort }));
          }}>
            <option value="newest">Newest first</option><option value="oldest">Oldest first</option>
          </select>
        </label>
      </div>
    </div>
    <div className={styles.columns}>
      <aside className={styles.filters} aria-label="Browse filters">
        <fieldset>
          <legend>Authorship</legend>
          {(["user", "ai"] as const).map(author => <label className={styles.choice} key={author}>
            <input type="checkbox" checked={query.author.includes(author)} onChange={event => {
              const checked = event.currentTarget.checked;
              change(current => ({ ...current,
                author: checked ? [...current.author, author] : current.author.filter(value => value !== author),
              }));
            }} />
            <span>{author === "user" ? "You" : "AI"}</span>
          </label>)}
        </fieldset>
        <div className={styles.filterFooter}>
          <label className={styles.choice}><input type="checkbox" checked={query.scope === "show-rejected"}
            onChange={event => {
              const scope = event.currentTarget.checked ? "show-rejected" : "normal";
              change(current => ({ ...current, scope }));
            }} />
            <span>Show rejected</span>
          </label>
          <button className={styles.textButton} type="button" onClick={() => change(current => ({ ...current, author: ["user", "ai"], scope: "normal" }))}>Clear filters</button>
        </div>
      </aside>
      <div className={styles.results}>
        {query.scope === "show-rejected" && <p className={styles.inspection}>User inspection · Rejected content remains unavailable to AI.</p>}
        <div role="status" aria-live="polite" aria-atomic="true" className={styles.status}>
          {!valid ? <><h2>Browse link not valid</h2><p>Refresh this list or choose your filters to browse again.</p></>
            : loading ? <p>Loading ideas…</p>
              : ready && items.length > 0 ? <p>{items.length} {items.length === 1 ? "idea" : "ideas"} loaded{state.loadingMore ? " · Loading more ideas…" : ""}</p> : null}
        </div>
        {problem && <div className={styles.problem} role="status">
          <p>{problem.reason === "restart-required" ? "This list needs refreshing. Refresh to load the current ideas."
            : problem.stage === "more" ? "More ideas could not be loaded. Your loaded ideas are still here." : "Ideas could not be loaded."}</p>
          {problem.reason !== "restart-required" && <button type="button" className={styles.button}
            onClick={() => void (problem.stage === "more" ? controller.loadMore() : controller.refresh())}>
            {problem.stage === "more" ? "Retry loading more" : "Retry loading ideas"}
          </button>}
        </div>}
        {ready && items.length === 0 && !problem && <div className={styles.empty}>
          <h2>{filtered ? "No ideas match these filters" : "No ideas yet"}</h2>
          {!query.author.length ? <p>Select You or AI to show ideas.</p>
            : filtered ? <p>Choose another authorship filter or clear filters to browse again.</p>
              : <><p>Capture a thought to give yourself something to return to.</p><Link href="/capture" prefetch={false}>Capture a thought</Link></>}
        </div>}
        <ol className={styles.list} aria-label="Ideas">{items.map(item => <li key={item.id}><BrowseRow item={item} /></li>)}</ol>
        {ready && state.nextCursor !== null && !problem && <button className={styles.button} type="button"
          disabled={state.loadingMore} aria-busy={state.loadingMore} onClick={() => void controller.loadMore()}>Load more</button>}
      </div>
    </div>
  </section>;
}

function BrowseRow({ item }: { item: IdeaThought }) {
  const title = item.title ?? (item.kind === "media-original" ? item.mediaSource.name : item.text.trim().split(/\s+/).slice(0, 5).join(" "));
  const date = new Date(item.createdAt);
  const created = Number.isNaN(date.valueOf()) ? "Date unavailable" : new Intl.DateTimeFormat("en", {
    month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
  }).format(date);
  return <article className={styles.card}>
    <h2>{title}</h2>
    {item.kind === "media-original" ? <MediaSourceDetails source={item.mediaSource} compact />
      : <p className={styles.excerpt}>{item.text.slice(0, 160)}{item.text.length > 160 ? "…" : ""}</p>}
    <div className={styles.byline}>
      <span className={item.author === "user" ? styles.user : item.author === "ai" ? styles.ai : styles.source}>
        {item.author === "user" ? "You" : item.author === "ai" ? "AI" : "Imported source"}
      </span>
      <span className={styles.kind}><ContentGlyph kind={item.kind} size={20} />{material[item.kind]}</span>
      <time dateTime={item.createdAt} title="Created (UTC)">{created}</time>
      {item.rejected === true && <span className={styles.rejected}>Rejected</span>}
    </div>
  </article>;
}
