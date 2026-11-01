import { parseFollowUpStatusView, parseInquiryView, type FollowUpVersionOrigin, type InquiryView } from "@thoughtloom/contracts";

export async function getFollowUps(sourceId: string, signal?: AbortSignal) {
  const response = await fetch(`/api/sources/${encodeURIComponent(sourceId)}/follow-ups`, { cache: "no-store", signal: signal ?? AbortSignal.timeout(10_000) });
  const value = response.ok ? parseFollowUpStatusView(await response.json()) : null;
  if (!value || value.sourceId !== sourceId) throw new Error("Follow-up status unavailable");
  return value;
}

export async function getInquiryContext(sourceId: string, signal?: AbortSignal) {
  const response = await fetch(`/api/sources/${encodeURIComponent(sourceId)}/inquiry`, { cache: "no-store", signal: signal ?? AbortSignal.timeout(10_000) });
  const value = response.ok ? parseInquiryView(await response.json()) : null;
  if (!value || value.source.id !== sourceId) throw new Error("Recorded context unavailable");
  return value;
}

// A background receipt does not grant permission to replace the reading in front
// of the user. Preserve displayed versions until an explicit findings view. User
// revisions and primary dialogue/capture updates can still refresh normally.
export type PendingFollowUpVersion = FollowUpVersionOrigin & { versionId: string };
export function pendingFollowUpVersions(model: InquiryView, allowed: ReadonlySet<string>): PendingFollowUpVersion[] {
  return [...model.items.flatMap((item) => item.history), ...model.relationships.flatMap((relation) => relation.history)]
    .flatMap((version) => version.followUp && !allowed.has(version.id) ? [{ ...version.followUp, versionId: version.id }] : []);
}
export function stageFollowUpChanges(previous: InquiryView, next: InquiryView, allowed: ReadonlySet<string>): InquiryView {
  const held = (version: { id: string; followUp?: FollowUpVersionOrigin }) => !!version.followUp && !allowed.has(version.id);
  const items = next.items.flatMap((item) => {
    const old = previous.items.find((old) => old.id === item.id);
    const history = item.history.filter((version) => !held(version)), current = history.at(-1);
    if (!current) {
      return old ? [item.title?.author === "user" ? { ...old, title: item.title } : old] : [];
    }
    // Generated metadata describes next.current, not a held earlier body. A user
    // label belongs to the stable entity and can arrive without accepting findings.
    const title = item.title?.author === "user" || current.id === item.current.id ? item.title : old?.current.id === current.id ? old.title : undefined;
    return [{ ...item, current, history, title }];
  });
  const ids = new Set(items.map((item) => item.id));
  const relationships = next.relationships.flatMap((relation) => {
    if (!ids.has(relation.fromItemId) || !ids.has(relation.toItemId)) return [];
    const history = relation.history.filter((version) => !held(version)), current = history.at(-1);
    if (!current) {
      const old = previous.relationships.find((old) => old.id === relation.id); return old ? [old] : [];
    }
    return [{ ...relation, current, history }];
  });
  // A held relationship may be a new neighbor's only connection to this view.
  // Keep only the displayed closure, including evidence for retained old versions
  // that may have fallen outside the next snapshot's bounded history window.
  const endpoints = new Set(relationships.flatMap((relation) => [relation.fromItemId, relation.toItemId]));
  const displayed = items.filter((item) => item.sourceId === next.source.id || endpoints.has(item.id));
  const needed = new Set([next.source.id, ...displayed.map((item) => item.sourceId),
    ...displayed.flatMap((item) => item.history.flatMap((version) => version.evidenceSourceIds)),
    ...relationships.flatMap((relation) => relation.history.flatMap((version) => version.evidenceSourceIds))]);
  const references = new Map([...previous.evidenceSources, ...next.evidenceSources].map((source) => [source.id, source]));
  const evidenceSources = [...needed].flatMap((id) => { const source = references.get(id); return source ? [source] : []; });
  const { selectedTarget, ...snapshot } = next;
  const pinnedItem = selectedTarget ? displayed.find((item) => item.id === selectedTarget.id && item.sourceId === next.source.id) : undefined;
  const pinnedVersion = pinnedItem?.history.find((version) => version.id === selectedTarget?.versionId);
  const pinnedTitle = pinnedVersion?.id === pinnedItem?.current.id ? pinnedItem?.title : selectedTarget?.title;
  return parseInquiryView({ ...snapshot, items: displayed, relationships, evidenceSources,
    ...(selectedTarget && pinnedVersion ? { selectedTarget: { kind: selectedTarget.kind, id: selectedTarget.id, versionId: pinnedVersion.id,
      text: pinnedVersion.text, author: pinnedVersion.author, evidenceSourceIds: pinnedVersion.evidenceSourceIds, ...(pinnedTitle ? { title: pinnedTitle } : {}) } } : {}) }) ?? previous;
}
