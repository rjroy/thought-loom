"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { parseInquiryView, parseItemView, parseRelationshipView, type DialogueSelection, type DialogueView, type InquiryView, type WeavingStatusView } from "@thoughtloom/contracts";
import { discussionHref, inquiryHref, readableDate } from "../../lib/links";
import { DevelopmentError, postDevelopment } from "../../lib/development-client";
import { InterpretationReading, ConnectionReading } from "./knowledge-reading";
import WeavingStatus from "./weaving-status";
import useDevelopment from "./use-development";
import Development from "./development";
import { DevelopmentNavigation, revealInquiryAnchor } from "./development-navigation";
import FollowUpStatus from "./follow-up-status";
import { pendingFollowUpVersions, stageFollowUpChanges, type PendingFollowUpVersion } from "../../lib/follow-up-client";

export default function InquiryContext({ initial, weaving, query, selectedId, initialDialogue, dialogueError = "" }: { initial: InquiryView; weaving: WeavingStatusView | null; query: string; selectedId: string; initialDialogue: DialogueView | null; dialogueError?: string }) {
  const [model, setModel] = useState(initial), [refreshError, setRefreshError] = useState(false);
  const [pendingFindings, setPendingFindings] = useState<PendingFollowUpVersion[]>([]);
  const [openedId, setOpenedId] = useState(selectedId);
  useEffect(() => { setOpenedId(selectedId); }, [selectedId]);
  // The two initial server reads are not one transaction. Reconcile once even
  // when status is unchanged, in case a run settled between those reads.
  const last = useRef(""), inFlight = useRef<Promise<boolean> | null>(null), reloadRequested = useRef(false), dialogueSignature = useRef("");
  const acceptRequested = useRef(false), historyAnchor = useRef("");
  const visibleVersions = useRef(new Set([...initial.items.flatMap((item) => item.history.map((version) => version.id)), ...initial.relationships.flatMap((relation) => relation.history.map((version) => version.id))]));
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const navigationIntent = useRef(0);
  useEffect(() => () => { navigationIntent.current++; }, []);
  const [worker, setWorker] = useState(weaving?.worker ?? null);
  const [mutationError, setMutationError] = useState(""), [mutationBusy, setMutationBusy] = useState(false);
  const mutationRunning = useRef(false), mutationKeys = useRef(new Map<string, { signature: string; key: string }>());
  const source = initial.source;
  const reloadKnowledge = useCallback(async (acceptFollowUps = false) => {
    reloadRequested.current = true;
    if (acceptFollowUps) acceptRequested.current = true;
    if (inFlight.current) return inFlight.current;
    const task = (async () => {
      let loaded = false;
      do {
        reloadRequested.current = false;
        const accept = acceptRequested.current; acceptRequested.current = false;
        try {
          const response = await fetch(`/api/sources/${source.id}/inquiry`, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
          const next = response.ok ? parseInquiryView(await response.json()) : null;
          if (!next || next.source.id !== source.id || next.source.text !== source.text || next.source.createdAt !== source.createdAt || next.source.provenance !== source.provenance) throw new Error("Context unavailable");
          if (accept) {
            for (const item of next.items) for (const version of item.history) visibleVersions.current.add(version.id);
            for (const relation of next.relationships) for (const version of relation.history) visibleVersions.current.add(version.id);
          }
          setPendingFindings(pendingFollowUpVersions(next, visibleVersions.current));
          setModel((previous) => stageFollowUpChanges(previous, next, visibleVersions.current)); setRefreshError(false); loaded = true;
        } catch { setRefreshError(true); loaded = false; }
      } while (reloadRequested.current);
      return loaded;
    })();
    inFlight.current = task;
    try { return await task; } finally { inFlight.current = null; }
  }, [source.id, source.text, source.createdAt, source.provenance]);
  const refresh = useCallback(async (snapshot: WeavingStatusView) => {
    setWorker(snapshot.worker);
    const signature = JSON.stringify(snapshot);
    if (signature === last.current) return;
    if (await reloadKnowledge()) last.current = signature;
  }, [reloadKnowledge]);
  const snapshot = useCallback((view: DialogueView) => {
    for (const turn of view.turns) for (const change of turn.changes) if (change.versionId) visibleVersions.current.add(change.versionId);
    const signature = JSON.stringify(view.turns.map((turn) => [turn.id, turn.status, turn.changes]));
    if (signature !== dialogueSignature.current) void reloadKnowledge().then((loaded) => { if (loaded) dialogueSignature.current = signature; });
  }, [reloadKnowledge]);
  useEffect(() => { void reloadKnowledge(); }, [initial, reloadKnowledge]);
  useEffect(() => {
    const reveal = () => {
      const hash = window.location.hash;
      if (!hash.startsWith("#version-")) { historyAnchor.current = ""; return; }
      if (historyAnchor.current === hash || !document.getElementById(hash.slice(1))) return;
      historyAnchor.current = hash; revealInquiryAnchor(hash.slice(1));
    };
    reveal(); window.addEventListener("hashchange", reveal);
    return () => window.removeEventListener("hashchange", reveal);
  }, [model]);
  const initialSelection = useMemo<DialogueSelection>(() => {
    const selected = initial.items.find((item) => item.id === selectedId && item.sourceId === source.id);
    return initialDialogue?.selection ?? (selected ? { kind: "item", id: selected.id, versionId: selected.current.id } : { kind: "source", id: source.id });
  }, [initial.items, initialDialogue, selectedId, source.id]);
  const development = useDevelopment({ root: source.id, initialSelection, initialDialogue, onSnapshot: snapshot });
  function discuss(selection: DialogueSelection) {
    void development.select(selection);
    requestAnimationFrame(() => composerRef.current?.focus());
  }
  async function openItem(item: InquiryView["items"][number]) {
    const intent = ++navigationIntent.current;
    setOpenedId(item.id);
    window.history.pushState(null, "", inquiryHref(source.id, query, item.id));
    await development.select({ kind: "item", id: item.id, versionId: item.current.id });
    if (intent !== navigationIntent.current || window.location.pathname !== `/sources/${source.id}/inquiry`) return;
    const address = new URL(window.location.href); address.hash = `item-${item.id}`;
    window.history.replaceState(null, "", address); revealInquiryAnchor(`item-${item.id}`);
  }
  async function openDiscussion(id: string, turnId: string) {
    const intent = ++navigationIntent.current;
    const view = await development.activateDialogue(id);
    if (!view || intent !== navigationIntent.current || window.location.pathname !== `/sources/${source.id}/inquiry`) return;
    window.history.pushState(null, "", discussionHref(source.id, view.id, query, turnId));
    revealInquiryAnchor(`turn-${turnId}`);
  }
  async function mutate(path: string, input: object): Promise<boolean> {
    if (mutationRunning.current) return false;
    mutationRunning.current = true; setMutationBusy(true); setMutationError("");
    const signature = JSON.stringify(input), prior = mutationKeys.current.get(path);
    const command = prior?.signature === signature ? prior : { signature, key: crypto.randomUUID() };
    mutationKeys.current.set(path, command);
    try {
      const raw = await postDevelopment(path, input, command.key);
      const result = path.startsWith("/api/items/") ? parseItemView(raw) : parseRelationshipView(raw);
      if (!result || result.current.author !== "user") throw new DevelopmentError(503, "invalid_receipt");
      mutationKeys.current.delete(path); await reloadKnowledge(); return true;
    } catch (error) {
      if (error instanceof DevelopmentError && error.status === 409) {
        mutationKeys.current.delete(path); setMutationError("This reading or connection changed before your revision could be applied. Review the newer version and choose again; nothing was overwritten.");
        await reloadKnowledge();
      } else setMutationError("Your revision could not be confirmed. Your input is kept. Check the current history before trying the same action again; it may already have been saved.");
      return false;
    } finally { mutationRunning.current = false; setMutationBusy(false); }
  }
  const interpretations = model.items.filter((item) => item.sourceId === source.id);
  return <>
    {model.truncated && <p className="context-limit" role="status">This view shows a bounded neighborhood. Some recorded context is not shown; your full original remains available.</p>}
    <DevelopmentNavigation.Provider value={{ root: source.id, openItem: (item) => void openItem(item), openDiscussion: (id, turnId) => void openDiscussion(id, turnId) }}><div className="inquiry-grid">
      <Development state={development} model={model} query={query} worker={worker} composerRef={composerRef} initialError={dialogueError} />
      <section className="inquiry-source" id="original-source" aria-label="Original source">
        <h2>Original source</h2><p className="record-identity">Your words · Unchanged</p>
        <dl className="inquiry-source-meta"><div><dt>Origin</dt><dd>{source.provenance}</dd></div><div><dt>Captured</dt><dd><time dateTime={source.createdAt}>{readableDate(source.createdAt)}</time></dd></div></dl>
        <p className="source-preview">{source.text.slice(0, 240)}{source.text.length > 240 ? "…" : ""}</p>
        <details className="source-disclosure"><summary role="button">Read full original</summary><article className="original-text inquiry-original" aria-label="Original thought">{source.text}</article></details>
        <Link className="text-link" href={`/sources/${source.id}`}>Open saved original</Link>
        <button type="button" className="button secondary" onClick={() => discuss({ kind: "source", id: source.id })}>Discuss original</button>
        <WeavingStatus sourceId={source.id} initial={weaving} onSnapshot={refresh} />
      </section>
      <div className="recorded-context">
        {mutationError && <div className="notice error-notice" role="alert"><p>{mutationError}</p></div>}
        {refreshError && <p className="status-recovery" role="status">Recorded context could not refresh. Existing readings are kept below; checking status will try loading updates again.</p>}
        <section aria-label="Interpretations" className="interpretations-section"><h2>Interpretations</h2><p className="section-context">Recorded readings, not established facts or a statement of what you believe.</p>{interpretations.length ? interpretations.map((item) => <InterpretationReading key={item.id} item={item} sources={model.evidenceSources} selected={item.id === openedId} query={query} busy={mutationBusy}
          onDiscuss={() => discuss({ kind: "item", id: item.id, versionId: item.current.id })}
          onRestore={(version) => void mutate(`/api/items/${item.id}/restore`, { expectedVersionId: item.current.id, restoreVersionId: version })}
          onCorrect={development.selection.kind === "item" && development.selection.id === item.id && development.latest ? () => void mutate(`/api/items/${item.id}/correct`, { expectedVersionId: item.current.id, sourceId: development.latest!.source.id, text: development.latest!.source.text }) : undefined} />) : <p className="empty-reading">No interpretations recorded yet.</p>}</section>
        <section aria-label="Connections" className="connections-section"><h2>Connections</h2><p className="section-context">A recorded relationship needs a reason. Similar search wording alone is not evidence.</p>{model.relationships.length ? model.relationships.map((relation) => <ConnectionReading key={relation.id} relation={relation} items={model.items} sources={model.evidenceSources} sourceId={source.id} query={query} busy={mutationBusy}
          onDiscuss={() => { const from = model.items.find((item) => item.id === relation.fromItemId), to = model.items.find((item) => item.id === relation.toItemId); if (from && to) discuss({ kind: "relationship", id: relation.id, versionId: relation.current.id, fromVersionId: from.current.id, toVersionId: to.current.id }); }}
          onReject={(reason) => mutate(`/api/relationships/${relation.id}/reject`, { expectedVersionId: relation.current.id, rationale: reason, evidenceSourceIds: relation.current.evidenceSourceIds })}
          onRestore={(version) => void mutate(`/api/relationships/${relation.id}/restore`, { expectedVersionId: relation.current.id, restoreVersionId: version })} />) : <p className="empty-reading">No connections recorded yet.</p>}</section>
      </div>
    </div><FollowUpStatus sourceId={source.id} query={query} initialModel={initial} pendingFindings={pendingFindings} onView={() => reloadKnowledge(true)} onWorker={setWorker} /></DevelopmentNavigation.Provider>
  </>;
}
