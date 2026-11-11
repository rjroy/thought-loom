"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useCallback, useId, useLayoutEffect, useState, useSyncExternalStore } from "react";
import { browseMapHref, decodeBrowseMapLocation, type BrowseMapLocation } from "../features/browse/query";
import { createBrowseMapController, type BrowseMapController, type BrowseMapState } from "../features/browse/map-controller";
import { fetchBrowseNeighborhood } from "../features/browse/request";
import type { NeighborhoodEdge } from "../features/browse/results";
import type { IdeaThought } from "../features/idea/types";
import { useBrowseMapMemory, type BrowseMapMemory } from "./browse-provider";
import { browseExpansionLabel, BrowseMapSurface } from "./browse-map-surface";
import { ContentGlyph } from "./content-glyph";
import { MediaSourceDetails } from "./media-source-details";
import { ThoughtMarkdown } from "./thought-markdown";
import styles from "./browse-map.module.css";

const browseThoughtTitle = (thought: IdeaThought) => thought.title ?? (thought.kind === "media-original" ? thought.mediaSource.name : thought.text.trim().split(/\s+/).slice(0, 5).join(" "));
const kinds = { "captured-original": "Original capture", "user-contribution": "Contribution", "ai-interpretation": "Interpretation",
  "developing-idea": "Developing idea", "imported-original": "Imported source", "media-original": "Image or PDF" };

function useMapAnnouncements(controller: BrowseMapController): string {
  const [announcement, setAnnouncement] = useState("");
  useLayoutEffect(() => {
    let previous = controller.getSnapshot();
    // Observe every publication, including overlapping reads React may render together.
    return controller.subscribe(() => {
      const next = controller.getSnapshot(), before = previous;
      previous = next;
      if (next.phase === "idle") { setAnnouncement(""); return; }
      const messages: string[] = [];
      for (const [id, expansion] of Object.entries(next.expansions)) {
        const prior = before.expansions[id];
        if (prior === expansion) continue;
        const thought = next.nodes.find(node => node.id === id) ?? before.nodes.find(node => node.id === id);
        if (!thought) continue;
        const subject = browseThoughtTitle(thought);
        if (expansion.phase === "loading" && prior?.phase !== "loading") {
          messages.push(`${subject}: ${expansion.loaded ? "Loading more direct links…" : "Loading direct links…"}`);
          continue;
        }
        if (prior?.phase !== "loading" || expansion.phase === "loading") continue;
        if (expansion.problem) {
          messages.push(`${subject}: ${expansion.problem.reason === "restart-required" ? "Restart the map to continue exploration." : "Direct links could not be loaded. Your explored map is still here."}`);
        } else if (expansion.phase === "ready") {
          const oldNodes = new Set(before.nodes.map(node => node.id)), oldEdges = new Set(before.edges.map(edge => edge.id));
          const addedNodes = next.nodes.filter(node => !oldNodes.has(node.id)).length;
          const addedEdges = next.edges.filter(edge => !oldEdges.has(edge.id)).length;
          const additions = [addedNodes ? `${addedNodes} ${addedNodes === 1 ? "idea" : "ideas"}` : "",
            addedEdges ? `${addedEdges} ${addedEdges === 1 ? "relationship" : "relationships"}` : ""].filter(Boolean);
          messages.push(`${subject}: ${additions.length ? `${additions.join(" and ")} added.` : "No additional ideas or relationships added."} ${expansion.exhausted ? "All direct links in this view are shown." : "More direct links available."}`);
        } else if (expansion.phase === "unavailable") messages.push(`${subject}: This idea is no longer available in this view.`);
      }
      if (messages.length) setAnnouncement(messages.join(" "));
    });
  }, [controller]);
  return announcement;
}

