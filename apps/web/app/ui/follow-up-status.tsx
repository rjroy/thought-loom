"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { parseFollowUpRetryReceipt, type FollowUpJobView, type FollowUpStatusView, type FollowUpTargetView, type InquiryView } from "@thoughtloom/contracts";
import { DevelopmentError, postDevelopment } from "../../lib/development-client";
import { getFollowUps, getInquiryContext, type PendingFollowUpVersion } from "../../lib/follow-up-client";
import { discussionHref, inquiryHref, sourceHref } from "../../lib/links";
import { revealInquiryAnchor, useDevelopmentNavigation } from "./development-navigation";
import EvidenceLinks from "./evidence-links";

type Command = { key: string; expectedRunId: string };
const titles: Record<FollowUpJobView["status"], string> = {
  queued: "Follow-up queued", running: "Follow-up running", completed: "Follow-up complete",
  failed: "Follow-up failed", interrupted: "Follow-up interrupted", uncertain: "Follow-up uncertain",
};
const explanations: Record<FollowUpJobView["status"], string> = {
  queued: "A bounded pass is waiting. This is separate from your saved input and the discussion response.",
  running: "The agent is checking the affected readings and connections. Your current question stays where it is.",
  completed: "This pass has finished. Only confirmed saved changes count as findings.",
  failed: "This pass ended with a confirmed failure. Already recorded changes remain available.",
  interrupted: "This pass was interrupted. Saved input and already recorded changes are kept.",
  uncertain: "The service may have accepted this pass. Check status rather than resend it.",
};

function HistoricalTarget({ target, model, root, query }: { target: FollowUpTargetView; model: InquiryView | null; root: string; query: string }) {
  const item = target.kind === "item" ? model?.items.find((item) => item.id === target.id) : undefined;
  const formulation = item?.history.find((version) => version.id === target.versionId);
  const relation = target.kind === "relationship" ? model?.relationships.find((relation) => relation.id === target.id) : undefined;
  const revision = relation?.history.find((version) => version.id === target.versionId);
  if (!formulation && !revision) return <li><p>{target.kind === "item" ? "Affected reading" : "Affected connection"}</p><p className="section-context">The exact version is outside this bounded context view. No current version is substituted.</p></li>;
  const destinationRoot = item?.sourceId ?? root;
  const href = `${inquiryHref(destinationRoot, query, item?.id).split("#")[0]}#version-${target.versionId}`;
  return <li><Link className="text-link" href={href} onNavigate={(event) => {
    if (window.location.pathname !== `/sources/${destinationRoot}/inquiry`) return;
    event.preventDefault();
    // Inspecting a version is not selecting a different discussion target.
    const next = new URL(window.location.href); next.hash = `version-${target.versionId}`;
    window.history.pushState(null, "", next); revealInquiryAnchor(`version-${target.versionId}`);
  }}>{target.kind === "item" ? "Affected reading" : "Affected connection"}</Link>
    <p className="follow-up-quote">{formulation?.text ?? revision?.rationale}</p>
    <p className="record-identity">Recorded version · {(formulation ?? revision)?.author === "user" ? "Written by you" : "AI-authored · Tentative"}</p>
  </li>;
}

