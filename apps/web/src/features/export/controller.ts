import { deleteExport, readExportHistory, readExportMetadata, readExportThought, readReport, stopExport, type Fetch } from "./request";
import { resolveSources, sourceCandidates } from "./sources";
import { terminalExportStatus, type ArtifactResult, type ExportHistoryItem, type ExportRun, type ExportSource, type MarkdownArtifact } from "./types";

interface Catalog {
  readonly items: readonly ExportHistoryItem[];
  readonly nextCursor: string | null;
  readonly loaded: boolean;
  readonly pending: boolean;
  readonly error: boolean;
  readonly restart: boolean;
}
export interface ExportDetail {
  readonly item: ExportHistoryItem | null;
  readonly checking: boolean;
  readonly verified: boolean;
  readonly missing: boolean;
  readonly error: boolean;
  readonly stopping: boolean;
  readonly stopUnconfirmed: boolean;
  readonly stopRequested: boolean;
  readonly report: MarkdownArtifact | null;
  readonly reportState: "none" | ArtifactResult["kind"];
  readonly sources: readonly ExportSource[];
  readonly deletion: "idle" | "pending" | "conflict" | "uncertain" | "deleted";
}
type Watcher = { count: number; epoch: number; abort: AbortController | null; timer: ReturnType<typeof setTimeout> | null };
const initialDetail = (): ExportDetail => ({ item: null, checking: false, verified: false, missing: false, error: false, stopping: false, stopUnconfirmed: false, stopRequested: false, report: null, reportState: "none", sources: [], deletion: "idle" });
const asRun = (item: ExportHistoryItem): ExportRun => ({ id: item.id, kind: "export", status: item.status, confirmedThoughtIds: [], responseId: null });

