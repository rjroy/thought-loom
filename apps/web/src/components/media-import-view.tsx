"use client";

import Link from "next/link";
import { useEffect, useRef, useSyncExternalStore, type FormEvent } from "react";
import type { MediaProblem } from "../features/media/types";
import { useContextualBack } from "./contextual-back";
import { useMediaImportController } from "./media-import-provider";
import styles from "./media-import.module.css";

const byteLabel = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024
  ? `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(bytes / 1024)} KB`
  : `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(bytes / (1024 * 1024))} MB`;
const mimeLabel: Record<string, string> = { "image/png": "PNG image", "image/jpeg": "JPEG image", "image/gif": "GIF image", "image/webp": "WebP image", "application/pdf": "PDF" };
function refusal(problem: MediaProblem | null) {
  if (problem?.code === "receiver-busy") return "The upload receiver is busy. Your file and clarification are still here; you can try again.";
  if (problem?.status === 413) return "This file is too large for this installation. Choose a smaller file. Your clarification is still here.";
  if (problem?.status === 415) return "Choose a PNG, JPEG, GIF, WebP or PDF. Your clarification is still here.";
  if (problem?.status === 422) return "The file did not pass validation. Choose another PNG, JPEG, GIF, WebP or PDF. Your clarification is still here.";
  return "The upload was not accepted. Your file and clarification are still here. You can adjust them and try again.";
}

