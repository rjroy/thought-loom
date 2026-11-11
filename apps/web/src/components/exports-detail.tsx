"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ExportDetail } from "../features/export/controller";
import type { ExportHistoryItem } from "../features/export/types";
import { exportDate } from "../features/export/location";
import { downloadMarkdown } from "../features/export/download";
import { useExportStore } from "./export-provider";
import { useContextualBack } from "./contextual-back";
import { ExportMarkdown } from "./export-markdown";
import styles from "./exports.module.css";

export function ExportDetailView({ id }: { id: string }) {
  useContextualBack("/exports", "Back to Exports");
  const controller = useExportStore().history, router = useRouter();
  const detail = useSyncExternalStore(controller.subscribe, () => controller.get(id), () => undefined);
  const [deleting, setDeleting] = useState(false);
  useEffect(() => controller.watch(id), [controller, id]);
  useEffect(() => { if (detail?.deletion === "deleted") router.replace("/exports"); }, [detail?.deletion, router]);
  const item = detail?.item;
  const canDelete = detail?.verified && !detail.checking && !detail.stopping && !detail.missing && item?.deletionState === "ready" && ["idle", "conflict"].includes(detail.deletion);
  return <section className={styles.view} aria-labelledby="export-heading">
    <div className={styles.pageHeading}><h1 id="export-heading">Export</h1><div className={styles.actions}><Link className={styles.textButton} href="/exports/new" prefetch={false}>New export</Link>{canDelete && <button className={`${styles.textButton} ${styles.dangerText}`} onClick={() => setDeleting(true)}>Delete</button>}</div></div>
    {!item ? <div className={styles.empty} role="status"><p>{detail?.missing ? "Export unavailable. It may have been deleted." : detail?.error ? "Could not read this export. Nothing new was started." : "Reading export…"}</p>{(detail?.error || detail?.missing) && <button className={styles.button} disabled={detail.checking} onClick={() => void controller.check(id)}>Check status</button>}</div> : <>
      <div className={styles.detail}>
        <aside className={styles.request}><h2>Request</h2><p className={styles.requestText}>{item.request}</p><dl><div><dt>Effort</dt><dd>{item.effort[0].toUpperCase() + item.effort.slice(1)}</dd></div><div><dt>Created</dt><dd><time dateTime={item.createdAt}>{exportDate(item.createdAt)}</time></dd></div></dl></aside>
        <div className={styles.reportArea}>
          {(detail.error || detail.stopUnconfirmed || detail.missing) && <div className={styles.warning} role="status"><p>{detail.stopUnconfirmed ? "Stop unconfirmed. Check this same export before drawing a conclusion." : detail.missing ? "This export is unavailable. Its report cannot be read here." : "Could not check this export. The last confirmed request and any previously read report are retained; current progress is unconfirmed."}</p>{detail.report && <button className={styles.textButton} disabled={detail.checking} onClick={() => void controller.check(id)}>Check status</button>}</div>}
          {detail.deletion === "uncertain" && <div className={styles.warning} role="status"><h2>Deletion unconfirmed</h2><p>The known export is retained here until its outcome can be checked. No new export was created.</p><button className={styles.button} disabled={detail.checking} onClick={() => void controller.checkDeletion(id)}>Check deletion</button></div>}
          {!detail.report && <ExportStatus detail={detail} />}
          {detail.report && <>
            {detail.reportState !== "ready" && <p className={styles.warning} role="status">Could not obtain the latest report. This is the previously confirmed report.</p>}
            <div className={styles.reportToolbar}><h2>Report ready</h2><button className={`${styles.button} ${styles.primary}`} onClick={() => downloadMarkdown(detail.report!, "thoughtloom-report.md")}>Download Markdown</button></div>
            <div className={styles.markdown}><ExportMarkdown markdown={detail.report.text} /></div>
            {detail.sources.length > 0 && <footer className={styles.sources}><h3>Source thoughts</h3><p className={styles.metadata}>Recorded identities and attribution, not endorsement. Links are available only for thoughts accessible in normal view.</p><ul>{detail.sources.map(source => <li key={source.id}>{source.thought ? <Link href={`/ideas/${encodeURIComponent(source.id)}`} prefetch={false}>{source.thought.title || (source.thought.kind === "media-original" ? source.thought.mediaSource.name : source.thought.text?.split(/\s+/).slice(0, 5).join(" ")) || "Untitled thought"}</Link> : <span>Source unavailable in this view</span>}</li>)}</ul></footer>}
          </>}
        </div>
      </div><p className={styles.policy}>This export is separate from your library ideas. Opening it does not start another investigation.</p>
      {deleting && <DeleteExportDialog item={item} onClose={() => setDeleting(false)} onDeleted={() => router.replace("/exports")} />}
    </>}
  </section>;
}