/** Current-document read memory only. Durable requests, eligibility and deletion belong to the daemon. */
export function createExportController(deps: { readonly fetch: Fetch }) {
  let catalog: Catalog = { items: [], nextCursor: null, loaded: false, pending: false, error: false, restart: false };
  let catalogEpoch = 0;
  let catalogAbort: AbortController | null = null;
  let catalogWatchers = 0;
  const details = new Map<string, ExportDetail>(), watchers = new Map<string, Watcher>(), listeners = new Set<() => void>();
  const emit = () => { for (const listener of listeners) listener(); };
  const putCatalog = (change: Partial<Catalog>) => { catalog = { ...catalog, ...change }; emit(); };
  const update = (id: string, change: Partial<ExportDetail>) => { details.set(id, { ...(details.get(id) ?? initialDetail()), ...change }); emit(); };
  function fence(id: string) {
    const watcher = watchers.get(id);
    if (!watcher) return;
    watcher.epoch++; watcher.abort?.abort(); watcher.abort = null;
    if (watcher.timer) clearTimeout(watcher.timer);
    watcher.timer = null;
  }
  function beginRead(id: string) {
    const watcher = watchers.get(id);
    if (!watcher?.count || details.get(id)?.deletion === "deleted") return null;
    fence(id);
    const epoch = watcher.epoch, abort = new AbortController();
    watcher.abort = abort;
    const current = () => watcher.count > 0 && watcher.epoch === epoch && !abort.signal.aborted && details.get(id)?.deletion !== "deleted";
    const fetch: Fetch = (input, init) => deps.fetch(input, { ...init, signal: abort.signal });
    return { watcher, current, fetch };
  }
  function fenceCatalog() {
    catalogEpoch++; catalogAbort?.abort(); catalogAbort = null;
  }
  function invalidateCatalog() {
    fenceCatalog(); putCatalog({ pending: false });
    // An admission can settle after its form unmounts and the catalog has already loaded.
    if (catalogWatchers > 0) void loadCatalog();
  }
  function schedule(id: string) {
    const watcher = watchers.get(id), detail = details.get(id), item = detail?.item;
    if (!watcher?.count || !item || item.restored || detail.missing || detail.stopping || detail.deletion !== "idle" || (terminalExportStatus(item.status) && item.deletionState !== "settling")) return;
    if (watcher.timer) clearTimeout(watcher.timer);
    watcher.timer = setTimeout(() => { watcher.timer = null; void check(id); }, 1500);
  }
  async function loadCatalog(more = false) {
    if (more && (catalog.pending || !catalog.nextCursor || catalog.restart)) return;
    // A fresh entry must supersede even a pending read from before a mutation.
    fenceCatalog();
    const cursor = more ? catalog.nextCursor : null, epoch = catalogEpoch, abort = new AbortController();
    catalogAbort = abort;
    putCatalog({ pending: true, error: false });
    const fetch: Fetch = (input, init) => deps.fetch(input, { ...init, signal: abort.signal });
    const result = await readExportHistory(cursor, { fetch });
    if (epoch !== catalogEpoch || abort.signal.aborted) return;
    catalogAbort = null;
    if (result.kind !== "ready") { putCatalog({ pending: false, error: true, restart: result.kind === "restart" }); return; }
    const items = more ? [...catalog.items] : [];
    for (const item of result.page.items) {
      const index = items.findIndex(current => current.id === item.id);
      if (index < 0) items.push(item); else items[index] = item;
    }
    putCatalog({ items, nextCursor: result.page.nextCursor, loaded: true, pending: false, error: false, restart: false });
  }
  async function check(id: string) {
    const previous = details.get(id);
    if (previous?.stopping || previous?.deletion === "pending") return;
    const observation = beginRead(id);
    if (!observation) return;
    const { watcher, current, fetch } = observation;
    update(id, { checking: true, verified: false });
    try {
      const result = await readExportMetadata(id, { fetch });
      if (!current()) return;
      if (result.kind !== "ready") {
        update(id, { verified: false, error: result.kind === "error", missing: result.kind === "missing", ...(result.kind === "missing" ? { report: null, reportState: "none", sources: [] } : {}) });
        return;
      }
      update(id, { item: result.item, verified: true, missing: false, error: false, stopUnconfirmed: false });
      putCatalog({ items: catalog.items.map(item => item.id === id ? result.item : item) });
      if (result.item.status !== "completed") return;
      const report = await readReport(asRun(result.item), { fetch });
      if (!current()) return;
      if (report.kind !== "ready") { update(id, { reportState: report.kind }); return; }
      update(id, { report: report.artifact, reportState: "ready", sources: [] });
      const sources = await resolveSources(sourceCandidates(report.artifact.text), sourceId => readExportThought(sourceId, { fetch }));
      if (current()) update(id, { sources });
    } finally {
      if (current()) { watcher.abort = null; update(id, { checking: false }); schedule(id); }
    }
  }
  async function stop(id: string) {
    const detail = details.get(id);
    if (!detail?.item || !detail.verified || detail.stopping || detail.stopUnconfirmed || !["idle", "conflict"].includes(detail.deletion) || detail.item.deletionState !== "stop-required") return;
    fence(id);
    update(id, { stopping: true, checking: false, verified: false, deletion: "idle" });
    const result = await stopExport(asRun(detail.item), deps);
    // The Stop response is not deletion eligibility, including for restored snapshots.
    update(id, { stopping: false, stopUnconfirmed: result.kind !== "observed", stopRequested: result.kind === "observed" });
    if (result.kind === "observed") await check(id);
  }
  function deleted(id: string) {
    fence(id); update(id, { deletion: "deleted", report: null, sources: [], verified: false, checking: false });
    fenceCatalog();
    putCatalog({ items: catalog.items.filter(item => item.id !== id), pending: false });
  }
  async function remove(id: string) {
    const detail = details.get(id);
    if (!detail?.item || !detail.verified || detail.item.deletionState !== "ready" || !["idle", "conflict"].includes(detail.deletion)) return;
    fence(id); update(id, { deletion: "pending", verified: false, checking: false });
    const result = await deleteExport(id, deps);
    if (result === "deleted") { deleted(id); return; }
    update(id, { deletion: result === "conflict" ? "conflict" : "uncertain" });
    // A conflict is a known refusal. An ambiguous outcome needs an explicit same-ID check.
    if (result === "conflict") await check(id);
  }
  async function checkDeletion(id: string) {
    const detail = details.get(id);
    if (!detail || detail.deletion !== "uncertain" || detail.checking) return;
    const observation = beginRead(id);
    if (!observation) return;
    const { watcher, current, fetch } = observation;
    update(id, { checking: true, verified: false });
    try {
      const result = await readExportMetadata(id, { fetch });
      if (!current()) return;
      if (result.kind === "missing") deleted(id);
      else if (result.kind === "ready") update(id, { item: result.item, verified: true, deletion: "idle", error: false, missing: false, stopUnconfirmed: false });
      else update(id, { verified: false, error: true });
    } finally {
      if (current()) { watcher.abort = null; update(id, { checking: false }); schedule(id); }
    }
  }
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getCatalog: () => catalog,
    get: (id: string) => details.get(id),
    loadCatalog, invalidateCatalog, check, stop, remove, checkDeletion,
    watchCatalog() {
      catalogWatchers++;
      if (catalogWatchers === 1) void loadCatalog();
      return () => {
        catalogWatchers--;
        if (!catalogWatchers) { fenceCatalog(); putCatalog({ pending: false }); }
      };
    },
    watch(id: string) {
      if (!details.has(id)) details.set(id, initialDetail());
      let watcher = watchers.get(id);
      if (!watcher) { watcher = { count: 0, epoch: 0, abort: null, timer: null }; watchers.set(id, watcher); }
      watcher.count++;
      update(id, { verified: false });
      void check(id);
      return () => { watcher.count--; if (!watcher.count) { fence(id); update(id, { checking: false, verified: false }); } };
    },
  };
}
