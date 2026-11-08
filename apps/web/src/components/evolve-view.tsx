"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import type { IdeaThought } from "../features/idea/types";
import {
  continuationPoints, terminalRun, useEvolveStore,
  type EvolveExchange, type EvolveWorkspace,
} from "./evolve-provider";
import styles from "./evolve.module.css";
import { useContextualBack } from "./contextual-back";
import { ContentGlyph } from "./content-glyph";
import { MediaSourceDetails } from "./media-source-details";

const titleOf = (thought: IdeaThought) => thought.title ?? (thought.kind === "media-original" ? thought.mediaSource.name : thought.text.trim().split(/\s+/).slice(0, 5).join(" "));
const hrefOf = (id: string) => `/ideas/${encodeURIComponent(id)}`;
const kinds = {
  "captured-original": "Original capture", "user-contribution": "Contribution",
  "ai-interpretation": "Interpretation", "developing-idea": "Developing idea", "imported-original": "Imported source", "media-original": "Image or PDF",
};

export function EvolveView({ thoughtId }: { thoughtId: string | null }) {
  const store = useEvolveStore();
  const [key, setKey] = useState<string | null>(null);
  const [contextOpen, setContextOpen] = useState(false);
  const [choicesOpen, setChoicesOpen] = useState(false);
  const changeButton = useRef<HTMLButtonElement>(null);
  const firstChoice = useRef<HTMLButtonElement>(null);
  const contributionField = useRef<HTMLTextAreaElement>(null);
  const snapshot = useCallback(() => store.get(key), [store, key]);
  const workspace = useSyncExternalStore(store.subscribe, snapshot, () => null);
  useContextualBack(thoughtId ? hrefOf(thoughtId) : "/explore", thoughtId ? "Back to idea" : "Back to Explore");

  useEffect(() => { if (thoughtId) setKey(store.open(thoughtId)); }, [store, thoughtId]);
  useEffect(() => {
    if (!key) return;
    let stopWatching: (() => void) | undefined;
    const visibility = () => {
      stopWatching?.();
      stopWatching = document.visibilityState === "visible" ? store.watch(key) : undefined;
    };
    visibility();
    document.addEventListener("visibilitychange", visibility);
    return () => { document.removeEventListener("visibilitychange", visibility); stopWatching?.(); };
  }, [store, key]);
  useEffect(() => { if (choicesOpen) firstChoice.current?.focus(); }, [choicesOpen]);

  if (!thoughtId) return <section className={styles.view}><h1>Evolve link not valid</h1><p>Choose Evolve from an idea to begin.</p></section>;
  if (!workspace || !key) return <section className={styles.view}><h1>Evolve</h1><p role="status">Opening the selected thought…</p></section>;

  const points = continuationPoints(workspace);
  const selected = points.find(item => item.id === workspace.continuationId);
  const selectionUnconfirmed = !selected && workspace.exchanges.some(item => item.readError
    && (item.unconfirmedOutputIds.includes(workspace.continuationId)
      || item.receipt?.contribution.id === workspace.continuationId));
  const latest = workspace.exchanges.at(-1);
  const blocked = workspace.exchanges.some(item => item.admission === "pending" || item.admission === "unconfirmed"
    || item.stopping || item.checking || (item.run && !terminalRun(item.run.status)));
  const frozen = latest?.admission === "pending" || latest?.admission === "unconfirmed";
  const canSend = !!workspace.draft.trim() && !!selected && workspace.rootState !== "loading" && !blocked;
  const composerHelp = frozen
    ? "The submitted words are preserved. They will not be sent again automatically."
    : blocked ? "You can keep a next draft. Send is paused while this run is active or being checked."
      : workspace.draft.trim() ? workspace.root?.kind === "media-original"
        ? "Send records a new contribution. The original file and clarification are not edited."
        : "Send records a new contribution. Saved thoughts are not edited." : null;
  function submit(event: FormEvent) {
    event.preventDefault();
    if (key && canSend) void store.send(key);
  }

  return <section className={styles.view}>
    <h1>Evolve</h1>
    <div className={styles.columns}>
      <div className={styles.context}>
        <button className={styles.contextToggle} type="button" aria-expanded={contextOpen}
          aria-controls="evolve-starting-context" onClick={() => setContextOpen(!contextOpen)}>
          <span>Starting thought{workspace.root ? ` · ${titleOf(workspace.root)}` : ""}</span>
          <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8"><path d={contextOpen ? "m6 15 6-6 6 6" : "m6 9 6 6 6-6"} /></svg>
        </button>
        <aside className={styles.rail} id="evolve-starting-context" data-open={contextOpen} aria-labelledby="evolve-starting-heading">
          <h2 id="evolve-starting-heading">Starting thought</h2>
          {workspace.rootState === "loading" ? <p role="status">Reading the starting thought…</p>
            : workspace.root ? <>
              <h3>{titleOf(workspace.root)}</h3><Byline thought={workspace.root} />
              {workspace.root.kind === "media-original" ? <MediaSourceDetails source={workspace.root.mediaSource} compact /> : <p className={styles.savedText}>{workspace.root.text}</p>}
              <Link href={hrefOf(workspace.root.id)} prefetch={false}>Open idea</Link>
            </> : <><p>Starting thought unavailable.</p><p className={styles.muted}>No history scope will be opened automatically.</p></>}
        </aside>
      </div>
      <div className={styles.working}>
        <div className={styles.conversation}>
          {workspace.exchanges.length === 0 && <p className={styles.empty}>Add a question, challenge, or new thought.</p>}
          {workspace.exchanges.map((exchange, index) => <Exchange key={exchange.key} value={exchange}
            latest={index === workspace.exchanges.length - 1} workspace={workspace} />)}
        </div>
        <form className={styles.composer} onSubmit={submit} noValidate>
          <div className={styles.continuation}>
            <p>Continuing from: <strong>{selected ? titleOf(selected) : selectionUnconfirmed ? "Selected point not confirmed" : "Selected point unavailable"}</strong></p>
            {(points.length > 1 || (!selected && points.length > 0)) && <button className={styles.textButton} type="button" ref={changeButton}
              aria-expanded={choicesOpen} aria-controls="evolve-continuation-choices"
              disabled={!!frozen} onClick={() => setChoicesOpen(!choicesOpen)}>Change</button>}
          </div>
          {!selected && <p className={styles.muted}>{selectionUnconfirmed
            ? "Check this run again or choose another available point. Your draft is kept."
            : "Choose an available point to continue. Your draft is kept."}</p>}
          {choicesOpen && <div className={styles.choices} id="evolve-continuation-choices"
            onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); setChoicesOpen(false); changeButton.current?.focus(); } }}>
            <p>Choose where the next contribution begins. Opening an idea only browses it.</p>
            {points.map((point, index) => <button className={styles.choice} key={point.id} type="button"
              ref={index === 0 ? firstChoice : undefined} aria-pressed={selected?.id === point.id}
              onClick={() => {
                store.choose(key, point.id);
                setChoicesOpen(false);
                (points.length > 1 ? changeButton.current : contributionField.current)?.focus();
              }}>
              {titleOf(point)}{point.id === workspace.rootId ? " · Starting thought" : ""}
            </button>)}
          </div>}
          <label htmlFor="evolve-contribution">Your contribution</label>
          <div className={styles.sendRow}>
            <textarea id="evolve-contribution" ref={contributionField} value={workspace.draft} readOnly={!!frozen}
              placeholder="Add a question, challenge, or new thought" aria-describedby={composerHelp ? "evolve-composer-help" : undefined}
              onChange={event => store.draft(key, event.target.value)} />
            <button className={`${styles.button} ${styles.primary}`} type="submit" disabled={!canSend}>Send</button>
          </div>
          {composerHelp && <p id="evolve-composer-help" className={`${styles.composerHelp} ${styles.muted}`}>{composerHelp}</p>}
        </form>
        <p className={styles.policy}>Drafts and known run references stay while you browse in this tab. Reload opens a fresh workspace; it does not stop existing work. Keep the displayed run IDs before reloading.</p>
      </div>
    </div>
  </section>;
}

