"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { admitExport } from "../features/export/request";
import { exportDate, exportHref } from "../features/export/location";
import { terminalExportStatus, type AgenticExportInput, type ExportHistoryItem } from "../features/export/types";
import { useExportStore } from "./export-provider";
import { useContextualBack } from "./contextual-back";
import { useExploreMemory } from "./explore-provider";
import { DeleteExportDialog } from "./exports-detail";
import styles from "./exports.module.css";

const activeExport = (item: ExportHistoryItem) => !item.restored && (item.deletionState !== "ready" || !terminalExportStatus(item.status));
function label(item: ExportHistoryItem) {
  if (item.restored) return item.deletionState === "ready" ? "Local discard confirmed" : "Restored snapshot";
  if (item.deletionState === "settling") return "Stop requested";
  return item.status === "uncertain" ? "Progress uncertain" : item.status[0].toUpperCase() + item.status.slice(1);
}

export function ExportsView() {
  const controller = useExportStore().history, memory = useExploreMemory();
  useContextualBack(memory.current?.url ?? "/explore", "Back to Explore");
  const catalog = useSyncExternalStore(controller.subscribe, controller.getCatalog, () => null);
  const [deleting, setDeleting] = useState<ExportHistoryItem | null>(null);
  useEffect(() => controller.watchCatalog(), [controller]);
  const active = catalog?.items.filter(activeExport) ?? [], history = catalog?.items.filter(item => !activeExport(item)) ?? [];
  return <section className={styles.view} aria-labelledby="exports-heading">
    <div className={styles.pageHeading}><h1 id="exports-heading">Exports</h1><Link className={`${styles.button} ${styles.primary}`} href="/exports/new" prefetch={false}>New export</Link></div>
    <p className={styles.intro}>Create a report from your existing thinking, or return to an earlier export. Exports stay until you delete them.</p>
    <div className={styles.catalog}>
      {(!catalog || (!catalog.loaded && catalog.pending)) && <p role="status">Reading exports…</p>}
      {catalog?.error && <div className={styles.warning} role="status"><h2>Could not read your exports</h2><p>{catalog.restart ? "This continuation is no longer available. Refresh the list to continue." : "Confirmed entries are retained. No new export was started."}</p><button className={styles.textButton} disabled={catalog.pending} onClick={() => void controller.loadCatalog()}>Check exports</button></div>}
      {catalog?.loaded && !catalog.items.length && <section className={styles.empty}><h2>No exports yet</h2><p>Start with a question or request. The agent gathers eligible thinking into a Markdown report without changing your library.</p></section>}
      {active.length > 0 && <section className={styles.group}><h2>Active exports</h2><ul className={styles.rows}>{active.map(item => <ExportRow key={item.id} item={item} onDelete={setDeleting} />)}</ul><p className={styles.policy}>Stop an active export before deleting it. Deletion stays unavailable while cancellation is unsettled.</p></section>}
      {history.length > 0 && <section className={styles.group}><h2>History</h2><ul className={styles.rows}>{history.map(item => <ExportRow key={item.id} item={item} onDelete={setDeleting} />)}</ul></section>}
      {catalog?.nextCursor && <button className={styles.textButton} disabled={catalog.pending || catalog.restart} onClick={() => void controller.loadCatalog(true)}>{catalog.pending ? "Reading more exports…" : "More exports"}</button>}
      {catalog?.items.length ? <p className={styles.policy}>Opening an export does not run it again. Reports are read-only and download as Markdown.</p> : null}
    </div>
    {deleting && <DeleteExportDialog item={deleting} onClose={() => setDeleting(null)} onDeleted={() => { setDeleting(null); void controller.loadCatalog(); }} />}
  </section>;
}

