"use client";

import { createContext, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { isThoughtTitleText, type InquiryView, type ThoughtTitle } from "@thoughtloom/contracts";
import { getTitle, saveTitle, TitleError, titleEntityKey, titleTargetKey, type TitleInput, type TitleTarget, type TitleView } from "../../lib/title-client";
import { inquiryTitleMetadata, TitleState, titleMetadataIdentity, type TitleObservation } from "../../lib/title-state";
import { compactThoughtLabel } from "../../lib/thought-label";

type Entry = { session: symbol; target: TitleTarget; draft: string; editing: boolean; loading: boolean; saving: boolean; initialized: boolean; ready: boolean; head: string | null; edits: number; error: string; pending: { key: string; input: TitleInput } | null };
function useTitles(root: string, initial?: InquiryView) {
  const [entries, setEntries] = useState<Record<string, Entry>>({}), [, changed] = useState(0);
  const [canonical] = useState(() => new TitleState(initial ? inquiryTitleMetadata(initial) : []));
  const state = useRef(entries), mounted = useRef(true), refreshes = useRef(new Map<string, symbol>());
  const reads = useRef(new Map<string, { token: symbol; controller: AbortController }>()), controllers = useRef(new Set<AbortController>());
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; for (const controller of controllers.current) controller.abort(); reads.current.clear(); }; }, []);
  function patch(entity: string, values: Partial<Entry>, session?: symbol) {
    if (!mounted.current || !state.current[entity] || (session && state.current[entity].session !== session)) return;
    state.current = { ...state.current, [entity]: { ...state.current[entity], ...values } }; setEntries(state.current);
  }
  function display(target: TitleTarget): ThoughtTitle | undefined { return canonical.display(target); }
  async function read(target: TitleTarget): Promise<TitleView | null> {
    const entity = titleEntityKey(target), token = Symbol(), controller = new AbortController(), observation = canonical.begin(target);
    reads.current.get(entity)?.controller.abort(); reads.current.set(entity, { token, controller }); controllers.current.add(controller);
    try {
      const view = await getTitle(root, target, controller.signal);
      if (!mounted.current || controller.signal.aborted || reads.current.get(entity)?.token !== token) return null;
      if (!canonical.accept(observation, { target, title: view.title }, view)) return null;
      changed((value) => value + 1); return view;
    } catch (error) {
      if (!mounted.current || controller.signal.aborted || reads.current.get(entity)?.token !== token || !canonical.current(observation, target)) return null;
      throw error;
    } finally { controllers.current.delete(controller); if (reads.current.get(entity)?.token === token) reads.current.delete(entity); }
  }
  async function refresh(entity: string, seedDraft = false) {
    const entry = state.current[entity]; if (!entry || entry.saving) return;
    const token = Symbol(); refreshes.current.set(entity, token); patch(entity, { loading: true });
    try {
      const view = await read(entry.target); if (!view) return;
      // Establish the initial editor baseline once. Later CAS invalidation must
      // not lock typing or replace a draft while its head is being revalidated.
      patch(entity, { initialized: true, ready: true, head: view.headRevisionId,
        ...((seedDraft || !entry.initialized) && state.current[entity].edits === entry.edits && !entry.pending ? { draft: view.title?.text ?? "" } : {}),
        error: entry.pending || entry.error === "Title changed · Your draft is kept." ? entry.error : "" }, entry.session);
    } catch { patch(entity, { error: "Title could not load · Draft kept." }, entry.session); }
    finally { if (refreshes.current.get(entity) === token) { refreshes.current.delete(entity); patch(entity, { loading: false }, entry.session); } }
  }
  function open(target: TitleTarget, initial?: ThoughtTitle) {
    const entity = titleEntityKey(target), prior = state.current[entity];
    if (prior?.editing) return;
    const next: Entry = prior?.pending ? { ...prior, editing: true } : { session: Symbol(), target, draft: display(target)?.text ?? initial?.text ?? "", editing: true, loading: false, saving: false, initialized: false, ready: false, head: null, edits: 0, error: "", pending: null };
    state.current = { ...state.current, [entity]: next }; setEntries(state.current);
    if (!next.pending) void refresh(entity, true);
  }
  function edit(entity: string, draft: string) { const entry = state.current[entity]; if (entry && !entry.saving && !entry.pending) patch(entity, { draft, edits: entry.edits + 1 }); }
  function close(entity: string) { if (!state.current[entity]?.saving) patch(entity, { editing: false }); }
  async function save(entity: string): Promise<boolean> {
    const entry = state.current[entity];
    if (!entry || entry.saving || (!entry.ready && !entry.pending) || !isThoughtTitleText(entry.draft)) return false;
    const command = entry.pending ?? { key: crypto.randomUUID(), input: { target: entry.target, text: entry.draft, expectedTitleRevisionId: entry.head } };
    // Fence both kinds of pre-write read. A receipt acknowledges only this exact
    // command, never the current head or another editor's draft.
    canonical.beginWrite(command.input.target);
    reads.current.get(entity)?.controller.abort(); reads.current.delete(entity);
    const controller = new AbortController(); controllers.current.add(controller); patch(entity, { saving: true, pending: command, error: "" });
    let acknowledged = false;
    try {
      await saveTitle(root, command.input, command.key, controller.signal); acknowledged = true;
      if (!mounted.current) return false;
      canonical.endWrite(command.input.target);
      // Receipts replay an immutable past write; only a fresh GET names the head.
      const view = await read(command.input.target);
      if (!view) { patch(entity, { ready: false, error: "Title saved. Current label unavailable · Draft kept." }); return false; }
      patch(entity, { head: view.headRevisionId, ready: true, pending: null, error: "" }); return true;
    } catch (error) {
      if (!mounted.current) return false;
      canonical.endWrite(command.input.target);
      const rejected = error instanceof TitleError && error.status === 409 && ["version_conflict", "operation_conflict"].includes(error.code);
      if (rejected) {
        patch(entity, { pending: null, ready: false, loading: true, error: "Title changed · Your draft is kept." });
        try { const view = await read(command.input.target); if (view) patch(entity, { head: view.headRevisionId, ready: true }); }
        catch { /* Keep the draft and require a successful head read before saving. */ }
        finally { patch(entity, { loading: false }); }
      } else patch(entity, { error: acknowledged ? "Title saved. Current label unavailable · Draft kept." : "Save unconfirmed · Draft kept." });
      return false;
    } finally { canonical.endWrite(command.input.target); controllers.current.delete(controller); patch(entity, { saving: false }); }
  }
  // Stable ports let inquiry requests take their ticket before fetch, without
  // resubscribing/reloading on every editor render. All mutable state is root-owned.
  const observations = useMemo(() => ({
    begin: () => canonical.begin(),
    accept(observation: TitleObservation, view: InquiryView) {
      if (!mounted.current) return;
      const accepted = new Map<string, TitleTarget>();
      for (const metadata of inquiryTitleMetadata(view)) {
        if (canonical.accept(observation, metadata)) accepted.set(titleEntityKey(metadata.target), metadata.target);
      }
      if (!accepted.size) return;
      changed((value) => value + 1);
      // Process the entire projection first: current and historical versions may
      // belong to the same entity and share the same observation generation.
      for (const [entity, target] of accepted) {
        const entry = state.current[entity]; if (!entry || entry.saving || entry.pending) continue;
        const unknownHead = canonical.head(target) === undefined;
        if (unknownHead) patch(entity, { ready: false, ...(entry.ready || entry.edits > 0 ? { error: "Title changed · Your draft is kept." } : {}) });
        if (entry.editing && (unknownHead || entry.loading)) void refresh(entity);
      }
    },
    seed(target: TitleTarget, title?: ThoughtTitle) {
      if (!mounted.current || !canonical.seed({ target, title: title ?? null })) return;
      const entity = titleEntityKey(target), entry = state.current[entity];
      if (entry?.saving || entry?.pending) return;
      if (entry?.editing) void refresh(entity);
      else void read(target).catch(() => { /* Existing labels remain until a successful observation. */ });
    },
  }), [canonical]);
  // These functions read refs so an async completion never closes over an older draft.
  return { entries, display, open, edit, close, refresh, save, observations };
}
const Titles = createContext<ReturnType<typeof useTitles> | null>(null);
export function ThoughtTitles({ root, initial, children }: { root: string; initial?: InquiryView; children: ReactNode }) {
  const value = useTitles(root, initial); return <Titles.Provider value={value}>{children}</Titles.Provider>;
}
export function useTitleObservations() {
  const titles = useContext(Titles);
  if (!titles) throw new Error("Title observations require a root provider");
  return titles.observations;
}
function useTitleLabel(target: TitleTarget, initial?: ThoughtTitle) {
  const titles = useContext(Titles), observations = titles?.observations;
  const key = titleTargetKey(target), identity = titleMetadataIdentity(initial);
  useEffect(() => { observations?.seed(target, initial); }, [observations, key, identity]);
  return { titles, title: titles ? titles.display(target) : initial };
}
export function ThoughtTitleText({ target, initial, fallbackText }: { target: TitleTarget; initial?: ThoughtTitle; fallbackText?: string }) {
  const { title } = useTitleLabel(target, initial);
  const label = compactThoughtLabel(title?.text, fallbackText ?? "");
  return label ? <p className="thought-title-text">{label}</p> : null;
}
export default function ThoughtTitleEditor({ target, initial, kind, fallbackText, children }: { target: TitleTarget; initial?: ThoughtTitle; kind: "original" | "reading" | "idea"; fallbackText?: string; children?: (parts: { title: ReactNode; controls: ReactNode }) => ReactNode }) {
  const { titles, title } = useTitleLabel(target, initial), id = useId(), button = useRef<HTMLButtonElement>(null), input = useRef<HTMLInputElement>(null), form = useRef<HTMLFormElement>(null);
  if (!titles) return null;
  const entity = titleEntityKey(target), entry = titles.entries[entity], editing = entry?.editing;
  const invalid = !!entry?.draft && !isThoughtTitleText(entry.draft), message = invalid ? "Use 1–240 characters on one line." : entry?.error;
  const returnFocus = () => requestAnimationFrame(() => { if (document.activeElement === document.body && button.current?.isConnected) button.current.focus({ preventScroll: true }); });
  const text = compactThoughtLabel(title?.text, fallbackText ?? "");
  const label = text ? <p className="thought-title-text">{text}</p> : null;
  const controls = <div className="thought-title-controls">
    <button ref={button} type="button" className="text-button" aria-expanded={!!editing} onClick={() => { titles.open(target, initial); requestAnimationFrame(() => { if (document.activeElement === button.current || document.activeElement === document.body) input.current?.focus({ preventScroll: true }); }); }}>Edit {kind} title</button>
    {editing && <form ref={form} className="title-form" aria-busy={entry.loading || entry.saving} onSubmit={async (event) => {
      event.preventDefault(); if (await titles.save(entity)) { const focused = form.current?.contains(document.activeElement); titles.close(entity); if (focused) returnFocus(); }
    }}>
      <label htmlFor={id}>{kind === "original" ? "Original title" : kind === "idea" ? "Idea title" : "Reading title"}</label>
      {title && <p className="title-author">{title.author === "user" ? "Title written by you" : "AI-generated title"}</p>}
      {titleTargetKey(entry.target) !== titleTargetKey(target) && <p className="title-author">Draft for the earlier selected formulation</p>}
      <input ref={input} id={id} type="text" value={entry.draft} maxLength={240} readOnly={entry.saving || !!entry.pending || !entry.initialized} aria-invalid={invalid || undefined} aria-describedby={message ? `${id}-error` : undefined} onChange={(event) => titles.edit(entity, event.target.value)} />
      {message && <p id={`${id}-error`} className="title-error" role="alert">{message}</p>}
      <div className="title-actions"><button type="submit" className="button secondary" disabled={entry.saving || entry.loading || (!entry.ready && !entry.pending) || !isThoughtTitleText(entry.draft)}>{entry.saving ? "Saving…" : "Save title"}</button><button type="button" className="text-button" disabled={entry.saving} onClick={() => { const focused = form.current?.contains(document.activeElement); titles.close(entity); if (focused) returnFocus(); }}>Cancel</button>{!entry.ready && !entry.loading && <button type="button" className="text-button" onClick={() => void titles.refresh(entity)}>Check title</button>}{entry.loading && <span role="status">Loading title…</span>}</div>
    </form>}
  </div>;
  return children ? children({ title: label, controls }) : <div className="thought-title"><div className="thought-title-heading">{label}</div>{controls}</div>;
}
