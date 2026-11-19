"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, type FormEvent, type Ref } from "react";
import { readEvolveThought } from "../features/evolve/request";
import type { IdeaThought } from "../features/idea/types";
import { useContextualBack } from "./contextual-back";
import { hrefOf, StartingThought, titleOf, wordsTitle } from "./evolve-context";
import { useEvolveStore } from "./evolve-provider";
import { conversationHref, freshEvolveHref, rememberInspection, takeInspectionReturn, type Save, type Speaker } from "./evolve-selective-client";
import { useSelectiveEvolve } from "./evolve-selective-state";
import base from "./evolve.module.css";
import styles from "./evolve-selective.module.css";

type Controller = ReturnType<typeof useSelectiveEvolve>;
type VisibleTurn = NonNullable<Controller["conversation"]>["turns"][number];
const primary = `${base.button} ${base.primary}`;
const dialogPrompt = "Add a question, challenge, or new thought";
const readNormalThought = (id: string) => readEvolveThought(id, { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(12_000) }) });

function useOffWindowLabels(ids: ReadonlySet<string>, retry: number) {
  const cache = useRef(new Map<string, string | null>());
  const [labels, setLabels] = useState<ReadonlyMap<string, string | null>>(() => new Map());
  const key = JSON.stringify([...ids]);
  useEffect(() => {
    let attached = true;
    const unknown = (JSON.parse(key) as string[]).filter(id => !cache.current.has(id) || (retry > 0 && cache.current.get(id) === null));
    async function resolve() {
      while (attached && unknown.length) {
        const batch = await Promise.all(unknown.splice(0, 4).map(async id => [id, await readNormalThought(id)] as const));
        if (!attached) return;
        for (const [id, read] of batch) {
          const thought = read.kind === "found" ? read.value : null;
          cache.current.set(id, thought ? thought.title ?? thought.text ?? titleOf(thought) : null);
        }
        setLabels(new Map(cache.current));
      }
    }
    void resolve();
    return () => { attached = false; };
  }, [key, retry]);
  return labels;
}

export function SelectiveModeChoice({ checked, onChange, inputRef, disabled = false }: {
  checked: boolean; onChange: () => void; inputRef?: Ref<HTMLInputElement>; disabled?: boolean;
}) {
  const help = useId();
  return <div className={styles.modeChoice}>
    <label><input type="checkbox" ref={inputRef} checked={checked} disabled={disabled} onChange={onChange} aria-describedby={help} /> Save ideas only</label>
    <p className={styles.meta} id={help}>Keep the conversation separate from your library. AI can save distinct ideas, and you can keep a passage yourself. You can’t switch modes once the conversation starts.</p>
  </div>;
}

function SelectiveBack({ anchor }: { anchor: string | null }) {
  useContextualBack(anchor ? hrefOf(anchor) : "/explore", anchor ? "Back to idea" : "Back to Explore");
  return null;
}

type Entry = { anchor: IdeaThought; initialDraft: string; onEntryDraft: (text: string) => void; onClassic: () => void; conversationId?: never };
type Linked = { conversationId: string; anchor?: never; initialDraft?: never; onEntryDraft?: never; onClassic?: never };

