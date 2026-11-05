"use client";

import { createContext, useContext, useRef, type ReactNode } from "react";
import { admitExport, observeExport, readExportThought, readReport, requestSimple, stopExport } from "../features/export/request";
import { resolveSources, sourceCandidates } from "../features/export/sources";
import type { AgenticExportInput, ExportRun, ExportSource, MarkdownArtifact, SimpleExportInput } from "../features/export/types";
import type { IdeaThought } from "../features/idea/types";

interface ExportWorkspace {
  readonly root: IdeaThought | null;
  readonly rootState: "loading" | "ready" | "unavailable";
  readonly count: string;
  readonly traversal: "breadth" | "depth";
  readonly simplePending: boolean;
  readonly simpleSnapshot: SimpleExportInput | null;
  readonly simpleArtifactSnapshot: SimpleExportInput | null;
  readonly simpleArtifact: MarkdownArtifact | null;
  readonly simpleError: boolean;
  readonly request: string;
  readonly effort: AgenticExportInput["effort"];
  readonly admission: "setup" | "pending" | "known" | "not-started" | "unconfirmed";
  readonly snapshot: AgenticExportInput | null;
  readonly run: ExportRun | null;
  readonly setup: boolean;
  readonly checking: boolean;
  readonly stopping: boolean;
  readonly readError: boolean;
  readonly stopUnconfirmed: boolean;
  readonly report: MarkdownArtifact | null;
  readonly reportState: "none" | "not-ready" | "unavailable" | "error" | "ready";
  readonly sources: readonly ExportSource[];
}
export const exportTerminal = (run: ExportRun) => ["completed", "interrupted", "failed"].includes(run.status);
type Watcher = { count: number; generation: number; controller: AbortController | null; busy: Promise<void> | null; timer: ReturnType<typeof setTimeout> | null };