export function BrowseMapView({ location }: { location: BrowseMapLocation | null }) {
  const wake = `${usePathname()}?${useSearchParams().toString()}`;
  const workspace = useBrowseMapMemory();
  const [memory] = useState(() => {
    if (workspace.current) return workspace.current;
    const value: BrowseMapMemory = { controller: createBrowseMapController(location ?? { rootId: "unavailable", scope: "normal", returnTo: "/browse" }, {
      read: (request, signal) => fetchBrowseNeighborhood(request, { fetch: window.fetch.bind(window), signal }),
    }), framedRoot: null };
    workspace.current = value;
    return value;
  });
  const controller = memory.controller;
  const announcement = useMapAnnouncements(controller);
  const inspectorId = `${useId()}-selected-idea`;
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [valid, setValid] = useState(location !== null);
  const [hiddenRoot, setHiddenRoot] = useState(false);
  const reconcileLocation = useCallback(() => {
    const match = /^\/browse\/([^/]+)$/.exec(window.location.pathname);
    if (!match?.[1]) return;
    let next: BrowseMapLocation | undefined;
    try { next = decodeBrowseMapLocation(decodeURIComponent(match[1]), new URLSearchParams(window.location.search)); }
    catch { next = undefined; }
    setValid(next !== undefined);
    if (!next) return;
    const current = controller.getSnapshot();
    if (next.rootId !== current.location.rootId || next.scope !== current.location.scope) {
      setHiddenRoot(next.rootId === current.location.rootId && next.scope === "normal"
        && current.nodes.some(node => node.id === next.rootId && node.rejected === true));
    }
    void controller.open(next);
    const url = browseMapHref(next.rootId, next.returnTo, next.scope);
    if (`${window.location.pathname}${window.location.search}` !== url) window.history.replaceState(null, "", url);
  }, [controller]);
  useLayoutEffect(() => {
    window.addEventListener("popstate", reconcileLocation);
    return () => { window.removeEventListener("popstate", reconcileLocation); };
  }, [reconcileLocation]);
  useLayoutEffect(() => { reconcileLocation(); }, [wake, reconcileLocation]);
  useLayoutEffect(() => {
    // A write settling in a departed Idea can invalidate an already-mounted map.
    if (state.phase === "idle") reconcileLocation();
  }, [state.phase, reconcileLocation]);

  function changeScope(scope: BrowseMapLocation["scope"]) {
    const current = controller.getSnapshot(), next = { ...current.location, scope };
    setHiddenRoot(scope === "normal" && current.nodes.some(node => node.id === next.rootId && node.rejected === true));
    setValid(true);
    void controller.open(next);
    const url = browseMapHref(next.rootId, next.returnTo, next.scope);
    if (`${window.location.pathname}${window.location.search}` !== url) window.history.pushState(null, "", url);
  }
  const selected = valid ? state.nodes.find(node => node.id === state.selectedId) : undefined;
  const linkedIds = new Set(state.edges.flatMap(edge => [edge.fromId, edge.toId]));
  const href = browseMapHref(state.location.rootId, state.location.returnTo, state.location.scope);
  return <section className={styles.view}>
    <h1 className={styles.srOnly}>Browse map</h1>
    <div className={styles.toolbar}>
      <Link className={styles.returnLink} href={state.location.returnTo} prefetch={false}>Back to list</Link>
      <div className={styles.switcher} role="group" aria-label="Presentation">
        <button type="button" aria-pressed={state.presentation === "map"} onClick={() => controller.setPresentation("map")}>Map</button>
        <button type="button" aria-pressed={state.presentation === "linked-list"} onClick={() => controller.setPresentation("linked-list")}>Linked list</button>
      </div>
      <label className={styles.scope}><input type="checkbox" checked={state.location.scope === "show-rejected"}
        onChange={event => changeScope(event.currentTarget.checked ? "show-rejected" : "normal")} />Show rejected</label>
    </div>
    {state.location.scope === "show-rejected" && <p className={styles.inspection}>User inspection · Rejected content remains unavailable to AI.</p>}
    {state.notice && <p role="status" className={styles.notice}>{state.notice === "scope-reset" ? "Inspection reset to the starting idea."
      : state.notice === "library-changed" ? "Your library changed. Exploration restarted from the starting idea." : "The selected idea is unavailable. Inspection returned to the starting idea."}</p>}
    {!valid ? <div className={styles.empty}><h2>Browse link not valid</h2><p>Open a map from the Browse list or an Idea.</p></div>
      : state.phase === "idle" || state.phase === "loading" ? <p role="status">Loading linked ideas…</p>
        : state.phase === "unavailable" ? <div className={styles.empty}><h2>Starting idea unavailable</h2>
          <p>{hiddenRoot ? "The starting idea is hidden while Show rejected is off." : "This idea is not available in the current view."}</p>
          {state.location.scope === "normal" && <p>Enable Show rejected to inspect rejected material deliberately.</p>}
        </div>
          : state.phase === "error" ? <div className={styles.problem} role="status"><h2>Linked ideas could not be loaded</h2>
            <button className={styles.button} type="button" onClick={() => void controller.refresh()}>Retry loading linked ideas</button></div>
            : <div className={styles.columns}>
              <div className={styles.mapColumn}>
                <p className={styles.count}>{state.nodes.length} {state.nodes.length === 1 ? "idea" : "ideas"} shown · Select an idea to read it and reveal its direct links.</p>
                {selected && state.presentation === "map" && <a className={styles.phoneJump} href={`#${inspectorId}`}>Read selected idea</a>}
                {state.presentation === "map" ? <BrowseMapSurface state={state} controller={controller} memory={memory} titleOf={browseThoughtTitle} />
                  : <ol className={styles.linkedList} aria-label="Explored ideas">{state.nodes.map(node => <li key={node.id}>
                    <button className={styles.linkedNode} type="button" aria-label={`Inspect and explore ${browseThoughtTitle(node)}`}
                      aria-describedby={`${inspectorId}-state-${encodeURIComponent(node.id)}`}
                      aria-pressed={state.selectedId === node.id} onClick={() => controller.select(node.id)}>{browseThoughtTitle(node)}</button>
                    <ThoughtByline thought={node} />
                    <p id={`${inspectorId}-state-${encodeURIComponent(node.id)}`} className={styles.metadata}>{browseExpansionLabel(state.expansions[node.id], linkedIds.has(node.id))}</p>
                    {node.kind === "media-original" ? <MediaSourceDetails source={node.mediaSource} compact />
                      : <p>{node.text.slice(0, 160)}{node.text.length > 160 ? "…" : ""}</p>}
                    {state.selectedId === node.id && <a className={styles.readSelected} href={`#${inspectorId}`}>Read selected idea</a>}
                  </li>)}</ol>}
                {state.presentation === "map" && <p className={styles.mapFeedback}>New ideas may be outside the view. Use Fit map to see them.</p>}
              </div>
              {selected && <MapInspector thought={selected} state={state} controller={controller} href={href} id={inspectorId} />}
            </div>}
    <p className={styles.mapFeedback} role="status" aria-atomic="true">{valid && state.phase === "ready" ? announcement : ""}</p>
  </section>;
}

