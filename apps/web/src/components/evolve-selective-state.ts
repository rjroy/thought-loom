"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { clearPending, conversationHref, readPending, selectiveClient, writePending,
  type AdmissionObservation, type ConversationPage, type PagedTurn, type Passage, type Pending, type Save, type Turn } from "./evolve-selective-client";

const terminal = (status: Turn["status"]) => status === "completed" || status === "interrupted" || status === "failed";
function hasActiveRun(turn: Turn): boolean {
  return turn.runId !== null && !terminal(turn.status);
}

type Task = "read" | "send" | "keep" | "check" | "change" | "poll" | "earlier" | "more-saves";
type CachedTurn = PagedTurn & { readonly receiptTail: string | null };
type Conversation = Omit<ConversationPage, "turns"> & {
  readonly turns: readonly CachedTurn[];
  readonly admissions: ReadonlyMap<string, AdmissionObservation>;
};
type ContinuationRecovery = {
  readonly phase: "review";
  readonly reason: "change-unknown" | "changed" | "return";
  readonly requested: string;
  readonly observed: string | null;
};
type ContinuationControl = { readonly phase: "changing"; readonly requested: string } | ContinuationRecovery;
type StopControl = "requesting" | "unconfirmed";
type RunStatus = Turn["status"];
interface ConversationControls {
  readonly continuation: ContinuationControl | null;
  readonly stops: ReadonlyMap<string, StopControl>;
  readonly settledStops: ReadonlyMap<string, RunStatus>;
}
const emptyControls: ConversationControls = { continuation: null, stops: new Map(), settledStops: new Map() };
// Document memory is independent of a mounted screen; it contains control
// identities only. A full reload discards it, as it discards the draft.
const controlsByConversation = new Map<string, ConversationControls>();
const controlListeners = new Set<() => void>();
const interruptedChanges = new WeakSet<ContinuationControl>();
const subscribeControls = (notify: () => void) => {
  controlListeners.add(notify);
  return () => { controlListeners.delete(notify); };
};
const readControls = (id: string | null) => id ? controlsByConversation.get(id) ?? emptyControls : emptyControls;
const serverControls = () => emptyControls;
function updateControls(id: string, update: (previous: ConversationControls) => ConversationControls) {
  const before = readControls(id), next = update(before);
  if (before === next) return;
  if (next.continuation || next.stops.size || next.settledStops.size) controlsByConversation.set(id, next);
  else controlsByConversation.delete(id);
  controlListeners.forEach(notify => notify());
}
function updateContinuation(id: string, expected: ContinuationControl | null, next: ContinuationControl | null) {
  updateControls(id, control => control.continuation === expected ? { ...control, continuation: next } : control);
}
function updateStop(id: string, runId: string, next: StopControl | RunStatus) {
  updateControls(id, control => {
    const stops = new Map(control.stops);
    if (next === "requesting" || next === "unconfirmed") {
      stops.set(runId, next);
      return { ...control, stops };
    }
    if (!terminal(next)) return control;
    stops.delete(runId);
    return { ...control, stops, settledStops: new Map(control.settledStops).set(runId, next) };
  });
}

function forgetObservedStops(id: string, turns: readonly PagedTurn[]) {
  updateControls(id, control => {
    if (!control.settledStops.size) return control;
    const settledStops = new Map(control.settledStops);
    for (const turn of turns) if (turn.runId && terminal(turn.status)) settledStops.delete(turn.runId);
    return settledStops.size === control.settledStops.size ? control : { ...control, settledStops };
  });
}

// Both lists are in canonical chronological order. Keep unmatched rows and
// use overlapping identities as anchors rather than comparing timestamps.
function mergeInOrder<T>(older: readonly T[], newer: readonly T[], identify: (value: T) => string): T[] {
  const positions = new Map(older.map((value, index) => [identify(value), index]));
  if (!newer.some(value => positions.has(identify(value)))) return [...older, ...newer];
  const incoming = new Set(newer.map(identify));
  const result: T[] = [];
  let nextRows: T[] = [];
  let i = 0;
  for (const value of newer) {
    const position = positions.get(identify(value));
    if (position === undefined) { nextRows.push(value); continue; }
    while (i < position) {
      const old = older[i++];
      if (!incoming.has(identify(old))) result.push(old);
    }
    i = Math.max(i, position + 1);
    result.push(...nextRows, value);
    nextRows = [];
  }
  while (i < older.length) {
    const old = older[i++];
    if (!incoming.has(identify(old))) result.push(old);
  }
  return [...result, ...nextRows];
}
const turnId = <T extends AdmissionObservation>(turn: T) => turn.id;
const saveId = (save: Save) => save.thoughtId;

