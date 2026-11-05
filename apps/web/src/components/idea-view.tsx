"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ideaActionHref, type IdeaLocation, type IdeaScope } from "../features/idea/location";
import { commandIdea, readIdea } from "../features/idea/request";
import type {
  BranchPreview, IdeaCommand, IdeaConnection,
  IdeaThought, IdeaView as IdeaRecord,
} from "../features/idea/types";
import styles from "./idea.module.css";
import { useIdeaNavigation, type PreviousIdea } from "./idea-navigation-provider";
import { useExploreMemory } from "./explore-provider";
import { useEvolveStore } from "./evolve-provider";

type Confirmation = { kind: "idea" } | { kind: "branch" } | { kind: "connection"; id: string };
type PreviewState = { phase: "loading" | "error"; stale: boolean }
  | { phase: "ready"; stale: boolean; value: BranchPreview };

const materials = {
  "captured-original": "Original capture", "user-contribution": "Contribution",
  "ai-interpretation": "Interpretation", "developing-idea": "Developing idea",
};
const titleOf = (thought: IdeaThought) => thought.title ?? thought.text.trim().split(/\s+/).slice(0, 5).join(" ");
const actor = (value: "user" | "ai") => value === "user" ? "You" : "AI";
function dateOf(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat("en", {
    month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
  }).format(date);
}
function thoughtHref(id: string, location: IdeaLocation, scope: IdeaScope = location.scope) {
  const params = new URLSearchParams({ returnTo: location.returnTo });
  if (scope !== "normal") params.set("scope", scope);
  return `/ideas/${encodeURIComponent(id)}?${params}`;
}
function relationship(connection: IdeaConnection, focus: string) {
  const outgoing = connection.fromId === focus;
  switch (connection.category) {
    case "supports": return outgoing ? "Supports" : "Supported by";
    case "contradicts": return outgoing ? "Contradicts" : "Contradicted by";
    case "extends": return outgoing ? "Extends" : "Extended by";
    case "related": return "Related";
  }
}

interface ContextItem {
  readonly id: string;
  thought: IdeaThought | null;
  child: boolean;
  source: boolean;
  readonly connections: IdeaConnection[];
}

/** Group direct records for presentation, preserving relation order and identity. */
function contextItems(view: IdeaRecord): ContextItem[] {
  const items = new Map<string, ContextItem>();
  const include = (id: string, thought: IdeaThought | null) => {
    let item = items.get(id);
    if (!item) {
      item = { id, thought, child: false, source: false, connections: [] };
      items.set(id, item);
    } else if (!item.thought && thought) item.thought = thought;
    return item;
  };
  for (const thought of view.children) include(thought.id, thought).child = true;
  for (const { connection, thought } of view.connections) {
    const id = connection.fromId === view.thought.id ? connection.toId : connection.fromId;
    const item = include(id, thought);
    if (!item.connections.some(value => value.id === connection.id)) item.connections.push(connection);
  }
  for (const { id, thought } of view.sources) include(id, thought).source = true;
  return [...items.values()];
}