function ThoughtByline({ thought }: { thought: IdeaThought }) {
  const date = new Date(thought.createdAt);
  return <p className={styles.byline}>
    <span className={thought.author === "ai" ? styles.ai : thought.author === "user" ? styles.user : undefined}>
      {thought.author === "ai" ? "AI" : thought.author === "user" ? "You" : "Imported source"}</span>
    <span className={styles.kind}><ContentGlyph kind={thought.kind} size={20} />{kinds[thought.kind]}</span>
    {!Number.isNaN(date.valueOf()) && <time dateTime={thought.createdAt} title="Created (UTC)">{new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(date)}</time>}
    {thought.rejected === true && <span className={styles.rejected}>Rejected</span>}
  </p>;
}

function MapInspector({ thought, state, controller, href, id }: {
  thought: IdeaThought; state: BrowseMapState; controller: BrowseMapController; href: string; id: string;
}) {
  const expansion = state.expansions[thought.id];
  const edges = state.edges.filter(edge => edge.fromId === thought.id || edge.toId === thought.id);
  const idea = `/ideas/${encodeURIComponent(thought.id)}?${new URLSearchParams({ scope: state.location.scope, returnTo: href })}`;
  const restart = expansion?.problem?.reason === "restart-required";
  const loading = expansion?.phase === "loading", failed = expansion?.phase === "error";
  const status = restart ? "This continuation is no longer available. Restart from the starting idea to continue; this clears the explored map."
    : failed ? "Direct links could not be loaded. Your explored map is still here."
      : loading ? expansion.loaded ? "Loading more direct links…" : "Loading direct links…"
        : expansion?.exhausted ? edges.length ? "All direct links in this view are shown." : "No direct links in this view."
          : expansion?.loaded ? "More direct links are available." : "Select this idea to reveal its direct links.";
  const label = loading ? expansion.loaded ? "Loading more links…" : "Loading links…"
    : failed ? "Retry loading links" : expansion?.loaded ? "Load more linked ideas" : "Explore links";
  return <section id={id} tabIndex={-1} className={styles.inspector} aria-label="Selected idea">
    <h2>{browseThoughtTitle(thought)}</h2>
    <ThoughtByline thought={thought} />
    {thought.kind === "media-original" ? <MediaSourceDetails source={thought.mediaSource} /> : <ThoughtMarkdown className={styles.actual} text={thought.text} headingLevel={3} />}
    <div className={styles.actions}>
      <Link href={idea} prefetch={false}>Open Idea</Link>
    </div>
    <h3>Recorded relationships</h3>
    <p id={`${id}-links-status`} className={failed ? styles.problem : styles.expansionStatus}>
      {expansion?.loaded && !expansion.exhausted && !loading && !failed
        ? <><span className={styles.statusLead}>{status}</span>{" "}Parent, child, source or connection links may still be on later pages.</> : status}
    </p>
    {restart ? <button className={styles.button} type="button" aria-describedby={`${id}-links-status`} onClick={() => void controller.refresh()}>Restart map</button>
      : !expansion?.exhausted && <button className={`${styles.button} ${styles.primary}`} type="button" disabled={loading}
        aria-busy={loading} aria-describedby={`${id}-links-status`} onClick={() => void controller.expand(thought.id)}>{label}</button>}
    <ul className={styles.relationships}>{edges.map(edge => <RelationshipRow key={edge.id} edge={edge} thought={thought} nodes={state.nodes} />)}</ul>
  </section>;
}