function withoutLoadedAdmissions(current: Conversation | null, page: readonly PagedTurn[]) {
  const admissions = new Map(current?.admissions);
  for (const turn of page) admissions.delete(turn.id);
  return admissions;
}

function mergeHeadTurns(current: Conversation | null, page: ConversationPage): Conversation {
  const cached = new Map(current?.turns.map(turn => [turn.id, turn]));
  const incoming = page.turns.map(turn => cacheTurn(turn, cached.get(turn.id)));
  const admissions = withoutLoadedAdmissions(current, page.turns);
  if (!current?.turns.length) return { ...page, turns: incoming, admissions };
  if (!incoming.length) return { ...current, session: page.session };
  const start = current.turns.findIndex(turn => turn.id === page.turns[0]?.id);
  if (start < 0 && !incoming.some(turn => cached.has(turn.id))) {
    // More than one page may have arrived since the last read. Retain what
    // was opened but use the new boundary so the gap remains discoverable.
    return { ...page, turns: [...current.turns, ...incoming], admissions };
  }
  const priorBoundary = current.turns.findIndex(turn => turn.id === current.nextBefore);
  const reachedPriorWindow = start >= Math.max(0, priorBoundary);
  return { ...page, turns: mergeInOrder(current.turns, incoming, turnId), admissions,
    nextBefore: reachedPriorWindow ? current.nextBefore : page.nextBefore };
}

function cacheTurn(fresh: PagedTurn, previous?: CachedTurn): CachedTurn {
  const status = previous && terminal(previous.status) && !terminal(fresh.status) ? previous.status : fresh.status;
  const receivedTail = fresh.saves.at(-1)?.thoughtId ?? null;
  const seen = new Set(fresh.saves.map(saveId));
  const saves = [...fresh.saves, ...(previous?.saves.filter(save => !seen.has(saveId(save))) ?? [])];
  if (!previous) return { ...fresh, status, saves, receiptTail: receivedTail };
  const hasDeeperCache = previous.receiptTail !== null && !fresh.saves.some(save => save.thoughtId === previous.receiptTail);
  const preserveBoundary = fresh.savesHasMore && hasDeeperCache;
  const stillGrowing = preserveBoundary && hasActiveRun(previous) && !previous.savesHasMore;
  return { ...fresh, status, saves,
    receiptTail: preserveBoundary ? previous.receiptTail : receivedTail,
    savesHasMore: preserveBoundary ? previous.savesHasMore || stillGrowing : fresh.savesHasMore,
    savesNextAfter: preserveBoundary ? stillGrowing ? previous.receiptTail : previous.savesNextAfter : fresh.savesNextAfter };
}
const storageError = "Request recovery is unavailable in this tab. No new message or passage can be sent safely.";
const requestKey = () => [...crypto.getRandomValues(new Uint8Array(18))].map(byte => byte.toString(16).padStart(2, "0")).join("");

