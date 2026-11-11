"use client";

import type { ReinterpretationState } from "../features/idea/reinterpretation-controller";
import type { ReinterpretationRun } from "../features/idea/reinterpretation";
import styles from "./idea.module.css";

const terminal = (run: ReinterpretationRun) => ["completed", "failed", "interrupted"].includes(run.status);

/** A blocker is existing work, never a receipt for this user's request. */
export function reinterpretationRunToShow(state: ReinterpretationState): ReinterpretationRun | null {
  const blocker = state.eligibility?.eligible === false ? state.eligibility.blockingRun : null;
  return blocker && !terminal(blocker) ? blocker : state.run ?? blocker;
}

function presentation(state: ReinterpretationState, rejected: boolean, outputPublished: boolean) {
  if (state.request === "pending") return { title: "Requesting reinterpretation…", copy: "Waiting for confirmation. The same request identity is retained; no other request will be sent.", tone: "warning" };
  if (state.request === "uncertain") return { title: "Request not confirmed", copy: "No admission receipt is confirmed for this request. It may still start. No replacement request will be sent automatically.", tone: "warning" };
  if (rejected || state.eligibility?.reason === "subject-rejected") return { title: "Restore this idea first", copy: "Rejected content is unavailable to AI. Restore the idea before requesting a fresh interpretation. Checking an earlier request does not restart it.", tone: "muted" };
  if (state.phase === "storage-error") return { title: "Request recovery unavailable", copy: "The request identity could not be safely stored or recovered in this tab. No new request will be sent while recovery is unavailable.", tone: "warning" };
  if (state.stopping) return { title: "Requesting Stop…", copy: "Stop requests cancellation of the known run. Saved work remains; cancellation may still need to settle.", tone: "warning" };
  if (state.unconfirmedStop) return { title: "Stop not confirmed", copy: "Check the known work before deciding what to do next. Stop will not be sent again automatically.", tone: "warning" };
  if (state.eligibility?.reason === "work-unsettled") return { title: "Earlier work may still be running", copy: "Thoughtloom has not confirmed that the earlier agent work has stopped. Another interpretation is blocked to avoid overlapping work. Check interpretation refreshes status; it does not restart or stop the agent. Your idea and saved output remain.", tone: "warning" };
  if (state.eligibility?.reason === "work-unverified") return { title: "Earlier work needs verification", copy: "The earlier run is marked interrupted or failed, but its records do not confirm that the agent stopped. Background verification may unblock a fresh interpretation. Check interpretation only refreshes status. Your idea and saved output remain. If this stays blocked, the earlier run needs investigation.", tone: "warning" };
  const run = reinterpretationRunToShow(state);
  if (run) {
    const ownRequest = state.receipt?.requestKey === state.requestKey && state.receipt?.runId === run.id;
    const label = ownRequest ? "Reinterpretation" : "Interpretation";
    switch (run.status) {
      case "queued": return { title: `${label} · Queued`, copy: "Waiting for recorded output. Earlier thoughts and Full replies stay available.", tone: "normal" };
      case "submitting": return { title: `${label} · Submitting`, copy: "Waiting for processing to be confirmed. Earlier output is not replaced.", tone: "normal" };
      case "running": return { title: `${label} · Running`, copy: "New saved interpretations will appear in Surrounding context. You stay on this idea.", tone: "normal" };
      case "uncertain": return { title: `${label} · Status uncertain`, copy: "The run's outcome is uncertain, not a confirmed failure. Check this work instead of requesting another interpretation.", tone: "warning" };
      case "failed": return { title: `${label} · Failed`, copy: "Any saved thoughts and Full replies remain available. Earlier interpretations are not replaced. A fresh request needs a new eligibility check.", tone: "failed" };
      case "interrupted": return { title: `${label} · Interrupted`, copy: "Thoughtloom marked this run interrupted. The cause is not shown here, and this status does not confirm whether the agent stopped. Your idea and saved output remain. Check interpretation refreshes whether a new interpretation is allowed; it does not restart this run.", tone: "warning" };
      case "completed": return { title: run.confirmedThoughtIds.length ? `${label} completed` : "Completed without new interpretations", copy: run.confirmedThoughtIds.length
        ? outputPublished ? "Saved output is available in the context and Full reply controls. Earlier output remains alongside it." : "The run recorded output. Its availability in this view must be confirmed through the saved context."
        : "No new interpretation thoughts were recorded by this run. Read its Full reply when available for the outcome and any limitations.", tone: "success" };
    }
  }
  if (state.notice === "request-refused") return { title: "Reinterpretation was not started", copy: "This request was not admitted. Check the current state before requesting another interpretation.", tone: "warning" };
  if (state.phase === "error") return { title: "Could not check interpretation", copy: "Current eligibility is unconfirmed. This read failure does not mean processing failed.", tone: "warning" };
  return { title: state.checking ? "Checking interpretation…" : "Ready to reinterpret", copy: "Reinterpret requests a fresh interpretation without changing this thought or its earlier output. Additional instructions belong in Evolve.", tone: "muted" };
}

