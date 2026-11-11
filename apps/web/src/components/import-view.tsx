"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { importId } from "../features/import/request";
import type { ImportFile, ImportSource } from "../features/import/types";
import type { IdeaThought } from "../features/idea/types";
import { useContextualBack } from "./contextual-back";
import { useImportStore } from "./import-provider";
import { ImportInspection } from "./import-inspection";
import { ThoughtMarkdown } from "./thought-markdown";
import styles from "./import.module.css";

const byteLabel = (bytes: number) => bytes < 1024 ? `${bytes} B` : `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(bytes / 1024)} KB`;
const reportHref = (id: string) => `/import?batchId=${encodeURIComponent(id)}`;
const activeFile = (file: ImportFile) => ["queued", "submitting", "running", "uncertain"].includes(file.state);

function outcome(file: ImportFile): { label: string; detail: string; tone: string } {
  switch (file.state) {
    case "imported": return { label: "Imported", detail: file.thoughtCount === 0 ? "0 thoughts — original retained." : `${file.thoughtCount} ${file.thoughtCount === 1 ? "thought" : "thoughts"} · ${file.segmentation?.method === "structural" ? "Structural fallback" : "AI grouping"}`, tone: styles.success };
    case "skipped-identical": return { label: "Skipped — identical", detail: "Same original already imported. No duplicate thoughts or restoration.", tone: "" };
    case "skipped-changed": return { label: "Skipped — changed", detail: "Existing import kept. Nothing overwritten.", tone: "" };
    case "failed": return { label: "Failed", detail: "No source or thoughts saved.", tone: styles.failed };
    case "interrupted": return { label: "Interrupted", detail: "No source or thoughts saved. Other files can continue.", tone: styles.failed };
    case "uncertain": return { label: "Outcome uncertain", detail: "Check this same file; do not import it again.", tone: styles.caution };
    case "running": return { label: "Running", detail: "Grouping the original words.", tone: styles.running };
    case "submitting": return { label: "Submitting", detail: "Waiting for the run to be confirmed.", tone: styles.running };
    case "queued": return { label: "Queued", detail: "Waiting to group the original words.", tone: styles.running };
    default: return { label: "Waiting", detail: "Admitted; waiting for a run. Not imported yet.", tone: styles.running };
  }
}

