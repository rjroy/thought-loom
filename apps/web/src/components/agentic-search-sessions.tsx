"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Session } from "../features/agentic-search/types";
import { searchCatalogHref, searchSessionHref } from "../features/agentic-search/location";
import { useAgenticSearchController } from "./agentic-search-provider";
import { useContextualBack } from "./contextual-back";
import { useExploreMemory } from "./explore-provider";
import styles from "./agentic-search.module.css";

export function NewSearchButton() {
  const controller = useAgenticSearchController(), router = useRouter();
  const [starting, setStarting] = useState(false), [error, setError] = useState(false);
  const pending = useRef(false);
  async function start() {
    if (pending.current) return;
    pending.current = true; setStarting(true); setError(false);
    const id = await controller.start();
    if (id) router.push(searchSessionHref(id));
    else setError(true);
    pending.current = false; setStarting(false);
  }
  return <div className={styles.newSearch}>
    <button className={`${styles.button} ${styles.primary}`} disabled={starting} onClick={() => void start()} type="button">{starting ? "Opening search…" : "New search"}</button>
    {error && <p className={styles.warning} role="status">Could not confirm the new search. Check <Link href={searchCatalogHref} prefetch={false}>Saved searches</Link> before starting another.</p>}
  </div>;
}

export function SavedSearchesView() {
  const memory = useExploreMemory();
  useContextualBack(memory.current?.url ?? "/explore", "Back to Explore");
  return <section className={styles.view} aria-labelledby="saved-searches-heading">
    <div className={styles.pageHeading}><h1 id="saved-searches-heading">Saved searches</h1><NewSearchButton /></div>
    <p className={styles.intro}>Return to a conversation and the ideas it found. Searches stay until you delete them.</p>
    <SessionsList />
  </section>;
}

/** One list serves both the bookmarkable catalog and the contextual sessions sheet. */
export function SessionsList({ onClose }: { readonly onClose?: () => void }) {
  const controller = useAgenticSearchController(), router = useRouter();
  const catalog = useSyncExternalStore(controller.subscribe, controller.getCatalog, () => null);
  const [opening, setOpening] = useState<string | null>(null), [error, setError] = useState(false);
  const [deleting, setDeleting] = useState<Session | null>(null);
  useEffect(() => { void controller.loadCatalog(); }, [controller]);
  async function resume(id: string) {
    if (opening) return;
    setOpening(id); setError(false);
    await controller.loadMetadata(id);
    await controller.resume(id);
    const workspace = controller.get(id);
    if (workspace?.context.kind === "editable" || workspace?.context.kind === "changed") {
      onClose?.(); router.push(searchSessionHref(id));
    } else setError(true);
    setOpening(null);
  }
  return <>
    {(!catalog || catalog.phase === "loading") && <p role="status">Reading saved searches…</p>}
    {(catalog?.phase === "error" || error) && <div className={styles.warning} role="status"><p>Could not read this search. Nothing new was started.</p><button className={styles.textButton} onClick={() => void controller.loadCatalog()} type="button">Check saved searches</button></div>}
    {catalog?.phase === "ready" && catalog.items.length === 0 && <p>No saved searches yet. Start a new search when you are ready.</p>}
    <ul className={styles.sessionList}>{catalog?.items.map(session => <li key={session.id} className={styles.sessionRow}>
      <div><Link className={styles.sessionTitle} href={searchSessionHref(session.id)} prefetch={false} onNavigate={onClose}>{session.title}</Link>
        <p className={styles.metadata}>Last activity: <time dateTime={session.lastActivityAt}>{activityDate(session.lastActivityAt)}</time></p></div>
      <div className={styles.actions}><button className={styles.button} type="button" disabled={opening !== null} onClick={() => void resume(session.id)}>{opening === session.id ? "Opening…" : "Resume"}</button>
        <button className={`${styles.textButton} ${styles.dangerText}`} type="button" disabled={opening !== null} onClick={() => setDeleting(session)}>Delete</button></div>
    </li>)}</ul>
    {catalog?.nextCursor && <button className={styles.textButton} disabled={catalog.phase === "loading"} type="button" onClick={() => void controller.loadCatalog(catalog.nextCursor ?? undefined)}>More saved searches</button>}
    {deleting && <DeleteSearchDialog session={deleting} onClose={() => setDeleting(null)} onDeleted={() => { setDeleting(null); void controller.loadCatalog(); }} />}
  </>;
}

export function DeleteSearchDialog({ session, onClose, onDeleted }: {
  readonly session: Session; readonly onClose: () => void; readonly onDeleted: () => void;
}) {
  const controller = useAgenticSearchController(), dialog = useRef<HTMLDialogElement>(null);
  const returnTarget = useRef<HTMLElement | null>(null);
  const [pending, setPending] = useState(false), [uncertain, setUncertain] = useState(false);
  useEffect(() => {
    returnTarget.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.showModal();
    return () => { if (returnTarget.current?.isConnected) returnTarget.current.focus(); };
  }, []);
  async function remove() {
    if (pending) return;
    setPending(true);
    if (!controller.get(session.id)) await controller.loadMetadata(session.id);
    const deleted = await controller.removeSession(session.id);
    setPending(false);
    if (deleted) onDeleted(); else setUncertain(true);
  }
  return <dialog ref={dialog} className={styles.dialog} aria-labelledby="delete-search-heading" aria-describedby="delete-search-description"
    onCancel={event => { event.preventDefault(); if (!pending) onClose(); }}>
    <h2 id="delete-search-heading">Delete this search?</h2>
    <p id="delete-search-description">Conversation and discoveries will be removed from Thoughtloom. Library ideas stay.</p>
    <p className={styles.metadata}>This does not erase copies held by OpenCode or providers.</p>
    {pending && <p role="status">Deleting this search…</p>}
    {uncertain && <p role="status" className={styles.warning}>Deletion was not confirmed. No replacement search was created. Any further Delete addresses this same search.</p>}
    <div className={styles.actions}><button type="button" autoFocus className={styles.button} disabled={pending} onClick={onClose}>Cancel</button>
      <button type="button" className={`${styles.button} ${styles.danger}`} disabled={pending} onClick={() => void remove()}>Delete search</button></div>
  </dialog>;
}

function activityDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "Unavailable" : `${new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }).format(date)} UTC`;
}
