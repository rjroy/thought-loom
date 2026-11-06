import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { selectSearchClockContext, normalizeSearchTimeRange, validateSearchRequestClock, type SearchClockSample, type SearchClockSelection, type SearchTimeRangeRequest } from "../src/domain/agentic-search";
import { migrate, SqliteStore } from "../src/storage/sqlite";
import { ValidationError } from "../src/domain/validation";

const anchor: SearchClockSample = { clock: { at: "2030-01-01T04:00:00-08:00", timeZone: "America/Los_Angeles" }, daemonObservedAt: "2030-01-01T12:00:03.000Z" };
const selection: SearchClockSelection = { boundary: "model-input", freshNative: true, preparedInput: null, requestAnchor: anchor,
  latestSample: null, retainedSample: anchor, daemonNow: "2030-01-01T12:10:03.000Z", elapsedSinceLastMs: null, backwardClockDiscontinuity: false };
const range: SearchTimeRangeRequest = { intentTurnPosition: 0, interpretation: "yesterday morning", from: "2030-01-01T09:00:00-08:00", until: "2030-01-01T12:00:00-08:00", timeZone: "America/Los_Angeles" };

test("actual admission freezes request clock while record times remain daemon-owned and replay allocates nothing", () => {
  const db = new Database(":memory:");
  try {
    migrate(db);
    let next = 0, now = "2030-01-01T12:00:03.000Z";
    const sessions = new SqliteStore(db).searchSessions({ id: () => `owned-${++next}`, now: () => now });
    const session = sessions.create("user", "session", {}).session;
    const composer = sessions.openComposer("user", session.id);
    const input = { text: "yesterday morning", startingThoughtIds: [], requestClock: anchor.clock, composerId: composer.composerId, contextToken: composer.contextToken };
    const admitted = sessions.admitTurn("user", session.id, "turn", input);
    const stored = db.query("SELECT intent_json,admitted_at FROM search_turns WHERE run_id=?").get(admitted.run.id) as { intent_json: string; admitted_at: string };
    expect(JSON.parse(stored.intent_json)).toEqual(expect.objectContaining({ requestClock: anchor.clock, daemonObservedAt: now }));
    expect(stored.admitted_at).toBe(now);
    const before = next;
    now = "2030-01-02T12:00:03.000Z";
    expect(sessions.admitTurn("user", session.id, "turn", input)).toEqual(admitted);
    expect(next).toBe(before);
    expect(db.query("SELECT intent_json,admitted_at FROM search_turns WHERE run_id=?").get(admitted.run.id)).toEqual(stored);
    expect(() => sessions.admitTurn("user", session.id, "other", { ...input, createdAt: "2099-01-01T00:00:00.000Z" })).toThrow(ValidationError);
  } finally { db.close(); }
});

test("fresh native input carries original anchor plus labeled stale observation and apparent skew", () => {
  const select = selectSearchClockContext;
  const result = select(selection);
  expect(result.kind).toBe("attach");
  if (result.kind !== "attach") throw new Error("expected initial clock context");
  expect(result.context.requestAnchor).toEqual(anchor);
  expect(result.context.observedNow).toEqual(expect.objectContaining({ clock: anchor.clock, daemonObservedAt: anchor.daemonObservedAt,
    daemonNow: selection.daemonNow, ageMs: 600_000, source: "last-reported", clientMinusDaemonMs: -3000 }));
});

test("later clock samples never rewrite the request anchor or silently rebase apparent skew", () => {
  const select = selectSearchClockContext;
  const latest: SearchClockSample = { clock: { at: "2030-01-02T08:00:00+05:45", timeZone: "Asia/Kathmandu" }, daemonObservedAt: "2030-01-02T02:10:00.000Z" };
  const result = select({ ...selection, latestSample: latest, daemonNow: "2030-01-02T02:15:00.000Z" });
  expect(result.kind).toBe("attach");
  if (result.kind !== "attach") throw new Error("expected fresh native clock context");
  expect(result.context.requestAnchor).toEqual(anchor);
  expect(result.context.observedNow).toEqual(expect.objectContaining({ clock: latest.clock, daemonObservedAt: latest.daemonObservedAt,
    ageMs: 300_000, clientMinusDaemonMs: 300_000, source: "latest" }));
});