function ExportStatus({ detail }: { detail: ExportDetail }) {
  const controller = useExportStore().history, item = detail.item!;
  const [discardOpen, setDiscardOpen] = useState(false), [acknowledged, setAcknowledged] = useState(false);
  const canStop = detail.verified && !detail.checking && !detail.stopping && !detail.stopUnconfirmed && ["idle", "conflict"].includes(detail.deletion) && item.deletionState === "stop-required";
  if (item.restored) {
    const ready = item.deletionState === "ready";
    return <section className={styles.statusPanel} aria-label="Restored export status">
      <h2 className={ready ? "" : styles.running}>{ready ? "Local discard confirmed" : discardOpen ? "Allow deletion of this local snapshot?" : "Restored snapshot"}</h2>
      <p>This export was restored from backup. It is inactive here. Thoughtloom will never reconnect it to the old agent.</p><p>Old remote work may still be running. Its status is unknown.</p>
      {ready ? <><p>Only this restored local record is now eligible for deletion. No remote Stop was sent, and remote cancellation is not confirmed.</p><p className={styles.help}>Use Delete to remove its local report, history and export-specific execution records.</p></> : discardOpen ? <>
        <p>This acknowledgment only allows local deletion. It does not stop old remote work or confirm that it has ended.</p>
        <label className={styles.acknowledgment}><input type="checkbox" checked={acknowledged} disabled={detail.stopping} onChange={event => setAcknowledged(event.target.checked)} />I understand this does not stop old remote work.</label>
        <div className={styles.actions}><button className={styles.button} disabled={detail.stopping} onClick={() => { setDiscardOpen(false); setAcknowledged(false); }}>Cancel</button><button className={styles.button} disabled={!acknowledged || !canStop} onClick={() => void controller.stop(item.id)}>{detail.stopping ? "Confirming local discard…" : "Confirm local discard"}</button></div>
      </> : <><div className={styles.actions}><button className={styles.button} disabled={!canStop} onClick={() => setDiscardOpen(true)}>Stop</button></div><p className={styles.help}>For this restored snapshot, Stop leads to a local-discard acknowledgment before Delete. It does not stop the old agent.</p></>}
      {(detail.error || detail.stopUnconfirmed || detail.checking || item.deletionState === "settling") && <div className={styles.actions}><button className={styles.button} disabled={detail.checking || detail.stopping} onClick={() => void controller.check(item.id)}>Check status</button></div>}
    </section>;
  }
  const settling = item.deletionState === "settling" || (detail.stopRequested && !detail.verified);
  const title = detail.stopping ? "Requesting stop…" : settling ? "Stop requested" : item.status === "completed" ? "Completed · report not yet readable" : item.status === "uncertain" ? "Progress uncertain" : item.status[0].toUpperCase() + item.status.slice(1);
  const copy = settling ? "This export won’t publish a new report. Waiting for confirmation that the agent has stopped."
    : item.status === "completed" ? "Completion is confirmed, but the Markdown report has not been obtained yet."
      : item.status === "queued" ? "Your request is accepted and queued."
        : item.status === "submitting" ? "The accepted request is being submitted to the agent."
          : item.status === "running" ? "The investigation is running. No completed report is available yet."
            : item.status === "uncertain" ? "The current outcome is not confirmed. Check this export rather than submitting the request again."
              : "This export ended without a completed report.";
  return <section className={styles.statusPanel} aria-label="Export status"><div role="status"><h2 className={settling || !["completed", "interrupted", "failed"].includes(item.status) ? styles.running : ""}>{title}</h2><p>{copy}</p>{["error", "unavailable", "not-ready"].includes(detail.reportState) && <p>Could not read a completed report yet. Check this export to try reading it again.</p>}</div>
    <div className={styles.actions}><button className={styles.button} disabled={detail.checking || detail.stopping} onClick={() => void controller.check(item.id)}>{detail.checking ? "Checking…" : "Check status"}</button>{item.deletionState === "stop-required" && <button className={styles.button} disabled={!canStop} onClick={() => void controller.stop(item.id)}>{detail.stopping ? "Requesting stop…" : "Stop"}</button>}{settling && <button className={styles.button} disabled>Stop requested</button>}</div>
    <p className={styles.help}>{settling ? "You can leave and return later. Delete will be available after stopping is confirmed." : item.deletionState === "stop-required" ? "Stop requests cancellation. The agent may not stop immediately. Delete stays unavailable until stopping is confirmed." : "To make another report, start a new export. This request stays unchanged."}</p>
  </section>;
}