export function SelectiveEvolve(props: Entry | Linked) {
  const linkedId = props.conversationId ?? null;
  const classicStore = useEvolveStore();
  const [resumed, setResumed] = useState(!linkedId);
  const state = useSelectiveEvolve(props.anchor?.id ?? null, linkedId, resumed);
  const { conversation, task, pending, stale, notice, journalError, stops, activeRuns, admissions, continuationChanging, continuationUnknown } = state;
  const session = conversation?.session;
  const anchorId = session?.anchorThoughtId ?? props.anchor?.id ?? null;
  const [loadedAnchor, setLoadedAnchor] = useState<{ id: string; thought: IdeaThought | null } | null>(null);
  const [anchorCheck, setAnchorCheck] = useState(0);
  const anchor = props.anchor ?? (loadedAnchor?.id === anchorId ? loadedAnchor?.thought ?? null : null);
  const [draft, setDraft] = useState(props.initialDraft ?? "");
  const [labelCheck, setLabelCheck] = useState(0);
  const [branch, setBranch] = useState<string | null>(null);
  const [openPassage, setOpenPassage] = useState<string | null>(null);
  const change = useRef<HTMLButtonElement>(null);
  const modeChoice = useRef<HTMLInputElement>(null);
  const mainHeading = useRef<HTMLHeadingElement>(null);
  const focusAfterResume = useRef(false);
  const focusAfterBranch = useRef(false);

  useEffect(() => {
    if (!linkedId) modeChoice.current?.focus();
    else {
      const memory = takeInspectionReturn(linkedId);
      if (memory) {
        setDraft(memory.text);
        setResumed(true);
      }
    }
  }, [linkedId]);

  useEffect(() => {
    if (resumed && focusAfterResume.current) {
      focusAfterResume.current = false;
      mainHeading.current?.focus();
    }
  }, [resumed]);

  useEffect(() => {
    if (!linkedId || !anchorId) return;
    let current = true;
    void readNormalThought(anchorId)
      .then(result => { if (current) setLoadedAnchor({ id: anchorId, thought: result.kind === "found" ? result.value : null }); });
    return () => { current = false; };
  }, [anchorCheck, anchorId, linkedId]);

  useEffect(() => {
    if (state.confirmedSend > 0) setDraft("");
  }, [state.confirmedSend]);

  useEffect(() => {
    if (branch === null && !task && focusAfterBranch.current) {
      focusAfterBranch.current = false;
      change.current?.focus();
    }
  }, [branch, task]);

  const turns = conversation?.turns ?? [];
  const saved = turns.flatMap(turn => turn.saves);
  const receipts = new Map(saved.map(save => [save.thoughtId, save]));
  const continuationId = session?.continuationThoughtId ?? anchorId;
  const unknownParents = new Set([continuationId, continuationChanging?.requested, continuationUnknown?.requested, continuationUnknown?.observed,
    ...turns.map(turn => turn.parentId), ...saved.map(save => save.parentId)]
    .filter((id): id is string => !!id && id !== anchorId && !receipts.has(id)));
  const labels = useOffWindowLabels(unknownParents, labelCheck);
  const labelFor = (id: string | null): string => {
    if (id === anchorId && anchor) return titleOf(anchor);
    const resolved = id ? labels.get(id) : null;
    if (resolved) return resolved;
    const thought = id ? receipts.get(id) : null;
    if (thought) return wordsTitle(thought.text);
    if (id && unknownParents.has(id)) return labels.has(id) ? "Selected thought unavailable" : "Reading the selected thought…";
    return "Selected thought unavailable";
  };
  const continuation = labelFor(continuationId);
  const loadingAnchor = Boolean(linkedId && anchorId && loadedAnchor?.id !== anchorId);
  const tooLong = new TextEncoder().encode(draft).length > 4096;
  const sendBusy = task === "send" || (pending?.kind === "send" && task === "check");
  const sendFrozen = sendBusy || pending?.kind === "send";
  const parentIdentified = Boolean(continuationId && (continuationId === anchorId || receipts.has(continuationId) || labels.get(continuationId)));
  const hasRunChecks = stops.size > 0;
  const hasActiveRun = activeRuns.size > 0;
  const visibleRunIds = new Set(turns.map(turn => turn.runId));
  const offWindowAdmissions = new Map(admissions.flatMap(turn => turn.runId ? [[turn.runId, turn] as const] : []));
  const offWindowRuns = [...new Set([...offWindowAdmissions.keys(), ...stops.keys()])].filter(id => !visibleRunIds.has(id));
  const admissionsWithoutRuns = admissions.filter(turn => !turn.runId);
  const canSend = Boolean(anchor && parentIdentified && draft.trim() && !tooLong && !task && !pending && !stale && !journalError
    && !hasActiveRun && !hasRunChecks && !continuationChanging && !continuationUnknown);
  const canChange = !task && !pending && !stale && !hasActiveRun && !hasRunChecks && !continuationChanging && !continuationUnknown && Boolean(anchor);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (canSend) void state.send(draft);
  };
  const closeBranch = () => { focusAfterBranch.current = true; setBranch(null); };
  const entryError = Boolean(linkedId && !session);
  const onInspect = session && resumed ? () => {
    state.prepareInspection();
    rememberInspection(session.id, draft);
  } : undefined;

  return <section className={`${base.view} ${styles.selective}`} aria-labelledby="evolve-title">
    {linkedId && <SelectiveBack anchor={anchorId} />}
    <header className={styles.heading}>
      <div><h1 ref={mainHeading} id="evolve-title" tabIndex={-1}>Evolve</h1>
        {(session || linkedId) && <p className={styles.mode}>Save ideas only</p>}</div>
      {session && resumed && <a className={base.textButton} href={conversationHref(session.id)}>Conversation link</a>}
    </header>
    {entryError ? <div className={styles.entryNotice}>
      <p role="status">{notice || "Reading the saved conversation…"}</p>
      {notice && <button type="button" className={base.button} disabled={!!task} onClick={() => void state.load(linkedId!)}>Check conversation</button>}
    </div> : <div className={base.columns}>
      <StartingThought thought={anchor} loading={loadingAnchor} onInspect={onInspect} />
      <div className={base.working}>
        {!resumed && anchorId ? <section className={styles.resume} aria-labelledby="evolve-resume">
          <h2 id="evolve-resume">Resume this conversation?</h2>
          <p className={styles.meta}>{anchor ? titleOf(anchor) : loadingAnchor ? "Reading the starting thought…" : "Starting thought unavailable"}
            {turns.length > 0 && <> · Last continued from {continuation}</>}</p>
          <div className={styles.actions}>
            <a className={primary} href="#evolve-title" onClick={event => {
              event.preventDefault();
              focusAfterResume.current = true;
              setResumed(true);
            }}>Resume</a>
            <Link className={base.textButton} href={freshEvolveHref(anchorId)} prefetch={false}
              onNavigate={() => classicStore.startFromIdea(anchorId)}>Start fresh instead</Link>
          </div>
          <p className={styles.meta}>Resume opens the saved dialogue without sending a message.</p>
        </section> : <>
          {!session && <div>
            <p className={base.empty}>{dialogPrompt}.</p>
            {props.onClassic && <SelectiveModeChoice checked onChange={props.onClassic} inputRef={modeChoice} disabled={sendBusy} />}
          </div>}
          <section aria-label="Conversation">
            {conversation?.nextBefore && <div className={styles.historyPaging}>
              <button className={base.textButton} type="button" disabled={!!task}
                onClick={() => void state.loadEarlier()}>Load earlier turns</button>
              {task === "earlier" && <p className={styles.meta} role="status">Loading earlier turns…</p>}
              {state.earlierNotice && <p className={styles.problem} role="status">{state.earlierNotice}</p>}
            </div>}
            {turns.map(turn => <TranscriptTurn key={turn.id} turn={turn} state={state} latest={turn.id === turns.at(-1)?.id}
              active={turn.runId !== null && activeRuns.has(turn.runId)} labelFor={labelFor} continuation={continuation}
              openPassage={openPassage} setOpenPassage={setOpenPassage} onInspect={onInspect} />)}
          </section>
          {(offWindowRuns.length > 0 || admissionsWithoutRuns.length > 0) && <section className={styles.historyPaging} aria-labelledby="evolve-run-checks">
            <h2 id="evolve-run-checks">Run checks</h2>
            {admissionsWithoutRuns.map(turn => <div key={turn.id} className={styles.run}>
              <p className={styles.meta}>Message recorded · No agent run was started.</p>
              <p className={base.savedText}>{turn.text}</p>
            </div>)}
            {offWindowRuns.map(runId => {
              const admission = offWindowAdmissions.get(runId), stopStatus = stops.get(runId);
              const confirmedStatus = state.settledStops.get(runId) ?? admission?.status;
              return <div className={styles.run} key={runId}>
                <p className={styles.meta}>Run <span>{runId}</span> · Turn not in the loaded transcript</p>
                {admission && <p className={base.savedText}>{admission.text}</p>}
                <p className={styles.meta} role="status">
                  {confirmedStatus ? <>Last confirmed status: {runStatusLabel[confirmedStatus]}.
                    {confirmedStatus === "interrupted" && " Remote tools may still be running."}</>
                    : "No confirmed run status is available in this view."}
                </p>
                <StopFeedback status={stopStatus} />
                <div className={styles.actions}>
                  {activeRuns.has(runId) && <button className={base.button} type="button" disabled={!!stopStatus}
                    onClick={() => void state.stop(runId)}>Stop</button>}
                  {stopStatus !== "requesting" && <button className={base.textButton} type="button" disabled={!!task}
                    aria-label={`Check this run: ${runId}`} onClick={() => void state.checkRun(runId)}>Check this run</button>}
                </div>
              </div>;
            })}
          </section>}
          <form className={base.composer} onSubmit={submit} noValidate>
            <div className={base.continuation}>
              <p>Continuing from: <strong>{continuation}</strong></p>
              {(saved.length > 0 || continuationId !== anchorId) && <button ref={change} className={base.textButton} type="button" disabled={!canChange}
                aria-expanded={branch !== null} aria-controls="evolve-selective-branches"
                onClick={() => branch === null ? setBranch(continuationId ?? "") : closeBranch()}>Change</button>}
            </div>
            {branch !== null && <Branches branch={branch} onChange={setBranch} close={closeBranch} state={state} anchor={anchor} saves={saved}
              extra={continuationId && continuationId !== anchorId && !receipts.has(continuationId) ? { id: continuationId, label: continuation } : null} />}
            <label htmlFor="evolve-message">Your message</label>
            <div className={base.sendRow}>
              <textarea id="evolve-message" value={draft} readOnly={sendFrozen} placeholder={dialogPrompt}
                aria-describedby="evolve-selective-help" aria-invalid={tooLong || undefined}
                onChange={event => {
                  setDraft(event.target.value);
                  if (!session) props.onEntryDraft?.(event.target.value);
                }} />
              <button className={primary} type="submit" disabled={!canSend}>Send</button>
            </div>
            <p id="evolve-selective-help" className={`${styles.meta} ${styles.composerHelp}`} role="status">
              {tooLong ? "This message is too long. Use at most 4,096 bytes."
                : sendBusy ? task === "check" ? "Checking the original request…" : "Sending this message. The submitted words are kept."
                : pending?.kind === "send" ? "Send unconfirmed. Check the original request rather than sending again."
                : hasActiveRun ? "You can draft while this reply is in progress. Send is paused."
                : loadingAnchor ? "Reading the starting thought…"
                : !anchor ? "You can read this conversation, but the starting thought is not available for new messages."
                : "Messages stay in this conversation. Only saved ideas enter your library."}
            </p>
            {!anchor && !loadingAnchor && linkedId && <button className={base.textButton} type="button" onClick={() => {
              setLoadedAnchor(null);
              setAnchorCheck(index => index + 1);
            }}>Check starting thought</button>}
            {anchor && continuationId && !parentIdentified && labels.has(continuationId) &&
              <button className={base.textButton} type="button" onClick={() => setLabelCheck(count => count + 1)}>Check continuation thought</button>}
            {pending?.kind === "send" && <button className={base.textButton} type="button" disabled={!!task}
              onClick={() => void state.checkPending()}>Check request</button>}
            {!openPassage && pending?.kind === "keep" && <div className={styles.problem}>
              <p role="status">Passage save unconfirmed. Check the original save.</p>
              <button className={base.textButton} type="button" disabled={!!task} onClick={() => void state.checkPending()}>Check save</button>
            </div>}
            {journalError && <p className={styles.problem} role="status">Request recovery is unavailable in this tab. New messages and saves are paused.</p>}
            {continuationChanging && <p className={styles.meta} role="status">Checking the outcome of the change to {labelFor(continuationChanging.requested)}. Your draft is kept.</p>}
            {continuationUnknown && <div className={styles.problem}>
              <p role="status">{continuationUnknown.reason === "change-unknown"
                ? "Continuation change unconfirmed. Your draft is kept. A delayed change may still arrive."
                : continuationUnknown.reason === "return" ? "Review the continuation before sending. Your draft is kept."
                : "Continuation changed. Your draft is kept. Review the recorded thought before sending."}</p>
              {continuationUnknown.reason === "change-unknown" && <p>Requested thought: <strong>{labelFor(continuationUnknown.requested)}</strong></p>}
              {continuationUnknown.observed && <p>Recorded thought at last check: <strong>{labelFor(continuationUnknown.observed)}</strong></p>}
              <button className={base.textButton} type="button" disabled={!!task}
                onClick={() => void state.checkContinuation()}>Check selection</button>
              {continuationUnknown.observed && <button className={base.button} type="button" disabled={!!task || stale
                || (unknownParents.has(continuationUnknown.observed) && !labels.get(continuationUnknown.observed))}
                onClick={async () => { if (await state.useObservedContinuation() && branch !== null) closeBranch(); }}>Use current thought</button>}
            </div>}
            {notice && !openPassage && <p className={styles.problem} role="status">{notice}</p>}
            {stale && !pending && <button className={base.textButton} type="button" disabled={!!task}
              onClick={() => void state.checkRun(null)}>Check conversation</button>}
          </form>
        </>}
      </div>
    </div>}
  </section>;
}

