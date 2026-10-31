"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import Link from "next/link";
import { DIALOGUE_LIMITS, type DialogueSelectedContext, type DialogueSelection, type DialogueTurnView, type InquiryView, type WeavingWorkerView } from "@thoughtloom/contracts";
import { discussionHref, inquiryHref, readableDate, sourceHref } from "../../lib/links";
import EvidenceLinks from "./evidence-links";
import { isActiveTurn } from "./use-development";
import type useDevelopment from "./use-development";
import { useDevelopmentNavigation } from "./development-navigation";

export type DevelopmentState = ReturnType<typeof useDevelopment>;

function TargetQuote({ context }: { context: DialogueSelectedContext }) {
  if (context.kind === "relationship") return <><p className="record-identity">Pinned connection · {context.author === "ai" ? "AI suggestion" : "Your recorded connection"}</p><blockquote>{context.rationale}</blockquote><p className="target-endpoint"><strong>From: </strong><span>{context.from.version.text}</span></p><p className="target-endpoint"><strong>{context.type === "suggests" ? "Suggests" : context.type === "supports" ? "Supports" : "Challenges"}: </strong><span>{context.to.version.text}</span></p></>;
  return <><p className="record-identity">{context.kind === "source" ? "Your unchanged original" : `Pinned reading · ${context.author === "ai" ? "AI-authored · Tentative" : "Written by you"}`}</p>{context.text.length > 1_200 ? <details className="target-disclosure"><summary role="button">Read selected context</summary><blockquote>{context.text}</blockquote></details> : <blockquote>{context.text}</blockquote>}</>;
}
function FallbackQuote({ selection, model }: { selection: DialogueSelection; model: InquiryView }) {
  if (selection.kind === "source") return <TargetQuote context={{ ...model.source, kind: "source" }} />;
  if (selection.kind === "item") {
    const item = model.items.find((item) => item.id === selection.id), version = item?.history.find((v) => v.id === selection.versionId);
    return version ? <TargetQuote context={{ ...version, kind: "item" }} /> : <p>Loading the exact selected reading…</p>;
  }
  const relation = model.relationships.find((r) => r.id === selection.id), version = relation?.history.find((v) => v.id === selection.versionId);
  return <><p className="record-identity">Pinned connection</p><blockquote>{version?.rationale ?? "Loading the exact selected connection…"}</blockquote></>;
}
function Turn({ turn, query, correctionLink }: { turn: DialogueTurnView; query: string; correctionLink?: string }) {
  return <section className="exchange" id={`turn-${turn.id}`} tabIndex={-1}>
    <div className="exchange-input"><h3>Your thought</h3><p className="attribution">Your thought saved</p><p className="turn-text">{turn.source.text}</p><p className="turn-date"><time dateTime={turn.source.createdAt}>{readableDate(turn.source.createdAt)}</time></p><Link className="text-link" href={sourceHref(turn.source.id, query)}>View discussion input</Link>{correctionLink && <Link className="text-link" href={correctionLink}>Review this reading</Link>}</div>
    {turn.assistant && (turn.assistant.text ? <div className="exchange-response"><h3>Agent response</h3><p className="record-identity">AI-authored · A response is not a saved-idea receipt</p>{turn.assistant.text.length > 6_000 ? <details className="full-reply"><summary role="button">Read full reply</summary><article className="canonical-response" aria-label="Agent response">{turn.assistant.text}</article></details> : <article className="canonical-response" aria-label="Agent response">{turn.assistant.text}</article>}</div> : <p className="empty-reading">Finished without a written reply. Any confirmed changes are shown separately.</p>)}
  </section>;
}
function progressCopy(turn: DialogueTurnView | undefined) {
  if (!turn) return { title: "Ready to develop", text: "Your next thought will be saved before any agent run begins." };
  switch (turn.status) {
    case "queued": return { title: "Waiting for agent", text: "Your thought is saved. This response has not started yet." };
    case "running": return { title: "Agent responding", text: "The agent is working in this pinned context. Confirmed changes can appear before the response ends." };
    case "uncertain": return { title: "Outcome uncertain", text: "The service may have accepted this turn. Check status; do not resend it as a new thought." };
    case "completed": return { title: "Response complete", text: "This turn has settled. A response can finish without producing a new idea." };
    case "interrupted": return { title: "Response interrupted", text: "Already saved input, partial response text and confirmed changes are kept. Nothing is rolled back." };
    case "failed": return { title: "Response failed", text: "This turn ended with a confirmed failure. Its saved input and recorded changes remain; you can continue with a new thought." };
  }
}

