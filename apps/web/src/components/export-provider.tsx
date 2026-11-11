"use client";

import { createContext, useContext, useRef, type ReactNode } from "react";
import { readExportThought, requestSimple } from "../features/export/request";
import { createExportController } from "../features/export/controller";
import type { MarkdownArtifact, SimpleExportInput } from "../features/export/types";
import type { IdeaThought } from "../features/idea/types";

interface SimpleWorkspace {
  readonly root: IdeaThought | null;
  readonly rootState: "loading" | "ready" | "unavailable";
  readonly count: string;
  readonly traversal: "breadth" | "depth";
  readonly simplePending: boolean;
  readonly simpleArtifactSnapshot: SimpleExportInput | null;
  readonly simpleArtifact: MarkdownArtifact | null;
  readonly simpleError: boolean;
}
function createExportStore() {
  const workspaces = new Map<string, SimpleWorkspace>(), listeners = new Set<() => void>();
  const browserFetch: typeof fetch = (input, init) => window.fetch(input, init);
  const update = (key: string, change: Partial<SimpleWorkspace>) => {
    const previous = workspaces.get(key);
    if (previous) { workspaces.set(key, { ...previous, ...change }); for (const listener of listeners) listener(); }
  };
  return {
    history: createExportController({ fetch: browserFetch }),
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    get(key: string) { return workspaces.get(key); },
    open(key: string) {
      if (!workspaces.has(key)) workspaces.set(key, { root: null, rootState: "loading", count: "20", traversal: "breadth", simplePending: false, simpleArtifactSnapshot: null, simpleArtifact: null, simpleError: false });
    },
    watch(key: string, rootId: string | null) {
      const controller = new AbortController();
      update(key, { rootState: rootId ? "loading" : "unavailable" });
      const fetch: typeof window.fetch = (input, init) => browserFetch(input, { ...init, signal: controller.signal });
      if (rootId) void readExportThought(rootId, { fetch }).then(root => {
        if (!controller.signal.aborted) update(key, { root, rootState: root ? "ready" : "unavailable" });
      });
      else update(key, { root: null, rootState: "unavailable" });
      return () => controller.abort();
    },
    editSimple(key: string, change: Pick<Partial<SimpleWorkspace>, "count" | "traversal">) { if (!workspaces.get(key)?.simplePending) update(key, change); },
    async simple(key: string) {
      const workspace = workspaces.get(key), count = Number(workspace?.count);
      if (!workspace?.root || workspace.rootState !== "ready" || workspace.simplePending || !Number.isInteger(count) || count < 1) return;
      const snapshot = Object.freeze({ rootId: workspace.root.id, count, traversal: workspace.traversal });
      update(key, { simplePending: true, simpleError: false });
      const result = await requestSimple(snapshot, { fetch: browserFetch });
      update(key, { simplePending: false, simpleError: result.kind !== "ready", ...(result.kind === "ready" ? { simpleArtifact: result.artifact, simpleArtifactSnapshot: snapshot } : {}) });
    },
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