function createExportStore() {
  const workspaces = new Map<string, ExportWorkspace>();
  const listeners = new Set<() => void>();
  const watchers = new Map<string, Watcher>();
  const browserFetch: typeof fetch = (input, init) => window.fetch(input, init);
  const update = (key: string, change: Partial<ExportWorkspace>) => {
    const previous = workspaces.get(key);
    if (previous) { workspaces.set(key, { ...previous, ...change }); for (const listener of listeners) listener(); }
  };
  const clearTimer = (watcher: Watcher) => { if (watcher.timer !== null) clearTimeout(watcher.timer); watcher.timer = null; };
  const active = (key: string, watcher: Watcher, generation: number) => watchers.get(key) === watcher && watcher.count > 0 && watcher.generation === generation;
  function schedule(key: string) {
    const watcher = watchers.get(key), run = workspaces.get(key)?.run;
    if (!watcher) return;
    clearTimer(watcher);
    if (watcher.count > 0 && run && !exportTerminal(run) && !workspaces.get(key)?.stopping) {
      watcher.timer = setTimeout(() => { void check(key); }, 1500);
    }
  }
  function check(key: string): Promise<void> {
    const watcher = watchers.get(key), workspace = workspaces.get(key);
    if (!watcher || !watcher.count || !workspace?.run || workspace.stopping) return Promise.resolve();
    if (watcher.busy) return watcher.busy;
    clearTimer(watcher);
    const generation = ++watcher.generation, controller = new AbortController();
    watcher.controller = controller;
    const fetch: typeof window.fetch = (input, init) => browserFetch(input, { ...init, signal: controller.signal });
    update(key, { checking: true });
    const operation = (async () => {
      try {
        const result = await observeExport(workspace.run!, { fetch });
        if (!active(key, watcher, generation)) return;
        if (result.kind !== "observed") { update(key, { readError: true }); return; }
        update(key, { run: result.run, readError: false });
        if (result.run.status === "completed") {
          const report = await readReport(result.run, { fetch });
          if (!active(key, watcher, generation)) return;
          if (report.kind === "ready") {
            // The artifact remains byte-for-byte unchanged; only the verified
            // producer appendix supplies candidates for separate normal links.
            update(key, { report: report.artifact, reportState: "ready", sources: [] });
            const sources = await resolveSources(sourceCandidates(report.artifact.text), id => readExportThought(id, { fetch }));
            if (active(key, watcher, generation)) update(key, { sources });
          } else update(key, { reportState: report.kind });
        } else if (exportTerminal(result.run)) update(key, { report: null, reportState: "none", sources: [] });
      } finally {
        if (active(key, watcher, generation)) {
          watcher.busy = null; watcher.controller = null;
          update(key, { checking: false }); schedule(key);
        }
      }
    })();
    watcher.busy = operation;
    return operation;
  }
  async function stop(key: string) {
    const workspace = workspaces.get(key), watcher = watchers.get(key);
    if (!workspace?.run || exportTerminal(workspace.run) || workspace.stopping || !watcher) return;
    // Fence in-flight observations, not the admitted write or its known ID.
    clearTimer(watcher); watcher.generation++; watcher.controller?.abort(); watcher.busy = null;
    update(key, { stopping: true, checking: false });
    const result = await stopExport(workspace.run, { fetch: browserFetch });
    update(key, result.kind === "observed"
      ? { run: result.run, stopping: false, stopUnconfirmed: false, readError: false }
      : { stopping: false, stopUnconfirmed: true });
    if (result.kind === "observed" && result.run.status === "completed") void check(key);
    else schedule(key);
  }
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    get(key: string) { return workspaces.get(key); },
    open(key: string) {
      if (!workspaces.has(key)) workspaces.set(key, {
        root: null, rootState: "loading", count: "20", traversal: "breadth", simplePending: false, simpleSnapshot: null, simpleArtifactSnapshot: null, simpleArtifact: null, simpleError: false,
        request: "", effort: "standard", admission: "setup", snapshot: null, run: null, setup: true, checking: false, stopping: false,
        readError: false, stopUnconfirmed: false, report: null, reportState: "none", sources: [],
      });
    },
    watch(key: string, rootId: string | null) {
      let watcher = watchers.get(key);
      if (!watcher) { watcher = { count: 0, generation: 0, controller: null, busy: null, timer: null }; watchers.set(key, watcher); }
      watcher.count++;
      // A mounted return rechecks normal visibility before Simple can use a
      // previously displayed root (for example after rejection in Idea).
      update(key, { rootState: rootId ? "loading" : "unavailable" });
      const rootController = new AbortController();
      const fetch: typeof window.fetch = (input, init) => browserFetch(input, { ...init, signal: rootController.signal });
      if (rootId) void readExportThought(rootId, { fetch }).then(root => {
        if (!rootController.signal.aborted) update(key, { root, rootState: root ? "ready" : "unavailable" });
      });
      else update(key, { rootState: "unavailable" });
      if (workspaces.get(key)?.run) void check(key);
      return () => {
        rootController.abort(); watcher!.count--;
        if (!watcher!.count) {
          clearTimer(watcher!); watcher!.generation++; watcher!.controller?.abort(); watcher!.busy = null;
          update(key, { checking: false });
        }
      };
    },
    editSimple(key: string, change: Pick<Partial<ExportWorkspace>, "count" | "traversal">) { if (!workspaces.get(key)?.simplePending) update(key, change); },
    editAgentic(key: string, change: Pick<Partial<ExportWorkspace>, "request" | "effort">) {
      const workspace = workspaces.get(key);
      if (workspace?.setup && !["pending", "unconfirmed"].includes(workspace.admission) && (!workspace.run || exportTerminal(workspace.run))) update(key, change);
    },
    back(key: string) { update(key, { setup: true }); },
    showRun(key: string) { update(key, { setup: false }); },
    async simple(key: string) {
      const workspace = workspaces.get(key), count = Number(workspace?.count);
      if (!workspace?.root || workspace.rootState !== "ready" || workspace.simplePending || !Number.isInteger(count) || count < 1) return;
      const snapshot = Object.freeze({ rootId: workspace.root.id, count, traversal: workspace.traversal });
      update(key, { simplePending: true, simpleSnapshot: snapshot, simpleError: false });
      const result = await requestSimple(snapshot, { fetch: browserFetch });
      update(key, { simplePending: false, simpleError: result.kind !== "ready", ...(result.kind === "ready" ? { simpleArtifact: result.artifact, simpleArtifactSnapshot: snapshot } : {}) });
    },
    async admit(key: string) {
      const workspace = workspaces.get(key);
      if (!workspace?.setup || !workspace.request.trim() || ["pending", "unconfirmed"].includes(workspace.admission) || (workspace.run && !exportTerminal(workspace.run))) return;
      const watcher = watchers.get(key);
      if (watcher) { clearTimer(watcher); watcher.generation++; watcher.controller?.abort(); watcher.busy = null; }
      const snapshot = Object.freeze({ request: workspace.request, effort: workspace.effort });
      update(key, { admission: "pending", snapshot, setup: false, run: null, report: null, reportState: "none", sources: [], checking: false, readError: false, stopUnconfirmed: false });
      const result = await admitExport(snapshot, { fetch: browserFetch });
      if (result.kind === "admitted") {
        update(key, { admission: "known", run: result.run });
        void check(key);
      } else update(key, { admission: result.kind === "uncertain" ? "unconfirmed" : "not-started", setup: result.kind === "not-started" });
    },
    check, stop,
  };
}

const ExportContext = createContext<ReturnType<typeof createExportStore> | null>(null);
export function ExportProvider({ children }: { children: ReactNode }) {
  const store = useRef<ReturnType<typeof createExportStore> | null>(null);
  if (store.current === null) store.current = createExportStore();
  return <ExportContext.Provider value={store.current}>{children}</ExportContext.Provider>;
}
export function useExportStore() {
  const store = useContext(ExportContext);
  if (!store) throw new Error("Export requires its mounted workspace provider.");
  return store;
}
