"use client";

import { createContext, useContext, useRef, type ReactNode } from "react";
import {
  admitEvolve, observeEvolve, readEvolveResponse, readEvolveThought,
  resolveEvolve, stopEvolve,
} from "../features/evolve/request";
import type {
  AdmissionSnapshot, EvolveReceipt, EvolveRun, ResolvedRun, RunStatus,
} from "../features/evolve/types";
import type { IdeaThought } from "../features/idea/types";

export interface EvolveExchange {
  readonly key: number;
  readonly snapshot: AdmissionSnapshot;
  readonly admission: "pending" | "known" | "not-started" | "unconfirmed";
  readonly receipt: EvolveReceipt | null;
  readonly run: EvolveRun | null;
  readonly resolved: ResolvedRun | null;
  readonly eligibleResolution: ResolvedRun | null;
  readonly unconfirmedOutputIds: readonly string[];
  readonly checking: boolean;
  readonly stopping: boolean;
  readonly readError: boolean;
  readonly stopUnconfirmed: boolean;
}
export interface EvolveWorkspace {
  readonly key: string;
  readonly rootId: string;
  readonly root: IdeaThought | null;
  readonly rootState: "loading" | "ready" | "unavailable" | "error";
  readonly draft: string;
  readonly continuationId: string;
  readonly automaticContinuation: boolean;
  readonly exchanges: readonly EvolveExchange[];
}

export const terminalRun = (status: RunStatus) => ["completed", "interrupted", "failed"].includes(status);

/** Canonical points already issued in this workspace, not a client evolution walk. */
export function continuationPoints(workspace: EvolveWorkspace): IdeaThought[] {
  const points = new Map<string, IdeaThought>();
  if (workspace.root && workspace.rootState === "ready") points.set(workspace.root.id, workspace.root);
  for (const exchange of workspace.exchanges) {
    for (const output of exchange.eligibleResolution?.outputs ?? []) {
      if (output.thought) points.set(output.id, output.thought);
    }
    if (exchange.receipt && exchange.eligibleResolution?.continuationId === exchange.receipt.contribution.id) {
      points.set(exchange.receipt.contribution.id, exchange.receipt.contribution);
    }
  }
  return [...points.values()];
}

interface ResolutionObservation {
  readonly eligible: ResolvedRun;
  readonly display: ResolvedRun;
  readonly readError: boolean;
  readonly unconfirmedOutputIds: readonly string[];
}

type Watcher = {
  count: number;
  generation: number;
  controller: AbortController | null;
  rootController: AbortController;
  busy: Promise<void> | null;
  timer: ReturnType<typeof setTimeout> | null;
  forceResolution: boolean;
};
const historyKey = "thoughtloomEvolveWorkspace";
const pollDelay = 1500;