export default function Development({ state, model, query, worker, composerRef, initialError }: { state: DevelopmentState; model: InquiryView; query: string; worker: WeavingWorkerView | null; composerRef: RefObject<HTMLTextAreaElement | null>; initialError: string }) {
  const navigation = useDevelopmentNavigation();
  const current = state.latest, turns = state.dialogue?.turns ?? [], older = turns.slice(0, -1), copy = progressCopy(current);
  const [openEarlier, setOpenEarlier] = useState(false), positioned = useRef("");
  useEffect(() => {
    const hash = window.location.hash;
    if (!state.dialogue || positioned.current === state.dialogue.id || !hash.startsWith("#turn-")) return;
    if (older.some((turn) => hash === `#turn-${turn.id}`)) setOpenEarlier(true);
    positioned.current = state.dialogue.id;
    requestAnimationFrame(() => document.getElementById(hash.slice(1))?.scrollIntoView({ block: "start" }));
  }, [state.dialogue, older]);
  const selected = state.dialogue?.selectedContext;
  const selection = state.selection;
  const selectedRelationship = selection.kind === "relationship" ? model.relationships.find((r) => r.id === selection.id) : null;
  const changed = selection.kind === "item" ? model.items.find((item) => item.id === selection.id)?.current.id !== selection.versionId
    : selection.kind === "relationship" && (selectedRelationship?.current.id !== selection.versionId ||
      model.items.find((item) => item.id === selectedRelationship?.fromItemId)?.current.id !== selection.fromVersionId ||
      model.items.find((item) => item.id === selectedRelationship?.toItemId)?.current.id !== selection.toVersionId);
  const changes = current?.changes ?? [];
  const ideas = changes.filter((change) => change.kind === "developing-idea");
  const active = current && isActiveTurn(current.status);
  return <section className="development-area" id="development" aria-label="Develop this thought">
    <h2>Develop through dialogue</h2>
    <section className="discussion-target" aria-label="Discussion target"><h3>What you’re discussing</h3>{selected ? <TargetQuote context={selected} /> : <FallbackQuote selection={state.selection} model={model} />}{changed && <p className="context-change">The current reading has changed since this discussion began. This discussion stays attached to its selected revision.</p>}<a className="text-link" href="#original-source">Read original and recorded context</a></section>
    {initialError && <p className="notice error-notice" role="alert">{initialError}</p>}
    <form className="development-form" onSubmit={(event) => { event.preventDefault(); void state.send(); }}>
      <label htmlFor="development-thought">Develop this thought</label><p className="field-help" id="development-help">Challenge the framing, ask a question, or try a different formulation. Your words stay intact.</p>
      <textarea ref={composerRef} id="development-thought" aria-describedby="development-help development-draft" value={state.draft} onChange={(event) => state.edit(event.target.value)} rows={4} maxLength={DIALOGUE_LIMITS.turnText} readOnly={state.opening || state.sending || !!state.pending} required />
      <div className="development-actions"><p id="development-draft" className="draft-state">{state.opening ? "Opening the selected discussion…" : state.sending ? "Saving your thought…" : state.pending ? "Awaiting a save acknowledgement. Retry uses these exact words." : state.draft ? "Draft only. Save before leaving or reloading." : "A saved turn is separate from its agent outcome."}</p><button className="button primary" type="submit" disabled={state.opening || state.sending || state.loading || !state.draft.trim() || state.blocked}>{state.sending ? "Saving thought…" : state.error ? "Retry send" : "Send thought"}</button></div>
    </form>
    {state.error && <div className="notice error-notice" role="alert"><p>{state.error}</p></div>}
    {state.blocked && !active && <p className="status-recovery">Another response on this original may still be in progress. You can keep drafting here. Check status before sending.</p>}
    <section className="dialogue-status" aria-label="Dialogue status"><div role="status" aria-live="polite" aria-atomic="true"><h3>{copy.title}</h3><p>{copy.text}</p>{active && current.stopRequested && <><p className="stop-request">Stop requested</p><p>Waiting for settlement. Already recorded changes are kept; completion can still win.</p></>}</div>
      {worker && !worker.configured && <p>Weaving is not configured. Your discussion input can be saved, but an agent cannot respond until <Link href="/setup/weaving">you set up your own service</Link>.</p>}
      {worker?.configured && ["unavailable", "failed", "stopped"].includes(worker.state) && <p>The configured agent service is unavailable. Saved input is retained; this is not a completed response.</p>}
      {!worker && <p className="section-context">Worker availability could not be confirmed. A saved turn or queued job does not prove the service is connected.</p>}
      <div className="claim-actions"><button type="button" className="button secondary" onClick={() => void state.check()}>Check status</button>{current?.actions?.stop.eligible && <button type="button" className="text-button" disabled={state.stopPending} onClick={() => void state.stop()}>Stop response</button>}</div>
    </section>
    {state.notice && <p role="status" className="status-recovery">{state.notice}</p>}
    <section className="latest-exchange" aria-label="Latest exchange"><h3>Latest exchange</h3>{current ? <Turn turn={current} query={query} /> : <p className="empty-reading">Start with an unfinished thought. There is no need to agree with the selected reading.</p>}</section>
    <section className="developed-here" aria-label="Developed here"><h3>Developed here</h3><p className="section-context">Changes saved in Thoughtloom, separate from what a response says.</p>
      {ideas.map((change) => {
        const item = model.items.find((entry) => entry.id === change.id), version = item?.history.find((version) => version.id === change.versionId);
        return <article className="developed-idea" key={`${change.id}-${change.versionId}`}><p className="attribution"><span>AI developing idea</span><span className="hypothesis-state">Tentative</span></p>{version ? <><p className="current-formulation">{version.text}</p><EvidenceLinks ids={version.evidenceSourceIds} sources={model.evidenceSources} query={query} /></> : <p>The recorded version is outside this bounded context view. Open the idea to inspect available history.</p>}<Link className="text-link" href={inquiryHref(item?.sourceId ?? model.source.id, query, change.id)} onNavigate={item && navigation?.root === item.sourceId ? (event) => { event.preventDefault(); navigation.openItem(item); } : undefined}>Open developing idea</Link>{item?.derivation && <Link className="text-link" href={discussionHref(item.sourceId, item.derivation.dialogueId, query, item.derivation.turnId)} onNavigate={navigation?.root === item.sourceId ? (event) => { event.preventDefault(); navigation.openDiscussion(item.derivation!.dialogueId, item.derivation!.turnId); } : undefined}>From this discussion</Link>}</article>;
      })}
      {!changes.length && <p className="empty-reading">No confirmed changes for this turn.</p>}
      {changes.some((change) => change.kind !== "developing-idea") && <p className="section-context">Other confirmed reading, connection or alias changes can be inspected in the recorded context below.</p>}
    </section>
    {older.length > 0 && <details className="earlier-exchanges" open={openEarlier} onToggle={(event) => setOpenEarlier(event.currentTarget.open)}><summary role="button">Earlier exchanges</summary><section aria-label="Earlier exchanges">{older.map((turn) => <Turn key={turn.id} turn={turn} query={query} />)}</section></details>}
    {state.dialogue?.turnsTruncated && <p className="history-limit">Only the latest saved exchanges are shown by this bounded view. Earlier input remains stored; older-history navigation is not available here.</p>}
    <p className="discussion-budget">The agent receives bounded recent context, not unlimited conversation history. Reloading resumes saved turns; unsaved drafts stay only in this open page. Stop is best effort, not rollback.</p>
  </section>;
}