function Branches({ branch, onChange, close, state, anchor, saves, extra }: {
  branch: string; onChange: (id: string) => void; close: () => void; state: Controller; anchor: IdeaThought | null; saves: Save[];
  extra: { id: string; label: string } | null;
}) {
  const fieldset = useRef<HTMLFieldSetElement>(null);
  const locked = Boolean(state.task || state.continuationChanging || state.continuationUnknown);
  useEffect(() => { (fieldset.current?.querySelector<HTMLInputElement>("input:checked")
    ?? fieldset.current?.querySelector<HTMLInputElement>("input"))?.focus(); }, []);
  return <fieldset ref={fieldset} id="evolve-selective-branches" className={styles.branch}
    onKeyDown={event => { if (event.key === "Escape" && !locked) { event.preventDefault(); close(); } }}>
    <legend>Choose where the next message begins.</legend>
    <p className={styles.meta}>Opening an idea does not change this choice.</p>
    {anchor && <label className={styles.radio}><input type="radio" name="evolve-parent" checked={branch === anchor.id} onChange={() => onChange(anchor.id)} disabled={locked} />
      <span>{titleOf(anchor)} · Starting thought</span></label>}
    {extra && <label className={styles.radio}><input type="radio" name="evolve-parent" checked={branch === extra.id} onChange={() => onChange(extra.id)} disabled={locked} />
      <span>{extra.label} · Current thought</span></label>}
    {saves.map(save => <label className={styles.radio} key={save.thoughtId}>
      <input type="radio" name="evolve-parent" checked={branch === save.thoughtId} onChange={() => onChange(save.thoughtId)} disabled={locked} />
      <span>{save.text} · {save.speaker === "user" ? "You" : "AI"}</span></label>)}
    <div className={styles.actions}>
      <button className={base.button} type="button" disabled={!branch || locked || state.stale}
        onClick={async () => { if (await state.choose(branch)) close(); }}>Use this thought</button>
      <button className={base.textButton} type="button" disabled={locked} onClick={close}>Cancel</button>
    </div>
  </fieldset>;
}

