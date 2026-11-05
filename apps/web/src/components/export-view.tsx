"use client";

import Link from "next/link";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { downloadBytes } from "../features/export/request";
import type { MarkdownArtifact } from "../features/export/types";
import { ExportMarkdown } from "./export-markdown";
import { exportTerminal, useExportStore } from "./export-provider";
import styles from "./export.module.css";

function download(artifact: MarkdownArtifact, filename: string) {
  const bytes = downloadBytes(artifact);
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "text/markdown;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = filename;
  document.body.append(anchor); anchor.click(); anchor.remove();
  // Let the browser consume the owned blob before releasing it.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ExportView({ thoughtId }: { thoughtId: string | null }) {
  const store = useExportStore(), key = JSON.stringify(thoughtId);
  const workspace = useSyncExternalStore(store.subscribe, () => store.get(key), () => undefined);
  useEffect(() => { store.open(key); return store.watch(key, thoughtId); }, [key, thoughtId, store]);
  const run = workspace?.run;
  const flow = Boolean(workspace && !workspace.setup);
  const progressHeading = useRef<HTMLHeadingElement>(null), requestField = useRef<HTMLTextAreaElement>(null);
  const previousFlow = useRef<boolean | null>(null);
  useEffect(() => {
    if (previousFlow.current !== null && previousFlow.current !== flow) {
      if (flow) progressHeading.current?.focus();
      else requestField.current?.focus();
    }
    previousFlow.current = flow;
  }, [flow]);
  const locked = Boolean(workspace && (!workspace.setup || ["pending", "unconfirmed"].includes(workspace.admission) || (run && !exportTerminal(run))));
  const countInvalid = Boolean(workspace && (!Number.isInteger(Number(workspace.count)) || Number(workspace.count) < 1));
  const frozen = flow && workspace?.snapshot;
  return <div className={styles.export}>
    {thoughtId && <Link className={styles.back} href={`/ideas/${encodeURIComponent(thoughtId)}`} prefetch={false}>Back to idea</Link>}
    <header className={styles.heading}>
      <h1>Export</h1><p>Take your thinking out as Markdown.</p>
    </header>
    {!workspace ? <p role="status">Loading export workspace…</p> : <>
      <div className={`${styles.methods} ${flow ? styles.outputLayout : ""}`}>
        {!flow && <section className={styles.method} aria-labelledby="simple-heading">
          <h2 id="simple-heading">Simple</h2>
          <p className={styles.description}>Recorded thoughts from a development branch.</p>
          <form noValidate onSubmit={event => { event.preventDefault(); void store.simple(key); }}>
            <div className={styles.field}>
              <h3>Starting idea</h3>
              {workspace.rootState === "loading" ? <p role="status">Loading starting idea…</p> : workspace.root ? <div className={styles.root}>
                <strong>{workspace.root.title || "Untitled thought"}</strong>
                <p>{workspace.root.text}</p>
                <span>{workspace.root.author === "user" ? "You" : "AI"} · {workspace.root.kind.replaceAll("-", " ")}</span>
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
            <div role="status">
              {workspace.simplePending && <p>Preparing Markdown… Waiting for the export response.</p>}
              {workspace.simpleError && <p className={styles.warning}>Could not obtain this export. Your inputs are retained. You can deliberately create the export again.</p>}
            </div>
            <button className={styles.primary} disabled={workspace.rootState !== "ready" || workspace.simplePending || countInvalid}>
              {workspace.simplePending ? "Preparing export…" : "Create simple export"}
            </button>
          </form>
        </section>}

        <section className={styles.method} aria-labelledby="agentic-heading">
          <h2 id="agentic-heading">{flow ? "Agentic export" : "Agentic"}</h2>
          <p className={styles.description}>A read-only report from existing thinking.</p>
          <form noValidate onSubmit={event => { event.preventDefault(); void store.admit(key); }}>
            <div className={styles.field}>
              <label htmlFor="export-request">Request</label>
              <textarea ref={requestField} id="export-request" rows={5} value={frozen ? frozen.request : workspace.request} readOnly={locked}
                onChange={event => store.editAgentic(key, { request: event.target.value })} />
            </div>
            <div className={styles.field}>
              <label htmlFor="export-effort">Effort</label>
              <select id="export-effort" value={frozen ? frozen.effort : workspace.effort} disabled={locked}
                onChange={event => store.editAgentic(key, { effort: event.target.value as "quick" | "standard" | "thorough" })}>
                <option value="quick">Quick</option><option value="standard">Standard</option><option value="thorough">Thorough</option>
              </select>
            </div>
            <p className={styles.help}>Doesn’t change your thoughts. Not limited to the starting idea’s branch.</p>
            {workspace.admission === "not-started" && <div className={styles.warning} role="status"><strong>Report was not started.</strong><p>The service could not start this request. Your inputs are retained.</p></div>}
            {!flow && workspace.admission === "unconfirmed" && <p className={styles.warning}>Admission unconfirmed. This frozen request may have started. No run ID is known, and it will not be submitted again automatically.</p>}
            {!flow && <button className={styles.primary} disabled={locked || !workspace.request.trim()}>Create report</button>}
          </form>
          {run && <div className={styles.runReference}>
            <span>Known run</span><strong>{run.id}</strong>
            {!flow && <><span>{run.status[0].toUpperCase() + run.status.slice(1)}</span><button className={styles.secondary} onClick={() => store.showRun(key)}>View this run</button></>}
          </div>}
          {flow && workspace.admission !== "pending" && <button className={styles.textButton} onClick={() => store.back(key)}>Back to setup</button>}
        </section>

        {flow && <section className={`${styles.method} ${styles.progress}`} aria-label="Report progress">
          <div role="status" aria-live="polite">
            <h2 ref={progressHeading} tabIndex={-1}>{workspace.admission === "pending" ? "Starting report…" : workspace.admission === "unconfirmed" ? "Admission unconfirmed" : run ? run.status[0].toUpperCase() + run.status.slice(1) : "Waiting for confirmation"}</h2>
            {workspace.admission === "pending" && <p>Waiting for confirmation. Your request is held unchanged.</p>}
            {workspace.admission === "unconfirmed" && <div className={styles.warning}><p>The report may have started, but no run ID was confirmed. Your request is preserved. It will not be submitted again automatically.</p><p>Starting another request could create a duplicate. There is no known run to check or stop here.</p></div>}
            {run?.status === "queued" && <p>Your request is accepted and queued.</p>}
            {run?.status === "submitting" && <p>The accepted request is being submitted to the agent.</p>}
            {run?.status === "running" && <p>The investigation is running. No completed report is available yet.</p>}
            {run?.status === "uncertain" && <p>Progress is uncertain, not a confirmed failure. Check this same known run rather than submit the request again.</p>}
            {run && ["interrupted", "failed"].includes(run.status) && <p>No completed report is available.</p>}
            {run?.status === "completed" && !workspace.report && <p>The run completed, but its report is not available to preview or download yet. Check this run to read the report again.</p>}
            {workspace.readError && <p className={styles.warning}>Could not check this run. The last confirmed status and any previously read report are retained; current progress is unconfirmed.</p>}
            {workspace.stopUnconfirmed && <p className={styles.warning}>Stop unconfirmed. The known run and last confirmed status are retained. Check this run before drawing a conclusion.</p>}
            {workspace.reportState === "error" && <p className={styles.warning}>Could not read the report. {workspace.report ? "The previously confirmed report remains below." : "No completed report has been obtained."}</p>}
            {workspace.reportState === "unavailable" && <p className={styles.warning}>Report unavailable in this view. {workspace.report && "The previously confirmed report remains below."}</p>}
            {workspace.reportState === "not-ready" && workspace.report && <p className={styles.warning}>The latest report read was not ready. The previously confirmed report remains below.</p>}
          </div>
          {run && <div className={styles.actions}>
            <button className={styles.secondary} disabled={workspace.checking || workspace.stopping} onClick={() => void store.check(key)}>{workspace.checking ? "Checking…" : "Check this run"}</button>
            {!exportTerminal(run) && <button className={styles.secondary} disabled={workspace.stopping} onClick={() => void store.stop(key)}>{workspace.stopping ? "Requesting stop…" : "Stop"}</button>}
          </div>}
          {run && !exportTerminal(run) && <p className={styles.help}>Stop requests cancellation of this run. The agent may not stop immediately.</p>}
          {workspace.report && <div className={styles.preview}>
            <div className={styles.previewHeading}><h3>Report ready</h3><button className={styles.primary} onClick={() => download(workspace.report!, "thoughtloom-report.md")}>Download Markdown</button></div>
            <div className={styles.markdown}><ExportMarkdown markdown={workspace.report.text} /></div>
            {workspace.sources.length > 0 && <footer className={styles.sources}>
              <h3>Source thoughts</h3><p>Recorded identities and attribution, not endorsement. Links are available only for thoughts accessible in normal view.</p>
              <ul>{workspace.sources.map(source => <li key={source.id}>{source.thought ? <Link href={`/ideas/${encodeURIComponent(source.id)}`} prefetch={false}>{source.thought.title || "Untitled thought"}</Link> : <span>Source unavailable in this view</span>}<span className={styles.sourceId}>{source.id}</span></li>)}</ul>
            </footer>}
          </div>}
        </section>}
      </div>

      {!flow && workspace.simpleArtifact && <section className={`${styles.method} ${styles.simplePreview}`} aria-label="Simple Markdown preview">
        <div className={styles.previewHeading}><h2>Simple Markdown preview</h2><button className={styles.primary} onClick={() => download(workspace.simpleArtifact!, "thoughtloom-simple.md")}>Download Markdown</button></div>
        <p className={styles.help}>This preview and download use the same returned Markdown bytes.{workspace.simplePending || workspace.simpleError ? " This is the previously confirmed export, not a result of the latest attempt." : ""}</p>
        {workspace.simpleArtifactSnapshot && <p className={styles.help}>Requested maximum: {workspace.simpleArtifactSnapshot.count} thoughts · {workspace.simpleArtifactSnapshot.traversal === "breadth" ? "Breadth-first" : "Depth-first"} · Starting ID: {workspace.simpleArtifactSnapshot.rootId}</p>}
        <div className={styles.markdown}><ExportMarkdown markdown={workspace.simpleArtifact.text} /></div>
      </section>}
      <p className={styles.policy}>Leaving this page does not stop a run. Inputs and known run references remain while you browse in this tab. A reload or fresh document starts setup without automatically resuming or submitting work.</p>
    </>}
  </div>;
}
