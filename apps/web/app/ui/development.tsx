"use client";

import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import Link from "next/link";
import { DIALOGUE_LIMITS, type DialogueSelectedContext, type DialogueSelection, type DialogueTurnView, type InquiryView, type ItemView, type WeavingWorkerView } from "@thoughtloom/contracts";
import { discussionHref, inquiryHref, readableDate, sourceHref } from "../../lib/links";
import EvidenceLinks from "./evidence-links";
import { isActiveTurn } from "./use-development";
import type useDevelopment from "./use-development";
import { useDevelopmentNavigation } from "./development-navigation";
import FlowArrow from "./flow-arrow";
import ThoughtTitleEditor, { ThoughtTitleText } from "./thought-title";
import ThoughtContent from "./thought-content";

export type DevelopmentState = ReturnType<typeof useDevelopment>;

function TargetQuote({ context, compact = false }: { context: DialogueSelectedContext; compact?: boolean }) {
  const text = context.kind === "relationship" ? context.rationale : context.text;
  return <ThoughtContent body={<><blockquote className="thought-body">{compact ? <p>{text.length > 1_200 ? `${text.slice(0, 240)}…` : text}</p> : <h1>{text.length > 1_200 ? `${text.slice(0, 240)}…` : text}</h1>}</blockquote>
    {text.length > 1_200 && <details className="target-disclosure"><summary role="button">Read selected context · Full text</summary><blockquote>{text}</blockquote></details>}
    {context.kind === "relationship" && <div className="target-relationship"><p className="target-endpoint"><strong>From: </strong><span>{context.from.version.text}</span></p><p className="target-endpoint"><strong>{context.type === "suggests" ? "Suggests" : context.type === "supports" ? "Supports" : "Challenges"}: </strong><span>{context.to.version.text}</span></p></div>}</>}
    metadata={<p className="record-identity">{context.kind === "relationship" ? `Pinned connection · ${context.author === "ai" ? "AI suggestion" : "Your recorded connection"}` : context.kind === "source" ? "Your unchanged original" : `Pinned reading · ${context.author === "ai" ? "AI-authored · Tentative" : "Written by you"}`}</p>} />;
}
function FallbackQuote({ selection, model, compact = false }: { selection: DialogueSelection; model: InquiryView; compact?: boolean }) {
  if (selection.kind === "source") return <TargetQuote context={{ ...model.source, kind: "source" }} compact={compact} />;
  if (selection.kind === "item") {
    const item = model.items.find((item) => item.id === selection.id), version = item?.history.find((v) => v.id === selection.versionId);
    return version ? <TargetQuote context={{ ...version, kind: "item" }} /> : <p>Loading the exact selected reading…</p>;
  }
  const relation = model.relationships.find((r) => r.id === selection.id), version = relation?.history.find((v) => v.id === selection.versionId);
  return <><p className="record-identity">Pinned connection</p><blockquote>{version?.rationale ?? "Loading the exact selected connection…"}</blockquote></>;
}
function Turn({ turn, query, correctionLink, children, progress }: { turn: DialogueTurnView; query: string; correctionLink?: string; children?: ReactNode; progress?: ReactNode }) {
  const canonical = turn.assistant !== undefined;
  const preview = progress && !canonical && ["running", "uncertain"].includes(turn.status) ? turn.preview : undefined;
  const text = canonical ? turn.assistant!.text : preview?.text ?? "";
  const pending = ["queued", "running", "uncertain"].includes(turn.status);
  return <section className="exchange" id={`turn-${turn.id}`} tabIndex={-1} data-has-ideas={!!children}>
    <div className="user-development"><div className="exchange-input thought-reading thought-reading-compact" data-role="user"><ThoughtContent body={<p className="turn-text thought-body">{turn.source.text}</p>} metadata={<p className="attribution">Your thought saved</p>} actions={<><details className="turn-provenance"><summary role="button">Saved input</summary><p className="turn-date"><time dateTime={turn.source.createdAt}>{readableDate(turn.source.createdAt)}</time></p><Link className="text-link" href={sourceHref(turn.source.id, query)}>View discussion input</Link>{correctionLink && <Link className="text-link" href={correctionLink}>Review this reading</Link>}</details>{progress && <a className="text-link response-jump" href={`#response-${turn.id}`}>View response</a>}</>} />{progress}</div>{children}</div>
    <div className="exchange-response" data-role="ai" id={`response-${turn.id}`} tabIndex={-1}>
      <FlowArrow direction="across" className="response-arrow" /><div className="exchange-identity"><h3>Agent response</h3><p className="record-identity">AI-authored</p>{preview && <span className="response-preview-label">Preview</span>}</div>
      {turn.status === "abandoned" && !progress && <><p className="response-state">Abandoned locally</p><p className="response-state">Native outcome unconfirmed.</p></>}
      {canonical && text.length > 6_000 ? <><p className="response-excerpt">{text.slice(0, 360)}…</p><details className="full-reply"><summary role="button">Read full reply</summary><article className="canonical-response" aria-label="Agent response">{text}</article></details></> : <article className="canonical-response" aria-label="Agent response">{text}</article>}
      {preview?.truncated && <p className="response-state">Preview shortened</p>}
      {!text && <p className="response-state">{pending && !canonical ? turn.status === "queued" ? "Waiting for agent" : turn.status === "uncertain" ? "Outcome uncertain · Check status" : "Waiting for response…" : turn.status === "completed" ? "Response complete · No written reply." : turn.status === "failed" || turn.status === "interrupted" ? `Response ${turn.status} · No written reply saved.` : "No written reply."}</p>}
    </div>
  </section>;
}
function progressCopy(turn: DialogueTurnView | undefined): { title: string; text: string } {
  if (!turn) return { title: "Ready to develop", text: "Your next thought will be saved before any agent run begins." };
  switch (turn.status) {
    case "queued": return { title: "Waiting for agent", text: "" };
    case "running": return { title: "Agent responding", text: "" };
    case "uncertain": return { title: "Outcome uncertain", text: "The service may have accepted this turn. Check status; do not resend it as a new thought." };
    case "completed": return { title: "Response complete", text: "" };
    case "interrupted": return { title: "Response interrupted", text: "Saved input and recorded changes are kept." };
    case "failed": return { title: "Response failed", text: "Saved input and recorded changes are kept. You can send a new thought." };
    case "abandoned": return { title: "Abandoned locally", text: "Native outcome unconfirmed. Saved input and recorded changes are kept." };
  }
}