function ExportRow({ item, onDelete }: { item: ExportHistoryItem; onDelete: (item: ExportHistoryItem) => void }) {
  const controller = useExportStore().history;
  const detail = useSyncExternalStore(controller.subscribe, () => controller.get(item.id), () => undefined);
  const active = activeExport(item);
  useEffect(() => { if (active) return controller.watch(item.id); }, [active, controller, item.id]);
  const warning = detail?.error || detail?.stopUnconfirmed;
  return <li className={styles.row}>
    <div><Link className={styles.rowTitle} href={exportHref(item.id)} prefetch={false}>{item.request}</Link><p className={styles.metadata}><span className={active ? styles.running : item.status === "failed" ? styles.dangerText : ""}>{label(item)}</span> · {item.effort[0].toUpperCase() + item.effort.slice(1)}<br />Created <time dateTime={item.createdAt}>{exportDate(item.createdAt)}</time></p>
      {warning && <p className={styles.metadata}>Current progress is unconfirmed. Open this export to check its status.</p>}</div>
    <div className={styles.actions}><Link className={styles.button} href={exportHref(item.id)} prefetch={false}>{item.status === "completed" ? "Open report" : "View export"}</Link>
      {active && item.deletionState === "stop-required" && <button className={styles.textButton} disabled={!detail?.verified || detail.stopping || detail.stopUnconfirmed} onClick={() => void controller.stop(item.id)}>{detail?.stopping ? "Requesting stop…" : "Stop"}</button>}
      {active && item.deletionState === "settling" && <button className={styles.button} disabled>Stop requested</button>}
      {!active && item.deletionState === "ready" && <button className={`${styles.textButton} ${styles.dangerText}`} onClick={() => onDelete(item)}>Delete</button>}</div>
  </li>;
}

export function NewExportView() {
  useContextualBack("/exports", "Back to Exports");
  const router = useRouter();
  const controller = useExportStore().history;
  const [request, setRequest] = useState(""), [effort, setEffort] = useState<AgenticExportInput["effort"]>("standard");
  const [state, setState] = useState<"editing" | "pending" | "unconfirmed" | "not-started">("editing");
  const pending = useRef(false), mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current || state === "unconfirmed" || !request.trim()) return;
    pending.current = true; setState("pending");
    controller.invalidateCatalog();
    const result = await admitExport({ request, effort }, { fetch: window.fetch.bind(window) });
    // An unknown outcome may have created an export too, even after leaving this form.
    controller.invalidateCatalog();
    if (!mounted.current) return;
    if (result.kind === "admitted") router.push(exportHref(result.run.id));
    else { pending.current = false; setState(result.kind === "uncertain" ? "unconfirmed" : "not-started"); }
  }
  const locked = state === "pending" || state === "unconfirmed";
  return <section className={styles.view} aria-labelledby="new-export-heading"><h1 id="new-export-heading">New export</h1><p className={styles.intro}>Ask for a read-only report from your existing thinking.</p>
    <form className={styles.form} noValidate onSubmit={event => void submit(event)}>
      <div className={styles.field}><label htmlFor="export-request">Request</label><textarea id="export-request" className={styles.control} value={request} readOnly={locked} onChange={event => setRequest(event.target.value)} /></div>
      <div className={`${styles.field} ${styles.effort}`}><label htmlFor="export-effort">Effort</label><select id="export-effort" className={styles.control} value={effort} disabled={locked} onChange={event => { const value = event.target.value; if (value === "quick" || value === "standard" || value === "thorough") setEffort(value); }}><option value="quick">Quick</option><option value="standard">Standard</option><option value="thorough">Thorough</option></select></div>
      <p className={styles.help}>Uses eligible thinking across your library, not just one idea’s branch. Does not create or change ideas or connections.</p><p className={styles.help}>Can read recorded source details and interpretations, not original image or PDF files.</p>
      {state === "pending" && <p role="status">Starting report… Waiting for confirmation. Your request is held unchanged.</p>}
      {state === "not-started" && <div className={styles.warning} role="status"><strong>Report was not started.</strong><p>The service could not start this request. Your inputs are retained.</p></div>}
      {state === "unconfirmed" && <div className={styles.warning} role="status"><h2>Request unconfirmed</h2><p>This request may have started, but no export was confirmed. It will not be submitted again automatically. There is no known export to check or stop.</p><Link href="/exports" prefetch={false}>Check Exports before starting another request</Link></div>}
      <div className={styles.formActions}><Link className={styles.textButton} href="/exports" prefetch={false}>Cancel</Link><button className={`${styles.button} ${styles.primary}`} disabled={locked || !request.trim()}>{state === "pending" ? "Starting report…" : "Create report"}</button></div>
    </form><p className={styles.policy}>After the request is accepted, you can return to it from Exports. Leaving the page does not stop the export.</p>
  </section>;
}