function createEvolveStore() {
  const workspaces = new Map<string, EvolveWorkspace>();
  const listeners = new Set<() => void>();
  const watchers = new Map<string, Watcher>();
  let sequence = 0;
  let exchangeSequence = 0;
  let startIntent: string | null = null;
  const fetchBrowser: typeof fetch = (input, init) => window.fetch(input, init);
  const notify = () => { for (const listener of listeners) listener(); };
  const update = (key: string, change: (value: EvolveWorkspace) => EvolveWorkspace) => {
    const value = workspaces.get(key);
    if (!value) return;
    workspaces.set(key, change(value));
    notify();
  };
  const updateExchange = (key: string, id: number, change: (value: EvolveExchange) => EvolveExchange) => {
    update(key, value => ({ ...value, exchanges: value.exchanges.map(item => item.key === id ? change(item) : item) }));
  };
  const latestKnown = (key: string) => workspaces.get(key)?.exchanges.findLast(item => item.receipt !== null);
  const watching = (key: string, watcher: Watcher) => watchers.get(key) === watcher && watcher.count > 0;
  const clearTimer = (watcher: Watcher) => {
    if (watcher.timer !== null) clearTimeout(watcher.timer);
    watcher.timer = null;
  };
  const readFetch = (signal: AbortSignal): typeof fetch => (input, init) => fetchBrowser(input, { ...init, signal });

  async function resolve(receipt: EvolveReceipt, run: EvolveRun, fetch: typeof window.fetch, previous: ResolvedRun | null): Promise<ResolutionObservation> {
    const unconfirmedOutputIds = new Set<string>();
    let responseError = false;
    let responseFound = false;
    const eligible = await resolveEvolve(receipt, run, {
      getThought: async id => {
        const result = await readEvolveThought(id, { fetch });
        if (result.kind === "error") unconfirmedOutputIds.add(id);
        return result.kind === "found" ? result.value : null;
      },
      getResponse: async responseId => {
        // No generic response lookup: each anchor belongs to this admitted run.
        const anchors = new Set([...run.confirmedThoughtIds, receipt.contribution.id]);
        for (const anchor of anchors) {
          const result = await readEvolveResponse(anchor, responseId, { fetch });
          if (result.kind === "found") {
            responseFound = true;
            responseError = false;
            return result.value;
          }
          if (result.kind === "error") responseError = true;
        }
        return null;
      },
    });
    // A scoped read can succeed while the run/response association cannot yet
    // be confirmed. That is not an authoritative absence either.
    if (responseFound && eligible.reply === null) responseError = true;
    const readError = unconfirmedOutputIds.size > 0 || responseError;
    const retainedReply = responseError && previous?.reply?.id === run.responseId ? previous.reply : eligible.reply;
    const display: ResolvedRun = {
      ...eligible,
      outputs: eligible.outputs.map(output => unconfirmedOutputIds.has(output.id)
        ? { ...output, thought: previous?.outputs.find(item => item.id === output.id)?.thought ?? null }
        : output),
      reply: retainedReply,
      replyUnavailable: !responseError && eligible.replyUnavailable,
      continuationId: readError ? previous?.continuationId ?? null : eligible.continuationId,
    };
    return { eligible, display, readError, unconfirmedOutputIds: [...unconfirmedOutputIds] };
  }

  function applyObserved(key: string, exchange: EvolveExchange, run: EvolveRun, resolution: ResolutionObservation) {
    update(key, workspace => {
      const previousPoint = exchange.resolved?.continuationId;
      const nextPoint = resolution.eligible.continuationId;
      // Default to newly issued work, never silently fall back because a
      // previously selected point became unavailable or could not be checked.
      const advances = previousPoint == null || run.confirmedThoughtIds.indexOf(nextPoint ?? "") > run.confirmedThoughtIds.indexOf(previousPoint);
      const chooseLatest = workspace.automaticContinuation && !resolution.readError && nextPoint !== null && advances;
      return {
        ...workspace,
        continuationId: chooseLatest ? nextPoint : workspace.continuationId,
        exchanges: workspace.exchanges.map(item => item.key === exchange.key
          ? { ...item, run, resolved: resolution.display, eligibleResolution: resolution.eligible,
            readError: resolution.readError, unconfirmedOutputIds: resolution.unconfirmedOutputIds } : item),
      };
    });
  }

  function schedule(key: string, watcher: Watcher) {
    clearTimer(watcher);
    const latest = latestKnown(key);
    if (!watching(key, watcher) || !latest?.run || terminalRun(latest.run.status) || latest.stopping) return;
    watcher.timer = setTimeout(() => { void check(key, false); }, pollDelay);
  }

  function check(key: string, forceResolution = true): Promise<void> {
    const watcher = watchers.get(key);
    const exchange = latestKnown(key);
    if (!watcher || !watching(key, watcher) || !exchange?.receipt || exchange.stopping) return Promise.resolve();
    watcher.forceResolution ||= forceResolution;
    if (watcher.busy) return watcher.busy;
    clearTimer(watcher);
    const generation = ++watcher.generation;
    const controller = new AbortController();
    watcher.controller = controller;
    updateExchange(key, exchange.key, value => ({ ...value, checking: true }));
    const fetch = readFetch(controller.signal);
    const operation = (async () => {
      try {
        const result = await observeEvolve(exchange.receipt!, { fetch });
        if (!watching(key, watcher) || generation !== watcher.generation) return;
        if (result.kind !== "observed") {
          updateExchange(key, exchange.key, value => ({ ...value, readError: true, eligibleResolution: null,
            unconfirmedOutputIds: value.run?.confirmedThoughtIds ?? [] }));
          return;
        }
        const changed = JSON.stringify(result.run) !== JSON.stringify(exchange.run);
        const resolution = changed || !exchange.resolved || !exchange.eligibleResolution || exchange.readError || watcher.forceResolution
          ? await resolve(exchange.receipt!, result.run, fetch, exchange.resolved)
          : { eligible: exchange.eligibleResolution, display: exchange.resolved, readError: false,
            unconfirmedOutputIds: exchange.unconfirmedOutputIds };
        if (!watching(key, watcher) || generation !== watcher.generation) return;
        watcher.forceResolution = false;
        applyObserved(key, exchange, result.run, resolution);
      } finally {
        if (watching(key, watcher) && generation === watcher.generation) {
          watcher.busy = null;
          watcher.controller = null;
          updateExchange(key, exchange.key, value => ({ ...value, checking: false }));
          schedule(key, watcher);
        }
      }
    })();
    watcher.busy = operation;
    return operation;
  }

  async function readRoot(key: string, watcher: Watcher) {
    const workspace = workspaces.get(key);
    if (!workspace) return;
    update(key, value => ({ ...value, rootState: "loading" }));
    const result = await readEvolveThought(workspace.rootId, { fetch: readFetch(watcher.rootController.signal) });
    if (!watching(key, watcher) || watcher.rootController.signal.aborted) return;
    update(key, value => ({
      ...value, root: result.kind === "found" ? result.value : null,
      rootState: result.kind === "found" ? "ready" : result.kind === "unavailable" ? "unavailable" : "error",
    }));
  }

  function watch(key: string) {
    let watcher = watchers.get(key);
    if (!watcher || watcher.count === 0) {
      watcher = { count: 0, generation: 0, controller: null, rootController: new AbortController(), busy: null, timer: null, forceResolution: true };
      watchers.set(key, watcher);
    }
    watcher.count++;
    if (watcher.count === 1) { void readRoot(key, watcher); void check(key); }
    const observed = watcher;
    return () => {
      observed.count--;
      if (observed.count > 0) return;
      clearTimer(observed);
      observed.generation++;
      observed.controller?.abort();
      observed.rootController.abort();
      observed.busy = null;
      const latest = latestKnown(key);
      if (latest) updateExchange(key, latest.key, value => ({ ...value, checking: false }));
    };
  }

  async function send(key: string) {
    const workspace = workspaces.get(key);
    if (!workspace || workspace.rootState === "loading" || !workspace.draft.trim()
      || !continuationPoints(workspace).some(item => item.id === workspace.continuationId)
      || workspace.exchanges.some(item => item.admission === "pending" || item.admission === "unconfirmed"
        || item.stopping || item.checking || (item.run && !terminalRun(item.run.status)))) return;
    const snapshot = Object.freeze({ thoughtId: workspace.continuationId, text: workspace.draft });
    const exchange: EvolveExchange = {
      key: ++exchangeSequence, snapshot, admission: "pending", receipt: null, run: null,
      resolved: null, eligibleResolution: null, unconfirmedOutputIds: [],
      checking: false, stopping: false, readError: false, stopUnconfirmed: false,
    };
    update(key, value => ({ ...value, automaticContinuation: true, exchanges: [...value.exchanges.filter(item => item.admission !== "not-started"), exchange] }));
    const result = await admitEvolve(snapshot, { fetch: fetchBrowser });
    if (result.kind === "admitted") {
      update(key, value => ({
        ...value, draft: value.draft === snapshot.text ? "" : value.draft,
        exchanges: value.exchanges.map(item => item.key === exchange.key
          ? { ...item, admission: "known", receipt: result.receipt, run: result.receipt.run } : item),
      }));
      void check(key);
    } else {
      updateExchange(key, exchange.key, value => ({ ...value, admission: result.kind === "uncertain" ? "unconfirmed" : "not-started" }));
    }
  }

  async function stop(key: string) {
    const exchange = latestKnown(key);
    if (!exchange?.run || exchange.stopping || terminalRun(exchange.run.status)) return;
    const watcher = watchers.get(key);
    if (watcher) {
      clearTimer(watcher); watcher.generation++; watcher.controller?.abort();
      watcher.busy = null;
    }
    updateExchange(key, exchange.key, value => ({ ...value, stopping: true, checking: false }));
    const result = await stopEvolve(exchange.run, { fetch: fetchBrowser });
    if (result.kind === "confirmed") {
      updateExchange(key, exchange.key, value => ({ ...value, run: result.run, stopping: false, stopUnconfirmed: false }));
      void check(key);
    } else {
      updateExchange(key, exchange.key, value => ({ ...value, stopping: false, stopUnconfirmed: true }));
      const current = watchers.get(key);
      if (current) schedule(key, current);
    }
  }

  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    get(key: string | null) { return key ? workspaces.get(key) ?? null : null; },
    startFromIdea(id: string) { startIntent = id; },
    open(id: string) {
      const saved = window.history.state?.[historyKey];
      const existing = typeof saved === "string" ? workspaces.get(saved) : undefined;
      const fresh = startIntent === id;
      startIntent = null;
      if (!fresh && existing?.rootId === id) return existing.key;
      const key = `evolve-workspace-${++sequence}`;
      workspaces.set(key, { key, rootId: id, root: null, rootState: "loading", draft: "", continuationId: id, automaticContinuation: true, exchanges: [] });
      window.history.replaceState({ ...window.history.state, [historyKey]: key }, "", window.location.href);
      return key;
    },
    draft(key: string, draft: string) { update(key, value => ({ ...value, draft })); },
    choose(key: string, id: string) {
      const workspace = workspaces.get(key);
      if (workspace && continuationPoints(workspace).some(item => item.id === id)) {
        update(key, value => ({ ...value, continuationId: id, automaticContinuation: false }));
      }
    },
    watch, send, check, stop,
  };
}

const EvolveContext = createContext<ReturnType<typeof createEvolveStore> | null>(null);

export function EvolveProvider({ children }: { children: ReactNode }) {
  const store = useRef<ReturnType<typeof createEvolveStore> | null>(null);
  if (store.current === null) store.current = createEvolveStore();
  return <EvolveContext.Provider value={store.current}>{children}</EvolveContext.Provider>;
}

export function useEvolveStore() {
  const store = useContext(EvolveContext);
  if (!store) throw new Error("Evolve requires its mounted workspace provider.");
  return store;
}