export function useSelectiveEvolve(anchor: string | null, conversationId: string | null, watching: boolean) {
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [task, setTask] = useState<Task | null>(null);
  const [notice, setNotice] = useState("");
  const [stale, setStale] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [journalError, setJournalError] = useState(false);
  const [earlierNotice, setEarlierNotice] = useState("");
  const [saveNotices, setSaveNotices] = useState<Readonly<Record<string, string>>>({});
  const [loadingSaves, setLoadingSaves] = useState<string | null>(null);
  const [confirmedSend, setConfirmedSend] = useState(0);
  const [confirmedKeep, setConfirmedKeep] = useState(0);
  const lane = useRef<Task | null>(null);
  const observationEpoch = useRef(0);
  const runEpoch = useRef(new Map<string, number>());
  const pollFlight = useRef<Promise<void> | null>(null);
  const mounted = useRef(false);
  const sendSnapshot = useRef<{ parentId: string; text: string } | undefined>(undefined);
  const keepSnapshot = useRef<Passage | undefined>(undefined);
  const id = conversation?.session.id ?? conversationId;
  const controls = useSyncExternalStore(subscribeControls, () => readControls(id), serverControls);
  const continuationUnknown = controls.continuation?.phase === "review" ? controls.continuation : null;
  const continuationChanging = controls.continuation?.phase === "changing" ? controls.continuation : null;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const perform = useCallback(async (name: Task, work: () => Promise<void>) => {
    // A user action can arrive during a background read. Let the read settle
    // before applying that intent rather than dropping it or racing publication.
    if (name !== "poll" && pollFlight.current) await pollFlight.current;
    if (lane.current || !mounted.current) return;
    lane.current = name;
    if (name !== "poll") setTask(name);
    try {
      const running = work();
      if (name === "poll") pollFlight.current = running;
      await running;
    }
    finally {
      lane.current = null;
      if (name === "poll") pollFlight.current = null;
      if (mounted.current && name !== "poll") setTask(null);
    }
  }, []);

  const refresh = useCallback(async (id: string, initial = false) => {
    const epoch = observationEpoch.current;
    const result = await selectiveClient.read(id);
    if (!mounted.current || epoch !== observationEpoch.current) return false;
    if (result.kind === "ok") {
      setConversation(current => mergeHeadTurns(current, result.value));
      forgetObservedStops(id, result.value.turns);
      setStale(false);
      return result.value;
    }
    setStale(true);
    setNotice(initial
      ? result.status === 404 ? "This conversation is unavailable." : "Could not open this conversation."
      : "Could not refresh the conversation. Last confirmed text and saves are still shown.");
    return false;
  }, []);

  const load = useCallback((id: string) => perform("read", async () => {
    setNotice("");
    try { setPending(readPending(id)); }
    catch { setJournalError(true); }
    await refresh(id, true);
  }), [perform, refresh]);

  useEffect(() => { if (conversationId) void load(conversationId); }, [conversationId, load]);

  const knownActive = ({ runId, status }: AdmissionObservation) => runId !== null && !terminal(status) && !controls.settledStops.has(runId);
  const pageActive = conversation?.turns.filter(knownActive) ?? [];
  const admissions = conversation ? [...conversation.admissions.values()] : [];
  const activeRuns = new Set([...pageActive, ...admissions.filter(knownActive)].flatMap(turn => turn.runId ? [turn.runId] : []));
  const shouldPoll = Boolean(id && watching && pending?.kind !== "send" && (pageActive.length || stale));
  useEffect(() => {
    if (!shouldPoll || !id) return;
    let timer: number | undefined;
    let cancelled = false;
    const schedule = () => {
      if (!cancelled) timer = window.setTimeout(async () => {
        if (document.visibilityState === "visible") {
          await perform("poll", async () => {
            const ok = await refresh(id);
            if (ok) setNotice(current => current.startsWith("Could not refresh the conversation.") ? "" : current);
          });
        }
        schedule();
      }, 1200);
    };
    schedule();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [id, perform, refresh, shouldPoll]);

  function journal(id: string, create: (key: string) => Pending): Pending | null {
    try {
      const request = create(requestKey());
      writePending(id, request);
      setPending(request);
      return request;
    } catch {
      setJournalError(true);
      setNotice(storageError);
      return null;
    }
  }

  function finishRequest(id: string, request: Pending) {
    try { clearPending(id, request); }
    catch {
      setJournalError(true);
      setNotice(storageError);
    }
    setPending(null);
    if (request.kind === "send") sendSnapshot.current = undefined;
    else keepSnapshot.current = undefined;
  }

  function recordTurn(turn: AdmissionObservation) {
    setConversation(current => {
      if (!current) return current;
      const known = current.turns.find(item => item.id === turn.id);
      if (known) {
        if (known.runId !== turn.runId || known.text !== turn.text || known.parentId !== turn.parentId || known.admittedAt !== turn.admittedAt) return current;
        const updated = { ...known, status: terminal(known.status) ? known.status : turn.status };
        return { ...current, turns: current.turns.map(item => item.id === turn.id ? updated : item) };
      }
      // The receipt proves admission, not where the turn belongs in history.
      // A later page places it. Until then it is available only for recovery.
      const previous = current.admissions.get(turn.id);
      if (previous && terminal(previous.status)) return current;
      return { ...current, admissions: new Map(current.admissions).set(turn.id, turn) };
    });
    setConfirmedSend(value => value + 1);
  }

  function recordSave(turnId: string, save: Save) {
    if (!conversation?.turns.some(turn => turn.id === turnId)) setNotice("Passage saved. Load earlier turns to see its receipt.");
    setConversation(current => current && {
      ...current, turns: current.turns.map(turn => turn.id === turnId && !turn.saves.some(item => item.thoughtId === save.thoughtId)
        ? { ...turn, saves: [...turn.saves, save] } : turn),
    });
    setConfirmedKeep(value => value + 1);
  }

  async function loadEarlier() {
    const cursor = conversation?.nextBefore;
    if (!id || !cursor) return;
    await perform("earlier", async () => {
      setEarlierNotice("");
      const result = await selectiveClient.read(id, cursor);
      if (!mounted.current) return;
      if (result.kind !== "ok") { setEarlierNotice("Could not load earlier turns. The turns already here are kept."); return; }
      setConversation(current => {
        if (!current || current.nextBefore !== cursor) return current;
        const boundary = current.turns.findIndex(turn => turn.id === cursor);
        if (boundary < 0) return current;
        const prefix = current.turns.slice(0, boundary), suffix = current.turns.slice(boundary);
        const cached = new Map(current.turns.map(turn => [turn.id, turn]));
        const incoming = result.value.turns.map(turn => cacheTurn(turn, cached.get(turn.id)));
        const before = mergeInOrder(prefix, incoming, turnId);
        const seen = new Set(before.map(turnId));
        return { ...current, turns: [...before, ...suffix.filter(turn => !seen.has(turn.id))],
          admissions: withoutLoadedAdmissions(current, result.value.turns), nextBefore: result.value.nextBefore };
      });
    });
  }

  async function loadSaves(turn: CachedTurn) {
    if (!id || !turn.savesHasMore) return;
    await perform("more-saves", async () => {
      setLoadingSaves(turn.id);
      setSaveNotices(current => ({ ...current, [turn.id]: "" }));
      const result = await selectiveClient.readSaves(id, turn.id, turn.savesNextAfter ?? undefined);
      if (!mounted.current) return;
      setLoadingSaves(null);
      if (result.kind !== "ok") {
        setSaveNotices(current => ({ ...current, [turn.id]: "Could not load more saved ideas. The ideas already here are kept." }));
        return;
      }
      setConversation(current => current && { ...current, turns: current.turns.map(item => {
        if (item.id !== turn.id) return item;
        const prefixIndex = item.saves.findIndex(save => save.thoughtId === item.receiptTail);
        const ordered = [...item.saves.slice(0, prefixIndex + 1), ...result.value.saves];
        const seen = new Set(ordered.map(saveId));
        return { ...item, saves: [...ordered, ...item.saves.slice(prefixIndex + 1).filter(save => !seen.has(saveId(save)))],
          receiptTail: result.value.saves.at(-1)?.thoughtId ?? item.receiptTail,
          savesHasMore: result.value.nextAfter !== null, savesNextAfter: result.value.nextAfter };
      }) });
    });
  }

  async function send(text: string) {
    if (!text.trim() || pending || journalError || stale || activeRuns.size || controls.stops.size || controls.continuation) return;
    await perform("send", async () => {
      setNotice("");
      let owner = conversation?.session;
      if (owner && (readControls(owner.id).continuation || readControls(owner.id).stops.size)) return;
      if (!owner && anchor) {
        const created = await selectiveClient.create(anchor);
        if (!mounted.current) return;
        if (created.kind !== "ok") {
          setNotice(created.kind === "refused"
            ? "Could not start this conversation. Your message was not sent."
            : "Could not confirm that the conversation was created. Your message was not sent. Sending again starts a separate conversation.");
          return;
        }
        owner = created.value;
        setConversation({ session: owner, turns: [], nextBefore: null, admissions: new Map() });
        // Keep the current workspace mounted but make reload/return address this exact session.
        window.history.replaceState(null, "", conversationHref(owner.id));
      }
      if (!owner) return;
      const request = journal(owner.id, key => ({ kind: "send", key }));
      if (!request) return;
      const snapshot = { parentId: owner.continuationThoughtId, text };
      sendSnapshot.current = snapshot;
      const response = await selectiveClient.send(owner.id, request.key, snapshot);
      if (!mounted.current) return;
      if (response.kind === "unknown") return; // Only a deliberate original-key lookup can reconcile this.
      finishRequest(owner.id, request);
      if (response.kind === "ok") recordTurn(response.value);
      else if (response.code === "stale-continuation") {
        const current = await refresh(owner.id);
        updateContinuation(owner.id, null, { phase: "review", reason: "changed", requested: snapshot.parentId,
          observed: current ? current.session.continuationThoughtId : null });
        return;
      } else setNotice("This message wasn’t accepted. Your draft is kept.");
      await refresh(owner.id);
    });
  }

  async function keep(turnId: string, snapshot: Passage) {
    if (!id || pending || journalError || stale) return;
    await perform("keep", async () => {
      setNotice("");
      const request = journal(id, key => ({ kind: "keep", key, turnId }));
      if (!request) return;
      keepSnapshot.current = snapshot;
      const response = await selectiveClient.keep(id, turnId, request.key, snapshot);
      if (!mounted.current) return;
      if (response.kind === "unknown") return;
      finishRequest(id, request);
      if (response.kind === "ok") recordSave(turnId, response.value);
      else setNotice("This passage couldn’t be kept. Your selection is still here.");
      await refresh(id);
    });
  }

  async function checkPending() {
    if (!id || !pending) return;
    const request = pending;
    await perform("check", async () => {
      setNotice("");
      if (request.kind === "send") {
        const result = await selectiveClient.checkSend(id, request.key, sendSnapshot.current);
        if (!mounted.current || result.kind !== "ok") return;
        finishRequest(id, request);
        recordTurn(result.value);
      } else {
        const result = await selectiveClient.checkKeep(id, request.turnId, request.key, keepSnapshot.current);
        if (!mounted.current || result.kind !== "ok") return;
        finishRequest(id, request);
        recordSave(request.turnId, result.value);
      }
      await refresh(id);
    });
  }

  async function choose(thoughtId: string): Promise<boolean> {
    if (!id || !conversation || pending || stale || activeRuns.size || controls.stops.size || controls.continuation) return false;
    const owner = conversation.session;
    let applied = false;
    await perform("change", async () => {
      if (readControls(id).continuation || readControls(id).stops.size) return;
      setNotice("");
      const intent: ContinuationControl = { phase: "changing", requested: thoughtId };
      updateContinuation(id, null, intent);
      const review = (reason: ContinuationRecovery["reason"], observed: string | null = null) =>
        updateContinuation(id, intent, { phase: "review", reason, requested: thoughtId, observed });
      const result = await selectiveClient.continueAt(id, owner.anchorThoughtId, thoughtId, owner.continuationThoughtId);
      if (!mounted.current || interruptedChanges.has(intent)) {
        review(result.kind === "unknown" ? "change-unknown" : "return");
        return;
      }
      if (result.kind === "ok") {
        setConversation(current => current && { ...current, session: result.value });
        updateContinuation(id, intent, null);
        applied = true;
      } else {
        const read = await refresh(id);
        if (!mounted.current || interruptedChanges.has(intent)) {
          review(result.kind === "unknown" ? "change-unknown" : "return");
          return;
        }
        if (result.kind === "refused" && result.code === "stale-continuation") {
          review("changed", read ? read.session.continuationThoughtId : null);
        } else if (result.kind === "refused") {
          updateContinuation(id, intent, null);
          if (read) setNotice("That thought could not be selected. Your draft is kept.");
        } else if (read && read.session.continuationThoughtId === thoughtId) {
          updateContinuation(id, intent, null);
          applied = true;
        } else {
          review("change-unknown");
        }
      }
    });
    return applied;
  }

  async function checkContinuation() {
    if (!id || !continuationUnknown) return;
    await perform("read", async () => {
      setNotice("");
      const checking = { ...continuationUnknown, observed: null };
      updateContinuation(id, continuationUnknown, checking);
      const read = await refresh(id);
      if (read) updateContinuation(id, checking, { ...checking, observed: read.session.continuationThoughtId });
    });
  }

  async function useObservedContinuation() {
    const observed = continuationUnknown?.observed;
    if (!id || !continuationUnknown || !observed) return false;
    let used = false;
    await perform("read", async () => {
      if (readControls(id).continuation !== continuationUnknown) return;
      setConversation(current => current && { ...current, session: { ...current.session, continuationThoughtId: observed } });
      updateContinuation(id, continuationUnknown, null);
      setNotice("");
      used = true;
    });
    return used;
  }

  async function checkRun(runId: string | null) {
    if (!id || (runId && readControls(id).stops.get(runId) === "requesting")) return;
    await perform("read", async () => {
      setNotice("");
      if (runId && readControls(id).stops.get(runId) === "requesting") return;
      const epoch = runId ? runEpoch.current.get(runId) : undefined;
      const observed = runId ? await selectiveClient.observe(runId) : null;
      if (runId && observed?.kind === "ok" && terminal(observed.value.status) && readControls(id).stops.get(runId) === "unconfirmed") {
        updateStop(id, runId, observed.value.status);
      }
      if (!mounted.current) return;
      if (runId && observed?.kind === "ok" && epoch === runEpoch.current.get(runId)) {
        publishRunStatus(observed.value.id, observed.value.status);
      }
      const refreshed = await refresh(id);
      if (observed && observed.kind !== "ok" && refreshed) setNotice("Could not check that run. The last confirmed conversation is shown.");
    });
  }

  async function stop(runId: string) {
    if (!id || readControls(id).stops.has(runId) || readControls(id).settledStops.has(runId) || !activeRuns.has(runId)) return;
    updateStop(id, runId, "requesting");
    runEpoch.current.set(runId, (runEpoch.current.get(runId) ?? 0) + 1);
    const result = await selectiveClient.stop(runId);
    if (result.kind !== "ok" || !terminal(result.value.status)) { updateStop(id, runId, "unconfirmed"); return; }
    if (mounted.current) {
      // A transcript read begun before this run control response must not
      // replace the newly confirmed status with an older snapshot.
      observationEpoch.current++;
      publishRunStatus(runId, result.value.status);
      setStale(true);
    }
    updateStop(id, runId, result.value.status);
    if (mounted.current && !lane.current) await perform("read", async () => { await refresh(id); });
  }

  function publishRunStatus(runId: string, status: Turn["status"]) {
    setConversation(current => {
      if (!current) return current;
      const update = <T extends AdmissionObservation>(turn: T): T =>
        turn.runId === runId && (!terminal(turn.status) || terminal(status)) ? { ...turn, status } : turn;
      return { ...current, turns: current.turns.map(update),
        admissions: new Map([...current.admissions].map(([id, turn]) => [id, update(turn)] as const)) };
    });
  }

  function prepareInspection() {
    const continuation = readControls(id).continuation;
    if (continuation?.phase === "changing") interruptedChanges.add(continuation);
  }

  return { conversation, task, notice, pending, stale, journalError, stops: controls.stops, settledStops: controls.settledStops,
    continuationChanging, continuationUnknown,
    earlierNotice, loadingSaves, saveNotices, confirmedSend, confirmedKeep, activeRuns, admissions,
    send, keep, choose, stop, checkRun, checkPending, checkContinuation, useObservedContinuation, load, loadEarlier, loadSaves, prepareInspection };
}