function BySpeaker({ speaker }: { speaker: Speaker }) {
  return <span className={speaker === "user" ? base.user : base.ai}>{speaker === "user" ? "You" : "AI"}</span>;
}

function StopFeedback({ status }: { status: ReturnType<Controller["stops"]["get"]> }) {
  if (status === "requesting") return <p className={styles.meta} role="status">Requesting Stop. Remote tools may still be running.</p>;
  if (status === "unconfirmed") return <p className={styles.problem} role="status">Stop unconfirmed. Check this run for its current status. Remote tools may still be running.</p>;
  return null;
}

const runStatusLabel = {
  pending: "No agent run was started", queued: "Queued", submitting: "Starting reply",
  running: "Reply in progress", uncertain: "Reply status uncertain", completed: "Completed",
  interrupted: "Interrupted", failed: "Reply failed",
} satisfies Record<VisibleTurn["status"], string>;

function TranscriptTurn({ turn, state, latest, active, labelFor, continuation, openPassage, setOpenPassage, onInspect }: {
  turn: VisibleTurn; state: Controller; latest: boolean; active: boolean; labelFor: (id: string) => string;
  continuation: string; openPassage: string | null; setOpenPassage: (id: string | null) => void;
  onInspect?: () => void;
}) {
  const runStatus = (turn.runId && state.settledStops.get(turn.runId)) || turn.status;
  const status = runStatus === "pending" ? "Message recorded · No agent run was started."
    : runStatus === "interrupted" ? "Interrupted · Confirmed saves are kept. Remote tools may still be running."
    : runStatus === "failed" ? "Reply failed · Confirmed saves are kept." : runStatusLabel[runStatus];
  const stopStatus = turn.runId ? state.stops.get(turn.runId) : undefined;
  const controls = Boolean(turn.runId && (active || stopStatus));
  const display = runStatus === "completed" && turn.reply !== null && turn.saves.length === 0 && !state.stale && !turn.savesHasMore
    ? "Completed · No thoughts saved" : status;
  const renderMessage = (speaker: Speaker, text: string) => {
    const key = `${turn.id}:${speaker}`;
    return <TranscriptMessage speaker={speaker} text={text} turnId={turn.id} parentId={turn.parentId}
      parent={labelFor(turn.parentId)} continuation={continuation} state={state} open={openPassage === key}
      onOpen={() => setOpenPassage(key)} onClose={() => setOpenPassage(null)} />;
  };
  return <section className={styles.turn} aria-label="Conversation turn">
    {renderMessage("user", turn.text)}
    {turn.reply !== null && renderMessage("ai", turn.reply)}
    {(controls || runStatus !== "completed" || turn.saves.length === 0) && <div className={styles.run}>
      <p className={styles.meta} role={latest ? "status" : undefined}>{display}</p>
      {controls && <div className={styles.actions}>
        {active && <button type="button" className={base.button} disabled={!!stopStatus}
          onClick={() => void state.stop(turn.runId!)}>Stop</button>}
        <button type="button" className={base.textButton} disabled={!!state.task || stopStatus === "requesting"}
          onClick={() => void state.checkRun(turn.runId)}>Check this run</button>
      </div>}
      <StopFeedback status={stopStatus} />
    </div>}
    {(turn.saves.length > 0 || turn.savesHasMore) && <section className={styles.saves} aria-label="Saved ideas">
      <div className={styles.saveHead}><h2>Saved ideas</h2>
        <p className={styles.meta} role={latest ? "status" : undefined}>{turn.savesHasMore
          ? turn.saves.length ? `${turn.saves.length} shown · more available` : "Saved ideas are available"
          : `${turn.saves.length} added to your library`}</p></div>
      {turn.saves.map(save => <article className={styles.receipt} key={save.thoughtId}>
        <p className={styles.meta}><BySpeaker speaker={save.speaker} /> · Selected by {save.selectedBy === "user" ? "you" : "AI"}</p>
        <div className={styles.receiptGrid}><div>
          <h3>{wordsTitle(save.text)}</h3>
          <p className={styles.receiptText}>{save.text}</p>
          <p className={styles.meta}><strong>Developed from:</strong> {labelFor(save.parentId)}</p>
        </div><Link className={base.textButton} href={hrefOf(save.thoughtId)} prefetch={false} onNavigate={onInspect}
          aria-label={`Open idea: ${wordsTitle(save.text)}`}>Open idea</Link></div>
      </article>)}
      {turn.savesHasMore && <div className={styles.savePaging}>
        <button className={base.textButton} type="button" disabled={!!state.task}
          onClick={() => void state.loadSaves(turn)}>Load more saved ideas</button>
        {state.loadingSaves === turn.id && <p className={styles.meta} role="status">Loading saved ideas…</p>}
        {state.saveNotices[turn.id] && <p className={styles.problem} role="status">{state.saveNotices[turn.id]}</p>}
      </div>}
    </section>}
  </section>;
}

