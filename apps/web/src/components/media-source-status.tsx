"use client";

import Link from "next/link";
import { mediaSourceControls, type MediaSourceController } from "../features/media/source-controller";
import type { MediaScope, MediaSourceWorkspace } from "../features/media/types";
import styles from "./idea.module.css";

function presentation(state: MediaSourceWorkspace, hasInterpretation: boolean, hasRejectedInterpretation: boolean) {
  if (state.phase === "unavailable") return { title: "Source unavailable", copy: "The source is not available in this view. No broader inspection has been opened.", tone: "warning" };
  if (state.phase === "error") return { title: "Current processing could not be checked", copy: `Last confirmed: ${state.run?.status ?? "No run confirmed"}. This read failure does not mean the run failed. Retry is paused until the current state can be checked.`, tone: "warning" };
  if (state.retryRequest.kind === "pending") return { title: "Requesting interpretation…", copy: "Waiting for admission. The request key is held unchanged; no other retry will be sent.", tone: "warning" };
  if (state.retryRequest.kind === "uncertain") return { title: "Retry not confirmed", copy: "It may still start. Your original is retained. No new retry request will be sent automatically.", tone: "warning" };
  if (state.unconfirmedStop) return { title: "Stop not confirmed", copy: `The Stop for run ${state.unconfirmedStop.id} is unconfirmed. Last confirmed processing is shown. Check current processing before deciding what to do next. No Stop or retry will be sent again automatically.`, tone: "warning" };
  if (state.stopping) return { title: "Requesting Stop…", copy: "Stop requests cancellation of this known run. It does not guarantee that native work has stopped.", tone: "warning" };
  if (state.notice !== "none" && state.notice !== "stop-requested") return { title: "Retry could not start", copy: state.notice === "key-unavailable" ? "The request could not be prepared. No retry was sent. Check the current state before trying again."
    : "The retry was not admitted by this request. Check the current state before deciding what to do next. Your original is retained.", tone: "warning" };
  if (state.rejected === true || state.retry?.reason === "source-rejected") return { title: "Interpretation unavailable for rejected source", copy: "Restore the source before requesting new work. Restoring does not restart the earlier run.", tone: "muted" };
  if (hasInterpretation) {
    if (state.run?.status === "failed") return { title: "Interpretation saved · Processing failed", copy: "The saved interpretation remains available below even though the run failed. It will not be generated again. Use Evolve for further development.", tone: "warning" };
    if (state.run?.status === "interrupted") return { title: "Interpretation saved · Processing interrupted", copy: "The saved interpretation remains available below. Stopping does not undo saved thoughts. Use Evolve for further development.", tone: "warning" };
    return { title: "Interpretation ready", copy: "A separate AI interpretation is available in Surrounding context below.", tone: "success" };
  }
  if (state.retry?.reason === "interpretation-exists") return { title: "Initial interpretation already recorded", copy: hasRejectedInterpretation
    ? "The rejected interpretation is shown in Inspected context below. It will not be generated again. Use Evolve for further development of the active source."
    : "The initial interpretation is unavailable in this normal view. It will not be generated again, even if rejected. Use Evolve for further development.", tone: "muted" };
  if (state.phase === "idle") return { title: "Reading current processing…", copy: "The retained original and any recorded thoughts are separate from this status read.", tone: "muted" };
  if (!state.run) return { title: "No interpretation run found", copy: "Your original is retained. An interpretation can be requested when current eligibility permits.", tone: "muted" };
  switch (state.run.status) {
    case "queued": return { title: "Interpretation · Queued", copy: "Your original is retained. No interpretation has been recorded yet.", tone: "normal" };
    case "submitting": return { title: "Interpretation · Submitting", copy: "Waiting for processing to be confirmed. Your original is retained.", tone: "normal" };
    case "running": return { title: "Interpretation · Running", copy: "Waiting for recorded output. Your original and clarification stay unchanged.", tone: "normal" };
    case "uncertain": return { title: "Interpretation · Status uncertain", copy: "The run’s outcome is uncertain. Check current processing; do not start another interpretation.", tone: "warning" };
    case "failed": return { title: "Interpretation · Failed", copy: state.retry?.eligible ? "Your original is retained. You can try interpretation again without uploading the file."
      : "Your original is retained. Check current eligibility before requesting another interpretation.", tone: "failed" };
    case "interrupted": return { title: "Interpretation · Interrupted", copy: state.retry?.reason === "work-unsettled" ? "The earlier work is still being settled. Another interpretation cannot start yet. Your original is retained."
      : "Your original is retained. Another attempt is available only when ordinary cancellation has settled and current eligibility permits.", tone: "warning" };
    case "completed": return { title: "Interpretation · Completed without a saved interpretation", copy: "No interpretation thought was recorded in this view. Read the Full reply for any available outcome and processing limitations. Use Evolve for a different request.", tone: "muted" };
  }
}

