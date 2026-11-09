"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { ideaActionHref, type IdeaLocation, type IdeaScope } from "../features/idea/location";
import { commandIdea, readIdea } from "../features/idea/request";
import type {
  BranchPreview, IdeaCommand, IdeaConnection,
  IdeaThought, IdeaView as IdeaRecord,
} from "../features/idea/types";
import styles from "./idea.module.css";
import { useIdeaNavigation, type PreviousIdea } from "./idea-navigation-provider";
import { useExploreMemory } from "./explore-provider";
import { useBrowseMapMemory, useBrowseMemory } from "./browse-provider";
import { browseMapHref } from "../features/browse/query";
import { useEvolveStore } from "./evolve-provider";
import { useContextualBack } from "./contextual-back";
import { ContentGlyph } from "./content-glyph";
import { ConnectionEditor } from "./connection-editor";
import { sourceController, useMediaSourceMemory } from "./media-import-provider";
import { MediaSourceDetails } from "./media-source-details";
import { MediaSourceStatus } from "./media-source-status";
import type { MediaRun, MediaScope } from "../features/media/types";
import { createReinterpretationController } from "../features/idea/reinterpretation-controller";
import { createReinterpretationClient } from "../features/idea/reinterpretation-request";
import { reinterpretationId } from "../features/idea/reinterpretation";
import { ReinterpretationStatus, reinterpretationRunToShow } from "./reinterpretation-status";

const noSource = () => null;
const noSubscription = () => () => {};

type Confirmation = { kind: "idea" } | { kind: "branch" } | { kind: "connection"; id: string };
type PreviewState = { phase: "loading" | "error"; stale: boolean }
  | { phase: "ready"; stale: boolean; value: BranchPreview };
type CanonicalRead = {
  readonly generation: number;
  mode: "foreground" | "background" | "connection";
  readonly publication: Promise<IdeaRecord | null>;
};
type RunContentIntent = { readonly token: string; readonly runs: readonly MediaRun[] };

