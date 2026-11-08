import { validUploadKey } from "./request";
import type { MediaRetryResult, MediaRun, MediaScope, MediaSourceClient, MediaSourceWorkspace } from "./types";

export const terminalMediaRun = (run: MediaRun): boolean => ["completed", "failed", "interrupted"].includes(run.status);
export function mediaSourceControls(state: MediaSourceWorkspace, scope: MediaScope) {
  const writing = state.retryRequest.kind === "pending" || state.stopping;
  const normal = scope === "normal" && state.rejected === false && state.phase !== "unavailable";
  return {
    canCheck: !writing && !state.checking,
    canRetry: normal && state.phase === "ready" && state.fresh && !state.checking && !writing && state.retryRequest.kind === "idle"
      && state.unconfirmedStop === null && state.retry?.eligible === true && (state.run === null || state.run.status === "failed" || state.run.status === "interrupted"),
    canResend: normal && !state.checking && !writing && state.retryRequest.kind === "uncertain",
    canStop: normal && state.phase === "ready" && !state.checking && !writing && state.retryRequest.kind === "idle"
      && !!state.run && !terminalMediaRun(state.run) && state.unconfirmedStop === null,
  };
}
const initial = (): MediaSourceWorkspace => ({ phase: "idle", run: null, retry: null, rejected: null,
  checking: false, fresh: false, retryRequest: { kind: "idle" }, stopping: false, unconfirmedStop: null, notice: "none" });
type Owner = { readonly sourceId: string; readonly thoughtId: string; readonly scope: MediaScope };
interface Options {
  readonly newKey?: () => string;
  /** An owned, injectable scheduling boundary. Returns cancellation, not a global timer handle. */
  readonly schedule?: (callback: () => void, delayMs: number) => () => void;
}

/** Source-scoped observation and command memory. No knowledge text or upload receipts are cached here. */
export function createMediaSourceController(owner: Owner, client: MediaSourceClient, options: Options = {}) {
  let state = initial(), generation = 0, watchers = 0;
  let reading: Promise<void> | null = null, abort: AbortController | null = null, cancelPoll: (() => void) | null = null;
  const listeners = new Set<() => void>();
  const newKey = options.newKey ?? (() => crypto.randomUUID());
  const schedule = options.schedule ?? ((callback, delay) => { const timer = setTimeout(callback, delay); return () => clearTimeout(timer); });
  const update = (change: Partial<MediaSourceWorkspace>) => { state = { ...state, ...change }; for (const listener of listeners) listener(); };
  function clearPoll() { cancelPoll?.(); cancelPoll = null; }
  function poll() {
    clearPoll();
    if (watchers && state.phase === "ready" && !state.checking && !state.stopping && state.retryRequest.kind !== "pending"
      && state.rejected !== true && state.run && !terminalMediaRun(state.run)) cancelPoll = schedule(() => { cancelPoll = null; void check(); }, 2000);
  }
  function invalidate() {
    clearPoll(); generation++; abort?.abort(); abort = null; reading = null;
    update({ checking: false, fresh: false });
  }
  function check(): Promise<void> {
    if (state.stopping || state.retryRequest.kind === "pending") return Promise.resolve();
    if (reading) return reading;
    clearPoll();
    const epoch = ++generation, controller = new AbortController(); abort = controller;
    const current = () => epoch === generation && !controller.signal.aborted;
    update({ checking: true, fresh: false });
    const operation = (async () => {
      try {
        const result = await client.readSource(owner.sourceId, owner.scope, controller.signal);
        if (!current()) return;
        if (result.kind !== "found" || result.value.thought.id !== owner.thoughtId) {
          update({ phase: result.kind === "unavailable" ? "unavailable" : "error", fresh: false }); return;
        }
        const value = result.value;
        let unconfirmedStop = state.unconfirmedStop;
        if (unconfirmedStop) {
          if (value.run?.id === unconfirmedStop.id && terminalMediaRun(value.run)) unconfirmedStop = null;
          else if (value.run?.id !== unconfirmedStop.id) {
            // The latest source run is not a receipt for an older Stop command.
            const previous = await client.readRun(unconfirmedStop.id, controller.signal);
            if (!current()) return;
            if (previous.kind === "found" && terminalMediaRun(previous.run)) unconfirmedStop = null;
          }
        }
        update({ phase: "ready", run: value.run, retry: value.retry, rejected: owner.scope === "normal" ? false : value.thought.rejected ?? null,
          fresh: true, unconfirmedStop, notice: "none" });
      } catch { if (current()) update({ phase: "error", fresh: false }); }
      finally { if (current()) { reading = null; abort = null; update({ checking: false }); poll(); } }
    })();
    reading = operation;
    return operation;
  }
  async function sendRetry(recovering: boolean) {
    const controls = mediaSourceControls(state, owner.scope);
    if (recovering ? !controls.canResend : !controls.canRetry) return;
    let snapshot;
    if (recovering && state.retryRequest.kind === "uncertain") snapshot = state.retryRequest.snapshot;
    else {
      let key: string;
      try { key = newKey(); } catch { update({ notice: "key-unavailable", fresh: false }); return; }
      if (!validUploadKey(key)) { update({ notice: "key-unavailable", fresh: false }); return; }
      snapshot = Object.freeze({ sourceId: owner.sourceId, key });
    }
    invalidate();
    update({ retryRequest: { kind: "pending", snapshot }, notice: "none" });
    let result: MediaRetryResult;
    try { result = await client.retry(snapshot.sourceId, snapshot.key); }
    catch { result = { kind: "uncertain", problem: { status: null, code: null } }; }
    if (result.kind === "confirmed") update({ phase: "ready", run: result.run, retry: null, retryRequest: { kind: "idle" }, unconfirmedStop: null, fresh: false });
    else if (recovering || result.kind === "uncertain") update({ retryRequest: { kind: "uncertain", snapshot }, fresh: false });
    else update({ retryRequest: { kind: "idle" }, fresh: false, notice: result.kind === "conflict" ? "retry-conflict" : "retry-refused" });
    poll();
  }
  async function stop() {
    if (!mediaSourceControls(state, owner.scope).canStop || !state.run) return;
    const known = Object.freeze({ ...state.run, confirmedThoughtIds: Object.freeze([...state.run.confirmedThoughtIds]) });
    invalidate(); update({ stopping: true, notice: "none" });
    try {
      const result = await client.stop(known);
      if (result.kind === "confirmed" && result.run.id === known.id) update({ run: result.run, retry: null, unconfirmedStop: null, notice: "stop-requested", fresh: false });
      else update({ unconfirmedStop: known, fresh: false });
    } catch { update({ unconfirmedStop: known, fresh: false }); }
    finally { update({ stopping: false }); poll(); }
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    check, invalidate,
    retry: () => sendRetry(false), resendRetry: () => sendRetry(true), stop,
    watch() {
      watchers++; void check();
      return () => { watchers = Math.max(0, watchers - 1); if (!watchers) invalidate(); };
    },
  };
}
export type MediaSourceController = ReturnType<typeof createMediaSourceController>;
