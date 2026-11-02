"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { parseDialogueStopReceipt, parseDialogueTurnReceipt, parseDialogueView, type DialogueSelection, type DialogueView } from "@thoughtloom/contracts";
import { creationKey, DevelopmentError, getDialogue, postDevelopment, reconcileDialogue, selectionKey } from "../../lib/development-client";
import { commandId } from "../../lib/command-id";

type Pending = { key: string; text: string };
type Context = { selection: DialogueSelection; dialogue: DialogueView | null; draft: string; error: string; notice: string; loading: boolean; sending: boolean; pending: Pending | null; busyConflict: boolean; stopPending: boolean };
function context(selection: DialogueSelection, dialogue: DialogueView | null = null): Context {
  return { selection, dialogue, draft: "", error: "", notice: "", loading: false, sending: false, pending: null, busyConflict: false, stopPending: false };
}
export const isActiveTurn = (status: string) => ["queued", "running", "uncertain"].includes(status);

export default function useDevelopment({ root, initialSelection, initialDialogue, onSnapshot }: { root: string; initialSelection: DialogueSelection; initialDialogue: DialogueView | null; onSnapshot: (view: DialogueView) => void }) {
  const firstKey = selectionKey(initialSelection);
  const [selected, setSelected] = useState(firstKey);
  const [opening, setOpening] = useState(false);
  const [contexts, setContexts] = useState<Record<string, Context>>({ [firstKey]: context(initialSelection, initialDialogue) });
  const all = useRef(contexts), current = useRef(selected), callback = useRef(onSnapshot);
  const creating = useRef(new Map<string, Promise<DialogueView>>()), reads = useRef(new Map<string, symbol>());
  const requests = useRef(new Map<string, { controller: AbortController; promise: Promise<DialogueView> }>());
  const controllers = useRef(new Set<AbortController>());
  const sends = useRef(new Set<string>()), stops = useRef(new Map<string, { key: string; expectedRunId: string | null }>());
  const mounted = useRef(true);
  const navigationIntent = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; for (const controller of controllers.current) controller.abort(); controllers.current.clear(); requests.current.clear(); }; }, []);
  useEffect(() => { callback.current = onSnapshot; }, [onSnapshot]);
  const patch = useCallback((key: string, values: Partial<Context>) => {
    const previous = all.current[key]; if (!previous) return;
    const next = { ...all.current, [key]: { ...previous, ...values } }; all.current = next; if (mounted.current) setContexts(next);
  }, []);
  const accept = useCallback((key: string, view: DialogueView) => {
    const entry = all.current[key];
    if (!mounted.current || !entry || selectionKey(entry.selection) !== selectionKey(view.selection) || (entry.dialogue && entry.dialogue.id !== view.id)) return null;
    const accepted = reconcileDialogue(entry.dialogue, view);
    patch(key, { dialogue: accepted }); callback.current(accepted); return accepted;
  }, [patch]);
  const load = useCallback(async (id: string, signal?: AbortSignal, followLatest = false) => {
    // Superseded transports may still deliver; request identity, not cancellation,
    // decides authority. Every read remains cancellable and timeout-bounded.
    const controller = new AbortController();
    const request = { controller,
      promise: getDialogue(id, root, signal ? AbortSignal.any([signal, controller.signal]) : controller.signal) };
    requests.current.set(id, request); controllers.current.add(request.controller);
    try {
      let candidate = request;
      while (true) {
        try {
          const view = await candidate.promise;
          if (!mounted.current || request.controller.signal.aborted || signal?.aborted) return null;
          const latest = requests.current.get(id);
          if (latest === candidate && !candidate.controller.signal.aborted) return view;
          if (!followLatest || !latest) return null;
          candidate = latest;
        } catch (error) {
          if (!mounted.current || request.controller.signal.aborted || signal?.aborted) return null;
          const latest = requests.current.get(id);
          if (latest === candidate) { if (candidate.controller.signal.aborted) return null; throw error; }
          if (!followLatest || !latest) return null;
          candidate = latest;
        }
      }
    } finally { controllers.current.delete(request.controller); }
  }, [root]);
  const url = useCallback((id: string, key: string, explicit = false) => {
    if (!mounted.current || current.current !== key || window.location.pathname !== `/sources/${encodeURIComponent(root)}/inquiry`) return;
    const next = new URL(window.location.href);
    next.searchParams.set("dialogue", id);
    if (next.searchParams.has("version")) {
      const selection = all.current[key]?.selection;
      if (selection?.kind === "item") { next.searchParams.set("item", selection.id); next.searchParams.set("version", selection.versionId); }
      else { next.searchParams.delete("item"); next.searchParams.delete("version"); }
    }
    if (explicit || (!next.hash.startsWith("#turn-") && next.hash !== "#discussion-target")) next.hash = "development";
    window.history.replaceState(null, "", next);
  }, [root]);
  const read = useCallback(async (key: string, manual = false, signal?: AbortSignal) => {
    const entry = all.current[key]; if (!entry?.dialogue || (reads.current.has(key) && !manual)) return;
    const token = Symbol(); reads.current.set(key, token);
    try {
      const view = await load(entry.dialogue.id, signal);
      if (!view || reads.current.get(key) !== token) return;
      const accepted = accept(key, view); if (!accepted) return;
      const last = accepted.turns.at(-1), notice = all.current[key].notice;
      patch(key, { notice: last?.stopRequested || !last || !isActiveTurn(last.status) || notice.startsWith("Discussion could not refresh") ? "" : notice,
        ...(manual ? { busyConflict: false, error: "" } : {}) });
    } catch {
      if (!signal?.aborted && reads.current.get(key) === token) patch(key, { notice: "Discussion could not refresh. Saved input and the last confirmed response are kept. Check status to try again; nothing is resent." });
    } finally { if (reads.current.get(key) === token) reads.current.delete(key); }
  }, [load, accept, patch]);
  const ensure = useCallback(async (key: string, explicit = false): Promise<DialogueView> => {
    const entry = all.current[key];
    if (entry.dialogue) { if (explicit || entry.dialogue.turns.length) url(entry.dialogue.id, key, explicit); return entry.dialogue; }
    const existing = creating.current.get(key); if (existing) return existing;
    const task = (async () => {
      patch(key, { loading: true });
      try {
        const commandKey = await creationKey(root, entry.selection);
        const receipt = parseDialogueView(await postDevelopment(`/api/sources/${root}/dialogues`, { selection: entry.selection }, commandKey));
        if (!receipt || receipt.sourceId !== root || selectionKey(receipt.selection) !== selectionKey(entry.selection)) throw new DevelopmentError(503, "invalid_receipt");
        // Creation receipts intentionally replay their original snapshot. Read
        // current history before showing a resumed context as empty/new.
        const loaded = await load(receipt.id);
        const view = loaded ? accept(key, loaded) : all.current[key]?.dialogue;
        if (!view) throw new DevelopmentError(503, "discussion_unavailable");
        patch(key, { error: "", loading: false });
        // Resolving an empty context is not navigation. Avoid replacing history
        // while someone is simply following another source or a results link.
        if (explicit || view.turns.length) url(view.id, key, explicit);
        return view;
      } catch (error) {
        patch(key, { loading: false, error: "The discussion could not be confirmed. Your draft is kept. Retry send will reuse the same context request." });
        throw error;
      } finally { creating.current.delete(key); }
    })();
    creating.current.set(key, task); return task;
  }, [patch, root, url, load, accept]);

  useEffect(() => {
    // Query/derivation navigation changes the selected context, not the root
    // draft owner. Retain each context's words while its server props arrive.
    navigationIntent.current++;
    const existing = all.current[firstKey];
    const key = initialDialogue && existing?.dialogue && existing.dialogue.id !== initialDialogue.id ? `${firstKey}@${initialDialogue.id}` : firstKey;
    if (!all.current[key]) {
      const next = { ...all.current, [key]: context(initialSelection, initialDialogue) }; all.current = next; setContexts(next);
    } else if (initialDialogue) accept(key, initialDialogue);
    current.current = key; setSelected(key);
    if (initialDialogue) { callback.current(all.current[key].dialogue ?? initialDialogue); void read(key); }
    else void ensure(key).catch(() => {});
  }, [ensure, firstKey, initialDialogue, initialSelection, accept, read]);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void read(current.current, false, controller.signal);
      // Known active sibling contexts must settle even while the user reads or
      // drafts elsewhere on this original. No global dialogue index is needed.
      for (const [key, entry] of Object.entries(all.current)) {
        if (key !== current.current && entry.dialogue?.turns.some((turn) => isActiveTurn(turn.status))) void read(key, false, controller.signal);
      }
    }, 1_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [read]);

  async function select(selection: DialogueSelection) {
    navigationIntent.current++;
    const key = selectionKey(selection);
    if (!all.current[key]) { const next = { ...all.current, [key]: context(selection) }; all.current = next; setContexts(next); }
    current.current = key; setSelected(key);
    try { await ensure(key, true); } catch { /* visible context-specific error */ }
  }
  async function activateDialogue(id: string): Promise<DialogueView | null> {
    const intent = ++navigationIntent.current;
    const known = Object.entries(all.current).find(([, entry]) => entry.dialogue?.id === id);
    if (known) { current.current = known[0]; setSelected(known[0]); void read(known[0], true); return known[1].dialogue; }
    setOpening(true);
    try {
      // Navigation may follow a newer background read, but never accept the
      // superseded response itself. The intent fence still rejects later clicks.
      const view = await load(id, undefined, true);
      if (!view || !mounted.current || intent !== navigationIntent.current) return null;
      const basic = selectionKey(view.selection);
      const existing = all.current[basic];
      const key = existing?.dialogue && existing.dialogue.id !== id ? `${basic}@${id}` : basic;
      if (!all.current[key]) { const next = { ...all.current, [key]: context(view.selection, view) }; all.current = next; setContexts(next); }
      const accepted = accept(key, view); if (!accepted) return null;
      current.current = key; setSelected(key); return accepted;
    } catch { if (mounted.current && intent === navigationIntent.current) patch(current.current, { notice: "That discussion could not be opened for this original. Your current draft remains here." }); return null; }
    finally { setOpening(false); }
  }
  function edit(text: string) { patch(current.current, { draft: text }); }
  async function send() {
    const key = current.current, entry = all.current[key];
    if (sends.current.has(key) || !entry.draft.trim()) return;
    const pending = entry.pending ?? { key: commandId(), text: entry.draft };
    sends.current.add(key); patch(key, { sending: true, error: "", pending });
    try {
      const view = await ensure(key);
      const receipt = parseDialogueTurnReceipt(await postDevelopment(`/api/dialogues/${view.id}/turns`, { text: pending.text }, pending.key));
      if (!receipt || receipt.dialogueId !== view.id) throw new DevelopmentError(503, "invalid_receipt");
      const draft = all.current[key].draft;
      patch(key, { pending: null, draft: draft === pending.text ? "" : draft, notice: "", error: "", busyConflict: false });
      url(view.id, key, true); await read(key);
    } catch (error) {
      const conflict = error instanceof DevelopmentError && error.status === 409;
      patch(key, { pending: conflict ? null : pending, busyConflict: conflict,
        error: conflict ? "Another discussion on this original is already waiting or in progress, or the context has changed. Your draft is kept. Check status before trying again." : "Your thought’s save acknowledgement could not be confirmed. Your exact draft is kept. Retry send uses the same key and words, not a new thought." });
    } finally { sends.current.delete(key); patch(key, { sending: false }); }
  }
  async function stop() {
    const key = current.current, entry = all.current[key], turn = entry.dialogue?.turns.at(-1);
    if (!entry.dialogue || !turn?.actions?.stop.eligible || entry.stopPending) return;
    let command = stops.current.get(turn.id);
    if (!command) { command = { key: commandId(), expectedRunId: turn.actions.stop.expectedRunId }; stops.current.set(turn.id, command); }
    patch(key, { stopPending: true });
    try {
      const receipt = parseDialogueStopReceipt(await postDevelopment(`/api/dialogues/${entry.dialogue.id}/turns/${turn.id}/stop`, { expectedRunId: command.expectedRunId }, command.key));
      if (!receipt || receipt.dialogueId !== entry.dialogue.id || receipt.turnId !== turn.id || receipt.expectedRunId !== command.expectedRunId) throw new DevelopmentError(503, "invalid_receipt");
      patch(key, { notice: "Stop requested. Waiting for the actual outcome; already recorded changes are kept." });
      await read(key);
    } catch (error) {
      const rejected = error instanceof DevelopmentError && error.status === 409 &&
        (error.code === "turn_conflict" || error.code === "version_or_command_conflict");
      // A rejected fence never applied. Only a later explicit click may issue a
      // new command; uncertain acknowledgements must retain this exact command.
      if (rejected) stops.current.delete(turn.id);
      patch(key, { notice: rejected ? "The response changed before Stop could be applied. Check its current status." : "Stop could not be confirmed. Check status; the run may still be active and no rollback is implied." });
      if (rejected) await read(key);
    } finally { patch(key, { stopPending: false }); }
  }

  const entry = contexts[selected], latest = entry.dialogue?.turns.at(-1);
  const rootActive = Object.values(contexts).some((state) => state.dialogue?.turns.some((turn) => isActiveTurn(turn.status)));
  return { ...entry, latest, selected, select, activateDialogue, opening, edit, send, stop,
    check: async () => { if (all.current[current.current].dialogue) await read(current.current, true); else await ensure(current.current).catch(() => {}); },
    blocked: !entry.pending && (rootActive || entry.busyConflict), refresh: () => read(current.current, true) };
}