const materials = {
  "captured-original": "Original capture", "user-contribution": "Contribution",
  "ai-interpretation": "Interpretation", "developing-idea": "Developing idea", "imported-original": "Imported source", "media-original": "Imported source",
};
const titleOf = (thought: IdeaThought) => thought.title ?? (thought.kind === "media-original" ? thought.mediaSource.name : thought.text.trim().split(/\s+/).slice(0, 5).join(" "));
const actor = (value: "user" | "ai" | "source") => value === "user" ? "You" : value === "ai" ? "AI" : "Imported source";
function dateOf(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat("en", {
    month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
  }).format(date);
}
function thoughtHref(id: string, location: IdeaLocation, scope: IdeaScope = location.scope) {
  const params = new URLSearchParams({ returnTo: location.returnTo });
  // An inclusive Explore return must not silently re-infer inspection on an explicit normal link.
  params.set("scope", scope);
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

function containsRunOutput(view: IdeaRecord, runs: readonly MediaRun[]) {
  return runs.every(run => run.confirmedThoughtIds.every(id => view.children.some(child => child.id === id))
    && (run.responseId === null || view.responses.some(reply => reply.id === run.responseId)));
}

/** A location-keyed reader: late responses cannot replace another focused idea. */
export function IdeaView({ location }: { location: IdeaLocation | null }) {
  const navigation = useIdeaNavigation();
  const exploreMemory = useExploreMemory();
  const browseMemory = useBrowseMemory();
  const browseMapMemory = useBrowseMapMemory();
  const invalidateBrowseReads = useCallback(() => {
    browseMapMemory.current?.controller.invalidate();
    browseMemory.current?.controller.invalidate();
  }, [browseMapMemory, browseMemory]);
  const evolve = useEvolveStore();
  const mediaMemory = useMediaSourceMemory();
  const subjectId = location?.id;
  const reinterpretation = useMemo(() => reinterpretationId(subjectId)
    ? createReinterpretationController(subjectId, createReinterpretationClient()) : null, [subjectId]);
  const reinterpretationState = useSyncExternalStore(reinterpretation?.subscribe ?? noSubscription,
    reinterpretation?.getSnapshot ?? noSource, noSource);
  const [showInterpretation, setShowInterpretation] = useState(false);
  const [previous, setPrevious] = useState<PreviousIdea | null>(null);
  const [view, setView] = useState<IdeaRecord | null>(null);
  const [readState, setReadState] = useState<"loading" | "ready" | "error" | "unavailable">("loading");
  const [removed, setRemoved] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [unconfirmedCommand, setUnconfirmedCommand] = useState<IdeaCommand | null>(null);
  const [editing, setEditing] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connectionLocked, setConnectionLocked] = useState(false);
  const [title, setTitle] = useState("");
  const [titleError, setTitleError] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [replyOpen, setReplyOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [replyId, setReplyId] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const alive = useRef(false);
  const readGeneration = useRef(0);
  const reinterpretationWatchGeneration = useRef(0);
  const canonicalRead = useRef<CanonicalRead | null>(null);
  const previewGeneration = useRef(0);
  const admittedPreview = useRef<BranchPreview | null>(null);
  const writing = useRef(false);
  const currentView = useRef(view);
  const titleInput = useRef<HTMLInputElement>(null);
  const connectButton = useRef<HTMLButtonElement>(null);
  const more = useRef<HTMLDivElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const dialogReturn = useRef<HTMLElement | null>(null);
  const [downloadPending, setDownloadPending] = useState(false), [downloadError, setDownloadError] = useState(false);
  const downloading = useRef(false);
  const [contextError, setContextError] = useState(false);
  // A token is satisfied by canonical publication, not by starting a read.
  const lastRunContent = useRef<string | null>(null);
  const runContentAttempt = useRef<{ token: string; generation: number } | null>(null);
  const mediaThought = view?.thought.kind === "media-original" ? view.thought : null;
  const mediaScope: MediaScope = location?.scope === "normal" ? "normal" : "history";
  const media = mediaThought ? sourceController(mediaMemory, mediaThought.id, mediaThought.mediaSource.id, mediaScope) : null;
  const mediaState = useSyncExternalStore(media?.subscribe ?? noSubscription, media?.getSnapshot ?? noSource, media?.getSnapshot ?? noSource);
  const mediaCommandPending = !!mediaState && (mediaState.retryRequest.kind === "pending" || mediaState.stopping);
  // Initial recovery retains its own pending retry and unconfirmed Stop controls.
  const initialRetryUnresolved = !!mediaState && (mediaState.retryRequest.kind !== "idle" || mediaState.stopping || mediaState.unconfirmedStop !== null);
  const reinterpretationCommandPending = reinterpretationState?.request === "pending" || reinterpretationState?.stopping === true;
  const disabled = pending || unconfirmed || connecting || connectionLocked || mediaCommandPending || reinterpretationCommandPending;
  const reinterpretationRun = reinterpretationState ? reinterpretationRunToShow(reinterpretationState) : null;
  const reinterpretationOwnsStatus = !initialRetryUnresolved && !!reinterpretationState && (showInterpretation
    || reinterpretationState.request !== "idle" || reinterpretationRun !== null);

  /** One current flight owns canonical publication; commands fence any older flight. */
  const readCanonical = useCallback((mode: CanonicalRead["mode"]): CanonicalRead | null => {
    if (!location || !alive.current || writing.current) return null;
    const active = canonicalRead.current;
    if (active?.generation === readGeneration.current) {
      if (mode === "foreground") {
        active.mode = mode;
        setReadState("loading");
      }
      return active;
    }
    const generation = ++readGeneration.current;
    if (mode === "foreground") setReadState("loading");
    const publication: Promise<IdeaRecord | null> = readIdea(location.id, {
      scope: location.scope, part: "view", responseId: location.responseId,
    }, { fetch: window.fetch.bind(window) }).then(result => {
      if (!alive.current || generation !== readGeneration.current) return null;
      if (result.kind === "view") {
        currentView.current = result.value;
        setView(result.value);
        setReadState("ready");
        setRemoved(false);
        setContextError(false);
        // Background publication must not reopen a reply the user closed.
        if (flight.mode === "foreground" && result.value.focusedResponse) {
          setReplyId(result.value.focusedResponse.id);
          setReplyOpen(true);
        }
        return result.value;
      }
      if (flight.mode === "foreground") {
        currentView.current = null;
        setView(null);
        setReadState(result.kind === "unavailable" ? "unavailable" : "error");
      } else {
        if (flight.mode === "connection") setNotice("Connection created, but surrounding context could not be refreshed. Reopen this idea to read its current context.");
        const observed = reinterpretation?.getSnapshot();
        if (currentView.current?.thought.kind === "media-original" || observed?.run || observed?.eligibility?.blockingRun) setContextError(true);
      }
      return null;
    }).finally(() => {
      if (canonicalRead.current === flight) canonicalRead.current = null;
    });
    const flight: CanonicalRead = { generation, mode, publication };
    canonicalRead.current = flight;
    return flight;
  }, [location, reinterpretation]);

  const load = useCallback(async () => !!(await readCanonical("foreground")?.publication), [readCanonical]);

  /** Observation requests canonical reconciliation; it never supersedes a current reader. */
  const refreshRunContext = useCallback(async (intent: RunContentIntent | null = null, force = false) => {
    if (!alive.current || writing.current || unconfirmed || connectionLocked) return;
    const attempt = runContentAttempt.current;
    const attempted = intent !== null && attempt?.token === intent.token && attempt.generation === readGeneration.current;
    // Failed and scoped-out attempts stay latched until Check, changed intent, or a fence.
    if (attempted && !force) return;
    const active = canonicalRead.current;
    if (active?.generation === readGeneration.current) {
      const published = await active.publication;
      if (!alive.current || writing.current || active.generation !== readGeneration.current) return;
      if (!published) {
        if (intent) runContentAttempt.current = { token: intent.token, generation: active.generation };
        return;
      }
      // A read begun before this observation can satisfy it only with actual output.
      // Otherwise make one follow-up attempt after that reader has published.
      if (!intent || attempted || containsRunOutput(published, intent.runs)) {
        if (intent) lastRunContent.current = intent.token;
        return;
      }
    }
    const flight = readCanonical("background");
    if (!flight) return;
    if (intent) runContentAttempt.current = { token: intent.token, generation: flight.generation };
    const published = await flight.publication;
    if (!alive.current || writing.current || flight.generation !== readGeneration.current) return;
    if (published && intent) lastRunContent.current = intent.token;
  }, [readCanonical, unconfirmed, connectionLocked]);

  useEffect(() => {
    if (!media) return;
    let stopWatching: (() => void) | undefined;
    const visibility = () => { stopWatching?.(); stopWatching = document.visibilityState === "visible" ? media.watch() : undefined; };
    visibility(); document.addEventListener("visibilitychange", visibility);
    return () => { stopWatching?.(); document.removeEventListener("visibilitychange", visibility); };
  }, [media]);

  useEffect(() => {
    if (!reinterpretation) return;
    let stopWatching: (() => void) | undefined;
    const visibility = () => {
      reinterpretationWatchGeneration.current++;
      stopWatching?.(); stopWatching = document.visibilityState === "visible" ? reinterpretation.watch() : undefined;
    };
    visibility(); document.addEventListener("visibilitychange", visibility);
    return () => { reinterpretationWatchGeneration.current++; stopWatching?.(); document.removeEventListener("visibilitychange", visibility); };
  }, [reinterpretation]);

  const observedRuns = new Map<string, MediaRun>();
  if (mediaState?.phase === "ready" && mediaState.run) observedRuns.set(mediaState.run.id, mediaState.run);
  if (reinterpretationState?.run) observedRuns.set(reinterpretationState.run.id, reinterpretationState.run);
  if (reinterpretationState?.eligibility?.blockingRun) observedRuns.set(reinterpretationState.eligibility.blockingRun.id, reinterpretationState.eligibility.blockingRun);
  const contentRuns = [...observedRuns.values()];
  const runContent = contentRuns.length
    ? JSON.stringify([location?.id, location?.scope, contentRuns.map(run => [run.id, run.confirmedThoughtIds, run.responseId])]) : null;
  useEffect(() => {
    if (pending || unconfirmed || connectionLocked || reinterpretationCommandPending || !runContent || runContent === lastRunContent.current || !currentView.current) return;
    if (!containsRunOutput(currentView.current, contentRuns)) void refreshRunContext({ token: runContent, runs: contentRuns });
    else lastRunContent.current = runContent; // The existing scoped publication already contains this output.
  }, [runContent, mediaState, reinterpretationState, view, pending, unconfirmed, connectionLocked, reinterpretationCommandPending, refreshRunContext]);

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
    const sourceCommand = media?.getSnapshot();
    const reinterpretationCommand = reinterpretation?.getSnapshot();
    if (writing.current || disabled || !location || sourceCommand?.stopping || sourceCommand?.retryRequest.kind === "pending"
      || reinterpretationCommand?.request === "pending" || reinterpretationCommand?.stopping) return;
    writing.current = true;
    readGeneration.current++;
    media?.invalidate();
    reinterpretation?.invalidate();
    setPending(true);
    invalidateBrowseReads();
    setNotice(null);
    // A write may change titles or eligibility. Reread on return, keeping the
    // exploration intent and place; this is not evidence that a write succeeded.
    const explored = exploreMemory.current;
    if (explored?.state.query.q.trim()) exploreMemory.current = {
      ...explored,
      state: { ...explored.state, phase: "loading", page: null, message: null },
    };
    const result = await commandIdea(command, { fetch: window.fetch.bind(window) });
    // The reader may already have returned to Browse while this write was pending.
    // Fence any intervening read on settlement too, including an uncertain outcome.
    invalidateBrowseReads();
    if (!alive.current) return;
    writing.current = false;
    setPending(false);
    if (result.kind === "conflict") {
      setNotice("The branch changed. Nothing was rejected. Review the fresh preview and confirm again.");
      void loadPreview(true);
      void reinterpretation?.prepare();
      return;
    }
    if (result.kind !== "applied") {
      setNotice(result.kind === "uncertain"
        ? "Outcome unconfirmed. The change may still complete. No change will be sent again automatically."
        : "The change was not applied. Your inputs are still here.");
      setUnconfirmed(result.kind === "uncertain");
      if (result.kind === "uncertain") setUnconfirmedCommand(result.command);
      else void reinterpretation?.prepare();
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
        ? mediaThought ? "Title cleared. A new title may be generated later; the file and clarification stay unchanged. This does not request another interpretation." : "Title cleared. A new title may be generated later. The original words are unchanged."
        : mediaThought ? "Title saved. The file and clarification stay unchanged." : "Title saved. The original words are unchanged.");
      if (media) void media.check();
      void reinterpretation?.prepare();
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
      void reinterpretation?.checkReceipt();
    } else {
      setNotice(command.action === "restore-branch" || command.action === "restore-thought"
        ? "Restored. Independently rejected connections stay rejected."
        : "Connection change confirmed.");
      const published = await load();
      // A successful mutation invalidated observation even if its controller identity
      // stayed mounted. Resume only after publishing this route's canonical Idea.
      if (published && alive.current && currentView.current?.thought.id === command.thoughtId) {
        void media?.check(); void reinterpretation?.prepare();
      }
    }
  }

  async function connectionCreated() {
    setConnectionLocked(false);
    // Never join a read begun before the confirmed connection existed.
    readGeneration.current++;
    media?.invalidate();
    reinterpretation?.invalidate();
    const explored = exploreMemory.current;
    if (explored?.state.query.q.trim()) exploreMemory.current = {
      ...explored, state: { ...explored.state, phase: "loading", page: null, message: null },
    };
    const published = await readCanonical("connection")?.publication;
    if (published && alive.current && currentView.current?.thought.id === published.thought.id) {
      void media?.check(); void reinterpretation?.prepare();
    }
  }

  function saveTitle(event: FormEvent) {
    event.preventDefault();
    if (!title.trim()) { setTitleError(true); titleInput.current?.focus(); return; }
    if (location) void submitCommand({ action: "title", thoughtId: location.id, title });
  }
  async function downloadOriginal() {
    if (downloading.current || !mediaThought) return;
    const descriptor = mediaThought.mediaSource;
    downloading.current = true; setDownloadPending(true); setDownloadError(false);
    const result = await mediaMemory.sourceClient.download(descriptor, mediaScope);
    downloading.current = false;
    if (!alive.current) return;
    setDownloadPending(false);
    if (result.kind !== "ready") { setDownloadError(true); return; }
    const url = URL.createObjectURL(new Blob([new Uint8Array(result.bytes)], { type: result.mimeType }));
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = result.filename;
    document.body.append(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function beforeMediaWrite() {
    if (writing.current || disabled || contextError || mediaThought?.rejected === true) return false;
    // An older knowledge read must not publish over a command-associated refresh.
    readGeneration.current++;
    reinterpretation?.invalidate();
    return true;
  }
  async function checkMedia() {
    if (!media) return;
    const generation = readGeneration.current;
    await media.check();
    if (!alive.current || generation !== readGeneration.current) return;
    const state = media.getSnapshot();
    if (state.phase === "ready") {
      const intent = mediaThought && state.run ? {
        token: JSON.stringify([mediaThought.id, mediaScope, state.run.id, state.run.confirmedThoughtIds, state.run.responseId]), runs: [state.run],
      } : null;
      await refreshRunContext(intent, true);
    }
  }

  function subjectIsActive() {
    const current = currentView.current?.thought;
    return !!current && current.id === location?.id && current.rejected !== true
      && (location?.scope === "normal" || current.rejected === false)
      && mediaState?.rejected !== true && mediaState?.phase !== "unavailable";
  }
  async function activateReinterpret(requestFresh: boolean) {
    if (!reinterpretation || writing.current || disabled || initialRetryUnresolved) return;
    setShowInterpretation(true); setMenuOpen(false); menuButton.current?.focus();
    if (!requestFresh) { await reinterpretation.prepare(); return; }
    if (!subjectIsActive()) return;
    if (!reinterpretation.getSnapshot().fresh) await reinterpretation.prepare();
    if (!alive.current || !subjectIsActive() || writing.current) return;
    const state = reinterpretation.getSnapshot();
    if (!state.fresh || state.eligibility?.eligible !== true || state.request === "uncertain" || state.request === "pending"
      || state.checking || state.stopping || state.unconfirmedStop) return;
    readGeneration.current++;
    await reinterpretation.request();
  }
  async function checkInterpretation() {
    if (!reinterpretation) return;
    const generation = readGeneration.current;
    const watchGeneration = reinterpretationWatchGeneration.current;
    const current = () => alive.current && generation === readGeneration.current
      && watchGeneration === reinterpretationWatchGeneration.current;
    const state = reinterpretation.getSnapshot();
    if (state.request !== "uncertain" && reinterpretationRunToShow(state)) {
      await reinterpretation.checkRun();
      if (!current()) return;
      if (reinterpretation.getSnapshot().notice !== "read-error") await reinterpretation.checkReceipt();
    } else await reinterpretation.checkReceipt();
    if (!current()) return;
    // Check also retries a failed or scoped-out canonical publication, never a command.
    await refreshRunContext(null, true);
  }
  async function resendInterpretation() {
    if (!reinterpretation || !subjectIsActive() || writing.current || disabled || initialRetryUnresolved) return;
    readGeneration.current++;
    await reinterpretation.resend();
  }
  async function stopInterpretation() {
    if (!reinterpretation || writing.current || disabled || initialRetryUnresolved) return;
    readGeneration.current++;
    await reinterpretation.stop();
  }
  const back = location?.returnTo ?? "/explore";
  const inspection = location?.scope !== "normal";
  const thought = view?.thought;
  const reply = view?.responses.find(value => value.id === replyId) ?? null;
  const context = view ? contextItems(view) : [];
  const showExistingInterpretation = !!reinterpretationState && (reinterpretationState.request === "uncertain"
    || reinterpretationState.unconfirmedStop !== null || reinterpretationState.eligibility?.eligible === false
      && reinterpretationState.eligibility.reason !== "subject-rejected"
    || !!reinterpretationRun && !["completed", "failed", "interrupted"].includes(reinterpretationRun.status));
  const interpretationStatus = reinterpretationOwnsStatus && reinterpretationState ? <ReinterpretationStatus
    state={reinterpretationState} rejected={removed || thought?.rejected === true || inspection && thought?.rejected !== false}
    disabled={pending || unconfirmed || connecting || connectionLocked || mediaCommandPending}
    outputPublished={!!view && !!reinterpretationRun && containsRunOutput(view, [reinterpretationRun])}
    contextError={contextError} onCheck={checkInterpretation} onResend={resendInterpretation} onStop={stopInterpretation} /> : null;
  const recordPreviousReturn = useCallback(() => {
    if (!previous || !location || !currentView.current) return;
    let href = thoughtHref(location.id, location);
    if (location.responseId) href += `&${new URLSearchParams({ responseId: location.responseId })}`;
    navigation.current = { destination: previous.href, href, title: titleOf(currentView.current.thought) };
  }, [previous, location, navigation]);
  useContextualBack(previous?.href ?? back,
    previous ? `Previous thought: ${previous.title}` : back.startsWith("/browse/") ? "Back to map" : back.startsWith("/browse") ? "Back to list" : back.startsWith("/explore/ask/") ? "Back to search" : back === "/explore" ? "Back to Explore" : "Back to results",
    previous ? recordPreviousReturn : undefined);

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
          {interpretationStatus}
        </div>
        : !thought || !view ? <div className={styles.empty}>
          <h1>Idea unavailable</h1>
          <p>{readState === "unavailable" ? "This idea is not available in this view." : "We could not read this idea. No changes were made by this read."}</p>
          {readState === "error" && <button className={styles.button} onClick={() => void load()}>Try reading again</button>}
          {readState === "unavailable" && !inspection && <Link href={thoughtHref(location.id, location, "history")} prefetch={false}>Inspect idea</Link>}
          {reinterpretationState?.request !== "idle" && interpretationStatus}
        </div>
        : <>
          {inspection && <div className={styles.inspection}>
            <strong>User inspection{thought.rejected === true ? " · Rejected idea" : ""}</strong>
            <p>Rejected content is unavailable to AI.{mediaThought ? " Rejection does not delete the original file." : " You can inspect rejected material here."}</p>
            {thought.rejected === undefined && <p>The idea's rejection status is unavailable. Evolve is paused.</p>}
            <Link className={styles.textButton} href={thoughtHref(thought.id, location, "normal")} prefetch={false}>Return to normal view</Link>
          </div>}
          <div className={styles.focus}>
            <div className={styles.thought}>
              <Byline thought={thought} focal />
              <h1>{titleOf(thought)}</h1>
              {thought.kind === "media-original" ? <MediaSourceDetails source={thought.mediaSource} /> : <p className={styles.original}>{thought.text}</p>}
            </div>
            {thought.rejected === true || (inspection && thought.rejected !== false) || mediaState?.rejected === true || mediaState?.phase === "unavailable"
              ? <button className={`${styles.button} ${styles.primary}`} disabled aria-disabled="true">Evolve this idea</button>
              : <Link className={`${styles.button} ${styles.primary}`} href={ideaActionHref(thought.id, "evolve")} prefetch={false}
                onNavigate={() => evolve.startFromIdea(thought.id)}>Evolve this idea</Link>}
          </div>

          {view.parent && <p className={styles.parent}>
            <span className={styles.relationLabel}><ContentGlyph kind="evolution" size={16} />Developed from:</span>{" "}
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
            {mediaThought && <button className={styles.textButton} type="button" disabled={downloadPending || mediaScope === "normal" && mediaState?.phase === "unavailable"}
              onClick={() => void downloadOriginal()}>{downloadPending ? "Reading original…" : "Download original"}</button>}
            {view.responses.length > 0 && <button className={styles.textButton} aria-expanded={replyOpen} aria-controls="idea-reply" onClick={() => {
              setReplyOpen(!replyOpen);
              if (!replyId) setReplyId(view.responses[0]!.id);
            }}>Full reply</button>}
            <button className={`${styles.textButton} ${styles.aboutButton}`} aria-expanded={aboutOpen}
              aria-controls="idea-metadata" onClick={() => setAboutOpen(open => !open)}>About</button>
            <Link className={styles.textButton} prefetch={false} href={browseMapHref(thought.id,
              browseMemory.current?.url ?? browseMapMemory.current?.controller.getSnapshot().location.returnTo ?? "/browse",
              inspection ? "show-rejected" : "normal")}>Browse from here</Link>
            <button ref={connectButton} className={styles.textButton} disabled={disabled || editing || thought.rejected === true || inspection}
              aria-expanded={connecting} aria-controls="idea-connection-editor" onClick={() => setConnecting(true)}>Connect to another thought…</button>
            <div className={styles.more} ref={more} onKeyDown={event => {
              if (event.key === "Escape" && menuOpen) { event.preventDefault(); setMenuOpen(false); menuButton.current?.focus(); }
            }}>
              <button className={styles.textButton} ref={menuButton} aria-expanded={menuOpen}
                aria-controls="idea-actions" onClick={() => {
                  if (!menuOpen && !pending && !unconfirmed && !initialRetryUnresolved) void reinterpretation?.prepare();
                  setMenuOpen(!menuOpen);
                }}>More actions</button>
              <div className={styles.actions} id="idea-actions" hidden={!menuOpen}>
                <Link href={ideaActionHref(thought.id, "export")} prefetch={false}>Export…</Link>
                <button className={styles.textButton} type="button" aria-controls="idea-interpretation-status"
                  disabled={disabled || initialRetryUnresolved || !subjectIsActive()}
                  onClick={() => void activateReinterpret(!showExistingInterpretation)}>{showExistingInterpretation ? "Show interpretation work" : "Reinterpret"}</button>
                {!subjectIsActive() && <p className={styles.metadata}>{thought.rejected === true ? "Restore this idea before reinterpreting it." : "Current access must be confirmed before reinterpreting this idea."}</p>}
                {initialRetryUnresolved && <p className={styles.metadata}>Resolve the initial interpretation request below before requesting fresh work.</p>}
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

          <div id="idea-metadata" className={styles.metadataDetails} hidden={!aboutOpen}>
            <dl><dt>Created (UTC)</dt><dd>{dateOf(thought.createdAt)}</dd>
              <dt>Origin</dt><dd>{thought.origin}</dd>
              <dt>Title by</dt><dd>{thought.titleAuthor ? actor(thought.titleAuthor) : "No attributed title"}</dd>
              <dt>Idea ID</dt><dd className={styles.identifier}>{thought.id}</dd></dl>
          </div>

          {pending && <p role="status">Waiting for confirmation. Please do not send the change again.</p>}
          {editing && <form className={styles.editor} onSubmit={saveTitle} noValidate>
            <h2>Edit title</h2>
            <p>{mediaThought ? "Only the title changes. The file and clarification stay unchanged." : "Only the title changes. The saved thought stays exactly as it is."}</p>
            <label htmlFor="idea-title">Title</label>
            <input id="idea-title" ref={titleInput} value={title} readOnly={disabled}
              aria-invalid={titleError ? true : undefined}
              aria-describedby={titleError ? "idea-title-error" : "idea-title-help"}
              onChange={event => { setTitle(event.target.value); setTitleError(false); }} />
            {titleError && <p id="idea-title-error" className={styles.error} role="alert">Enter a title, or choose Clear title.</p>}
            <p id="idea-title-help">Clearing permits a new title to be generated later; it does not promise when.{mediaThought && " It does not request another interpretation."}</p>
            <div className={styles.buttons}>
              <button className={`${styles.button} ${styles.primary}`} type="submit" disabled={disabled}>Save title</button>
              <button className={styles.button} type="button" disabled={disabled}
                onClick={() => void submitCommand({ action: "title", thoughtId: thought.id, title: null })}>Clear title</button>
              <button className={styles.textButton} type="button" disabled={pending} onClick={() => setEditing(false)}>Cancel</button>
            </div>
          </form>}

          {connecting && <div id="idea-connection-editor">
            <ConnectionEditor thought={thought} disabled={pending || unconfirmed || mediaCommandPending} onLockedChange={setConnectionLocked}
              onClose={() => { setConnecting(false); requestAnimationFrame(() => connectButton.current?.focus()); }}
              onCreated={() => void connectionCreated()} onInvalidateReads={invalidateBrowseReads} />
          </div>}

          {location.responseId && !view.focusedResponse && <p className={styles.notice}>
            The requested full reply is unavailable for this idea in this view.
          </p>}
          <div id="idea-reply" hidden={!replyOpen} className={styles.detail}>
            {reply && <>
              <h2 className={styles.recordHeading}><ContentGlyph kind="full-reply" size={20} />Full reply</h2>
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

          {downloadError && <div className={styles.warning} role="status"><h2>Original could not be downloaded</h2><p>The source record is still here, but its original bytes could not be read. No substitute file was created. You can try Download original again.</p></div>}
          {interpretationStatus}
          {!reinterpretationOwnsStatus && media && mediaState && location && <MediaSourceStatus state={mediaState} controller={media} scope={mediaScope}
            hasInterpretation={view.children.some(child => child.kind === "ai-interpretation" && child.rejected !== true)}
            hasRejectedInterpretation={view.children.some(child => child.kind === "ai-interpretation" && child.rejected === true)}
            inspectHref={thoughtHref(thought.id, location, "history")} disabled={pending || unconfirmed || connecting || connectionLocked || contextError || reinterpretationCommandPending}
            onCheck={checkMedia} beforeWrite={beforeMediaWrite} />}
          {contextError && !reinterpretationOwnsStatus && <p className={styles.warning} role="status">Could not refresh the saved context. Last confirmed thoughts and Full reply remain available. Check current processing to read them again; no work was started by this read.</p>}

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

function Byline({ thought, focal = false }: { thought: IdeaThought; focal?: boolean }) {
  return <p className={styles.byline}>
    <span className={thought.author === "user" ? styles.user : thought.author === "ai" ? styles.ai : styles.source}>{actor(thought.author)}</span>
    {thought.kind === "media-original" ? <span>Image or PDF</span> : <span className={styles.materialLabel}><ContentGlyph kind={thought.kind} size={focal ? 24 : 20} />{materials[thought.kind]}</span>}
    {thought.rejected === true && <span className={styles.rejected}>Rejected</span>}
  </p>;
}

function ContextRow({ item, location, focus, inspection, disabled, onReject, onRestore }: {
  item: ContextItem; location: IdeaLocation; focus: string;
  inspection: boolean; disabled: boolean; onReject: (id: string) => void; onRestore: (id: string) => void;
}) {
  const { thought } = item;
  const [expanded, setExpanded] = useState(false);
  const abbreviate = thought !== null && thought.text !== null && thought.text.length > 240;
  return <article className={styles.connectionRow}>
    <div>
      <h3>{thought ? <Link href={thoughtHref(thought.id, location)} prefetch={false}>{titleOf(thought)}</Link> : "Idea unavailable in this view"}</h3>
      {thought && <Byline thought={thought} />}
      {!thought && <p className={styles.metadata}>{item.id}</p>}
    </div>
    <div>
      {thought?.kind === "media-original" ? <MediaSourceDetails source={thought.mediaSource} compact /> : thought && <p className={styles.contextText}>
        {abbreviate && !expanded ? thought.text?.slice(0, 240) : thought.text}
        {abbreviate && <> <button className={styles.textButton} aria-expanded={expanded}
          aria-label={`${expanded ? "Collapse" : "Expand"} context text for ${titleOf(thought)}`}
          onClick={() => setExpanded(!expanded)}>{expanded ? "Show less" : "…"}</button></>}
      </p>}
      {item.child && <p className={`${styles.relationship} ${styles.directRelationship}`}><span className={styles.relationLabel}><ContentGlyph kind="evolution" size={16} />Developed from this idea</span></p>}
      {item.source && <p className={`${styles.relationship} ${styles.directRelationship}`}><span className={styles.relationLabel}><ContentGlyph kind="used-as-source" size={16} />Used as a source for this idea</span></p>}
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
        <strong className={styles.relationLabel}><ContentGlyph kind="connection" size={16} />{relationship(connection, focus)}</strong>
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
