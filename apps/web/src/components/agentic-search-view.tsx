"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import type { AgenticSearchController } from "../features/agentic-search/controller";
import { controls, terminal, type Effort, type Workspace } from "../features/agentic-search/types";
import { searchCatalogHref, searchHistoryHref, searchSessionHref } from "../features/agentic-search/location";
import { useAgenticSearchController } from "./agentic-search-provider";
import { useContextualBack } from "./contextual-back";
import { useExploreMemory } from "./explore-provider";
import { NewSearchButton, SessionsList, DeleteSearchDialog } from "./agentic-search-sessions";
import { SearchConversation, SearchDiscoveries } from "./agentic-search-content";
import styles from "./agentic-search.module.css";

// Presentation memory belongs to this mounted controller, never to a shared user/session cache.
const disclosures = new WeakMap<AgenticSearchController, Map<string, boolean>>();
function disclosureMemory(controller: AgenticSearchController) {
  let memory = disclosures.get(controller);
  if (!memory) { memory = new Map(); disclosures.set(controller, memory); }
  return memory;
}

export function AgenticSearchEntry() {
  const memory = useExploreMemory();
  useContextualBack(memory.current?.url ?? "/explore", "Back to Explore");
  return <section className={`${styles.view} ${styles.entry}`} aria-labelledby="ask-heading">
    <h1 id="ask-heading">Ask your library</h1>
    <p className={styles.intro}>Find existing ideas, even when you cannot remember the words. Ask a question, then narrow the search together.</p>
    <div className={styles.actions}><NewSearchButton /><Link className={styles.textButton} prefetch={false} href={searchCatalogHref}>Saved searches</Link></div>
    <p className={styles.policy}>Search looks only in your library. It does not create ideas or connections.</p>
  </section>;
}

