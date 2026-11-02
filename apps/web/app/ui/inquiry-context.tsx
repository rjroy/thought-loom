"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { parseInquiryView, parseItemView, parseRelationshipView, type DialogueSelection, type DialogueView, type InquiryView, type WeavingStatusView } from "@thoughtloom/contracts";
import { discussionHref, inquiryHref, readableDate } from "../../lib/links";
import { DevelopmentError, postDevelopment } from "../../lib/development-client";
import { commandId } from "../../lib/command-id";
import { InterpretationReading, ConnectionReading } from "./knowledge-reading";
import WeavingStatus from "./weaving-status";
import useDevelopment from "./use-development";
import Development from "./development";
import { DevelopmentNavigation, revealInquiryAnchor } from "./development-navigation";
import FollowUpStatus from "./follow-up-status";
import ThoughtTitleEditor, { ThoughtTitles, useTitleObservations } from "./thought-title";
import ThoughtContent from "./thought-content";
import { pendingFollowUpVersions, stageFollowUpChanges, type PendingFollowUpVersion } from "../../lib/follow-up-client";

type InquiryContextProps = { initial: InquiryView; weaving: WeavingStatusView | null; query: string; selectedId: string; initialDialogue: DialogueView | null; dialogueError?: string };
export default function InquiryContext(props: InquiryContextProps) {
  return <ThoughtTitles key={props.initial.source.id} root={props.initial.source.id} initial={props.initial}><InquiryContents {...props} /></ThoughtTitles>;
}
function InquiryContents({ initial, weaving, query, selectedId, initialDialogue, dialogueError = "" }: InquiryContextProps) {
  const titleObservations = useTitleObservations();
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
  useEffect(() => () => { navigationIntent.current++; }, [selectedId, initial.selectedTarget?.versionId, initialDialogue?.id]);
  const [worker, setWorker] = useState(weaving?.worker ?? null);
  const [mutationError, setMutationError] = useState(""), [mutationBusy, setMutationBusy] = useState(false);
  const mutationRunning = useRef(false), mutationKeys = useRef(new Map<string, { signature: string; key: string }>());
  const source = initial.source;
  const projectionPath = `/api/sources/${source.id}/inquiry${initial.selectedTarget ? `?${new URLSearchParams({ itemId: initial.selectedTarget.id, versionId: initial.selectedTarget.versionId })}` : ""}`;
  const projection = useRef(projectionPath); projection.current = projectionPath;
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
          const path = projection.current, titleObservation = titleObservations.begin();
          const response = await fetch(path, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
          const next = response.ok ? parseInquiryView(await response.json()) : null;
          if (path !== projection.current) { reloadRequested.current = true; continue; }
          if (!next || next.source.id !== source.id || next.source.text !== source.text || next.source.createdAt !== source.createdAt || next.source.provenance !== source.provenance) throw new Error("Context unavailable");
          titleObservations.accept(titleObservation, next);
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
  }, [source.id, source.text, source.createdAt, source.provenance, titleObservations]);
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
    const pinned = initial.selectedTarget;
    return initialDialogue?.selection ?? (pinned ? { kind: "item", id: pinned.id, versionId: pinned.versionId } : selected ? { kind: "item", id: selected.id, versionId: selected.current.id } : { kind: "source", id: source.id });
  }, [initial.items, initial.selectedTarget, initialDialogue, selectedId, source.id]);
  useEffect(() => {
    if (window.location.hash === "#discussion-target") revealInquiryAnchor("discussion-target");
  }, [source.id, selectedId, initial.selectedTarget?.versionId]);
  const development = useDevelopment({ root: source.id, initialSelection, initialDialogue, onSnapshot: snapshot });
  function discuss(selection: DialogueSelection) {
    navigationIntent.current++;
    void development.select(selection);
    requestAnimationFrame(() => composerRef.current?.focus());
  }
  async function openItem(item: InquiryView["items"][number]) {
    const intent = ++navigationIntent.current, owner = document.activeElement;
    const isCurrent = () => intent === navigationIntent.current && window.location.pathname === `/sources/${source.id}/inquiry`;
    setOpenedId(item.id);
    window.history.pushState(null, "", inquiryHref(source.id, query, item.id));
    await development.select({ kind: "item", id: item.id, versionId: item.current.id });
    if (!isCurrent()) return;
    const address = new URL(window.location.href); address.hash = "discussion-target";
    window.history.replaceState(null, "", address); revealInquiryAnchor("discussion-target", { owner, isCurrent });
  }
  async function openDiscussion(id: string, turnId: string) {
    const intent = ++navigationIntent.current, owner = document.activeElement;
    const isCurrent = () => intent === navigationIntent.current && window.location.pathname === `/sources/${source.id}/inquiry`;
    const view = await development.activateDialogue(id);
    if (!view || !isCurrent()) return;
    window.history.pushState(null, "", discussionHref(source.id, view.id, query, turnId));
    revealInquiryAnchor(`turn-${turnId}`, { owner, isCurrent });
  }
  async function mutate(path: string, input: object): Promise<boolean> {
    if (mutationRunning.current) return false;
    mutationRunning.current = true; setMutationBusy(true); setMutationError("");
    const signature = JSON.stringify(input), prior = mutationKeys.current.get(path);
    const command = prior?.signature === signature ? prior : { signature, key: commandId() };
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
  // A reading can lead the overview without selecting it as the discussion target.
  const overviewItem = development.selection.kind === "source" && !development.latest
    ? interpretations.find((item) => item.kind === "interpretation") ?? interpretations[0] : undefined;
  return <>
    {model.truncated && <p className="context-limit" role="status">This view shows a bounded neighborhood. Some recorded context is not shown; your full original remains available.</p>}
    <DevelopmentNavigation.Provider value={{ root: source.id, openItem: (item) => void openItem(item), openDiscussion: (id, turnId) => void openDiscussion(id, turnId) }}><div className="inquiry-grid">
      <section className="inquiry-source thought-reading thought-reading-compact" id="original-source" aria-label="Original source" data-role="original">
        <ThoughtTitleEditor target={{ kind: "source" }} initial={model.source.title} kind="original" fallbackText={source.text}>{({ title, controls }) => <ThoughtContent title={title}
          body={null}
          metadata={<h2 className="attribution">Original · Unchanged</h2>}
          actions={<><details className="source-disclosure"><summary role="button">Read full original</summary><dl className="inquiry-source-meta"><div><dt>Origin</dt><dd>{source.provenance}</dd></div><div><dt>Captured</dt><dd><time dateTime={source.createdAt}>{readableDate(source.createdAt)}</time></dd></div></dl><article className="original-text inquiry-original" aria-label="Original thought">{source.text}</article></details><Link className="text-link" href={`/sources/${source.id}`}>Open source</Link><button type="button" className="text-button" onClick={() => discuss({ kind: "source", id: source.id })}>Discuss original</button>{controls}</>} />}</ThoughtTitleEditor>
      </section>
      <div className="original-progress"><WeavingStatus sourceId={source.id} initial={weaving} onSnapshot={refresh} compact /></div>
      <Development state={development} model={model} query={query} worker={worker} composerRef={composerRef} initialError={dialogueError} overviewItem={overviewItem}
        onDiscussOverview={overviewItem ? () => discuss({ kind: "item", id: overviewItem.id, versionId: overviewItem.current.id }) : undefined}
        connections={<section aria-label="Connections" className="connections-section">{model.relationships.length > 0 && <h2>Connected thoughts</h2>}{model.relationships.length ? model.relationships.map((relation) => <ConnectionReading key={relation.id} relation={relation} items={model.items} sources={model.evidenceSources} sourceId={source.id} query={query} busy={mutationBusy} focalId={overviewItem?.id}
          onDiscuss={() => { const from = model.items.find((item) => item.id === relation.fromItemId), to = model.items.find((item) => item.id === relation.toItemId); if (from && to) discuss({ kind: "relationship", id: relation.id, versionId: relation.current.id, fromVersionId: from.current.id, toVersionId: to.current.id }); }}
          onReject={(reason) => mutate(`/api/relationships/${relation.id}/reject`, { expectedVersionId: relation.current.id, rationale: reason, evidenceSourceIds: relation.current.evidenceSourceIds })}
          onRestore={(version) => void mutate(`/api/relationships/${relation.id}/restore`, { expectedVersionId: relation.current.id, restoreVersionId: version })} />) : <p className="empty-reading">No connections recorded yet.</p>}</section>}>
      <div className="recorded-context" id="recorded-context">
        {mutationError && <div className="notice error-notice" role="alert"><p>{mutationError}</p></div>}
        {refreshError && <p className="status-recovery" role="status">Recorded context could not refresh. Existing readings are kept below; checking status will try loading updates again.</p>}
        <section aria-label="Interpretations" className="interpretations-section">{interpretations.length > 0 && <h2>Readings and history</h2>}<div className="reading-branches">{interpretations.length ? interpretations.map((item) => <InterpretationReading key={item.id} item={item} sources={model.evidenceSources} selected={item.id === openedId} query={query} busy={mutationBusy}
          onDiscuss={() => discuss({ kind: "item", id: item.id, versionId: item.current.id })}
          onRestore={(version) => void mutate(`/api/items/${item.id}/restore`, { expectedVersionId: item.current.id, restoreVersionId: version })}
          onCorrect={development.selection.kind === "item" && development.selection.id === item.id && development.latest ? () => void mutate(`/api/items/${item.id}/correct`, { expectedVersionId: item.current.id, sourceId: development.latest!.source.id, text: development.latest!.source.text }) : undefined} />) : <p className="empty-reading">No interpretations recorded yet.</p>}</div></section>
      </div>
      </Development>
    </div><FollowUpStatus sourceId={source.id} query={query} initialModel={initial} pendingFindings={pendingFindings} onView={() => reloadKnowledge(true)} onWorker={setWorker} /></DevelopmentNavigation.Provider>
  </>;
}
