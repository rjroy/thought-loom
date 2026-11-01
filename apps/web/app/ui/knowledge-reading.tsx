"use client";

import { useState } from "react";
import type { EvidenceSource, ItemView, RelationshipView } from "@thoughtloom/contracts";
import Link from "next/link";
import { discussionHref, inquiryHref } from "../../lib/links";
import EvidenceLinks from "./evidence-links";
import { useDevelopmentNavigation } from "./development-navigation";
import FlowArrow from "./flow-arrow";
import { ThoughtTitleText } from "./thought-title";
import ThoughtContent from "./thought-content";

export function InterpretationReading({ item, sources, selected, query = "", onDiscuss, onRestore, onCorrect, busy = false }: { item: ItemView; sources: EvidenceSource[]; selected: boolean; query?: string; onDiscuss?: () => void; onRestore?: (version: string) => void; onCorrect?: () => void; busy?: boolean }) {
  const navigation = useDevelopmentNavigation();
  const attribution = item.current.author === "ai" ? item.kind === "interpretation" ? "AI interpretation" : "AI developing idea" : "Your recorded formulation";
  return <article className={`interpretation-reading thought-reading thought-reading-compact${selected ? " matched-reading" : ""}`} id={`item-${item.id}`} tabIndex={-1} data-role={item.current.author === "user" ? "user" : item.kind === "developing-idea" ? "idea" : "ai"}>
    <ThoughtContent title={<ThoughtTitleText target={{ kind: "item", itemId: item.id, versionId: item.current.id }} initial={item.title} />}
      body={<p className="current-formulation thought-body">{item.current.text}</p>}
      metadata={<><p className="attribution"><span>{attribution}</span>{item.current.author === "ai" && <span className="hypothesis-state">Tentative</span>}</p>{selected && <p className="selection-context">Current formulation</p>}</>}
      actions={<><details className="evidence-disclosure"><summary role="button">Evidence</summary><EvidenceLinks ids={item.current.evidenceSourceIds} sources={sources} query={query} /></details>
    {item.derivation && <Link className="text-link derivation-link" href={discussionHref(item.sourceId, item.derivation.dialogueId, query, item.derivation.turnId)} onNavigate={navigation?.root === item.sourceId ? (event) => { event.preventDefault(); navigation.openDiscussion(item.derivation!.dialogueId, item.derivation!.turnId); } : undefined}>From this discussion</Link>}
    <div className="claim-actions">{onDiscuss && <button className="button secondary" type="button" onClick={onDiscuss}>Discuss this reading</button>}{onCorrect && <button className="text-button" type="button" disabled={busy} onClick={onCorrect}>Use my saved thought as formulation</button>}</div>
    <details className="reading-history"><summary role="button">View history</summary><section aria-label="Formulation history"><ol>{item.history.map((version, index) => <li key={version.id} id={`version-${version.id}`} tabIndex={-1}><p className="version-meta">{item.historyTruncated ? "Shown version" : "Version"} {index + 1}{version.id === item.current.id ? " · Current" : ""} · {version.author === "ai" ? "AI-authored" : "Written by you"}</p><p>{version.text}</p><EvidenceLinks ids={version.evidenceSourceIds} sources={sources} prefix="Version evidence:" query={query} />{onRestore && version.id !== item.current.id && <button className="text-button" type="button" disabled={busy} onClick={() => onRestore(version.id)}>Restore this version</button>}</li>)}</ol>{item.historyTruncated && <p className="history-limit">Only the latest {item.history.length} versions are shown. Older history remains stored.</p>}</section></details></>} />
  </article>;
}