export function DeleteExportDialog({ item, onClose, onDeleted }: { item: ExportHistoryItem; onClose: () => void; onDeleted: () => void }) {
  const controller = useExportStore().history, dialog = useRef<HTMLDialogElement>(null);
  const detail = useSyncExternalStore(controller.subscribe, () => controller.get(item.id), () => undefined);
  const trigger = useRef<HTMLElement | null>(null);
  const deletedCallback = useRef(onDeleted); deletedCallback.current = onDeleted;
  useEffect(() => {
    trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const unwatch = controller.watch(item.id);
    dialog.current?.showModal();
    return () => { unwatch(); if (trigger.current?.isConnected) trigger.current.focus(); };
  }, [controller, item.id]);
  useEffect(() => { if (detail?.deletion === "deleted") deletedCallback.current(); }, [detail?.deletion]);
  const pending = detail?.deletion === "pending", uncertain = detail?.deletion === "uncertain";
  const ready = detail?.verified && !detail.checking && detail.item?.deletionState === "ready" && ["idle", "conflict"].includes(detail.deletion);
  return <dialog ref={dialog} className={styles.dialog} aria-labelledby="delete-export-heading" onCancel={event => { event.preventDefault(); if (controller.get(item.id)?.deletion !== "pending") onClose(); }}>
    <h2 id="delete-export-heading">Delete this export?</h2><p className={styles.identity}>{item.request}</p>
    <p>Delete this export’s {item.restored ? "local " : ""}report, history entry and internal execution records? Library ideas and downloaded files stay.</p>
    <p className={styles.metadata}>{item.restored ? "Old remote work may still be running. This does not stop it or erase copies held by OpenCode or providers." : "This does not erase copies held by OpenCode or providers."}</p>
    {detail?.checking && <p role="status">Checking this same export…</p>}
    {pending && <p role="status">Deleting this export…</p>}
    {(detail?.deletion === "conflict" || detail?.error || detail?.missing) && <p className={styles.warning} role="status">Could not delete this export. Its eligibility may have changed. Check this same export before trying again.</p>}
    {uncertain && <p className={styles.warning} role="status">Deletion unconfirmed. Check this same export before drawing a conclusion.</p>}
    <div className={styles.actions}><button className={styles.button} autoFocus disabled={pending} onClick={() => { if (controller.get(item.id)?.deletion !== "pending") onClose(); }}>Cancel</button>{uncertain ? <button className={styles.button} disabled={detail.checking} onClick={() => void controller.checkDeletion(item.id)}>Check deletion</button> : <button className={`${styles.button} ${styles.dangerFill}`} disabled={!ready || pending} onClick={() => void controller.remove(item.id)}>Delete export</button>}</div>
    {!pending && !uncertain && !ready && !detail?.checking && <button className={styles.textButton} onClick={() => void controller.check(item.id)}>Check status</button>}
  </dialog>;
}