export function ReinterpretationStatus({ state, rejected, disabled, outputPublished, contextError, onCheck, onResend, onStop }: {
  state: ReinterpretationState; rejected: boolean; disabled: boolean; outputPublished: boolean; contextError: boolean;
  onCheck: () => Promise<void>; onResend: () => Promise<void>; onStop: () => Promise<void>;
}) {
  const item = presentation(state, rejected, outputPublished), run = reinterpretationRunToShow(state);
  const readingBusy = state.checking || state.stopping || state.request === "pending";
  const busy = disabled || readingBusy;
  const unknown = state.request === "uncertain";
  const ownRun = state.receipt?.requestKey === state.requestKey && state.receipt?.runId === run?.id;
  return <section id="idea-interpretation-status" className={styles.sourceStatus} data-tone={item.tone} aria-label="Interpretation status">
    <div className={styles.sourceStatusHeading}>
      <h2 aria-live="polite" aria-atomic="true">{item.title}</h2>
      {run && <p className={styles.metadata}>Run {run.id}</p>}
    </div>
    <p className={styles.sourceStatusCopy}>{item.copy}</p>
    {run && <p className={styles.metadata}>{ownRun ? "This request" : "Existing work"} · {run.status[0].toUpperCase() + run.status.slice(1)}{unknown && " · This does not confirm admission of your unconfirmed request."}</p>}
    {state.receipt && run && !ownRun && <p className={styles.metadata}>Your earlier request remains associated with run {state.receipt.runId}, not this existing work.</p>}
    {state.eligibility?.blockingRun && state.eligibility.blockingRun.id !== run?.id && <p className={styles.metadata}>Blocking work: run {state.eligibility.blockingRun.id} · {state.eligibility.blockingRun.status}. This is separate from your request's receipt.</p>}
    {state.phase === "storage-error" && state.request === "uncertain" && <p className={styles.metadata} role="status">The request identity could not be safely recovered or updated in this tab. Fresh work and resend are paused; no replacement key will be used.</p>}
    {state.notice === "read-error" && <p className={styles.metadata} role="status">Could not check interpretation. The last confirmed status and saved output are retained. This read failure does not mean the run failed.</p>}
    {state.checking && <p className={styles.metadata} role="status">Checking interpretation…</p>}
    <div className={styles.sourceStatusActions}>
      <button className={styles.textButton} type="button" disabled={readingBusy} onClick={() => void onCheck()}>{unknown ? "Check request" : "Check interpretation"}</button>
      {unknown && <button className={styles.textButton} type="button" disabled={busy || rejected || state.phase === "storage-error" || state.unconfirmedStop !== null} onClick={() => void onResend()}>Send same request</button>}
      {run && !terminal(run) && !state.unconfirmedStop && <button className={styles.textButton} type="button" disabled={busy} onClick={() => void onStop()}>Stop</button>}
    </div>
    {unknown && <p className={styles.metadata}>Check only reads this request's receipt. Sending the same request is an explicit write with the original key; it may start work if the earlier request never arrived. No new key will be used to recover it.</p>}
    {state.notice === "stop-requested" && <p className={styles.metadata}>Stop was acknowledged. Native cancellation may still be settling. Check interpretation before requesting fresh work.</p>}
    {contextError && <p className={styles.metadata} role="status">Could not refresh the saved context. Earlier thoughts and Full replies remain available. Check interpretation to read the context again; checking starts no work.</p>}
    {(state.receipt || unknown) && state.phase !== "storage-error" && <p className={styles.sourceLifetime}>Request identity is retained in this tab's session for reload recovery. Reload checks it without submitting again.</p>}
  </section>;
}