test("refresh is strictly after one hour on model-input boundaries; prepared bytes always win", () => {
  const select = selectSearchClockContext;
  const running = { ...selection, freshNative: false, elapsedSinceLastMs: 3_600_000 };
  expect(select(running)).toEqual({ kind: "none" });
  expect(select({ ...running, boundary: "observation", elapsedSinceLastMs: 3_600_001 })).toEqual({ kind: "none" });
  expect(select({ ...running, elapsedSinceLastMs: 3_600_001 }).kind).toBe("attach");
  expect(select({ ...running, elapsedSinceLastMs: 1, backwardClockDiscontinuity: true }).kind).toBe("attach");
  expect(select({ ...running, elapsedSinceLastMs: 3_600_001, preparedInput: "exact prepared café\r\nbytes" }))
    .toEqual({ kind: "reuse", input: "exact prepared café\r\nbytes" });
});

test("older last-reported browser sample keeps its own receipt time and cannot move the frozen anchor", () => {
  const older: SearchClockSample = { clock: { at: "2029-12-31T21:00:00-08:00", timeZone: "America/Los_Angeles" }, daemonObservedAt: "2030-01-01T05:00:05.000Z" };
  const input: SearchClockSelection = { ...selection, latestSample: older, daemonNow: "2030-01-01T12:10:03.000Z" };
  const original = structuredClone(input), result = selectSearchClockContext(input);
  expect(input).toEqual(original);
  expect(result.kind).toBe("attach");
  if (result.kind !== "attach") throw new Error("expected clock context");
  expect(result.context.requestAnchor).toEqual(anchor);
  expect(result.context.observedNow).toEqual(expect.objectContaining({ clock: older.clock, daemonObservedAt: older.daemonObservedAt,
    source: "latest", ageMs: 25_798_000, offsetBasis: "apparent-including-transit-delay", clientMinusDaemonMs: -5000 }));
});

test("restart without a fresh browser sample reports actual age; backward wall time is explicitly uncertain", () => {
  const stale = selectSearchClockContext({ ...selection, freshNative: false, elapsedSinceLastMs: null, daemonNow: "2030-01-02T12:00:03.000Z" });
  expect(stale.kind).toBe("attach");
  if (stale.kind !== "attach") throw new Error("expected restart clock");
  expect(stale.context.observedNow).toEqual(expect.objectContaining({ source: "last-reported", daemonObservedAt: anchor.daemonObservedAt, ageMs: 86_400_000 }));
  const backwards = selectSearchClockContext({ ...selection, freshNative: false, elapsedSinceLastMs: 20, daemonNow: "2030-01-01T11:59:59.000Z" });
  expect(backwards.kind).toBe("attach");
  if (backwards.kind !== "attach") throw new Error("expected backwards clock refresh");
  expect(backwards.context.observedNow).toEqual(expect.objectContaining({ ageMs: null, backwardClockDiscontinuity: true }));
  expect(selectSearchClockContext({ ...selection, boundary: "observation", backwardClockDiscontinuity: true })).toEqual({ kind: "none" });
  for (const elapsedSinceLastMs of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    expect(() => selectSearchClockContext({ ...selection, elapsedSinceLastMs })).toThrow(ValidationError);
  }
});