/** A location-keyed reader: late responses cannot replace another focused idea. */
export function IdeaView({ location }: { location: IdeaLocation | null }) {
  const navigation = useIdeaNavigation();
  const exploreMemory = useExploreMemory();
  const evolve = useEvolveStore();
  const [previous, setPrevious] = useState<PreviousIdea | null>(null);
  const [view, setView] = useState<IdeaRecord | null>(null);
  const [readState, setReadState] = useState<"loading" | "ready" | "error" | "unavailable">("loading");
  const [removed, setRemoved] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [unconfirmedCommand, setUnconfirmedCommand] = useState<IdeaCommand | null>(null);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const [titleError, setTitleError] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyId, setReplyId] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const alive = useRef(false);
  const readGeneration = useRef(0);
  const previewGeneration = useRef(0);
  const admittedPreview = useRef<BranchPreview | null>(null);
  const writing = useRef(false);
  const currentView = useRef(view);
  const titleInput = useRef<HTMLInputElement>(null);
  const more = useRef<HTMLDivElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const dialogReturn = useRef<HTMLElement | null>(null);
  const disabled = pending || unconfirmed;

  const load = useCallback(async () => {
    if (!location) return;
    const generation = ++readGeneration.current;
    setReadState("loading");
    const result = await readIdea(location.id, {
      scope: location.scope, part: "view", responseId: location.responseId,
    }, { fetch: window.fetch.bind(window) });
    if (!alive.current || generation !== readGeneration.current) return;
    if (result.kind === "view") {
      currentView.current = result.value;
      setView(result.value);
      setReadState("ready");
      setRemoved(false);
      // Only the scoped associated-response match may be automatically selected.
      if (result.value.focusedResponse) {
        setReplyId(result.value.focusedResponse.id);
        setReplyOpen(true);
      }
    } else {
      currentView.current = null;
      setView(null);
      setReadState(result.kind === "unavailable" ? "unavailable" : "error");
    }
  }, [location]);

  useEffect(() => {
    alive.current = true;
    const pendingNavigation = navigation.current;
    if (pendingNavigation?.destination === `${window.location.pathname}${window.location.search}`) {
      setPrevious(pendingNavigation);
    }
    navigation.current = null;
    void load();
    return () => {
      alive.current = false;
      readGeneration.current++;
      previewGeneration.current++;
    };
  }, [load, navigation]);

  useEffect(() => { if (editing) titleInput.current?.focus(); }, [editing]);
  useEffect(() => {
    if (confirmation && !dialog.current?.open) dialog.current?.showModal();
    if (!confirmation && dialog.current?.open) dialog.current.close();
  }, [confirmation]);

  useEffect(() => {
    if (!menuOpen) return;
    const dismissOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !more.current?.contains(event.target)) {
        // Let the clicked control receive its own pointer event and focus.
        setMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", dismissOutside, true);
    return () => document.removeEventListener("pointerdown", dismissOutside, true);
  }, [menuOpen]);

  async function loadPreview(stale = false) {
    if (!location) return;
    const generation = ++previewGeneration.current;
    // Invalidate the previous payload before a fresh read, including on failure.
    admittedPreview.current = null;
    setPreview({ phase: "loading", stale });
    const result = await readIdea(location.id, { scope: location.scope, part: "preview" }, { fetch: window.fetch.bind(window) });
    if (!alive.current || generation !== previewGeneration.current) return;
    if (result.kind === "preview") admittedPreview.current = result.value;
    setPreview(result.kind === "preview" ? { phase: "ready", value: result.value, stale } : { phase: "error", stale });
  }
  function openConfirmation(value: Confirmation, returnTarget = document.activeElement as HTMLElement | null) {
    if (disabled) return;
    // A command can become disabled while its outcome is unconfirmed.
    dialogReturn.current = returnTarget;
    setMenuOpen(false);
    setConfirmation(value);
    if (value.kind === "branch") void loadPreview();
  }
  function closeConfirmation() {
    if (writing.current) return;
    const wasOpen = dialog.current?.open === true;
    const returnTarget = dialogReturn.current;
    dialogReturn.current = null;
    previewGeneration.current++;
    admittedPreview.current = null;
    dialog.current?.close();
    setConfirmation(null);
    setPreview(null);
    if (wasOpen) {
      const available = returnTarget?.isConnected && returnTarget !== document.body && !returnTarget.matches(":disabled")
        && !returnTarget.closest("[hidden]");
      (available ? returnTarget : menuButton.current)?.focus();
    }
  }

  async function submitCommand(command: IdeaCommand) {
    if (writing.current || unconfirmed || !location) return;
    writing.current = true;
    setPending(true);
    setNotice(null);
    // A write may change titles or eligibility. Reread on return, keeping the
    // exploration intent and place; this is not evidence that a write succeeded.
    const explored = exploreMemory.current;
    if (explored?.state.query.q.trim()) exploreMemory.current = {
      ...explored,
      state: { ...explored.state, phase: "loading", page: null, message: null },
    };
    const result = await commandIdea(command, { fetch: window.fetch.bind(window) });
    if (!alive.current) return;
    writing.current = false;
    setPending(false);
    if (result.kind === "conflict") {
      setNotice("The branch changed. Nothing was rejected. Review the fresh preview and confirm again.");
      void loadPreview(true);
      return;
    }
    if (result.kind !== "applied") {
      setNotice(result.kind === "uncertain"
        ? "Outcome unconfirmed. The change may still complete. No change will be sent again automatically."
        : "The change was not applied. Your inputs are still here.");
      setUnconfirmed(result.kind === "uncertain");
      if (result.kind === "uncertain") setUnconfirmedCommand(result.command);
      closeConfirmation();
      return;
    }
    closeConfirmation();
    setMenuOpen(false);
    if (command.action === "title" && result.thought && currentView.current) {
      const previous = currentView.current.thought;
      const thought = {
        ...result.thought,
        ...(result.thought.rejected === undefined && previous.rejected !== undefined
          ? { rejected: previous.rejected } : {}),
      };
      const updated = { ...currentView.current, thought };
      currentView.current = updated;
      setView(updated);
      setEditing(false);
      setNotice(command.title === null
        ? "Title cleared. A new title may be generated later. The original words are unchanged."
        : "Title saved. The original words are unchanged.");
      return;
    }
    setReplyOpen(false); setReplyId(null);
    if (command.action === "reject-thought" || command.action === "reject-branch") {
      // Confirmed rejection is not permission to broaden the ordinary read scope.
      readGeneration.current++;
      currentView.current = null;
      setView(null);
      setRemoved(true);
      setReadState("ready");
      setNotice(command.action === "reject-thought"
        ? "Idea rejected. Its descendants remain active."
        : "Idea branch rejected. Discovered connections were not included.");
    } else {
      setNotice(command.action === "restore-branch" || command.action === "restore-thought"
        ? "Restored. Independently rejected connections stay rejected."
        : "Connection change confirmed.");
      void load();
    }
  }

  function saveTitle(event: FormEvent) {
    event.preventDefault();
    if (!title.trim()) { setTitleError(true); titleInput.current?.focus(); return; }
    if (location) void submitCommand({ action: "title", thoughtId: location.id, title });
  }
  const back = location?.returnTo ?? "/explore";
  const inspection = location?.scope !== "normal";
  const thought = view?.thought;
  const reply = view?.responses.find(value => value.id === replyId) ?? null;
  const context = view ? contextItems(view) : [];

  return (
    <section className={styles.view} onClickCapture={event => {
      if (!location || !thought || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = (event.target as Element).closest<HTMLAnchorElement>("a[href]");
      if (!link || link.origin !== window.location.origin || !link.pathname.startsWith("/ideas/")
        || link.download || (link.target && link.target !== "_self")) return;
      const destination = `${link.pathname}${link.search}`;
      let href = thoughtHref(location.id, location);
      if (location.responseId) href += `&${new URLSearchParams({ responseId: location.responseId })}`;
      if (destination !== href) navigation.current = { destination, href, title: titleOf(thought) };
    }}>
      <Link className={styles.back} href={back} prefetch={false}>
        <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="m10 5-7 7 7 7M3 12h18" /></svg>
        {back === "/explore" ? "Back to Explore" : "Back to results"}
      </Link>
      {previous && <Link className={`${styles.back} ${styles.previous}`} href={previous.href}
        prefetch={false}>Previous thought: {previous.title}</Link>}

      {notice && !removed && <div className={unconfirmed ? styles.warning : styles.notice} role="status">
        <p>{notice}</p>
        {unconfirmed && <>
          {unconfirmedCommand?.action === "title" && <p className={styles.retained}>
            Requested title: {unconfirmedCommand.title === null ? "Clear title" : unconfirmedCommand.title}
          </p>}
          <button className={styles.textButton} disabled={readState === "loading"}
            onClick={() => void load()}>Check current idea</button>
          <p>A current read cannot prove that a delayed change will not still complete. Further changes are paused in this view.</p>
        </>}
      </div>}

      {!location ? <><h1>Idea link not valid</h1><p>Open an idea from Explore or Capture.</p></>
        : readState === "loading" ? <div role="status"><h1>Loading idea…</h1><p>Reading the saved thought and its available context.</p></div>
        : removed ? <div className={styles.empty}>
          <h1>Idea rejected</h1><p role="status">{notice}</p>
          <Link href={thoughtHref(location.id, location, "show-rejected")} prefetch={false}>Inspect rejected idea</Link>
        </div>
        : !thought || !view ? <div className={styles.empty}>
          <h1>Idea unavailable</h1>
          <p>{readState === "unavailable" ? "This idea is not available in this view." : "We could not read this idea. No changes were made by this read."}</p>
          {readState === "error" && <button className={styles.button} onClick={() => void load()}>Try reading again</button>}
        </div>
        : <>
          {inspection && <div className={styles.inspection}>
            <strong>User inspection{thought.rejected === true ? " · Rejected idea" : ""}</strong>
            <p>This view may include rejected material. It is not ordinary AI context.</p>
            {thought.rejected === undefined && <p>The idea's rejection status is unavailable. Evolve is paused.</p>}
          </div>}
          <div className={styles.focus}>
            <div className={styles.thought}>
              <Byline thought={thought} />
              <h1>{titleOf(thought)}</h1>
              <p className={styles.original}>{thought.text}</p>
            </div>
            {thought.rejected === true || (inspection && thought.rejected !== false)
              ? <button className={`${styles.button} ${styles.primary}`} disabled aria-disabled="true">Evolve this idea</button>
              : <Link className={`${styles.button} ${styles.primary}`} href={ideaActionHref(thought.id, "evolve")} prefetch={false}
                onNavigate={() => evolve.startFromIdea(thought.id)}>Evolve this idea</Link>}
          </div>

          {view.parent && <p className={styles.parent}>
            <span>Developed from:</span>{" "}
            {view.parent.thought ? <>
              <Link href={thoughtHref(view.parent.id, location)} prefetch={false}>{titleOf(view.parent.thought)}</Link>
              {view.parent.thought.rejected === true && <span className={styles.rejected}>Rejected</span>}
            </> : <>
              <span>Parent unavailable in this view.</span>
              {!inspection && <Link href={thoughtHref(view.parent.id, location, "show-rejected")} prefetch={false}>Inspect parent</Link>}
            </>}
          </p>}

          <div className={styles.tools}>
            <button className={styles.textButton} disabled={disabled} onClick={() => {
              setTitle(thought.title ?? ""); setTitleError(false); setEditing(true);
            }}>Edit title</button>
            {view.responses.length > 0 && <button className={styles.textButton} aria-expanded={replyOpen} aria-controls="idea-reply" onClick={() => {
              setReplyOpen(!replyOpen);
              if (!replyId) setReplyId(view.responses[0]!.id);
            }}>Full reply</button>}
            <div className={styles.more} ref={more} onKeyDown={event => {
              if (event.key === "Escape" && menuOpen) { event.preventDefault(); setMenuOpen(false); menuButton.current?.focus(); }
            }}>
              <button className={styles.textButton} ref={menuButton} aria-expanded={menuOpen}
                aria-controls="idea-actions" onClick={() => setMenuOpen(!menuOpen)}>More actions</button>
              <div className={styles.actions} id="idea-actions" hidden={!menuOpen}>
                <Link href={ideaActionHref(thought.id, "export")} prefetch={false}>Export…</Link>
                {thought.rejected === true ? <>
                  <button className={styles.textButton} disabled={disabled} onClick={() => void submitCommand({ action: "restore-thought", thoughtId: thought.id })}>Restore this idea</button>
                  <button className={styles.textButton} disabled={disabled} onClick={() => void submitCommand({ action: "restore-branch", thoughtId: thought.id })}>Restore idea branch</button>
                </> : <>
                  <button className={styles.textButton} disabled={disabled} onClick={() => openConfirmation({ kind: "idea" }, menuButton.current)}>Reject idea…</button>
                  <button className={styles.textButton} disabled={disabled} onClick={() => openConfirmation({ kind: "branch" }, menuButton.current)}>Reject branch…</button>
                </>}
              </div>
            </div>
          </div>

          {pending && <p role="status">Waiting for confirmation. Please do not send the change again.</p>}
          {editing && <form className={styles.editor} onSubmit={saveTitle} noValidate>
            <h2>Edit title</h2>
            <p>Only the title changes. The saved thought stays exactly as it is.</p>
            <label htmlFor="idea-title">Title</label>
            <input id="idea-title" ref={titleInput} value={title} readOnly={disabled}
              aria-invalid={titleError ? true : undefined}
              aria-describedby={titleError ? "idea-title-error" : "idea-title-help"}
              onChange={event => { setTitle(event.target.value); setTitleError(false); }} />
            {titleError && <p id="idea-title-error" className={styles.error} role="alert">Enter a title, or choose Clear title.</p>}
            <p id="idea-title-help">Clearing permits a new title to be generated later; it does not promise when.</p>
            <div className={styles.buttons}>
              <button className={`${styles.button} ${styles.primary}`} type="submit" disabled={disabled}>Save title</button>
              <button className={styles.button} type="button" disabled={disabled}
                onClick={() => void submitCommand({ action: "title", thoughtId: thought.id, title: null })}>Clear title</button>
              <button className={styles.textButton} type="button" disabled={pending} onClick={() => setEditing(false)}>Cancel</button>
            </div>
          </form>}

          {location.responseId && !view.focusedResponse && <p className={styles.notice}>
            The requested full reply is unavailable for this idea in this view.
          </p>}
          <div id="idea-reply" hidden={!replyOpen} className={styles.detail}>
            {reply && <>
              <h2>Full reply</h2>
              <p className={styles.metadata}>AI · {reply.state === "interrupted" ? "Interrupted reply" : "Retained reply"} · {reply.role === "fallback" ? "Fallback" : "Addendum"}</p>
              {view.responses.length > 1 && <label className={styles.replyChoice}>Reply
                <select value={reply.id} onChange={event => setReplyId(event.target.value)}>
                  {view.responses.map((item, index) => <option key={item.id} value={item.id}>Reply {index + 1} · {item.state}</option>)}
                </select>
              </label>}
              <p className={styles.retained}>{reply.text}</p>
              <p className={styles.metadata}>A retained response is not a new development or an endorsement.</p>
            </>}
          </div>

          <details className={styles.metadataDetails}>
            <summary>About this idea</summary>
            <dl><dt>Created (UTC)</dt><dd>{dateOf(thought.createdAt)}</dd>
              <dt>Origin</dt><dd>{thought.origin}</dd>
              <dt>Title by</dt><dd>{thought.titleAuthor ? actor(thought.titleAuthor) : "No attributed title"}</dd>
              <dt>Idea ID</dt><dd className={styles.identifier}>{thought.id}</dd></dl>
          </details>

          <section className={styles.context} aria-labelledby="idea-context-heading">
            <h2 id="idea-context-heading">{inspection ? "Inspected context" : "Surrounding context"}</h2>
            {context.length === 0 && <p>No directly linked thoughts are available in this view.</p>}
            {context.map(item => <ContextRow key={item.id} item={item}
              location={location} focus={thought.id} inspection={inspection} disabled={disabled}
              onReject={id => openConfirmation({ kind: "connection", id })}
              onRestore={id => void submitCommand({ action: "restore-connection", thoughtId: thought.id, connectionId: id })} />)}
          </section>
        </>}

      <dialog ref={dialog} className={styles.dialog} aria-labelledby="idea-confirm-heading"
        aria-describedby="idea-confirm-description" onCancel={event => { event.preventDefault(); closeConfirmation(); }}>
        {confirmation && location && <>
          <h2 id="idea-confirm-heading">{confirmation.kind === "branch" ? "Reject idea branch" : confirmation.kind === "idea" ? "Reject this idea?" : "Reject this connection?"}</h2>
          <p id="idea-confirm-description">{confirmation.kind === "branch"
            ? "This idea and its evolution descendants only. Discovered connections and source references are not included."
            : confirmation.kind === "idea" ? "Only this idea is rejected. Its descendants remain active. Rejection is not deletion."
              : "Only this recorded connection is rejected. Neither connected idea is rejected."}</p>
          {confirmation.kind === "branch" && <>
            {preview?.stale && <p className={styles.warning}>The branch changed. Nothing was rejected. A new preview needs a new confirmation.</p>}
            {preview?.phase === "loading" ? <p role="status">Reading a fresh branch preview…</p>
              : preview?.phase === "error" ? <><p>Preview unavailable. The old confirmation cannot be used.</p><button className={styles.textButton} onClick={() => void loadPreview(preview.stale)}>Read a new preview</button></>
              : preview?.phase === "ready" && <>
                <p className={styles.previewCount}>{preview.value.count} {preview.value.count === 1 ? "idea will" : "ideas will"} be rejected</p>
                <p>Starting at <strong>{thought ? titleOf(thought) : location.id}</strong>.</p>
                <details><summary>Affected idea IDs</summary><ul className={styles.ids}>
                  {preview.value.affectedIds.map(id => <li key={id}>{id}</li>)}
                </ul></details>
              </>}
          </>}
          {pending && <p role="status">Waiting for confirmation. This change has already been sent.</p>}
          <div className={styles.buttons}>
            <button className={styles.button} type="button" disabled={pending} onClick={closeConfirmation} autoFocus>Cancel</button>
            <button className={`${styles.button} ${styles.danger}`} type="button"
              disabled={disabled || (confirmation.kind === "branch" && preview?.phase !== "ready")}
              onClick={() => {
                if (confirmation.kind === "idea") void submitCommand({ action: "reject-thought", thoughtId: location.id });
                else if (confirmation.kind === "connection") void submitCommand({ action: "reject-connection", thoughtId: location.id, connectionId: confirmation.id });
                else if (preview?.phase === "ready" && admittedPreview.current === preview.value) {
                  void submitCommand({ action: "reject-branch", thoughtId: location.id, preview: preview.value });
                }
              }}>{confirmation.kind === "branch" ? "Confirm reject branch" : confirmation.kind === "idea" ? "Reject this idea" : "Reject connection"}</button>
          </div>
        </>}
      </dialog>
    </section>
  );
}

function Byline({ thought }: { thought: IdeaThought }) {
  return <p className={styles.byline}>
    <span className={thought.author === "user" ? styles.user : styles.ai}>{actor(thought.author)}</span>
    <span>{materials[thought.kind]}</span>
    {thought.rejected === true && <span className={styles.rejected}>Rejected</span>}
  </p>;
}

function ContextRow({ item, location, focus, inspection, disabled, onReject, onRestore }: {
  item: ContextItem; location: IdeaLocation; focus: string;
  inspection: boolean; disabled: boolean; onReject: (id: string) => void; onRestore: (id: string) => void;
}) {
  const { thought } = item;
  const [expanded, setExpanded] = useState(false);
  const abbreviate = thought !== null && thought.text.length > 240;
  return <article className={styles.connectionRow}>
    <div>
      <h3>{thought ? <Link href={thoughtHref(thought.id, location)} prefetch={false}>{titleOf(thought)}</Link> : "Idea unavailable in this view"}</h3>
      {thought && <Byline thought={thought} />}
      {!thought && <p className={styles.metadata}>{item.id}</p>}
    </div>
    <div>
      {thought && <p className={styles.contextText}>
        {abbreviate && !expanded ? thought.text.slice(0, 240) : thought.text}
        {abbreviate && <> <button className={styles.textButton} aria-expanded={expanded}
          aria-label={`${expanded ? "Collapse" : "Expand"} context text for ${titleOf(thought)}`}
          onClick={() => setExpanded(!expanded)}>{expanded ? "Show less" : "…"}</button></>}
      </p>}
      {item.child && <p className={`${styles.relationship} ${styles.directRelationship}`}>Developed from this idea</p>}
      {item.source && <p className={`${styles.relationship} ${styles.directRelationship}`}>Used as a source for this idea</p>}
      {item.connections.map(connection => <RecordedConnection key={connection.id} connection={connection}
        focus={focus} inspection={inspection} disabled={disabled}
        onReject={() => onReject(connection.id)} onRestore={() => onRestore(connection.id)} />)}
    </div>
    <div className={styles.connectionActions}>
      {thought && <Link href={thoughtHref(thought.id, location)} prefetch={false}>Open idea</Link>}
    </div>
  </article>;
}

function RecordedConnection({ connection, focus, inspection, disabled, onReject, onRestore }: {
  connection: IdeaConnection; focus: string; inspection: boolean; disabled: boolean;
  onReject: () => void; onRestore: () => void;
}) {
  const [why, setWhy] = useState(inspection);
  const [actions, setActions] = useState(false);
  return <div className={styles.recordedConnection} role="group" aria-label={`${relationship(connection, focus)} connection ${connection.id}`}>
      <div className={styles.relationship}>
        <strong>{relationship(connection, focus)}</strong>
        <button className={styles.textButton} aria-expanded={why}
          aria-controls={`why-${connection.id}`} onClick={() => setWhy(!why)}>Why connected</button>
      </div>
      <div id={`why-${connection.id}`} hidden={!why} className={styles.rationale}>
        <p>{connection.explanation}</p>
        <p className={styles.metadata}>Connection proposed by {actor(connection.proposedBy)}.</p>
        <p className={styles.metadata}>Recorded direction: <span className={styles.identifier}>{connection.fromId}</span> to <span className={styles.identifier}>{connection.toId}</span>.</p>
        {connection.sourceIds.length > 0 && <p className={styles.metadata}>Recorded source IDs: {connection.sourceIds.join(", ")}</p>}
      </div>
    <div className={styles.connectionActions}>
      {inspection && <p className={styles.metadata}>{connection.rejected === true ? "Explicitly rejected connection" : connection.rejected === false ? "Connection not independently rejected" : "Connection rejection status unavailable"}</p>}
      {connection.rejected === true
        ? <button className={styles.textButton} disabled={disabled} onClick={onRestore}>Restore connection</button>
        : <details open={actions} onToggle={event => setActions(event.currentTarget.open)}>
          <summary>Connection actions</summary>
          <button className={styles.textButton} disabled={disabled} onClick={onReject}>Reject connection…</button>
        </details>}
    </div>
  </div>;
}