export default function FollowUpStatus({ sourceId, query = "", initialModel = null, pendingFindings = [], onView, onWorker }: {
  sourceId: string; query?: string; initialModel?: InquiryView | null;
  pendingFindings?: PendingFollowUpVersion[];
  onView?: () => Promise<boolean>; onWorker?: (view: FollowUpStatusView["worker"]) => void;
}) {
  const navigation = useDevelopmentNavigation();
  const [view, setView] = useState<FollowUpStatusView | null>(null), [reference, setReference] = useState(initialModel);
  const [readError, setReadError] = useState(false), [checking, setChecking] = useState(false);
  const [pending, setPending] = useState<Record<string, Command>>({}), [sending, setSending] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({}), [viewing, setViewing] = useState("");
  const [viewed, setViewed] = useState<Record<string, string>>({}), [findingsError, setFindingsError] = useState("");
  const commands = useRef(new Map<string, Command>()), submitting = useRef(new Set<string>());
  const inFlight = useRef<Promise<FollowUpStatusView | null> | null>(null), referenceSignature = useRef("");
  const callbacks = useRef({ onView, onWorker });
  useEffect(() => { callbacks.current = { onView, onWorker }; }, [onView, onWorker]);

  const check = useCallback((signal?: AbortSignal): Promise<FollowUpStatusView | null> => {
    if (inFlight.current) return inFlight.current;
    const task = (async () => {
      setChecking(true);
      try {
        const next = await getFollowUps(sourceId, signal);
        if (signal?.aborted) return null;
        setView(next); setReadError(false); callbacks.current.onWorker?.(next.worker);
        const signature = JSON.stringify(next.jobs.map((job) => [job.id, job.targets, job.changes]));
        if (signature !== referenceSignature.current) {
          // This reference read supplies history links only. It never replaces
          // the main reading area or grants an agent response a saved receipt.
          try {
            const model = await getInquiryContext(sourceId, signal);
            if (!signal?.aborted) { setReference(model); referenceSignature.current = signature; }
          } catch { /* Keep known references; unknown exact versions get no link. */ }
        }
        return next;
      } catch { if (!signal?.aborted) setReadError(true); return null; }
      finally { inFlight.current = null; if (!signal?.aborted) setChecking(false); }
    })();
    inFlight.current = task; return task;
  }, [sourceId]);

  useEffect(() => {
    const controller = new AbortController(); void check(controller.signal);
    const timer = setInterval(() => { if (document.visibilityState === "visible") void check(controller.signal); }, 1_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [check]);

  async function retry(job: FollowUpJobView) {
    if (submitting.current.has(job.id)) return;
    const existing = commands.current.get(job.id);
    if (!existing && (!job.actions.retry || !job.run)) return;
    const command = existing ?? { key: crypto.randomUUID(), expectedRunId: job.run!.id };
    commands.current.set(job.id, command); setPending((old) => ({ ...old, [job.id]: command }));
    submitting.current.add(job.id); setSending((old) => ({ ...old, [job.id]: true }));
    setErrors((old) => ({ ...old, [job.id]: "" }));
    try {
      const value = parseFollowUpRetryReceipt(await postDevelopment(`/api/sources/${sourceId}/follow-ups/${job.id}/retry`, { expectedRunId: command.expectedRunId }, command.key));
      if (!value || value.sourceId !== sourceId || value.jobId !== job.id || value.expectedRunId !== command.expectedRunId) throw new DevelopmentError(503, "retry_unconfirmed");
      commands.current.delete(job.id);
      setPending((old) => { const next = { ...old }; delete next[job.id]; return next; });
      await check();
    } catch (error) {
      const rejected = error instanceof DevelopmentError && error.status === 409 && error.code === "retry_conflict";
      if (rejected) {
        commands.current.delete(job.id);
        setPending((old) => { const next = { ...old }; delete next[job.id]; return next; });
      }
      setErrors((old) => ({ ...old, [job.id]: rejected ? "This follow-up changed before the retry could be applied. Review current status; another explicit retry will use the current run." : "The retry acknowledgement could not be confirmed. Check status. Retry follow-up replays this exact request and key, not a new attempt." }));
      await check();
    } finally { submitting.current.delete(job.id); setSending((old) => ({ ...old, [job.id]: false })); }
  }

  async function showFindings(job?: FollowUpJobView) {
    if (viewing) return;
    setViewing(job?.id ?? "neighborhood"); setFindingsError("");
    try {
      if (callbacks.current.onView && !await callbacks.current.onView()) throw new Error("Findings unavailable");
      const next = await getInquiryContext(sourceId); setReference(next);
      if (job) setViewed((old) => ({ ...old, [job.id]: JSON.stringify(job.changes) }));
    } catch { setFindingsError("The findings could not be loaded. Your current reading and draft are kept. Try viewing them again."); }
    finally { setViewing(""); }
  }

  const unlistedFindings = pendingFindings.some((finding) => finding.sourceId !== sourceId || !view?.jobs.some((job) => job.id === finding.jobId && job.changes.length > 0));
  return <section className="follow-up-status" aria-label="Background follow-up">
    <h2>Background follow-up</h2>
    <p className="section-context">A focused check of readings and connections after a meaningful saved change. Separate from your current discussion.</p>
    {unlistedFindings && <div className="follow-up-findings"><p className="section-context">Follow-up findings affect this neighborhood, including connected thoughts. Your current reading is kept until you choose to view them.</p><button className="button secondary" type="button" disabled={!!viewing} onClick={() => void showFindings()}>{viewing === "neighborhood" ? "Loading findings…" : "View follow-up findings"}</button></div>}
    {!view && <p className="status-recovery" role="status">{readError ? "Follow-up status is unavailable. Your saved input and current reading are kept." : "Checking background follow-up…"}</p>}
    {view && !view.worker.configured && <div className="worker-availability"><p>Background follow-up is not configured.</p><p>Saved changes remain intact. Queued passes wait until you configure your own agent service.</p><Link className="text-link" href="/setup/weaving">Set up weaving</Link></div>}
    {view?.worker.configured && ["unavailable", "failed", "stopped"].includes(view.worker.state) && <div className="worker-availability"><p>Background follow-up service unavailable</p><p>The configured worker cannot currently use the service. This is not a completed pass.</p><Link className="text-link" href="/setup/weaving">Review weaving setup</Link></div>}
    {view?.jobs.length === 0 && <p className="empty-reading">No background follow-up queued.</p>}
    {view?.jobs.map((job) => <article className="follow-up-pass" id={`follow-up-${job.id}`} key={job.id}>
      <div className="follow-up-summary" role="status" aria-live="polite" aria-atomic="true"><h3>{titles[job.status]}</h3><p>{explanations[job.status]}</p></div>
      <div className="follow-up-context"><div><h4>What triggered this pass</h4>
        {job.origins.some((origin) => origin.kind === "user") && <p>Your saved revision</p>}
        {job.origins.filter((origin) => origin.kind === "dialogue").map((origin) => <p key={origin.runId}><Link className="text-link" href={discussionHref(sourceId, origin.dialogueId, query, origin.turnId)} onNavigate={navigation?.root === sourceId ? (event) => { event.preventDefault(); navigation.openDiscussion(origin.dialogueId, origin.turnId); } : undefined}>Triggering discussion</Link><Link className="text-link follow-up-input" href={sourceHref(origin.turnSourceId, query)}>View triggering input</Link></p>)}
        {job.originsTruncated && <p className="history-limit">Some triggering changes are not shown.</p>}
      </div><div><h4>Affected versions</h4><ul className="follow-up-targets">{job.targets.map((target) => <HistoricalTarget key={`${target.kind}:${target.id}:${target.versionId}`} target={target} model={reference} root={sourceId} query={query} />)}</ul>
        {job.targetsTruncated && <p className="history-limit">Some affected versions are not shown.</p>}
      </div></div>
      {job.recordedChanges === 0 && ["completed", "failed", "interrupted"].includes(job.status) && <p className="section-context">No confirmed changes were recorded.</p>}
      {job.changesTruncated && <p className="history-limit">Some confirmed changes are not shown.</p>}
      {job.changes.length > 0 && viewed[job.id] !== JSON.stringify(job.changes) && <div className="follow-up-findings"><p className="section-context">Confirmed changes are available. Your reading above has not been rearranged.</p><button className="button secondary" type="button" disabled={!!viewing} onClick={() => void showFindings(job)}>{viewing === job.id ? "Loading findings…" : "View follow-up findings"}</button></div>}
      {viewed[job.id] === JSON.stringify(job.changes) && job.changes.length > 0 && <div className="follow-up-findings"><h4>Confirmed updates</h4>{job.changes.map((change) => {
        if (change.kind === "alias") return <p className="section-context" key={change.id}>A search alias was recorded. It is not a new idea or interpretation.</p>;
        if (!change.versionId) return <p className="section-context" key={change.id}>The confirmed version reference is unavailable in this view.</p>;
        const target: FollowUpTargetView = { kind: change.kind === "relationship" ? "relationship" : "item", id: change.id, versionId: change.versionId };
        const evidence = target.kind === "item" ? reference?.items.find((item) => item.id === target.id)?.history.find((version) => version.id === target.versionId)?.evidenceSourceIds : reference?.relationships.find((relation) => relation.id === target.id)?.history.find((version) => version.id === target.versionId)?.evidenceSourceIds;
        return <div key={`${change.id}:${change.versionId}`}><ul className="follow-up-targets"><HistoricalTarget target={target} model={reference} root={sourceId} query={query} /></ul>{reference && evidence && <EvidenceLinks ids={evidence} sources={reference.evidenceSources} query={query} />}</div>;
      })}</div>}
      {(job.actions.retry && job.run || pending[job.id]) && <button className="text-button" type="button" disabled={!!sending[job.id]} onClick={() => void retry(job)}>{sending[job.id] ? "Requesting retry…" : "Retry follow-up"}</button>}
      {errors[job.id] && <p className="notice error-notice" role="alert">{errors[job.id]}</p>}
    </article>)}
    {view?.truncated && <p className="history-limit">Some follow-up passes are not shown.</p>}
    {view && readError && <p className="status-recovery" role="status">Could not refresh follow-up status. The last confirmed state is kept; nothing was resent.</p>}
    {findingsError && <p className="notice error-notice" role="alert">{findingsError}</p>}
    <button className="button secondary follow-up-check" type="button" aria-disabled={checking} onClick={() => void check()}>Check status</button>
  </section>;
}