function Exchange({ value, latest, workspace }: {
  value: EvolveExchange; latest: boolean; workspace: EvolveWorkspace;
}) {
  const store = useEvolveStore();
  const run = value.run;
  const receipt = value.receipt;
  const resolved = value.resolved;
  const active = run && !terminalRun(run.status);
  const fallbackPoint = receipt && resolved?.reply?.role === "fallback" && resolved.reply.state === "complete";
  return <section className={styles.exchange}>
    {receipt ? <div className={styles.contribution}>
      <Byline thought={receipt.contribution} /><p className={styles.message}>{receipt.contribution.text}</p>
    </div> : <div className={styles.warning} role="status">
      <h2>{value.admission === "pending" ? "Waiting for admission" : value.admission === "not-started" ? "Evolve was not started" : "Admission unconfirmed"}</h2>
      <p>{value.admission === "pending" ? "Waiting for confirmation. No run ID is known yet."
        : value.admission === "not-started" ? "No run was admitted. Your contribution is still in the field; you can send it deliberately when ready."
          : "It may have started. The original submitted words and selected point are preserved. No run ID is known, so there is no run to check or stop in this view. Do not send the same contribution again."}</p>
      <p className={styles.savedText}>{value.snapshot.text}</p>
      <p className={styles.muted}>Submitted point: {value.snapshot.thoughtId}</p>
    </div>}
    {run && <div className={styles.run}>
      <div className={styles.runHeading}>
        <p role="status" className={styles.runState}>{run.status[0].toUpperCase() + run.status.slice(1)}</p>
        <p className={styles.runId}>Run <span>{run.id}</span></p>
      </div>
      {active && <p className={styles.muted}>{run.status === "uncertain"
        ? "Observation is uncertain. Check this same run; do not send the contribution again."
        : "Waiting for recorded output. This is not a stream of model text."}</p>}
      {run.status === "failed" && <p>The run failed. Any saved developments below are retained; no new reply is invented.</p>}
      {run.status === "interrupted" && <p>The run is interrupted. Saved work and your next draft remain.</p>}
      {value.readError && <p className={styles.warning} role="status">Could not check this run or all of its saved records. Last confirmed text is shown where available. Check this run again before continuing from an unconfirmed point.</p>}
      {value.stopUnconfirmed && <p className={styles.warning} role="status">Stop unconfirmed. No Stop request will be repeated automatically. Check this same run for its current status.</p>}
      {latest && <div className={styles.runActions}>
        {active && <button className={styles.button} type="button" disabled={value.stopping}
          onClick={() => void store.stop(workspace.key)}>Stop</button>}
        <button className={styles.textButton} type="button" disabled={value.checking || value.stopping}
          onClick={() => void store.check(workspace.key)}>Check this run</button>
        {value.stopping && <span role="status">Sending Stop. This does not guarantee native work has stopped.</span>}
      </div>}
    </div>}
    {resolved?.reply && <div className={styles.reply}>
      <p className={styles.byline}><span className={styles.ai}>AI{resolved.reply.state === "interrupted" ? " · Interrupted reply" : ""}</span> · <span className={styles.materialLabel}><ContentGlyph kind="full-reply" size={20} />Full reply</span></p>
      <p className={styles.message}>{resolved.reply.text}</p>
    </div>}
    {resolved?.replyUnavailable && <p className={styles.muted}>The recorded reply is unavailable in the normal view.</p>}
    {resolved && (resolved.outputs.length > 0 || fallbackPoint) && <section className={styles.developments}>
      <h2>Recorded developments</h2>
      <div className={styles.developmentGrid}>
        {resolved.outputs.map(output => output.thought
          ? <Development key={output.id} thought={output.thought} unconfirmed={value.unconfirmedOutputIds.includes(output.id)} />
          : <article className={styles.development} key={output.id}><h3>{value.unconfirmedOutputIds.includes(output.id) ? "Saved idea not confirmed" : "Saved idea unavailable"}</h3><p className={styles.muted}>{output.id}</p></article>)}
        {fallbackPoint && receipt && <Development thought={receipt.contribution} />}
      </div>
    </section>}
  </section>;
}