export function AgenticSearchView({ id, history = false }: { readonly id: string; readonly history?: boolean }) {
  const controller = useAgenticSearchController(), memory = useExploreMemory(), router = useRouter();
  const snapshot = useCallback(() => controller.get(id), [controller, id]);
  const workspace = useSyncExternalStore(controller.subscribe, snapshot, () => null);
  const [ready, setReady] = useState(false), [sessionsOpen, setSessionsOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false), [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false), [copyNotice, setCopyNotice] = useState<string | null>(null);
  const [discoveriesOpen, setDiscoveriesOpen] = useState(() => disclosureMemory(controller).get(id) ?? false);
  const sessionButton = useRef<HTMLButtonElement>(null), actionsButton = useRef<HTMLButtonElement>(null), editTitleButton = useRef<HTMLButtonElement>(null);
  const sheetHeading = useRef<HTMLHeadingElement>(null), departing = useRef(false), restored = useRef(false);
  const rememberPosition = useCallback(() => {
    departing.current = true;
    if (!history) controller.saveScroll(id, window.scrollY);
  }, [controller, id, history]);
  const back = history ? searchSessionHref(id) : memory.current?.url ?? "/explore";
  useContextualBack(back, history ? "Back to search" : "Back to Explore", rememberPosition);

  useEffect(() => {
    let active = true;
    departing.current = false; restored.current = false; setReady(false);
    const existing = controller.get(id);
    const previewId = existing?.content.kind === "normal" ? existing.content.preview?.thought.id : undefined;
    async function open() {
      await controller.loadMetadata(id);
      if (!active) return;
      if (history) await controller.history(id);
      else if (controller.get(id)?.context.kind === "editable") {
        // Existing composer revalidation is GET-only. Unopened bookmarks require deliberate Resume.
        await controller.resume(id);
        if (active && previewId && controller.get(id)?.context.kind === "editable") await controller.preview(id, previewId);
      }
      if (active) setReady(true);
    }
    void open();
    const scroll = () => { if (!history && !departing.current && restored.current) controller.saveScroll(id, window.scrollY); };
    window.addEventListener("scroll", scroll, { passive: true });
    return () => {
      active = false;
      window.removeEventListener("scroll", scroll);
      if (!history && !departing.current && restored.current) controller.saveScroll(id, window.scrollY);
      controller.leave(id);
    };
  }, [controller, id, history]);

  useEffect(() => {
    if (!ready || restored.current) return;
    const y = history ? 0 : controller.get(id)?.scrollY ?? 0;
    const frame = requestAnimationFrame(() => { window.scrollTo(0, y); restored.current = true; });
    return () => cancelAnimationFrame(frame);
  }, [controller, id, history, ready]);

  const run = workspace?.admission.kind === "known" ? workspace.admission.run : null;
  useEffect(() => {
    if (history || !ready || !run || terminal(run)) return;
    const timer = setInterval(() => { if (document.visibilityState === "visible") void controller.check(id); }, 1500);
    return () => clearInterval(timer);
  }, [controller, id, history, ready, run?.id, run?.status]);
  useEffect(() => { if (sessionsOpen) sheetHeading.current?.focus(); }, [sessionsOpen]);
  function closeSessions() { setSessionsOpen(false); sessionButton.current?.focus(); }
  async function copyLink() {
    try { await navigator.clipboard.writeText(new URL(searchSessionHref(id), window.location.origin).href); setCopyNotice("Search link copied."); }
    catch { setCopyNotice("Could not copy the link. You can bookmark this search from your browser."); }
  }
  if (!workspace || workspace.phase === "loading") return <section className={styles.view}><h1>Search</h1><p role="status">Reading saved search…</p></section>;
  if (workspace.phase === "error" || !workspace.session) return <section className={styles.view}><h1>Search unavailable</h1><p>This search could not be read. Nothing new was started.</p><Link href={searchCatalogHref} prefetch={false}>Saved searches</Link></section>;
  if (workspace.phase === "deleted") return <section className={styles.view}><h1>Search deleted</h1><p>Library ideas are unchanged.</p><Link href={searchCatalogHref} prefetch={false}>Saved searches</Link></section>;
  const session = workspace.session;
  const usableContent = ready && (history ? workspace.content.kind === "history" : workspace.content.kind === "normal");
  const content = workspace.content;
  const permissions = controls(workspace);

  return <section className={styles.view} aria-labelledby="search-session-heading">
    <div className={styles.toolbar}>
      <h1 id="search-session-heading"><button ref={sessionButton} type="button" className={styles.sessionSwitcher}
        aria-expanded={sessionsOpen} aria-controls="search-sessions-sheet" onClick={() => setSessionsOpen(open => !open)}>
        <span className={styles.srOnly}>Sessions: </span>{session.title}<Chevron open={sessionsOpen} />
      </button></h1>
      <NewSearchButton />
      <button className={`${styles.button} ${styles.sessionActionsToggle}`} ref={actionsButton} type="button"
        aria-expanded={actionsOpen} aria-controls="search-session-actions" onClick={() => setActionsOpen(open => !open)}>Session actions</button>
      <div className={styles.sessionActions} id="search-session-actions" data-open={actionsOpen}
        onKeyDown={event => { if (event.key === "Escape") { setActionsOpen(false); actionsButton.current?.focus(); } }}>
        <button className={styles.textButton} ref={editTitleButton} type="button" disabled={workspace.busy} onClick={() => setEditing(true)}>Edit title</button>
        <button className={styles.textButton} type="button" onClick={() => void copyLink()}>Copy link</button>
        {!history && <Link className={styles.textButton} href={searchHistoryHref(id)} prefetch={false} onNavigate={rememberPosition}>History</Link>}
        <button className={`${styles.textButton} ${styles.dangerText}`} type="button" disabled={workspace.busy} onClick={() => setDeleting(true)}>Delete</button>
      </div>
    </div>
    {copyNotice && <p className={styles.metadata} role="status">{copyNotice}</p>}
    {editing && <SearchTitleEditor id={id} workspace={workspace} onClose={() => { setEditing(false); editTitleButton.current?.focus(); }} />}
    {sessionsOpen && <section id="search-sessions-sheet" className={styles.sessionsSheet} aria-labelledby="search-sessions-heading"
      onKeyDown={event => { if (event.key === "Escape") closeSessions(); }}>
      <div className={styles.pageHeading}><h2 id="search-sessions-heading" tabIndex={-1} ref={sheetHeading}>Saved searches</h2><button className={styles.textButton} type="button" onClick={closeSessions}>Close sessions</button></div>
      <SessionsList onClose={() => setSessionsOpen(false)} />
    </section>}
    {history && <div className={styles.historyHeading}><h2>History · User-only</h2><p>This is a read-only history view, not context for the agent.</p><Link href={searchSessionHref(id)} prefetch={false}>Return to search</Link></div>}
    {workspace.observationError && <div className={styles.warning} role="status"><p>Could not confirm the latest state. No request has been sent again automatically.</p>
      <button className={styles.textButton} type="button" disabled={workspace.busy} onClick={() => void (history ? controller.history(id) : permissions.canCheck ? controller.check(id) : workspace.context.kind === "editable" ? controller.readNormal(id) : controller.loadMetadata(id))}>Check {history ? "history" : "search"}</button></div>}
    {!ready && <p role="status">Reading eligible saved content…</p>}
    {!history && ready && workspace.context.kind === "unopened" && <div className={styles.resume}>
      <p>Resume this search to read its available conversation and discoveries.</p><button className={`${styles.button} ${styles.primary}`} type="button" disabled={workspace.busy} onClick={() => void controller.resume(id)}>Resume</button>
    </div>}
    {!history && <SearchRunStatus id={id} workspace={workspace} />}
    <div className={styles.columns}>
      <div className={styles.working}>
        {usableContent && content.kind !== "unopened" && <SearchConversation page={content.messages} busy={workspace.busy} more={() => {
          const cursor = content.messages.nextCursor;
          if (cursor) void (history ? controller.readHistoryPage(id, "messages", cursor) : controller.readPage(id, "messages", cursor));
        }} />}
        {!history && workspace.blockedDraft !== null && <section className={styles.warning} aria-label="Preserved previous draft">
          <h2>{workspace.context.kind === "changed" ? "Context changed. This draft cannot be sent." : "Previous draft · Not sent"}</h2>
          <p className={styles.message}>{workspace.blockedDraft || "The previous draft was empty."}</p>
          {workspace.context.kind === "changed" && <button className={styles.button} disabled={workspace.busy} type="button" onClick={() => void controller.newBlankDraft(id)}>Start a new blank draft</button>}
        </section>}
        {!history && ready && workspace.context.kind === "editable" && <SearchComposer id={id} workspace={workspace} />}
      </div>
      {usableContent && <aside className={styles.discoveryPane} aria-labelledby="search-discoveries-heading">
        <button className={styles.discoveryToggle} type="button" aria-expanded={discoveriesOpen} aria-controls="search-discoveries" onClick={() => {
          disclosureMemory(controller).set(id, !discoveriesOpen); setDiscoveriesOpen(!discoveriesOpen);
        }}><span>Discovered ideas</span><Chevron open={discoveriesOpen} /></button>
        <div id="search-discoveries" className={styles.discoveryContent} data-open={discoveriesOpen}>
          <h2 id="search-discoveries-heading">Discovered ideas</h2><SearchDiscoveries id={id} workspace={workspace} history={history} rememberPosition={rememberPosition} />
        </div>
      </aside>}
    </div>
    {deleting && <DeleteSearchDialog session={session} onClose={() => setDeleting(false)} onDeleted={() => router.replace(searchCatalogHref)} />}
  </section>;
}