export function MediaSourceStatus({ state, controller, scope, hasInterpretation, hasRejectedInterpretation, inspectHref, disabled, onCheck, beforeWrite }: {
  state: MediaSourceWorkspace; controller: MediaSourceController; scope: MediaScope;
  hasInterpretation: boolean; hasRejectedInterpretation: boolean; inspectHref: string;
  disabled: boolean; onCheck: () => Promise<void>; beforeWrite: () => boolean;
}) {
  const item = presentation(state, hasInterpretation, hasRejectedInterpretation), controls = mediaSourceControls(state, scope);
  const freshAction = scope === "normal" && state.phase === "ready" && state.retry?.eligible === true && state.retryRequest.kind === "idle" && !hasInterpretation && !hasRejectedInterpretation;
  return <section className={styles.sourceStatus} data-tone={item.tone} aria-label="Interpretation status">
    <div className={styles.sourceStatusHeading}>
      <h2 aria-live="polite" aria-atomic="true">{item.title}</h2>
      {state.run && <p className={styles.metadata}>Run {state.run.id}</p>}
    </div>
    <p className={styles.sourceStatusCopy}>{item.copy}</p>
    {state.checking && <p className={styles.metadata} role="status">Checking current processing…</p>}
    <div className={styles.sourceStatusActions}>
      <button className={styles.textButton} type="button" disabled={!controls.canCheck} onClick={() => void onCheck()}>Check current processing</button>
      {controls.canStop || state.stopping ? <button className={styles.textButton} type="button" disabled={!controls.canStop || disabled} onClick={() => { if (beforeWrite()) void controller.stop(); }}>Stop</button> : null}
      {freshAction && <button className={`${styles.button} ${styles.primary}`} type="button" disabled={!controls.canRetry || disabled} onClick={() => { if (beforeWrite()) void controller.retry(); }}>{state.run ? "Try interpretation again" : "Request interpretation"}</button>}
      {state.retryRequest.kind === "uncertain" && scope === "normal" && <button className={styles.textButton} type="button" disabled={!controls.canResend || disabled} onClick={() => { if (beforeWrite()) void controller.resendRetry(); }}>Send same retry request</button>}
      {scope === "normal" && (state.phase === "unavailable" || state.retry?.reason === "interpretation-exists" && !hasInterpretation) && <Link href={inspectHref} prefetch={false}>{state.phase === "unavailable" ? "Inspect source" : "Inspect recorded context"}</Link>}
    </div>
    {state.retryRequest.kind === "uncertain" && <p className={styles.metadata}>Check only reads the current state. Sending the same retry request may start interpretation if the earlier request never arrived; it does not upload another file.</p>}
    {freshAction && <p className={styles.metadata}>Availability is checked again when you request it.</p>}
    {state.notice === "stop-requested" && <p className={styles.metadata}>Stop was acknowledged. Saved work remains; native cancellation may still be settling. Check current processing before requesting another interpretation.</p>}
    {state.retryRequest.kind !== "idle" && <p className={styles.sourceLifetime}>Status reads never start work. A reload does not preserve an unconfirmed retry request.</p>}
  </section>;
}
