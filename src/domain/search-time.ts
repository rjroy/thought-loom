import { searchRecordTime, validateSearchRequestClock, type SearchRequestClock } from "./agentic-search";
import { protocolJson } from "./run-protocol";
import { searchRevision, searchString } from "./search-session-guards";
import { record, ValidationError } from "./validation";

/** The daemon supplied receipt time and the original client-reported clock are distinct facts. */
export interface SearchClockSample {
  readonly clock: SearchRequestClock;
  readonly daemonObservedAt: string;
}
/** Trusted preparation dependency, never model/tool-selected clock or session authority. */
export interface SearchClockOwner {
  readonly runId: string;
  readonly generation: number;
  readonly searchSessionId: string;
  readonly nativeSessionId: string;
}
export interface SearchClientClockObservation extends SearchClockSample { readonly searchSessionId: string }
export interface SearchClockDependencies {
  /** Milliseconds from one process-local monotonic source; defaults to performance.now(). */
  readonly monotonicNow?: () => number;
  /** Synchronous validated receipt-store lookup. No HTTP/provider work may run under the preparation transaction. */
  readonly latestObservation?: (owner: SearchClockOwner) => SearchClientClockObservation | null;
}
export interface SearchClockSelection {
  readonly boundary: "model-input" | "observation";
  readonly freshNative: boolean;
  readonly preparedInput: string | null;
  readonly requestAnchor: SearchClockSample;
  readonly latestSample: SearchClockSample | null;
  readonly retainedSample: SearchClockSample;
  readonly daemonNow: string;
  readonly elapsedSinceLastMs: number | null;
  readonly backwardClockDiscontinuity: boolean;
}
export interface SearchClockContext {
  readonly requestAnchor: SearchClockSample;
  readonly observedNow: {
    readonly clock: SearchRequestClock;
    readonly daemonObservedAt: string;
    readonly daemonNow: string;
    /** Null when the daemon wall clock precedes the receipt; not an invented age. */
    readonly ageMs: number | null;
    readonly source: "latest" | "last-reported";
    readonly clientMinusDaemonMs: number;
    readonly offsetBasis: "apparent-including-transit-delay";
    readonly backwardClockDiscontinuity: boolean;
  };
}
export type SearchClockSelectionResult = { readonly kind: "none" } | { readonly kind: "reuse"; readonly input: string }
  | { readonly kind: "attach"; readonly context: SearchClockContext };
export interface SearchTimeRangeRequest {
  readonly intentTurnPosition: number;
  readonly interpretation: string;
  readonly from: string;
  readonly until: string;
  readonly timeZone: string;
}
export interface SearchTimeRangeReceipt extends SearchTimeRangeRequest {
  readonly basis: "agent-interpretation";
  readonly fromUtc: string;
  readonly untilUtc: string;
  readonly requestAnchor: SearchClockSample;
}

function exact(input: unknown, keys: readonly string[]): Record<string, unknown> {
  try {
    protocolJson(input);
    const data = record(input);
    if (Object.keys(data).length !== keys.length || keys.some(key => !Object.hasOwn(data, key))) throw new Error();
    return data;
  } catch { throw new ValidationError("Invalid search time fields"); }
}

export function readSearchClockSample(input: unknown): SearchClockSample {
  const data = exact(input, ["clock", "daemonObservedAt"]);
  const clock = exact(data.clock, ["at", "timeZone"]);
  const validated = Object.freeze({ at: searchString(clock.at, "client time"), timeZone: searchString(clock.timeZone, "time zone") });
  validateSearchRequestClock(validated);
  return Object.freeze({ clock: validated, daemonObservedAt: searchRecordTime(data.daemonObservedAt) });
}

export function readSearchClientClockObservation(input: unknown): SearchClientClockObservation {
  const data = exact(input,["searchSessionId","clock","daemonObservedAt"]);
  return Object.freeze({ searchSessionId: searchString(data.searchSessionId,"clock session"),
    ...readSearchClockSample({ clock: data.clock, daemonObservedAt: data.daemonObservedAt }) });
}