export function ImportView() {
  const params = useSearchParams(), router = useRouter(), store = useImportStore();
  const workspace = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const requested = params.get("batchId"), valid = requested === null || (params.getAll("batchId").length === 1 && importId(requested));
  const batchId = valid ? requested ?? workspace.batchId : null;
  const report = batchId ? workspace.reports[batchId] : undefined;
  const [recent, setRecent] = useState(false), [inspection, setInspection] = useState<string | null>(null);
  const [narrow, setNarrow] = useState(false), [explanationOpen, setExplanationOpen] = useState(false);
  const [sample, setSample] = useState<{ thought: IdeaThought; source: ImportSource } | null>(null);
  const [commandFocus, setCommandFocus] = useState<string | null>(null);
  const fileMessages = useRef(new Map<string, HTMLParagraphElement>());
  const fileInput = useRef<HTMLInputElement>(null), recentHeading = useRef<HTMLHeadingElement>(null), resultHeading = useRef<HTMLHeadingElement>(null);
  const recentButton = useRef<HTMLButtonElement>(null), chooseButton = useRef<HTMLButtonElement>(null);
  const inspectedTrigger = useRef<HTMLElement | null>(null), previousAdmission = useRef(workspace.admission);
  const admissionHere = !requested || requested === workspace.batchId;
  const pending = admissionHere && workspace.admission === "pending", uncertain = admissionHere && workspace.admission === "uncertain";
  useContextualBack("/capture", "Back to Capture");
  useEffect(() => {
    const media = window.matchMedia("(max-width: 48rem)");
    const change = () => setNarrow(media.matches);
    change(); media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  useEffect(() => batchId ? store.watch(batchId) : undefined, [store, batchId]);
  useEffect(() => {
    if (workspace.batchId && requested === null) router.replace(reportHref(workspace.batchId), { scroll: false });
  }, [workspace.batchId, requested, router]);
  useEffect(() => { setInspection(null); setSample(null); }, [batchId]);
  useEffect(() => {
    if (previousAdmission.current === "pending" && workspace.admission !== "pending" && admissionHere) resultHeading.current?.focus();
    previousAdmission.current = workspace.admission;
  }, [workspace.admission, admissionHere]);
  useEffect(() => { if (recent) recentHeading.current?.focus(); }, [recent]);
  useEffect(() => {
    if (!commandFocus || !report || report.busyFiles.includes(commandFocus)) return;
    fileMessages.current.get(commandFocus)?.focus();
    setCommandFocus(null);
  }, [commandFocus, report]);
  function inspect(id: string) { inspectedTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setInspection(id); }
  function closeInspection() { setInspection(null); inspectedTrigger.current?.focus(); }
  function closeRecent() { setRecent(false); recentButton.current?.focus(); }
  function newImport() { store.reset(); closeRecent(); setSample(null); router.push("/import"); }
  function stopFile(id: string, fileId: string) { setCommandFocus(fileId); void store.stopFile(id, fileId); }
  const localIssues = workspace.issues.map(issue => <div className={styles.notSent} key={issue.id}><strong>{issue.name} · Not sent</strong><p>{issue.message}</p></div>);

  return <section className={styles.workspace} aria-labelledby="import-heading">
    <header className={styles.pageHeading}>
      <div><h1 id="import-heading">Import Markdown</h1><p className={styles.intro}>Bring in files without rewriting their words.</p></div>
      <button ref={recentButton} type="button" className={styles.action} aria-expanded={recent} aria-controls="import-recent" onClick={() => { setRecent(value => !value); if (!recent) void store.recent(); }}>Recent imports</button>
    </header>
    {recent ? <section id="import-recent" className={styles.recent} aria-labelledby="import-recent-heading">
      <div className={styles.actions}><h2 id="import-recent-heading" ref={recentHeading} tabIndex={-1}>Recent imports</h2><button className={styles.action} type="button" onClick={closeRecent}>{batchId ? "Back to report" : "Back to selection"}</button></div>
      <p className={styles.small}>Known batch reports can be reopened. Unsent files are only held in this mounted browser workspace, not saved across reload.</p>
      {workspace.recentBusy && <p role="status">Checking recent imports…</p>}
      {workspace.recentError && <div role="status" className={styles.warning}><p>Could not check recent imports. Previously confirmed reports remain below.</p><button className={styles.action} type="button" onClick={() => void store.recent()}>Check recent imports</button></div>}
      {!workspace.recentBusy && !workspace.recentError && !workspace.recent.length && <p>No imports found.</p>}
      <ul className={styles.fileList}>{workspace.recent.map(batch => <li className={styles.recentRow} key={batch.id}>
        <Link className={styles.action} href={reportHref(batch.id)} prefetch={false} onClick={closeRecent}>{batch.id}</Link>
        <span className={styles.small}>{batch.counts.admitted} admitted · {batch.counts.pending} pending · {new Date(batch.createdAt).toLocaleString()}</span>
      </li>)}</ul>
      {workspace.recentCursor && <button className={styles.action} type="button" disabled={workspace.recentBusy} onClick={() => void store.recent(true)}>More imports</button>}
      {!["pending", "uncertain"].includes(workspace.admission) && <button type="button" className={styles.action} onClick={newImport}>New import</button>}
    </section> : <div className={styles.grid}>
      <div className={styles.main}>
        {!valid ? <div className={styles.warning} role="status"><h2>Invalid report link</h2><p>Choose a known batch from Recent imports. No import has been started.</p></div> : <>
          {admissionHere && workspace.message && <div className={uncertain ? styles.warning : styles.notice} role="status" aria-atomic="true">
            <h2 ref={resultHeading} tabIndex={-1}>{uncertain ? "Admission uncertain" : pending ? "Submitting files…" : "Not started"}</h2><p>{workspace.message}</p>
            {uncertain && workspace.snapshot.length > 0 && <details className={styles.attempt}><summary>Frozen selection</summary><p className={styles.small}>Frozen for this attempt. Unsent later files are not included in admitted totals.</p><ul>{workspace.snapshot.map(file => <li key={file.id}>{file.relativePath} · {byteLabel(file.file.size)}</li>)}</ul></details>}
          </div>}
          {batchId ? <>
            {(!report || report.state === "loading") && !report?.readError && <p role="status">Loading this import report…</p>}
            {report?.state === "unavailable" && <div className={styles.warning} role="status"><h2>Import report unavailable</h2><p>This batch could not be found. No replacement import has been started.</p></div>}
            {report?.readError && <div className={styles.warning} role="status"><p>Could not confirm the latest report. Last confirmed information, if any, remains below.</p><button className={styles.action} type="button" disabled={report.checking} onClick={() => void store.check(batchId)}>Check report</button></div>}
            {report?.batch && <>
              <header className={styles.batchSummary}>
                <div className={styles.actions}><h2 ref={!workspace.message ? resultHeading : undefined} tabIndex={-1}>{report.batch.counts.admitted} {report.batch.counts.admitted === 1 ? "file" : "files"} admitted{report.batch.counts.pending > 0 ? ` · ${report.batch.counts.pending} still working` : ""}</h2>{!report.readError && <button className={styles.action} type="button" disabled={report.checking || pending || !!report.busyFiles.length} onClick={() => void store.check(batchId)}>{report.checking ? "Checking…" : "Check report"}</button>}</div>
                <p className={styles.counts}>{report.batch.counts.imported} imported · {report.batch.counts.skippedIdentical + report.batch.counts.skippedChanged} skipped · {report.batch.counts.failed} failed{report.batch.counts.interrupted > 0 ? ` · ${report.batch.counts.interrupted} interrupted` : ""}</p>
                <p className={styles.batchId}>Batch {batchId} <Link className={styles.action} href={reportHref(batchId)} prefetch={false}>Report link</Link></p>
                {report.batch.sealedAt === null && !pending && <p className={styles.small}>This batch is still open. Only confirmed admissions are counted.</p>}
              </header>
              <ul className={`${styles.fileList} ${styles.results}`}>{report.files.map(file => {
                const copy = outcome(file), busy = report.busyFiles.includes(file.id), run = report.runs[file.id];
                const canStop = file.runId && activeFile(file) && (!run || !["completed", "failed", "interrupted"].includes(run.status));
                return <li className={styles.resultRow} key={file.id}>
                  <div className={styles.fileIdentity}><span className={styles.fileName}>{file.relativePath}</span><p className={styles.fileSize}>{byteLabel(file.byteLength)}</p></div>
                  <div className={styles.fileStatus}><p className={`${styles.outcome} ${copy.tone}`}>{copy.label}</p><p className={styles.detail}>{copy.detail}</p>{file.runId && activeFile(file) && <p className={styles.run}>Run {file.runId}</p>}</div>
                  <div className={styles.fileAction}>
                    {file.state === "imported" && file.segmentation?.method !== "structural" && file.documentId ? <button className={styles.action} type="button" onClick={() => inspect(file.documentId!)}>Inspect source</button>
                    : file.state === "skipped-identical" && file.documentId ? <button className={styles.action} type="button" onClick={() => inspect(file.documentId!)}>Inspect source</button>
                    : file.state === "uncertain" ? <div className={styles.fileActions} aria-busy={busy}>
                      <button className={styles.action} type="button" disabled={busy} onClick={() => void store.checkFile(batchId, file.id)}>Check file</button>
                      {canStop && <button className={styles.action} type="button" disabled={busy} onClick={() => stopFile(batchId, file.id)}>Stop file</button>}
                    </div>
                    : file.state === "running" && canStop ? <button className={styles.action} type="button" disabled={busy} onClick={() => stopFile(batchId, file.id)}>{busy ? "Stopping…" : "Stop file"}</button>
                    : <details className={styles.fileDetails}><summary>Details</summary><div className={styles.fileDetailBody}>
                      {file.segmentation?.method === "structural" && <p>Structural fallback grouped the original blocks because AI grouping could not be used. The import succeeded.</p>}
                      {file.error && <p>File outcome: {file.error.code}. A new import would be a separate request, not a retry or resume of this run.</p>}
                      {file.documentId && <button className={styles.action} type="button" onClick={() => inspect(file.documentId!)}>Inspect original</button>}
                      {canStop && <button className={styles.action} type="button" disabled={busy} onClick={() => stopFile(batchId, file.id)}>Stop file</button>}
                      <button className={styles.action} type="button" disabled={busy} onClick={() => void store.checkFile(batchId, file.id)}>Check file</button>
                    </div></details>}
                  </div>
                  {report.fileMessages[file.id] && <p className={styles.fileMessage} role="status" tabIndex={-1} ref={element => { if (element) fileMessages.current.set(file.id, element); else fileMessages.current.delete(file.id); }}>{report.fileMessages[file.id]}</p>}
                </li>;
              })}</ul>
              {report.cursor && <button className={styles.action} type="button" disabled={report.checking} onClick={() => void store.check(batchId, true)}>More files</button>}
              <p className={styles.reportFoot}>One failed file does not stop the others. Leaving does not stop this batch. Unsent files are not included in these totals.</p>
              {sample && <article className={styles.sample}>
                <p className={styles.small}>From {sample.source.originalPath}</p><p className={styles.small}>Imported source · Original authorship unverified</p>
                {sample.thought.text !== null && <ThoughtMarkdown className={styles.sampleText} text={sample.thought.text} />}
                <div className={styles.actions}><Link className={styles.action} href={`/ideas/${encodeURIComponent(sample.thought.id)}`} prefetch={false}>Open idea</Link><button className={styles.action} type="button" onClick={() => inspect(sample.source.id)}>Inspect original</button></div>
              </article>}
            </>}
          </> : !uncertain && <>
            <div className={styles.fileBar}><strong>{workspace.selected.length ? `${workspace.selected.length} Markdown ${workspace.selected.length === 1 ? "file" : "files"} ready` : "Choose Markdown files"}</strong><button ref={chooseButton} className={styles.control} type="button" onClick={() => fileInput.current?.click()} disabled={pending}>Choose files</button></div>
            <input ref={fileInput} className={styles.fileInput} type="file" multiple accept=".md,.markdown,text/markdown,text/plain" aria-label="Choose Markdown files" tabIndex={-1} onChange={event => { if (event.target.files) store.select(event.target.files); event.target.value = ""; }} />
            <ul className={styles.fileList}>{workspace.selected.map(file => <li className={styles.setupRow} key={file.id}><span className={styles.fileName}>{file.relativePath}</span><span className={styles.fileSize}>{byteLabel(file.file.size)}</span><button className={styles.action} type="button" aria-label={`Remove ${file.relativePath}`} disabled={pending} onClick={() => { store.remove(file.id); chooseButton.current?.focus(); }}>Remove</button></li>)}</ul>
            {!workspace.selected.length && <p className={styles.empty}>Select one or more Markdown files. There is no upload until you choose Import.</p>}
            {localIssues}
            <div className={styles.readyActions}><p>Files are sent only when you choose Import. Unsent selections are not saved across reload.</p><button className={`${styles.control} ${styles.gold}`} type="button" disabled={!workspace.selected.length || pending} onClick={() => void store.admit()}>{pending ? "Importing…" : workspace.selected.length ? `Import ${workspace.selected.length} ${workspace.selected.length === 1 ? "file" : "files"}` : "Import files"}</button></div>
          </>}
          {admissionHere && (batchId || uncertain) && localIssues}
        </>}
      </div>
      <details className={styles.explanation} open={!narrow || explanationOpen} onToggle={event => { if (narrow) setExplanationOpen(event.currentTarget.open); }}>
        <summary>How import works</summary><div className={styles.explanationBody}>
          <h2>Original words, unchanged</h2><p>AI groups the original words into thoughts. Structure is used automatically if AI grouping cannot be used.</p><p>Imported thoughts are labelled <strong>Imported source</strong>, not You or AI.</p>
          <h2>No overwrite</h2><p>Identical files are skipped. Changed files at known paths are reported and skipped; the existing import stays untouched.</p>
          <h2>{batchId ? "Keep working" : "No file-by-file approval"}</h2><p>{batchId ? "Leaving does not stop these files. Keep this report link to return later. Stop applies only to a file’s known run, not the whole batch." : "Import the selection once. Each file reports its own result."}</p>
          {batchId && <Link className={styles.action} href={reportHref(batchId)} prefetch={false}>Report link</Link>}
        </div>
      </details>
    </div>}
    {inspection && <ImportInspection key={inspection} id={inspection} onClose={closeInspection} onThought={(thought, source) => setSample({ thought, source })} />}
  </section>;
}
