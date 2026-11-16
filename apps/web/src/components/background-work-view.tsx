"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createBackgroundController } from "../features/background-work/controller";
import { createBackgroundClient } from "../features/background-work/request";
import { sameTarget, type WorkItem, type WorkView } from "../features/background-work/types";
import { useContextualBack } from "./contextual-back";
import styles from "./background-work.module.css";

const views: readonly { value: WorkView; label: string }[] = [
  { value: "needs-attention", label: "Needs attention" },
  { value: "in-progress", label: "In progress" },
  { value: "locally-closed", label: "Locally closed" },
];
const kinds = { weave: "Weaver", evolve: "Evolve", search: "Search", export: "Export", import: "Import" };
const statuses: Record<WorkItem["status"], string> = {
  queued: "Queued", submitting: "Submitting", running: "Running", uncertain: "Outcome uncertain",
  completed: "Completed", interrupted: "Interrupted", failed: "Failed", waiting: "Waiting",
  imported: "Imported", "skipped-identical": "Skipped identical file", "skipped-changed": "Skipped changed file",
  pending: "Pending", settled: "Settled", "ownership-conflict": "Ownership conflict",
};

function titleOf(item: WorkItem): string {
  if (item.owner.title?.trim()) return item.owner.title;
  return { thought: "Thought title unavailable", "search-session": "Search title unavailable",
    import: "Markdown import", export: "Export", unknown: "Background work" }[item.owner.type];
}
function ownerLink(item: WorkItem): { href: string; label: string } | null {
  const id = item.owner.id;
  if (!id) return null;
  const encoded = encodeURIComponent(id);
  switch (item.owner.type) {
    case "thought": return { href: `/ideas/${encoded}?${new URLSearchParams({scope:"normal",returnTo:"/settings/background-work"})}`, label: "Open idea" };
    case "search-session": return { href: `/explore/ask/${encoded}`, label: "Open search" };
    case "import": return { href: `/import?${new URLSearchParams({batchId:id})}`, label: "Open import report" };
    case "export": return { href: `/exports/${encoded}`, label: "Open export" };
    default: return null;
  }
}
function createdLabel(value: string | null): string {
  if (value === null || !Number.isFinite(Date.parse(value))) return "Creation time unavailable";
  return `Created ${new Intl.DateTimeFormat("en", {
    day:"numeric",month:"short",year:"numeric",hour:"2-digit",minute:"2-digit",hourCycle:"h23",timeZone:"UTC",
  }).format(new Date(value))} UTC`;
}
function explanation(item: WorkItem, closed: boolean): { title: string; copy: string } {
  if (closed) return { title: "Local tracking stopped", copy: "Local retries and late publication for this work are stopped. This does not confirm that the remote agent stopped." };
  switch (item.reason) {
    case "cancellation-pending": return { title: "Remote stop not confirmed", copy: "Thoughtloom has not confirmed that the earlier agent work stopped. Refresh list reads the saved state; it does not send another Stop." };
    case "uncertain": return { title: "The request’s outcome is not confirmed", copy: "Thoughtloom has not confirmed how this work finished. A missing response is not proof that it failed. Check this work instead of submitting a replacement." };
    case "failed": return { title: "This work failed", copy: "A more specific failure reason is not available here. Saved thoughts and confirmed output remain." };
    case "interrupted": return { title: "This work was interrupted", copy: "The interruption cause is not available here. This status alone does not confirm whether the remote agent stopped." };
    case "ownership-conflict": return { title: "Remote work could not be safely identified", copy: "Thoughtloom cannot safely treat the remote work as its own. Do not assume it stopped. Share this run ID with the operator if you need help." };
    case "waiting": return { title: "This work is waiting", copy: "The saved state does not provide a more specific waiting reason. Waiting does not mean the work failed." };
    case "unverified": return { title: "Earlier work needs verification", copy: "The saved records do not establish that earlier agent work stopped. Refresh list reads the saved state without restarting the work." };
    default: return { title: "Reason unavailable", copy: "The saved state does not provide a reason. Queued or running work is not necessarily stuck." };
  }
}