/** Only a caller's existing model-input boundary can attach a clock; this does not schedule work. */
export function selectSearchClockContext(input: SearchClockSelection): SearchClockSelectionResult {
  const data = exact(input, ["boundary", "freshNative", "preparedInput", "requestAnchor", "latestSample", "retainedSample", "daemonNow", "elapsedSinceLastMs", "backwardClockDiscontinuity"]);
  if ((data.boundary !== "model-input" && data.boundary !== "observation") || typeof data.freshNative !== "boolean" ||
      (data.preparedInput !== null && typeof data.preparedInput !== "string") || typeof data.backwardClockDiscontinuity !== "boolean" ||
      (data.elapsedSinceLastMs !== null && (typeof data.elapsedSinceLastMs !== "number" || !Number.isFinite(data.elapsedSinceLastMs) || data.elapsedSinceLastMs < 0))) throw new ValidationError("Invalid clock selection");
  const requestAnchor = readSearchClockSample(data.requestAnchor), retained = readSearchClockSample(data.retainedSample);
  const latest = data.latestSample === null ? null : readSearchClockSample(data.latestSample);
  const daemonNow = searchRecordTime(data.daemonNow);
  if (data.preparedInput !== null) return { kind: "reuse", input: data.preparedInput as string };
  if (data.boundary === "observation") return { kind: "none" };
  const chosen = latest ?? retained;
  const age = Date.parse(daemonNow) - Date.parse(chosen.daemonObservedAt);
  const backward = data.backwardClockDiscontinuity || age < 0;
  if (!data.freshNative && !backward && data.elapsedSinceLastMs !== null && (data.elapsedSinceLastMs as number) <= 3_600_000) return { kind: "none" };
  return { kind: "attach", context: { requestAnchor, observedNow: {
    clock: chosen.clock, daemonObservedAt: chosen.daemonObservedAt, daemonNow, ageMs: age < 0 ? null : age,
    source: latest ? "latest" : "last-reported", clientMinusDaemonMs: Date.parse(chosen.clock.at) - Date.parse(chosen.daemonObservedAt),
    offsetBasis: "apparent-including-transit-delay", backwardClockDiscontinuity: backward,
  } } };
}

/** Validate only retained structured clock metadata, never native history or arbitrary prompt prose. */
export function readSearchClockContext(input: unknown): SearchClockContext {
  const data = exact(input,["requestAnchor","observedNow"]);
  const observed = exact(data.observedNow,["clock","daemonObservedAt","daemonNow","ageMs","source","clientMinusDaemonMs","offsetBasis","backwardClockDiscontinuity"]);
  if ((observed.source !== "latest" && observed.source !== "last-reported") || typeof observed.backwardClockDiscontinuity !== "boolean") {
    throw new ValidationError("Invalid retained search clock context");
  }
  const reported = readSearchClockSample({ clock: observed.clock, daemonObservedAt: observed.daemonObservedAt });
  const selected = selectSearchClockContext({ boundary: "model-input", freshNative: true, preparedInput: null,
    requestAnchor: readSearchClockSample(data.requestAnchor), latestSample: observed.source === "latest" ? reported : null,
    retainedSample: reported, daemonNow: searchRecordTime(observed.daemonNow), elapsedSinceLastMs: null,
    backwardClockDiscontinuity: observed.backwardClockDiscontinuity });
  if (selected.kind !== "attach" || protocolJson(selected.context) !== protocolJson(input)) throw new ValidationError("Invalid retained search clock context");
  return selected.context;
}

/** The trusted caller selects an eligible same-session anchor; the model supplies only interpretation and endpoints. */
export function normalizeSearchTimeRange(input: SearchTimeRangeRequest, trustedAnchor: SearchClockSample): SearchTimeRangeReceipt {
  const data = exact(input, ["intentTurnPosition", "interpretation", "from", "until", "timeZone"]);
  const intentTurnPosition = searchRevision(data.intentTurnPosition);
  const interpretation = searchString(data.interpretation, "interpretation");
  const from = searchString(data.from, "from"), until = searchString(data.until, "until"), timeZone = searchString(data.timeZone, "time zone");
  const requestAnchor = readSearchClockSample(trustedAnchor);
  validateSearchRequestClock({ at: from, timeZone });
  validateSearchRequestClock({ at: until, timeZone });
  const fromMs = Date.parse(from), untilMs = Date.parse(until);
  if (fromMs >= untilMs) throw new ValidationError("Invalid search time range");
  return Object.freeze({ basis: "agent-interpretation", intentTurnPosition, interpretation, from, until, timeZone,
    fromUtc: new Date(fromMs).toISOString(), untilUtc: new Date(untilMs).toISOString(), requestAnchor });
}
