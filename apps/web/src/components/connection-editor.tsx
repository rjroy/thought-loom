"use client";

import { useEffect, useRef, useState } from "react";
import { commandIdea } from "../features/idea/request";
import type { CreateConnectionCommand, IdeaThought } from "../features/idea/types";
import { ConnectionThought, ConnectionThoughtPicker, connectionTitle } from "./connection-thought-picker";
import idea from "./idea.module.css";
import styles from "./connection-editor.module.css";

type Category = CreateConnectionCommand["category"];
type Phase = "editing" | "pending" | "saved" | "uncertain";
interface Snapshot { command: CreateConnectionCommand; from: IdeaThought; to: IdeaThought; sources: readonly IdeaThought[]; }
const categories: readonly Category[] = ["supports", "contradicts", "extends", "related"];
const categoryLabel = (category: Category) => category[0]!.toUpperCase() + category.slice(1);
const sentence = (from: IdeaThought, category: Category, to: IdeaThought) =>
  `${connectionTitle(from)} ${category === "related" ? "is related to" : category} ${connectionTitle(to)}`;

export function ConnectionEditor({ thought, disabled, onClose, onCreated, onLockedChange, onInvalidateReads }: {
  thought: IdeaThought; disabled: boolean; onClose: () => void; onCreated: () => void;
  onLockedChange: (locked: boolean) => void;
  /** Write attempt and settlement invalidate consumer reads even if this editor has unmounted. */
  onInvalidateReads: () => void;
}) {
  const [other, setOther] = useState<IdeaThought | null>(null);
  const [category, setCategory] = useState<Category | null>(null);
  const [direction, setDirection] = useState<"outgoing" | "incoming" | null>(null);
  const [explanation, setExplanation] = useState("");
  const [sources, setSources] = useState<readonly IdeaThought[]>([]);
  const [queries, setQueries] = useState({ second: "", source: "" });
  const [phase, setPhase] = useState<Phase>("editing");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copyNotice, setCopyNotice] = useState<string | null>(null);
  const writing = useRef(false);
  const alive = useRef(false);
  const describe = useRef<HTMLHeadingElement>(null);
  const chooseSection = useRef<HTMLElement>(null);
  const receipt = useRef<HTMLHeadingElement>(null);
  const locked = phase !== "editing" || disabled;
  const dirty = !!(other || category || direction || explanation.trim() || sources.length || queries.second.trim() || queries.source.trim());
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    onLockedChange(phase === "pending" || phase === "uncertain");
  }, [phase, onLockedChange]);
  useEffect(() => () => onLockedChange(false), [onLockedChange]);

  const from = direction === "incoming" ? other : thought;
  const to = direction === "incoming" ? thought : other;
  const ready = !!(other && category && direction && explanation.trim()) && !locked;
  function cancel() {
    if (phase === "pending" || phase === "uncertain") return;
    if (phase === "saved" || !dirty || window.confirm("Discard this connection draft? Your entered work is kept only on this Idea page.")) onClose();
  }
  async function create() {
    if (!ready || !category || !from || !to || writing.current) return;
    writing.current = true;
    const submitted: Snapshot = { from, to, sources: [...sources], command: {
      action: "create-connection", thoughtId: thought.id, fromId: from.id, toId: to.id,
      category, explanation, sourceIds: sources.map(source => source.id),
    } };
    setSnapshot(submitted); setPhase("pending"); setNotice(null);
    onInvalidateReads();
    const result = await commandIdea(submitted.command, { fetch: window.fetch.bind(window) }).finally(onInvalidateReads);
    if (!alive.current) return;
    writing.current = false;
    if (result.kind === "applied") {
      setPhase("saved"); onCreated();
    } else if (result.kind === "uncertain") setPhase("uncertain");
    else {
      setPhase("editing");
      setNotice("Connection not applied. A connected or supporting thought may be unavailable, or the inputs could not be accepted. Your inputs are still here.");
    }
  }
  useEffect(() => {
    if ((phase === "saved" || phase === "uncertain") &&
      (document.activeElement === document.body || document.activeElement?.closest("[data-connection-editor]"))) receipt.current?.focus();
  }, [phase]);

  return <section className={styles.editor} aria-labelledby="create-connection-heading" data-connection-editor>
    <h2 id="create-connection-heading">Create connection</h2>
    <ol className={styles.steps} aria-label="Connection steps">
      <li aria-current={!other ? "step" : undefined}>Choose thought</li>
      <li aria-current={other && !ready && phase === "editing" ? "step" : undefined}>Describe</li>
      <li aria-current={ready || phase !== "editing" ? "step" : undefined}>Review</li>
    </ol>
    {phase === "saved" ? <div className={styles.receipt} role="status">
      <h3 ref={receipt} tabIndex={-1}>Connection created · Proposed by You</h3>
      <p>The connection was confirmed. Your original thoughts and evolution ancestry are unchanged.</p>
    </div> : phase === "uncertain" ? <div className={idea.warning} role="status">
      <h3 ref={receipt} tabIndex={-1}>Creation unconfirmed</h3>
      <p>This connection may already exist. Nothing will be sent again automatically.</p>
      <p>Keep or copy the submitted details below. Reading the current Idea cannot prove that this request failed.</p>
    </div> : null}
    {notice && <p className={idea.error} role="alert">{notice}</p>}

    {(phase === "editing" || phase === "pending") && <>
      <section ref={chooseSection} className={styles.section} aria-labelledby="connection-choose-heading">
        <h3 id="connection-choose-heading">Choose thought</h3>
        {other && <div className={styles.selected}><ConnectionThought thought={other} />
          <button type="button" className={idea.textButton} disabled={locked}
            onClick={() => chooseSection.current?.querySelector<HTMLInputElement>('input[type="text"]')?.focus()}>Change thought</button>
        </div>}
        <ConnectionThoughtPicker excluded={[thought.id]} locked={locked}
          onQueryChange={value => setQueries(current => ({ ...current, second: value }))}
          onChoose={value => {
            if (writing.current || phase !== "editing" || disabled) return;
            setOther(value); setNotice(null); describe.current?.focus();
          }} />
      </section>
      <section className={styles.section} aria-labelledby="connection-describe-heading">
        <h3 id="connection-describe-heading" ref={describe} tabIndex={-1}>Describe the relationship</h3>
        <fieldset className={styles.fieldset} disabled={locked}>
          <legend>Category</legend>
          <div className={styles.categories}>{categories.map(value => <label key={value}>
            <input type="radio" name="connection-category" checked={category === value} onChange={() => setCategory(value)} />
            {categoryLabel(value)}
          </label>)}</div>
        </fieldset>
        {other && category && <fieldset className={styles.fieldset} disabled={locked}>
          <legend>Direction</legend>
          <label className={styles.direction}><input type="radio" name="connection-direction" checked={direction === "outgoing"}
            onChange={() => setDirection("outgoing")} />{sentence(thought, category, other)}</label>
          <label className={styles.direction}><input type="radio" name="connection-direction" checked={direction === "incoming"}
            onChange={() => setDirection("incoming")} />{sentence(other, category, thought)}</label>
        </fieldset>}
        <label className={styles.label} htmlFor="connection-explanation">Why are these connected? (required)</label>
        <textarea id="connection-explanation" className={styles.explanation} value={explanation} readOnly={locked} required
          onChange={event => setExplanation(event.target.value)} />
      </section>
      <details className={styles.supporting} open>
        <summary>Supporting thoughts (optional)</summary>
        <p className={idea.metadata}>Choose existing thoughts that informed this connection. Adding a source does not verify or endorse it.</p>
        {sources.map(source => <div className={styles.source} key={source.id}>
          <ConnectionThought thought={source} />
          <button type="button" className={idea.textButton} disabled={locked}
            aria-label={`Remove supporting thought: ${connectionTitle(source)}`}
            onClick={() => setSources(current => current.filter(value => value.id !== source.id))}>Remove supporting thought</button>
        </div>)}
        <ConnectionThoughtPicker supporting excluded={sources.map(source => source.id)} locked={locked}
          onQueryChange={value => setQueries(current => ({ ...current, source: value }))}
          onChoose={value => {
            if (writing.current || phase !== "editing" || disabled) return;
            setSources(current => current.some(source => source.id === value.id) ? current : [...current, value]);
          }} />
      </details>
    </>}

    <section className={styles.review} aria-label="Review connection">
      <h3>Review</h3>
      {snapshot && phase !== "editing" ? <>
        <p><strong>{sentence(snapshot.from, snapshot.command.category, snapshot.to)}</strong></p>
        <p className={styles.words}>{snapshot.command.explanation}</p>
        <p>Supporting thoughts: {snapshot.sources.length ? snapshot.sources.map(connectionTitle).join("; ") : "None"}</p>
        <details><summary>Submitted identities</summary><p className={idea.metadata}>From: {snapshot.command.fromId}<br />To: {snapshot.command.toId}<br />Sources: {snapshot.command.sourceIds?.join(", ") || "None"}</p></details>
      </> : <>
        <p>{from && to && category && direction ? <strong>{sentence(from, category, to)}</strong> : "Choose another thought, a category and an explicit direction."}</p>
        {other && <p>Thoughts: {connectionTitle(thought)}; {connectionTitle(other)}</p>}
        {explanation.trim() && <p className={styles.words}>{explanation}</p>}
        <p>Supporting thoughts: {sources.length ? sources.map(connectionTitle).join("; ") : "None"}</p>
      </>}
    </section>
    {phase === "pending" && <p role="status">Creating connection… Waiting for confirmation. This request has already been sent.</p>}
    {phase === "uncertain" && <>
      <button type="button" className={idea.textButton} onClick={async () => {
        if (!snapshot) return;
        try { await navigator.clipboard.writeText(JSON.stringify(snapshot.command, null, 2)); setCopyNotice("Submitted details copied."); }
        catch { setCopyNotice("Could not copy automatically. The submitted details remain selectable above."); }
      }}>Copy submitted details</button>
      {copyNotice && <p role="status">{copyNotice}</p>}
    </>}
    <div className={styles.buttons}>
      {phase !== "saved" && <button type="button" className={`${idea.button} ${idea.primary}`} disabled={!ready} onClick={() => void create()}>Create connection</button>}
      <button type="button" className={idea.button} disabled={phase === "pending" || phase === "uncertain"} onClick={cancel}>{phase === "saved" ? "Close" : "Cancel"}</button>
    </div>
  </section>;
}