function RelationshipRow({ edge, thought, nodes }: { edge: NeighborhoodEdge; thought: IdeaThought; nodes: readonly IdeaThought[] }) {
  const outgoing = edge.fromId === thought.id, other = nodes.find(node => node.id === (outgoing ? edge.toId : edge.fromId));
  if (!other) return null;
  const labels = { supports: outgoing ? "Supports" : "Supported by", contradicts: outgoing ? "Contradicts" : "Contradicted by",
    extends: outgoing ? "Extends" : "Extended by", related: "Related" };
  const label = edge.kind === "evolution" ? outgoing ? "Developed into:" : "Developed from:"
    : edge.kind === "provenance" ? outgoing ? "This idea was used as a source for:" : "Used as a source for this idea:"
      : `Conceptual connection · ${labels[edge.connection.category]}:`;
  return <li>
    <p className={styles.role}><ContentGlyph kind={edge.kind === "evolution" ? "evolution" : edge.kind === "provenance" ? "used-as-source" : "connection"} size={16} />
      <strong>{label}</strong> {browseThoughtTitle(other)}{other.id === thought.id ? " (this idea)" : ""}</p>
    {edge.kind === "provenance" && <p className={styles.metadata}>Source reference {edge.position + 1}</p>}
    {edge.kind === "connection" && <>
      <p className={styles.metadata}>Proposed by {edge.connection.proposedBy === "user" ? "You" : "AI"}{edge.connection.rejected === true ? " · Rejected connection" : ""}</p>
      <p>{edge.connection.explanation}</p>
      {edge.connection.sourceIds.length > 0 && <p className={styles.metadata}>Recorded evidence IDs: {edge.connection.sourceIds.join(", ")}</p>}
    </>}
  </li>;
}