function Byline({ thought }: { thought: IdeaThought }) {
  return <p className={styles.byline}><span className={thought.author === "user" ? styles.user : thought.author === "ai" ? styles.ai : styles.source}>{thought.author === "user" ? "You" : thought.author === "ai" ? "AI" : "Imported source"}</span> · <span className={styles.materialLabel}><ContentGlyph kind={thought.kind === "media-original" ? "imported-original" : thought.kind} size={20} />{kinds[thought.kind]}</span></p>;
}

function Development({ thought, unconfirmed = false }: { thought: IdeaThought; unconfirmed?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const abbreviated = thought.text !== null && thought.text.length > 240;
  return <article className={styles.development}>
    <Byline thought={thought} /><h3>{titleOf(thought)}</h3>
    {unconfirmed && <p className={styles.muted}>Last confirmed text · this idea could not be refreshed.</p>}
    <p className={styles.savedText}>{abbreviated && !expanded ? thought.text?.slice(0, 240) : thought.text}
      {abbreviated && <> <button className={styles.textButton} type="button" aria-expanded={expanded}
        aria-label={`${expanded ? "Collapse" : "Expand"} saved development ${titleOf(thought)}`}
        onClick={() => setExpanded(!expanded)}>{expanded ? "Show less" : "…"}</button></>}
    </p>
    <Link href={hrefOf(thought.id)} prefetch={false}>Open idea</Link>
  </article>;
}