test.each([
  { timeZone: "Asia/Kathmandu", from: "2030-01-02T00:15:00+05:45", until: "2030-01-02T01:15:00+05:45", fromUtc: "2030-01-01T18:30:00.000Z", untilUtc: "2030-01-01T19:30:00.000Z" },
  { timeZone: "Australia/Adelaide", from: "2030-06-01T00:00:00+09:30", until: "2030-06-01T01:00:00+09:30", fromUtc: "2030-05-31T14:30:00.000Z", untilUtc: "2030-05-31T15:30:00.000Z" },
  { timeZone: "America/New_York", from: "2024-11-03T01:15:00-04:00", until: "2024-11-03T01:15:00-05:00", fromUtc: "2024-11-03T05:15:00.000Z", untilUtc: "2024-11-03T06:15:00.000Z" },
  { timeZone: "Pacific/Kiritimati", from: "2030-01-01T00:15:00+14:00", until: "2030-01-01T01:15:00+14:00", fromUtc: "2029-12-31T10:15:00.000Z", untilUtc: "2029-12-31T11:15:00.000Z" },
])("agent-supplied calendar endpoints normalize correctly in $timeZone", example => {
  const normalize = normalizeSearchTimeRange;
  const result = normalize({ ...range, from: example.from, until: example.until, timeZone: example.timeZone }, anchor);
  expect(result).toEqual(expect.objectContaining({ basis: "agent-interpretation", interpretation: range.interpretation, intentTurnPosition: 0,
    from: example.from, until: example.until, timeZone: example.timeZone, fromUtc: example.fromUtc, untilUtc: example.untilUtc, requestAnchor: anchor }));
});

test("calendar normalization rejects DST gaps, mismatched offsets, invalid dates and reversed intervals", () => {
  const normalize = normalizeSearchTimeRange;
  for (const invalid of [
    { from: "2024-03-10T02:15:00-05:00", until: "2024-03-10T03:30:00-04:00", timeZone: "America/New_York" },
    { from: "2024-11-03T01:15:00-06:00", until: "2024-11-03T03:00:00-05:00", timeZone: "America/New_York" },
    { from: "2024-11-03T01:15:00", until: "2024-11-03T03:00:00-05:00", timeZone: "America/New_York" },
    { from: "2030-02-30T00:00:00Z", until: "2030-03-02T00:00:00Z", timeZone: "UTC" },
    { from: "2030-01-02T00:00:00Z", until: "2030-01-01T00:00:00Z", timeZone: "UTC" },
    { from: "2030-01-01T00:00:00Z", until: "2030-01-01T00:00:00+00:00", timeZone: "UTC" },
    { from: "2030-01-01T00:00:00Z", until: "2030-01-02T00:00:00Z", timeZone: "Not/AZone" },
  ]) expect(() => normalize({ ...range, ...invalid }, anchor)).toThrow();
  expect(() => normalize({ ...range, intentTurnPosition: -1 }, anchor)).toThrow();
  expect(() => normalize({ ...range, interpretation: "" }, anchor)).toThrow();
  const callerRecordTime = { ...range, createdAt: "2099-01-01T00:00:00Z" };
  expect(() => normalize(callerRecordTime, anchor)).toThrow();
});

test("both explicit DST-fold offsets select different UTC instants without interpreting prose", () => {
  const convert = (offset: string) => normalizeSearchTimeRange({ ...range, interpretation: "an ambiguous interval", timeZone: "America/New_York",
    from: `2024-11-03T01:15:00${offset}`, until: `2024-11-03T01:45:00${offset}` }, anchor);
  const earlier = convert("-04:00"), later = convert("-05:00");
  expect([earlier.fromUtc, earlier.untilUtc]).toEqual(["2024-11-03T05:15:00.000Z", "2024-11-03T05:45:00.000Z"]);
  expect([later.fromUtc, later.untilUtc]).toEqual(["2024-11-03T06:15:00.000Z", "2024-11-03T06:45:00.000Z"]);
  expect(earlier).toEqual(expect.objectContaining({ basis: "agent-interpretation", interpretation: "an ambiguous interval", requestAnchor: anchor }));
});

test("existing request-clock Z/non-UTC consistency rule remains unchanged", () => {
  expect(() => validateSearchRequestClock({ at: "2030-01-01T12:00:00Z", timeZone: "UTC" })).not.toThrow();
  expect(() => validateSearchRequestClock({ at: "2030-01-01T12:00:00Z", timeZone: "America/Los_Angeles" })).toThrow(ValidationError);
});
