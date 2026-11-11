"use client";

import { useEffect, useRef, useSyncExternalStore, type FormEvent } from "react";
import { downloadMarkdown } from "../features/export/download";
import type { MarkdownArtifact } from "../features/export/types";
import { ExportMarkdown } from "./export-markdown";
import { useExportStore } from "./export-provider";
import styles from "./export.module.css";
import { useContextualBack } from "./contextual-back";
import { MediaSourceDetails } from "./media-source-details";
import type { IdeaThought } from "../features/idea/types";

function titleOf(thought: IdeaThought) {
  return thought.title || (thought.kind === "media-original" ? thought.mediaSource.name : "Untitled thought");
}

export function ExportView({ thoughtId }: { thoughtId: string | null }) {
  useContextualBack(thoughtId ? `/ideas/${encodeURIComponent(thoughtId)}` : null, "Back to idea");
  const store = useExportStore(), key = JSON.stringify(thoughtId);
  const workspace = useSyncExternalStore(store.subscribe, () => store.get(key), () => undefined);
  useEffect(() => { store.open(key); return store.watch(key, thoughtId); }, [key, thoughtId, store]);
  const simpleForm = useRef<HTMLFormElement>(null), simpleHeading = useRef<HTMLHeadingElement>(null);
  const simpleFocus = useRef<{ key: string; previous: MarkdownArtifact | null } | null>(null);
  useEffect(() => () => { simpleFocus.current = null; }, [key]);
  useEffect(() => {
    const intent = simpleFocus.current;
    if (!intent) return;
    if (intent.key !== key || workspace?.simpleError) { simpleFocus.current = null; return; }
    const artifact = workspace?.simpleArtifact;
    if (workspace?.simplePending || !artifact || artifact === intent.previous) return;
    simpleFocus.current = null;
    // A fresh result from this submission may move focus, not a cached artifact
    // on return. Respect an intervening action.
    const active = document.activeElement;
    if (active && active !== document.body && !simpleForm.current?.contains(active)) return;
    simpleHeading.current?.focus({ preventScroll: true });
    simpleHeading.current?.scrollIntoView({ block: "center", behavior: "instant" });
  }, [key, workspace?.simpleArtifact, workspace?.simplePending, workspace?.simpleError]);
  function submitSimple(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const current = store.get(key);
    if (!current || current.simplePending) return;
    simpleFocus.current = { key, previous: current.simpleArtifact };
    void store.simple(key);
  }
  const countInvalid = Boolean(workspace && (!Number.isInteger(Number(workspace.count)) || Number(workspace.count) < 1));
  return <div className={`${styles.export} ${styles.simpleOnly}`}>
    <header className={styles.heading}>
      <h1>Simple export</h1><p>Take recorded thoughts from this idea’s development branches as Markdown.</p>
    </header>
    {!workspace ? <p role="status">Loading export workspace…</p> : <>
      <div>
        <section className={styles.simpleSetup} aria-label="Simple export setup">
          <form ref={simpleForm} noValidate onSubmit={submitSimple}>
            <div className={styles.field}>
              <h3>Starting idea</h3>
              {workspace.rootState === "loading" ? <p role="status">Loading starting idea…</p> : workspace.root ? <div className={styles.root}>
                <strong>{titleOf(workspace.root)}</strong>
                {workspace.root.kind === "media-original" ? <>
                  <p className={styles.rootByline}>Imported source · <span>Image or PDF</span></p>
                  <MediaSourceDetails source={workspace.root.mediaSource} compact />
                </> : <><p>{workspace.root.text}</p>
                  <span>{workspace.root.author === "user" ? "You" : workspace.root.author === "ai" ? "AI" : "Imported source"} · {workspace.root.kind.replaceAll("-", " ")}</span></>}
              </div> : <p className={styles.warning}>Starting idea unavailable in this view. Simple export needs an available starting thought.</p>}
            </div>
            <div className={styles.field}>
              <label htmlFor="export-count">Maximum thoughts (count)</label>
              <input id="export-count" type="number" min="1" step="1" value={workspace.count}
                readOnly={workspace.simplePending} aria-invalid={countInvalid} aria-describedby={countInvalid ? "export-count-error" : undefined}
                onChange={event => store.editSimple(key, { count: event.target.value })} />
              {countInvalid && <p id="export-count-error" className={styles.error}>Enter a whole number of 1 or more.</p>}
            </div>
            <fieldset className={styles.order} disabled={workspace.simplePending}>
              <legend>Order</legend>
              {(["breadth", "depth"] as const).map(value => <label key={value}>
                <input type="radio" name="traversal" value={value} checked={workspace.traversal === value}
                  onChange={() => store.editSimple(key, { traversal: value })} />
                {value === "breadth" ? "Breadth-first" : "Depth-first"}
              </label>)}
            </fieldset>
            <p className={styles.help}>Includes the starting idea. Follows evolution branches, not discovered connections. Skips rejected thoughts and leaves out separate full replies.</p>
            {workspace.root?.kind === "media-original" && <p className={styles.help}>A media source exports its descriptor and clarification, not binary or extracted file contents.</p>}
            <div role="status">
              {workspace.simplePending && <p>Preparing Markdown… Waiting for the export response.</p>}
              {workspace.simpleError && <p className={styles.warning}>Could not obtain this export. Your inputs are retained. You can deliberately create the export again.</p>}
              {!workspace.simplePending && !workspace.simpleError && workspace.simpleArtifact && <p>Simple Markdown export ready. Preview and download are available.</p>}
            </div>
            <button className={styles.primary} disabled={workspace.rootState !== "ready" || workspace.simplePending || countInvalid}>
              {workspace.simplePending ? "Preparing export…" : "Create simple export"}
            </button>
          </form>
        </section>
      </div>

      {workspace.simpleArtifact && <section className={`${styles.method} ${styles.simplePreview}`} aria-label="Simple Markdown preview">
        <div className={styles.previewHeading}><h2 ref={simpleHeading} tabIndex={-1}>Simple Markdown preview</h2><button className={styles.primary} onClick={() => downloadMarkdown(workspace.simpleArtifact!, "thoughtloom-simple.md")}>Download Markdown</button></div>
        <p>{workspace.simplePending
          ? "Preparing a new export. This is the previously confirmed preview."
          : workspace.simpleError ? "The latest export was not obtained. This previously confirmed preview is still available."
            : "Simple Markdown export ready. Preview and download are available."}</p>
        <p className={styles.help}>This preview and download use the same returned Markdown bytes.{workspace.simplePending || workspace.simpleError ? " This is the previously confirmed export, not a result of the latest attempt." : ""}</p>
        {workspace.simpleArtifactSnapshot && <p className={styles.help}>Requested maximum: {workspace.simpleArtifactSnapshot.count} thoughts · {workspace.simpleArtifactSnapshot.traversal === "breadth" ? "Breadth-first" : "Depth-first"} · Starting ID: {workspace.simpleArtifactSnapshot.rootId}</p>}
        <div className={styles.markdown}><ExportMarkdown markdown={workspace.simpleArtifact.text} /></div>
      </section>}
      <p className={styles.policy}>Inputs and the confirmed preview remain while you browse in this tab. Reload starts setup without submitting an export.</p>
    </>}
  </div>;
}