function SearchComposer({ id, workspace }: { readonly id: string; readonly workspace: Workspace }) {
  const controller = useAgenticSearchController(), permissions = controls(workspace);
  const frozen = workspace.admission.kind === "submitting" || workspace.admission.kind === "unconfirmed";
  function send(event: FormEvent) { event.preventDefault(); if (permissions.canSend) void controller.send(id); }
  return <form className={styles.composer} onSubmit={send} noValidate>
    <label htmlFor="search-message">Your message</label>
    <div className={styles.sendRow}><textarea id="search-message" rows={3} value={workspace.draft} readOnly={frozen}
      onChange={event => controller.changeDraft(id, event.target.value)} />
      <button className={`${styles.button} ${styles.primary}`} type="submit" disabled={!permissions.canSend}>Send</button></div>
    <div className={styles.effort}><label htmlFor="search-effort">Effort</label><select id="search-effort" value={workspace.effort} disabled={frozen || workspace.busy}
      onChange={event => { const value = event.target.value; if (isEffort(value)) controller.changeEffort(id, value); }}>
      <option value="quick">Quick</option><option value="standard">Standard</option><option value="thorough">Thorough</option>
    </select></div>
    {workspace.admission.kind === "known" && !terminal(workspace.admission.run) && <p className={styles.metadata}>Your next draft stays here. Send is paused while this search is active.</p>}
  </form>;
}