export function BackgroundWorkView() {
  const [controller] = useState(() => createBackgroundController(createBackgroundClient()));
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [ready, setReady] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  // Presentation only: keep the reviewed subject visible while the controller records its request.
  const [displayedSubject, setDisplayedSubject] = useState<WorkItem | null>(null);
  const dialog = useRef<HTMLDialogElement>(null), cancel = useRef<HTMLButtonElement>(null);
  const stopTrigger = useRef<HTMLButtonElement | null>(null);
  const notice = useRef<HTMLDivElement>(null), receiptHeading = useRef<HTMLHeadingElement>(null);
  const focusedReceipt = useRef<string | null>(null);
  useContextualBack("/settings#background-work", "Back to Settings");
  useEffect(() => {
    let active = true;
    void controller.prepare().then(() => { if (active) setReady(true); });
    return () => { active = false; };
  }, [controller]);

  useEffect(() => {
    if (state.confirmation) {
      setDisplayedSubject(state.confirmation);
      if (dialog.current && !dialog.current.open) {
        setAcknowledged(false);
        dialog.current.showModal();
        cancel.current?.focus();
      }
    } else if (!state.stopping && dialog.current?.open) {
      dialog.current.close();
      if (state.notice === "none") stopTrigger.current?.focus();
      else if (state.notice !== "stopped") notice.current?.focus();
    }
    if (!state.stopping && !state.confirmation && state.receipt && focusedReceipt.current !== state.receipt.requestKey) {
      focusedReceipt.current = state.receipt.requestKey;
      receiptHeading.current?.focus();
    }
  }, [state.confirmation, state.stopping, state.notice, state.receipt]);

  const subject = state.confirmation ?? displayedSubject;
  const busy = state.preparing || state.stopping || state.confirmation !== null;
  const paused = busy || state.loading || !ready;
  const viewLocked = state.pending.some(pending => state.items.some(item => sameTarget(item.target,pending.target)));
  const storageFailed = state.notice === "storage-error";
  const receipt = state.receipt;
  const noticeCopy = {
    none: "",
    "read-error": "Could not verify this work. No new local stop was sent. Refresh the list before deciding what to do next.",
    changed: "This work changed or is no longer eligible. Nothing else was stopped. Refresh the list and review it again.",
    "storage-error": "Request recovery could not be stored or read safely. New local stops are paused. Keep this page open and keep a copy of any displayed run or file IDs.",
    unconfirmed: "Local stop not confirmed. Keep the original request identity and check its receipt. No command will be sent again automatically.",
    stopped: "",
  }[state.notice];

  return <section className={styles.workspace} aria-labelledby="background-heading">
    <div className={styles.pageHeading}>
      <div><h1 id="background-heading">Background work</h1><p className={styles.intro}>Find unfinished AI work across your library.<br />Your saved thoughts and confirmed output stay available.</p></div>
      <button type="button" className={styles.button} disabled={paused} onClick={() => void controller.refresh()}>Refresh list</button>
    </div>
    <div className={styles.views} role="group" aria-label="Background work views">
      {views.map(view => <button key={view.value} type="button" aria-pressed={state.view === view.value}
        disabled={paused || viewLocked} onClick={() => void controller.selectView(view.value)}>
        {view.label}{view.value === "needs-attention" && state.counts !== null ? ` (${state.counts[view.value]}${state.summaryError ? ", last confirmed" : ""})` : ""}
      </button>)}
    </div>
    <p className={styles.metadata}>Oldest created first · Unknown creation times last</p>
    {state.summaryError && <p className={styles.warning} role="status">Counts unavailable. This does not mean there is no background work.</p>}
    <div ref={notice} tabIndex={-1} className={styles.notice} role="status">
      {noticeCopy && <p>{noticeCopy}</p>}
      {state.preparing && <p>Checking whether this work can be stopped locally…</p>}
    </div>
    {state.pending.length > 0 && <section className={styles.recovery} aria-label="Local stop request recovery">
      <h2>Local stop requests to check</h2>
      <p>A local stop may already have been recorded. Check local stop reads the same request; it does not send another command. A missing receipt does not prove the command cannot still arrive.</p>
      {viewLocked && <p className={styles.metadata}>This list view stays in place while a displayed row has an unresolved local stop request.</p>}
      <ul className={styles.pendingList}>{state.pending.map(pending => <li key={`${pending.target.type}:${pending.target.id}`}>
        <p className={styles.metadata}>{pending.target.type === "run" ? "Run" : "Import file"} {pending.target.id}</p>
        <button className={styles.button} type="button" disabled={busy} onClick={() => void controller.checkStop(pending)}>Check local stop</button>
      </li>)}</ul>
    </section>}
    {receipt && <section className={styles.receipt} aria-label="Local stop receipt">
      <h2 ref={receiptHeading} tabIndex={-1}>Local tracking stopped</h2>
      <p>No more local retries will run for this work. Its late results cannot publish in Thoughtloom. Saved thoughts and confirmed output stay unchanged.</p>
      <p>The remote agent may still be running. Its tools may still change external files or services and overlap later work.</p>
      <p className={styles.metadata}>{receipt.target.type === "run" ? "Run" : "Import file"} {receipt.target.id}</p>
      <p className={styles.metadata}>Other work may still prevent new requests. Previously queued work may now proceed. No new work was requested.</p>
      <p className={styles.metadata}>Refresh list to update counts and views.</p>
    </section>}
    <section aria-label={views.find(view => view.value === state.view)?.label} aria-busy={state.loading} className={styles.listSection}>
      {(!ready || state.loading) && <p className={styles.readStatus} role="status">{state.items.length ? "Refreshing saved status…" : "Loading background work…"}</p>}
      {state.listError && <div className={styles.readError} role="status">
        <p>{state.items.length ? "Could not refresh; showing last confirmed information." : "Could not load background work."}</p>
        <button className={styles.button} type="button" disabled={paused} onClick={() => void controller.refresh()}>Try loading again</button>
      </div>}
      {ready && !state.loading && !state.listError && state.items.length === 0 && <div className={styles.empty}>
        <h2>{state.view === "needs-attention" ? "Nothing needs your attention" : state.view === "in-progress" ? "No work in progress" : "No locally closed work"}</h2>
        <p>{state.view === "needs-attention" ? "Other work may still be in progress. This does not confirm that all remote work has stopped." : "This view contains no matching work."}</p>
      </div>}
      <ul className={styles.items}>{state.items.map(item => {
        const link = ownerLink(item);
        const closed = state.view === "locally-closed" || !!(receipt && sameTarget(receipt.target,item.target)) || item.localStop?.reason === "already-stopped";
        const pending = state.pending.some(entry => sameTarget(entry.target,item.target));
        const explanationOfWork = explanation(item, closed);
        return <li className={styles.item} key={`${item.target.type}:${item.target.id}`}>
          <div className={styles.itemHeading}>
            <h2>{link ? <Link className={styles.titleLink} href={link.href} prefetch={false}>{titleOf(item)}</Link> : titleOf(item)}</h2>
            <p className={styles.metadata}>{kinds[item.kind]} · {statuses[item.status]}</p>
          </div>
          <p className={styles.state} data-closed={closed}>{explanationOfWork.title}</p>
          <p className={styles.itemCopy}>{explanationOfWork.copy}</p>
          <p className={styles.metadata}>{createdLabel(item.createdAt)}</p>
          <div className={styles.actions}>
            {!closed && item.actions.stopLocalTracking && <button className={`${styles.button} ${styles.danger}`} type="button"
              disabled={paused || pending || storageFailed || state.listError} onClick={event => {
                stopTrigger.current = event.currentTarget;
                void controller.prepareStop(item);
              }}>Stop local tracking…</button>}
            {link && <Link className={styles.textAction} href={link.href} prefetch={false}>{link.label}</Link>}
          </div>
          {pending && <p className={styles.warning}>Local stop not confirmed. Use Check local stop above; do not send another command.</p>}
          <details className={styles.details}><summary>{item.target.type === "run" ? "Run details" : "File details"}</summary>
            <dl className={styles.facts}><dt>{item.target.type === "run" ? "Run ID" : "Import file ID"}</dt><dd>{item.target.id}</dd>
              <dt>Remote status</dt><dd>Not established by this view</dd>
              {!link && <><dt>Owner</dt><dd>No owning page is available</dd></>}
            </dl>
          </details>
        </li>;
      })}</ul>
      {state.nextCursor && !state.listError && <div className={styles.more}><button className={styles.button} type="button" disabled={paused} onClick={() => void controller.more()}>Load more</button></div>}
    </section>
    <dialog ref={dialog} className={styles.dialog} aria-labelledby="local-stop-title" aria-describedby="local-stop-warning"
      onCancel={event => { event.preventDefault(); if (!state.stopping) controller.cancelStop(); }}>
      <h2 id="local-stop-title">Stop local tracking?</h2>
      {subject && <p><strong>{titleOf(subject)}</strong><br /><span className={styles.metadata}>{kinds[subject.kind]} · {subject.target.type === "run" ? "Run" : "Import file"} {subject.target.id}</span></p>}
      <p>End this work’s local retries and permanently block its late results in Thoughtloom.</p>
      <p>Saved thoughts and replies stay unchanged. No new work is started.</p>
      <p id="local-stop-warning" className={styles.consequence}>The remote agent may still be running. Its tools can still change files or services and overlap later work. This cannot undo those changes.</p>
      <p className={styles.metadata}>Already queued work may proceed. Other blockers still apply. Local tracking stays stopped after restart.</p>
      <label className={styles.ack}><input type="checkbox" checked={acknowledged} disabled={state.stopping} onChange={event => setAcknowledged(event.target.checked)} />
        <span>I understand that remote work and external effects may continue.</span></label>
      {(state.notice === "read-error" || storageFailed) && <p className={styles.warning} role="status">{noticeCopy}</p>}
      <div className={styles.dialogActions}>
        <button ref={cancel} className={styles.button} type="button" disabled={state.stopping} onClick={() => controller.cancelStop()}>Cancel</button>
        <button className={`${styles.button} ${styles.danger}`} type="button"
          disabled={!acknowledged || state.stopping || !state.confirmation || state.notice === "read-error" || storageFailed}
          onClick={() => { if (acknowledged) void controller.confirmStop(); }}>{state.stopping ? "Stopping local tracking…" : "Stop local tracking"}</button>
      </div>
    </dialog>
  </section>;
}