export function ConnectionReading({ relation, items, sources, sourceId, query, focalId, onDiscuss, onReject, onRestore, busy = false }: { relation: RelationshipView; items: ItemView[]; sources: EvidenceSource[]; sourceId: string; query: string; focalId?: string; onDiscuss?: () => void; onReject?: (reason: string) => Promise<boolean>; onRestore?: (version: string) => void; busy?: boolean }) {
  const [rejecting, setRejecting] = useState(false), [reason, setReason] = useState("");
  const from = items.find((item) => item.id === relation.fromItemId);
  const to = items.find((item) => item.id === relation.toItemId);
  if (!from || !to) return <p role="alert">This connection could not be resolved. Open the saved original instead.</p>;
  const connected = from.sourceId === sourceId ? to : from;
  return <article className="connection-reading" data-from-focal={relation.fromItemId === focalId}>
    <p className="attribution"><span>{relation.current.author === "ai" ? "AI suggestion" : "Your recorded connection"}</span><span className="hypothesis-state">{relation.current.status === "rejected" ? "Rejected" : "Active hypothesis"}</span></p>
    <div className="connection-direction"><p className="connection-from relationship-endpoint" data-role={from.current.author === "user" ? "user" : from.kind === "developing-idea" ? "idea" : "ai"}><span>From</span> {from.current.text}</p><div className="relationship-verb"><strong>{relation.type === "supports" ? "Supports" : relation.type === "challenges" ? "Challenges" : "Suggests"}</strong><FlowArrow direction="across" /></div><p className="relationship-endpoint" data-role={to.current.author === "user" ? "user" : to.kind === "developing-idea" ? "idea" : "ai"}>{to.current.text}</p></div>
    <p className="connection-rationale">{relation.current.rationale}</p>
    <details className="evidence-disclosure"><summary role="button">Evidence</summary><EvidenceLinks ids={relation.current.evidenceSourceIds} sources={sources} query={query} /></details>
    <Link className="text-link" href={inquiryHref(connected.sourceId, query, connected.id)}>Open connected thought</Link>
    <div className="claim-actions">{onDiscuss && <button className="button secondary" type="button" onClick={onDiscuss}>Discuss this connection</button>}{onReject && relation.current.status === "active" && <button className="text-button" type="button" disabled={busy} onClick={() => setRejecting(true)}>Reject connection</button>}{onRestore && relation.current.status === "rejected" && relation.history.some((v) => v.status === "active") && <button className="text-button" type="button" disabled={busy} onClick={() => onRestore(relation.history.findLast((v) => v.status === "active")!.id)}>Restore connection</button>}</div>
    {rejecting && onReject && <form className="rejection-form" onSubmit={async (event) => { event.preventDefault(); if (await onReject(reason)) { setRejecting(false); setReason(""); } }}>
      <label htmlFor={`reason-${relation.id}`}>Reason for rejecting this connection</label><textarea id={`reason-${relation.id}`} value={reason} onChange={(event) => setReason(event.target.value)} required maxLength={32_000} readOnly={busy} rows={3} />
      <p className="section-context">Your reason becomes an attributed revision. Evidence and earlier history remain available.</p>
      <div className="claim-actions"><button className="button secondary" type="submit" disabled={busy || !reason.trim()}>Confirm rejection</button><button className="text-button" type="button" disabled={busy} onClick={() => setRejecting(false)}>Cancel</button></div>
    </form>}
    <details className="reading-history"><summary role="button">View history</summary><section aria-label="Connection history"><ol>{relation.history.map((version, index) => <li key={version.id} id={`version-${version.id}`} tabIndex={-1}><p className="version-meta">{relation.historyTruncated ? "Shown version" : "Version"} {index + 1}{version.id === relation.current.id ? " · Current" : ""} · {version.author === "ai" ? "AI-authored" : "Written by you"} · {version.status}</p><p>{version.rationale}</p><EvidenceLinks ids={version.evidenceSourceIds} sources={sources} prefix="Version evidence:" query={query} />{onRestore && version.id !== relation.current.id && <button className="text-button" type="button" disabled={busy} onClick={() => onRestore(version.id)}>Restore this version</button>}</li>)}</ol>{relation.historyTruncated && <p className="history-limit">Only the latest {relation.history.length} versions are shown. Older history remains stored.</p>}</section></details>
  </article>;
}