export function MediaImportView() {
  const controller = useMediaImportController();
  const workspace = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const fileInput = useRef<HTMLInputElement>(null), chooseButton = useRef<HTMLButtonElement>(null), resultHeading = useRef<HTMLHeadingElement>(null);
  const previous = useRef(workspace.admission), focusFresh = useRef(false);
  useContextualBack("/capture", "Back to Capture");
  useEffect(() => {
    if (previous.current === "pending" && workspace.admission !== "pending") resultHeading.current?.focus();
    previous.current = workspace.admission;
    if (focusFresh.current && workspace.admission === "editing") { focusFresh.current = false; chooseButton.current?.focus(); }
  }, [workspace.admission]);
  const pending = workspace.admission === "pending", uncertain = workspace.admission === "uncertain";
  const saved = workspace.admission === "saved" && workspace.receipt !== null;
  const locked = pending || uncertain;
  const selected = locked ? workspace.snapshot?.file ?? null : workspace.file;
  const receipt = workspace.receipt;
  const source = saved ? receipt?.thought.mediaSource : null;
  const name = source?.name ?? selected?.name;
  const mime = source?.mimeType ?? selected?.type;
  const size = source?.byteLength ?? selected?.size;
  const absent = uncertain && workspace.receiptCheck === "absent";
  function submit(event: FormEvent) { event.preventDefault(); void controller.submit(); }

  return <section className={styles.workspace} aria-labelledby="media-import-heading">
    <header className={styles.intro}>
      <h1 id="media-import-heading">Import image or PDF</h1>
      {!saved && <p>Keep the original. Let AI help you make sense of it.</p>}
    </header>
    <div role="status" aria-atomic="true">
      {saved && <div className={styles.retained}>
        <h2 ref={resultHeading} tabIndex={-1}>Original saved</h2>
        <p>Your original{source?.clarification !== null ? " and clarification are" : " is"} saved. The AI interpretation is separate.</p>
      </div>}
      {pending && <div className={styles.notice}>
        <h2>Uploading and checking the file…</h2>
        <p>Waiting for confirmation that the original is retained. This is not AI interpretation progress.</p>
        <p className={styles.small}>The submitted file and clarification are frozen. Nothing will be sent again automatically.</p>
      </div>}
      {uncertain && <div className={`${styles.notice} ${styles.warning}`}>
        <h2 ref={resultHeading} tabIndex={-1}>{absent ? "No upload receipt found yet" : "Upload not confirmed"}</h2>
        <p>{absent ? "A receipt was not found for this request. That does not rule out a delayed admission. The submitted file and clarification are still held here."
          : "The original may already be saved. Keep this page open and check this same upload before doing anything else."}</p>
        {workspace.receiptCheck === "error" && <p>Could not check this upload. That does not mean the upload failed.</p>}
        <div className={styles.actions}>
          <button className={styles.action} type="button" disabled={workspace.checking} onClick={() => void controller.checkUpload()}>{workspace.checking ? "Checking upload…" : "Check upload"}</button>
          {absent && <button className={`${styles.control} ${styles.primary}`} type="button" disabled={workspace.checking} onClick={() => void controller.resendUpload()}>Send same upload request</button>}
        </div>
        <p className={styles.small}>{absent ? "Sending the same upload request sends these original bytes and clarification again. It may save the original if the earlier request never arrived; it does not use a new request."
          : "Your selected file and exact clarification are held in this workspace only, not across reload. Nothing will be sent again automatically."}</p>
      </div>}
      {workspace.admission === "not-started" && <div className={`${styles.notice} ${styles.warning}`}>
        <h2 ref={resultHeading} tabIndex={-1}>Upload not started</h2><p>{refusal(workspace.problem)}</p>
      </div>}
    </div>

    <div className={styles.split}>
      <aside className={styles.rail} aria-label={saved ? "Retained original" : locked ? "Submitted file" : "Selected file"}>
        <h2>{saved ? "Retained original" : locked ? "Submitted file" : "Selected file"}</h2>
        <div className={styles.fileRow}>
          <div>{name ? <><p className={styles.fileName}>{name}</p><p className={styles.fileFacts}>{mime ? mimeLabel[mime] ?? mime : "File"} · {size === undefined ? "" : byteLabel(size)}</p></>
            : <p className={styles.empty}>Choose one image or PDF.</p>}</div>
          {!saved && <button ref={chooseButton} className={styles.action} type="button" disabled={locked} onClick={() => fileInput.current?.click()}>{name ? "Change file" : "Choose file"}</button>}
        </div>
        <input ref={fileInput} className={styles.fileInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp,application/pdf" aria-label="Choose image or PDF" tabIndex={-1}
          disabled={locked || saved} onChange={event => { const file = event.target.files?.[0]; if (file) controller.select(file); event.target.value = ""; }} />
        {name && <p className={styles.authorship}>Original authorship unverified</p>}
        {!saved && !locked && <p className={styles.small}>The file is not uploaded yet.</p>}
      </aside>

      <div className={styles.main}>
        {saved && receipt && source ? <>
          {source.clarification !== null ? <div className={styles.clarification}>
            <h3>Your clarification</h3><p>{source.clarification}</p>
          </div> : <p className={styles.small}>No user clarification was supplied. A summary was requested.</p>}
          <section className={styles.run} aria-label="Interpretation status">
            <div className={styles.runHeading}><h2>Interpretation · {receipt.run.status[0].toUpperCase() + receipt.run.status.slice(1)}</h2><p className={styles.small}>Run {receipt.run.id}</p></div>
            <p>{receipt.run.confirmedThoughtIds.length > 0 || receipt.run.responseId !== null
              ? "The run has recorded output. Open the source idea to read its available thoughts and Full reply."
              : "The original is retained. No AI interpretation was confirmed by this receipt."}</p>
            <p className={styles.small}>Last confirmed status of the original import run. This receipt does not identify a later retry.</p>
          </section>
          <div className={`${styles.actions} ${styles.afterSave}`}>
            <Link className={`${styles.control} ${styles.primary}`} href={`/ideas/${encodeURIComponent(receipt.thought.id)}`} prefetch={false}>Open source idea</Link>
            <button className={styles.action} type="button" onClick={() => { focusFresh.current = true; controller.reset(); }}>Import another file</button>
          </div>
        </> : <>
          <form className={styles.form} noValidate onSubmit={submit}>
            <div className={styles.field}>
              <label htmlFor="media-clarification">{locked ? "Submitted clarification" : "Clarification"} {!locked && <span>(optional)</span>}</label>
              <textarea id="media-clarification" value={locked ? workspace.snapshot?.clarification ?? "" : workspace.clarification} readOnly={locked}
                aria-describedby="media-clarification-help" onChange={event => controller.setClarification(event.target.value)} />
              <p className={styles.small} id="media-clarification-help">{locked ? "Exact wording from this upload attempt. It remains copyable." : "Leave blank to request a summary. Your wording is saved separately from the file."}</p>
            </div>
            {workspace.selectionError && <p className={styles.error} role="alert">{workspace.selectionError}</p>}
            {!uncertain && <div className={styles.formActions}>
              <p className={styles.small}>{pending ? "Waiting for confirmation. Do not send another copy." : "Nothing is sent until you choose Import file."}</p>
              <button className={`${styles.control} ${styles.primary}`} type="submit" disabled={!selected || pending || !!workspace.selectionError} aria-busy={pending}>Import file</button>
            </div>}
          </form>
          {!locked && <div className={styles.how}><p>The original stays unchanged. Any AI interpretation is saved as a separate thought.</p><p className={styles.small}>PNG, JPEG, GIF, WebP or PDF. One file at a time.</p></div>}
        </>}
      </div>
    </div>
    <p className={`${styles.small} ${styles.lifetime}`}>Unsent files and unconfirmed upload requests stay only in this mounted browser workspace, not across reload. Leaving does not cancel an upload already sent.</p>
  </section>;
}