function SearchRunStatus({ id, workspace }: { readonly id: string; readonly workspace: Workspace }) {
  const controller = useAgenticSearchController(), permission = controls(workspace), admission = workspace.admission;
  if (admission.kind === "idle") return null;
  if (admission.kind === "submitting") return <p className={styles.runStatus} role="status">Waiting for request confirmation…</p>;
  if (admission.kind === "unconfirmed") return <section className={styles.warning} aria-label="Unconfirmed request">
    <h2>Not sure this request started. Check before sending again.</h2><p className={styles.metadata}>Submitted request · local snapshot, not a recorded message</p>
    <p className={styles.message}>{admission.snapshot.payload.text}</p><button className={styles.button} disabled={!permission.canCheck} type="button" onClick={() => void controller.check(id)}>Check</button>
  </section>;
  if (admission.kind === "not-started") return <p className={styles.warning} role="status">Search was not started. Your words are kept; send deliberately when you are ready.</p>;
  const run = admission.run;
  const label = run.status === "queued" ? "Queued" : run.status === "running" || run.status === "submitting" ? "Searching" : run.status === "uncertain" ? "Search status uncertain" : run.status === "interrupted" ? run.outcomeReason === "stopped" ? "Search stopped" : "Search interrupted" : run.status === "failed" ? "Search failed" : "Search complete";
  return <div className={styles.runStatus}>
    <p role="status">{label}</p>
    <div className={styles.actions}><button className={styles.textButton} type="button" disabled={!permission.canCheck} onClick={() => void controller.check(id)}>Check</button>
      {!terminal(run) && <button className={styles.button} type="button" disabled={!permission.canStop} onClick={() => void controller.stop(id)}>Stop</button>}</div>
    {run.cancellation === "pending" && <p className={styles.metadata}>Remote stopping is not yet confirmed. Saved messages and discoveries remain.</p>}
  </div>;
}

function SearchTitleEditor({ id, workspace, onClose }: { readonly id: string; readonly workspace: Workspace; readonly onClose: () => void }) {
  const controller = useAgenticSearchController(), input = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState(workspace.session?.title ?? ""), [invalid, setInvalid] = useState(false);
  useEffect(() => { input.current?.focus(); }, []);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!title.trim()) { setInvalid(true); input.current?.focus(); return; }
    await controller.rename(id, title);
    if (controller.get(id)?.session?.title === title) onClose();
  }
  return <form className={styles.titleEditor} onSubmit={event => void save(event)} noValidate>
    <label htmlFor="search-title">Search title</label><input ref={input} id="search-title" value={title} aria-invalid={invalid || undefined}
      aria-describedby={invalid ? "search-title-error" : undefined} onChange={event => { setTitle(event.target.value); setInvalid(false); }} />
    {invalid && <p id="search-title-error" className={styles.dangerText}>Enter a title.</p>}
    <div className={styles.actions}><button className={`${styles.button} ${styles.primary}`} disabled={workspace.busy} type="submit">Save title</button><button className={styles.textButton} disabled={workspace.busy} type="button" onClick={onClose}>Cancel</button></div>
  </form>;
}
function Chevron({ open }: { readonly open: boolean }) {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d={open ? "m6 15 6-6 6 6" : "m6 9 6 6 6-6"} /></svg>;
}
function isEffort(value: string): value is Effort { return value === "quick" || value === "standard" || value === "thorough"; }