interface Range { start: number; end: number }
function selectedOffsets(message: HTMLElement | null): Range | null {
  const selection = window.getSelection();
  if (!message || !selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
  const selected = selection.getRangeAt(0);
  if (!message.contains(selected.startContainer) || !message.contains(selected.endContainer)) return null;
  const before = document.createRange();
  before.selectNodeContents(message);
  before.setEnd(selected.startContainer, selected.startOffset);
  const start = before.toString().length;
  return { start, end: start + selected.toString().length };
}

/** Textarea selection offsets use normalized line breaks; translate to the stored text. */
function sourceOffset(text: string, offset: number): number {
  let read = 0;
  while (offset-- > 0 && read < text.length) {
    if (text[read] === "\r" && text[read + 1] === "\n") read++;
    read++;
  }
  return read;
}

function TranscriptMessage({ speaker, text, turnId, parentId, parent, continuation, state, open, onOpen, onClose }: {
  speaker: Speaker; text: string; turnId: string; parentId: string; parent: string; continuation: string;
  state: Controller; open: boolean; onOpen: () => void; onClose: () => void;
}) {
  const [range, setRange] = useState<Range | null>(null);
  const [error, setError] = useState("");
  const message = useRef<HTMLParagraphElement>(null);
  const source = useRef<HTMLTextAreaElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const pointerRange = useRef<Range | null>(null);
  const formId = useId(), fieldId = useId();
  const originalResult = useRef(state.confirmedKeep);
  const exact = range ? text.slice(range.start, range.end) : "";
  const frozen = state.pending?.kind === "keep";
  const canSelect = !state.pending && !state.journalError && !state.stale && !state.task;

  function dismiss() {
    onClose();
    trigger.current?.focus();
  }

  useEffect(() => {
    if (!open) return;
    if (range) title.current?.focus();
    else source.current?.focus();
  }, [open, range]);

  useEffect(() => {
    if (open && !state.task && state.confirmedKeep > originalResult.current) {
      onClose();
      trigger.current?.focus();
    }
  }, [onClose, open, state.confirmedKeep, state.task]);

  function begin() {
    if (open) { dismiss(); return; }
    const selection = pointerRange.current ?? selectedOffsets(message.current);
    pointerRange.current = null;
    setRange(selection && text.slice(selection.start, selection.end).trim() ? selection : null);
    setError("");
    originalResult.current = state.confirmedKeep;
    onOpen();
  }

  function preview() {
    const field = source.current;
    if (!field) return;
    const start = sourceOffset(text, field.selectionStart), end = sourceOffset(text, field.selectionEnd);
    if (!text.slice(start, end).trim()) {
      setError("Select some words from the message first.");
      field.focus();
      return;
    }
    setRange({ start, end });
  }

  return <div className={styles.message}>
    <p className={styles.byline}><BySpeaker speaker={speaker} /></p>
    <p ref={message} className={base.message}>{open && range ? <>{text.slice(0, range.start)}<mark>{exact}</mark>{text.slice(range.end)}</> : text}</p>
    <button ref={trigger} className={base.textButton} type="button" aria-expanded={open} aria-controls={open ? formId : undefined}
      aria-label={speaker === "user" ? "Select passage from your message" : "Select passage from the AI reply"}
      disabled={!canSelect && !open}
      onPointerDown={() => { pointerRange.current = selectedOffsets(message.current); }}
      onClick={() => { if (!frozen && !state.task) begin(); }}>Select passage</button>
    {open && <section className={styles.panel} id={formId}
      onKeyDown={event => {
        if (event.key === "Escape" && !frozen && !state.task) { event.preventDefault(); dismiss(); }
      }}>
      {range ? <>
        <h3 ref={title} tabIndex={-1}>Keep this passage</h3>
        <p className={styles.quote}>{exact}</p>
        <p className={styles.meta}><BySpeaker speaker={speaker} /> wrote this · Selected by you</p>
        <p><strong>Save under:</strong> {parent}</p>
        <p className={styles.meta}>The next message will still continue from {continuation}.</p>
        <div className={styles.actions}>
          {frozen ? <button className={base.button} disabled={!!state.task} type="button" onClick={() => void state.checkPending()}>Check save</button>
            : <button className={primary} disabled={!canSelect} type="button"
              onClick={() => void state.keep(turnId, { speaker, text: exact, parentId })}>Keep as thought</button>}
          <button className={base.textButton} type="button" onClick={dismiss} disabled={frozen || !!state.task}>Cancel</button>
        </div>
        {frozen && <p className={styles.problem} role="status">{state.task === "keep" ? "Saving this passage…" : "Passage save unconfirmed. Check the original save before trying again."}</p>}
        {state.notice && <p className={styles.problem} role="status">{state.notice}</p>}
      </> : <>
        <label htmlFor={fieldId}>Select the exact words to keep</label>
        <p className={styles.meta} id={`${fieldId}-help`}>Select text here, then review the passage before saving.</p>
        <textarea ref={source} id={fieldId} readOnly value={text} aria-describedby={`${fieldId}-help`} />
        <div className={styles.actions}>
          <button className={base.button} type="button" onClick={preview}>Review passage</button>
          <button className={base.textButton} type="button" onClick={dismiss}>Cancel</button>
        </div>
        {error && <p className={styles.problem} role="status">{error}</p>}
      </>}
    </section>}
  </div>;
}