export default function Development({ state, model, query, worker, composerRef, initialError, overviewItem, onDiscussOverview, connections, children }: { state: DevelopmentState; model: InquiryView; query: string; worker: WeavingWorkerView | null; composerRef: RefObject<HTMLTextAreaElement | null>; initialError: string; overviewItem?: ItemView; onDiscussOverview?: () => void; connections?: ReactNode; children?: ReactNode }) {
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
  const selectedItem = selection.kind === "item" ? model.items.find((item) => item.id === selection.id) : undefined;
  const derivation = selectedItem?.derivation;
  const challenge = derivation ? model.evidenceSources.find((source) => source.id === derivation.turnSourceId) : undefined;
  const prior = derivation?.itemId ? model.items.find((item) => item.id === derivation.itemId)?.history.find((version) => version.id === derivation.versionId) : undefined;
  const pinnedVersion = selection.kind === "item" ? selectedItem?.history.find((version) => version.id === selection.versionId) : undefined;
  const pinnedTitle = selection.kind === "item" && model.selectedTarget?.id === selection.id && model.selectedTarget.versionId === selection.versionId ? model.selectedTarget.title
    : selectedItem?.title && (selectedItem.current.id === (selection.kind === "item" ? selection.versionId : "") || selectedItem.title.author === "user") ? selectedItem.title : undefined;
  const pinnedAuthor = selected ? selected.kind === "source" ? "user" : selected.author : pinnedVersion?.author ?? (selection.kind === "source" ? "user" : selectedRelationship?.history.find((version) => version.id === selection.versionId)?.author);
  const targetRole = selection.kind === "source" ? "original" : pinnedAuthor === "user" ? "user" : pinnedAuthor === "ai" ? selectedItem?.kind === "developing-idea" ? "idea" : "ai" : undefined;
  const sourceEvidence = pinnedVersion?.evidenceSourceIds.includes(model.source.id) ?? false;
  const linkedToCurrent = (item: ItemView | undefined) => !!current && !!state.dialogue && item?.derivation?.dialogueId === state.dialogue.id && item.derivation.turnId === current.id && item.derivation.turnSourceId === current.source.id;
  const hasLinkedIdeas = ideas.some((change) => linkedToCurrent(model.items.find((item) => item.id === change.id)));
  const responseProgress = <section className="dialogue-status" aria-label="Dialogue status"><div role="status" aria-live="polite" aria-atomic="true">{current && <><h3>{copy.title}</h3>{copy.text && <p>{copy.text}</p>}{current.status === "completed" && !changes.length && <p>No confirmed changes for this turn.</p>}</>}{active && current.stopRequested && <><p className="stop-request">Stop requested</p><p>Waiting for settlement; completion can still win. Recorded changes are kept.</p></>}</div>
    {worker && !worker.configured && <p>Agent not set up · Input can be saved, but responses are waiting. <Link href="/setup/weaving">Set up weaving</Link></p>}
    {worker?.configured && ["unavailable", "failed", "stopped"].includes(worker.state) && <p>Agent service unavailable · Saved input is kept.</p>}
    {!worker && <p className="section-context">Agent availability unknown · Check status.</p>}
    {(current || state.blocked || !worker) && <div className="claim-actions"><button type="button" className="text-button" onClick={() => void state.check()}>Check status</button>{active && current?.actions?.stop.eligible && <button type="button" className="text-button" disabled={state.stopPending} onClick={() => void state.stop()}>Stop response</button>}</div>}
  </section>;
  const confirmedIdeas = ideas.length > 0 ? <section className="developed-here" aria-label="Developed here" data-linked={hasLinkedIdeas}>
    {hasLinkedIdeas && <svg className="input-idea-route" viewBox="0 0 1000 32" preserveAspectRatio="none" aria-hidden="true" focusable="false"><path d="M500 0V8Q500 16 492 16H8Q0 16 0 24V32" /></svg>}
    <h2>Developed here</h2><div className="idea-branches">{ideas.map((change) => {
      const item = model.items.find((entry) => entry.id === change.id), version = item?.history.find((version) => version.id === change.versionId);
      return <article className="developed-idea thought-reading thought-reading-compact" data-role="idea" key={`${change.id}-${change.versionId}`}>
        {linkedToCurrent(item) && <FlowArrow direction="across" className="idea-inbound" />}
        <ThoughtContent title={item && change.versionId && <ThoughtTitleText target={{ kind: "item", itemId: item.id, versionId: change.versionId }} initial={item.current.id === change.versionId || item.title?.author === "user" ? item.title : undefined} />}
          body={version ? <p className="current-formulation thought-body">{version.text}</p> : <p>Recorded version outside this view. Open the idea for available history.</p>}
          metadata={<p className="attribution"><span>AI developing idea</span><span className="hypothesis-state">Tentative</span><span>Saved</span></p>}
          actions={<>{version && <details className="evidence-disclosure"><summary role="button">Evidence</summary><EvidenceLinks ids={version.evidenceSourceIds} sources={model.evidenceSources} query={query} /></details>}<Link className="text-link" href={inquiryHref(item?.sourceId ?? model.source.id, query, change.id)} onNavigate={item && navigation?.root === item.sourceId ? (event) => { event.preventDefault(); navigation.openItem(item); } : undefined}>Open developing idea</Link>{item?.derivation && <Link className="text-link" href={discussionHref(item.sourceId, item.derivation.dialogueId, query, item.derivation.turnId)} onNavigate={navigation?.root === item.sourceId ? (event) => { event.preventDefault(); navigation.openDiscussion(item.derivation!.dialogueId, item.derivation!.turnId); } : undefined}>From this discussion</Link>}</>} />
      </article>;
    })}</div></section> : null;
  return <section className="development-area" id="development" aria-label="Develop this thought" data-has-turn={!!current} data-emerging={!!derivation} data-selection={selection.kind} data-overview={!!overviewItem}>
    {overviewItem && <section className="working-reading thought-reading thought-reading-focal" aria-label="Reading to explore" data-role={overviewItem.current.author === "user" ? "user" : overviewItem.kind === "developing-idea" ? "idea" : "ai"} data-source-backed={overviewItem.current.evidenceSourceIds.includes(model.source.id)}>{overviewItem.current.evidenceSourceIds.includes(model.source.id) && <FlowArrow className="source-to-reading" />}
      <ThoughtTitleEditor target={{ kind: "item", itemId: overviewItem.id, versionId: overviewItem.current.id }} initial={overviewItem.title} kind={overviewItem.kind === "developing-idea" ? "idea" : "reading"}>{({ title, controls }) => <ThoughtContent title={title} body={<h1 className="thought-body">{overviewItem.current.text}</h1>}
        metadata={<p className="attribution"><span>{overviewItem.current.author === "user" ? "Your recorded formulation" : overviewItem.kind === "interpretation" ? "AI interpretation" : "AI developing idea"}</span>{overviewItem.current.author === "ai" && <span>Tentative</span>}</p>}
        actions={<><button className="text-button" type="button" onClick={onDiscussOverview}>Discuss this reading</button>{controls}</>} />}</ThoughtTitleEditor>
    </section>}
    <section className={`discussion-target thought-reading ${overviewItem ? "thought-reading-context" : "thought-reading-focal"}`} id="discussion-target" tabIndex={-1} aria-label="Discussion target" data-role={targetRole} data-source-backed={sourceEvidence && !overviewItem && !derivation}>{sourceEvidence && !overviewItem && !derivation && <FlowArrow className="source-to-reading" />}
      {selection.kind === "item" && selectedItem ? <ThoughtTitleEditor target={{ kind: "item", itemId: selection.id, versionId: selection.versionId }} initial={pinnedTitle} kind={selectedItem.kind === "developing-idea" ? "idea" : "reading"}>{({ title, controls }) => <>{title}{selected ? <TargetQuote context={selected} compact={!!overviewItem} /> : <FallbackQuote selection={state.selection} model={model} compact={!!overviewItem} />}<div className="thought-reading-actions">{controls}</div></>}</ThoughtTitleEditor> : <>{selected ? <TargetQuote context={selected} compact={!!overviewItem} /> : <FallbackQuote selection={state.selection} model={model} compact={!!overviewItem} />}</>}
      {overviewItem && <p className="composer-context">Discussion target · Original</p>}{changed && <p className="context-change">Current formulation changed · This discussion keeps its pinned revision.</p>}</section>
    {derivation && <section className="idea-derivation" aria-label="Idea derivation"><h2>How this idea emerged</h2><div className="derivation-chain"><svg className="provenance-paths" viewBox="0 0 1200 56" preserveAspectRatio="none" aria-hidden="true" focusable="false">{sourceEvidence && <path d={prior ? "M200 56V32Q200 24 208 24H592Q600 24 600 16V0" : "M300 56V32Q300 24 308 24H592Q600 24 600 16V0"} />}{prior && <path d="M600 56V0" />}<path d={prior ? "M1000 56V32Q1000 24 992 24H608Q600 24 600 16V0" : "M900 56V32Q900 24 892 24H608Q600 24 600 16V0"} /><path d="M592 9L600 1L608 9" /></svg><span className="mobile-provenance-rail" aria-hidden="true"><FlowArrow direction="up" /></span>
      <div className="derivation-card thought-reading thought-reading-compact" data-role="original">{sourceEvidence && <FlowArrow direction="left" className="provenance-join" />}<ThoughtContent body={<p className="thought-body">{model.source.text.slice(0, 180)}{model.source.text.length > 180 ? "…" : ""}</p>} actions={<a className="text-link" href="#original-source">Original thought</a>} /></div>
      {prior && <div className="derivation-card thought-reading thought-reading-compact" data-role={prior.author === "user" ? "user" : "ai"}><FlowArrow direction="left" className="provenance-join" /><ThoughtContent body={<p className="thought-body">{prior.text}</p>} metadata={<p className="record-identity">Earlier formulation · {prior.author === "user" ? "Written by you" : "AI-authored"}</p>} /></div>}
      <div className="originating-input derivation-card thought-reading thought-reading-compact" data-role="user"><FlowArrow direction="left" className="provenance-join" /><ThoughtContent body={challenge && <p className="thought-body">{challenge.excerpt}</p>} actions={<Link className="text-link" href={sourceHref(derivation.turnSourceId, query)}>Your discussion input</Link>} /></div>
    </div><Link className="text-link" href={discussionHref(model.source.id, derivation.dialogueId, query, derivation.turnId)} onNavigate={navigation?.root === model.source.id ? (event) => { event.preventDefault(); navigation.openDiscussion(derivation.dialogueId, derivation.turnId); } : undefined}>From this discussion</Link></section>}
    {initialError && <p className="notice error-notice" role="alert">{initialError}</p>}
    {current && <section className="latest-exchange" aria-label="Latest exchange">{!derivation && <svg className="claim-input-route" viewBox="0 0 1000 32" preserveAspectRatio="none" aria-hidden="true" focusable="false"><path className="claim-input-desktop" d="M500 0V8Q500 16 492 16H258Q250 16 250 24V31M244 23L250 31L256 23" /><path className="claim-input-phone" d="M500 0V31M480 23L500 31L520 23" /></svg>}<Turn turn={current} query={query} progress={responseProgress}>{confirmedIdeas}</Turn></section>}
    {connections}
    {children}
    {!current && responseProgress}
    {state.notice && <p role="status" className="status-recovery">{state.notice}</p>}
    {state.blocked && !active && <p className="status-recovery">Another response may be in progress. Draft kept · Check status before sending.</p>}
    {state.error && <div className="notice error-notice" role="alert"><p>{state.error}</p></div>}
    <form className="development-form" onSubmit={(event) => { event.preventDefault(); void state.send(); }}>
      <div className="composer-heading"><label htmlFor="development-thought">Develop this thought</label>{overviewItem && <span className="composer-context">Target: original</span>}<a className="text-link" href="#recorded-context">Readings and connections</a></div>
      <div className="composer-entry"><textarea ref={composerRef} id="development-thought" aria-describedby="development-draft" placeholder="Challenge this framing, or follow an idea…" value={state.draft} onChange={(event) => state.edit(event.target.value)} rows={2} maxLength={DIALOGUE_LIMITS.turnText} readOnly={state.opening || state.sending || !!state.pending} required /><button className="button primary" type="submit" disabled={state.opening || state.sending || state.loading || !state.draft.trim() || state.blocked}>{state.sending ? "Saving thought…" : state.error ? "Retry send" : "Send thought"}</button></div>
      <p id="development-draft" className="draft-state">{state.opening ? "Opening discussion…" : state.sending ? "Saving thought…" : state.pending ? "Save unconfirmed. Retry keeps these exact words." : state.draft ? "Draft · Save before leaving or reloading" : ""}</p>
    </form>
    {older.length > 0 && <details className="earlier-exchanges" open={openEarlier} onToggle={(event) => setOpenEarlier(event.currentTarget.open)}><summary role="button">Earlier exchanges</summary><section aria-label="Earlier exchanges">{older.map((turn) => <Turn key={turn.id} turn={turn} query={query} />)}</section></details>}
    {state.dialogue?.turnsTruncated && <p className="history-limit">Only the latest saved exchanges are shown by this bounded view. Earlier input remains stored; older-history navigation is not available here.</p>}
    <details className="discussion-budget"><summary role="button">About this discussion</summary><p>The agent receives bounded recent context, not unlimited conversation history. Reloading resumes saved turns; unsaved drafts stay only in this open page. Stop is best effort, not rollback.</p></details>
  </section>;
}
