"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { parseWeavingRetryReceipt, parseWeavingStatusView, type WeavingStatusView } from "@thoughtloom/contracts";
import StatusIcon from "./status-icon";

type Command = { key: string; expectedRunId: string };

function statusCopy(view: WeavingStatusView | null): { title: string; detail: string } {
  if (!view) return { title: "Status unavailable", detail: "Your original remains saved. Check status to reconnect; this does not start a run." };
  switch (view.job.status) {
    case "queued": return { title: "Queued for weaving", detail: "Your original is saved. A queued job has not started an agent run." };
    case "running": return { title: "Weaving in progress", detail: "The agent is exploring possible readings and connections. Your original stays unchanged." };
    case "completed": return { title: "Weaving completed", detail: view.job.recordedChanges === 0 ? "No new changes or connections were recorded. A completed run does not have to find a connection." : "Recorded changes are available in this thought’s context. AI readings remain tentative, with their evidence attached." };
    case "failed": return { title: "Weaving failed", detail: "The run ended with a confirmed failure. Any changes already recorded remain available; your original is intact." };
    case "interrupted": return { title: "Run interrupted", detail: "The run stopped before finishing. Any recorded readings and connections are kept, not rolled back." };
    case "uncertain": return { title: "Outcome uncertain", detail: "The service may have accepted or started this run, but its outcome cannot be confirmed. Check status rather than resend it." };
  }
}

export default function WeavingStatus({ sourceId, initial, onSnapshot }: { sourceId: string; initial: WeavingStatusView | null; onSnapshot?: (view: WeavingStatusView) => void }) {
  const [view, setView] = useState(initial);
  const [readError, setReadError] = useState(false);
  const [checking, setChecking] = useState(false);
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState<Command | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const command = useRef<Command | null>(null), reading = useRef(false), submitting = useRef(false);
  const callback = useRef(onSnapshot);
  useEffect(() => { callback.current = onSnapshot; }, [onSnapshot]);

  const check = useCallback(async (signal?: AbortSignal) => {
    if (reading.current) return;
    reading.current = true;
    setChecking(true);
    try {
      const response = await fetch(`/api/sources/${sourceId}/weaving`, { cache: "no-store", signal: signal ?? AbortSignal.timeout(10_000) });
      const next = response.ok ? parseWeavingStatusView(await response.json()) : null;
      if (!next || next.sourceId !== sourceId) throw new Error("Status unavailable");
      if (signal?.aborted) return;
      setView(next); setReadError(false);
      // A new run or a durably queued next attempt resolves an uncertain command
      // without issuing another command. Otherwise keep its original key/payload.
      if (command.current && (next.job.status === "queued" || next.run?.id !== command.current.expectedRunId)) {
        command.current = null; setPending(null); setAcknowledged(false); setMessage("Retry accepted. Current status is shown above.");
      }
      callback.current?.(next);
    } catch {
      if (!signal?.aborted) setReadError(true);
    } finally { reading.current = false; if (!signal?.aborted) setChecking(false); }
  }, [sourceId]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void check(controller.signal); }, 1_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [check]);

  async function retry() {
    if (submitting.current) return;
    const existing = command.current;
    if (!existing && (!view?.actions.retry || !view.run)) return;
    const request = existing ?? { key: crypto.randomUUID(), expectedRunId: view!.run!.id };
    command.current = request; setPending(request);
    submitting.current = true; setSending(true); setMessage("");
    try {
      console.info("weaving.retry attempt", { sourceId });
      const response = await fetch(`/api/sources/${sourceId}/weaving/retry`, {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": request.key },
        body: JSON.stringify({ expectedRunId: request.expectedRunId }), signal: AbortSignal.timeout(10_000),
      });
      const receipt = response.status === 202 ? parseWeavingRetryReceipt(await response.json()) : null;
      if (receipt?.sourceId === sourceId && receipt.expectedRunId === request.expectedRunId && receipt.jobId === view?.job.id) {
        setAcknowledged(true); setMessage("Retry accepted. Checking current status…");
        console.info("weaving.retry accepted", { sourceId });
      } else if ([400, 404, 409].includes(response.status)) {
        command.current = null; setPending(null); setMessage("This retry is no longer eligible. Check current status before trying anything else.");
      } else throw new Error("Unconfirmed retry");
    } catch {
      console.warn("weaving.retry unconfirmed", { sourceId });
      setMessage("The retry acknowledgement is uncertain. Check status first. Confirm retry only replays the same request; it does not request a second attempt.");
    } finally {
      submitting.current = false; setSending(false); void check();
    }
  }

  const copy = statusCopy(view);
  const blocked = view && !view.worker.configured;
  const unavailable = view?.worker.configured && ["unavailable", "failed", "stopped"].includes(view.worker.state);
  return <section className="weaving-status queue-notice" aria-label="Weaving status">
    <div className="notice weaving-summary" role="status" aria-live="polite" aria-atomic="true">
      <StatusIcon kind={view?.job.status === "completed" ? "saved" : ["failed", "interrupted", "uncertain"].includes(view?.job.status ?? "") ? "error" : "queued"} />
      <div><h2>{copy.title}</h2><p>{copy.detail}</p></div>
    </div>
    {blocked && <div className="worker-availability"><p>Weaving is not configured.</p><p>The weaving worker is not available until you configure your own agent and service. Your original remains saved; queued work waits for setup.</p><Link className="text-link" href="/setup/weaving">Set up weaving</Link></div>}
    {unavailable && <div className="worker-availability"><p>Weaving service unavailable</p><p>Configuration exists, but the worker cannot currently use it. Check the operator-managed service and registration; this is separate from the saved job’s outcome.</p><Link className="text-link" href="/setup/weaving">Review weaving setup</Link></div>}
    {readError && <p className="status-recovery" role="status">Could not refresh status. The last confirmed state is shown; your original has not been resubmitted.</p>}
    <div className="weaving-actions">
      <button className="button secondary" type="button" onClick={() => void check()} aria-disabled={checking}>Check status</button>
      {!acknowledged && (pending || (view?.actions.retry && view.run)) && <button className="button primary" type="button" disabled={sending} onClick={() => void retry()}>{sending ? "Requesting retry…" : pending ? "Confirm retry" : "Retry weaving"}</button>}
    </div>
    {message && <p className="status-recovery" role="status">{message}</p>}
  </section>;
}
