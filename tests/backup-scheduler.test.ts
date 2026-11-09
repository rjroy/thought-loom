import { expect, test } from "bun:test";
import { BackupScheduler, type BackupTimer } from "../src/backup/scheduler";
import { createLogger } from "../src/logging";

class Clock implements BackupTimer {
  private time = 0n;
  private serial = 0;
  private readonly events = new Map<number, { readonly due: bigint; readonly callback: () => void }>();
  now(): bigint { return this.time; }
  schedule(delayMs: number, callback: () => void): () => void {
    if (!Number.isSafeInteger(delayMs) || delayMs < 1 || delayMs > 2147483647) throw new Error("Invalid owned timer delay");
    const id = ++this.serial;
    this.events.set(id, { due: this.time + BigInt(delayMs), callback });
    return () => { this.events.delete(id); };
  }
  get count(): number { return this.events.size; }
  advance(milliseconds: bigint): void {
    const target = this.time + milliseconds;
    for (let steps = 0; steps < 1000; steps++) {
      const next = [...this.events].sort((a, b) => a[1].due < b[1].due ? -1 : a[1].due > b[1].due ? 1 : a[0] - b[0])[0];
      if (!next || next[1].due > target) { this.time = target; return; }
      this.time = next[1].due; this.events.delete(next[0]); next[1].callback();
    }
    throw new Error("Unbounded owned timer dispatch");
  }
}
const logger = createLogger("verbose", () => {});
async function settle(): Promise<void> { for (let i = 0; i < 8; i++) await Promise.resolve(); }

test("manual-only schedule starts no attempts or timers", async () => {
  const timer = new Clock(); let calls = 0;
  const scheduler = new BackupScheduler({ intervalSeconds: null, timer, logger, async attempt() { calls++; } });
  scheduler.start(); await settle(); timer.advance(100000000n); await settle();
  expect(calls).toBe(0); expect(timer.count).toBe(0);
  await scheduler.stop();
});

test("one initial attempt and coalesced ticks do not accumulate while a flight is held", async () => {
  const timer = new Clock(), release = Promise.withResolvers<void>(); let calls = 0, active = 0, maximum = 0;
  const scheduler = new BackupScheduler({ intervalSeconds: 5, timer, logger, async attempt() {
    calls++; active++; maximum = Math.max(maximum, active);
    try { if (calls === 1) await release.promise; } finally { active--; }
  } });
  try {
    expect(calls).toBe(0); scheduler.start(); await settle(); expect(calls).toBe(1);
    timer.advance(100000n); await settle(); expect(calls).toBe(1);
    release.resolve(); await settle(); expect(calls).toBe(2); expect(maximum).toBe(1);
    await settle(); expect(calls).toBe(2);
  } finally { release.resolve(); await scheduler.stop(); }
  const stopped = calls; timer.advance(100000n); await settle(); expect(calls).toBe(stopped); expect(timer.count).toBe(0);
});

test("stop aborts and joins entered work and seals later timer callbacks", async () => {
  const timer = new Clock(), entered = Promise.withResolvers<AbortSignal>(), release = Promise.withResolvers<void>();
  let calls = 0, done = false;
  const scheduler = new BackupScheduler({ intervalSeconds: 3, timer, logger, async attempt(signal) { calls++; entered.resolve(signal); await release.promise; } });
  scheduler.start(); const signal = await entered.promise;
  const stopping = scheduler.stop().then(() => { done = true; });
  await settle(); expect(signal.aborted).toBe(true); expect(done).toBe(false);
  timer.advance(100000n); await settle(); expect(calls).toBe(1);
  release.resolve(); await stopping; expect(done).toBe(true); expect(timer.count).toBe(0);
  timer.advance(100000n); await settle(); expect(calls).toBe(1);
});

test("long safe-integer intervals do not clamp to a rapid loop and failures allow later ticks", async () => {
  const timer = new Clock(); let calls = 0;
  const intervalSeconds = 30 * 24 * 60 * 60;
  const scheduler = new BackupScheduler({ intervalSeconds, timer, logger, async attempt() { calls++; if (calls === 1) throw new Error("owned failure"); } });
  try {
    scheduler.start(); await settle(); expect(calls).toBe(1);
    timer.advance(BigInt(intervalSeconds) * 1000n - 1n); await settle(); expect(calls).toBe(1);
    timer.advance(1n); await settle(); expect(calls).toBe(2);
  } finally { await scheduler.stop(); }
  const maximum = new Clock(); let maxCalls = 0;
  const long = new BackupScheduler({ intervalSeconds: Number.MAX_SAFE_INTEGER, timer: maximum, logger, async attempt() { maxCalls++; } });
  try {
    long.start(); await settle(); maximum.advance(2147483647n + 1000n); await settle(); expect(maxCalls).toBe(1);
  } finally { await long.stop(); }
});

test("cancelled and repeatedly invoked stale callbacks cannot restart a stopped scheduler", async () => {
  let callback: (() => void) | undefined, calls = 0, cancelled = false;
  const timer: BackupTimer = { now: () => 0n, schedule(_delay, wake) { callback = wake; return () => { cancelled = true; }; } };
  const scheduler = new BackupScheduler({ intervalSeconds: 3, timer, logger, async attempt() { calls++; } });
  scheduler.start(); await settle(); expect(calls).toBe(1);
  const stale = callback;
  if (!stale) throw new Error("Owned timer was not scheduled");
  await scheduler.stop(); expect(cancelled).toBe(true);
  stale(); stale(); scheduler.start(); await settle();
  expect(calls).toBe(1);
});

test("clock and timer failures stay contained without reviving stopped work", async () => {
  let callback: (() => void) | undefined, failClock = false, calls = 0;
  const timer: BackupTimer = { now() { if (failClock) throw new Error("private clock failure"); return 0n; },
    schedule(_delay, wake) { callback = wake; return () => { throw new Error("private cancellation failure"); }; } };
  const scheduler = new BackupScheduler({ intervalSeconds: 3, timer, logger, async attempt() { calls++; } });
  scheduler.start(); await settle(); expect(calls).toBe(1);
  const stale = callback; if (!stale) throw new Error("Owned timer was not scheduled");
  failClock = true; expect(() => stale()).not.toThrow(); await settle();
  await scheduler.stop(); expect(() => { stale(); stale(); }).not.toThrow(); await settle(); expect(calls).toBe(1);
  const cancellationTimer: BackupTimer = { now: () => 0n, schedule() { return () => { throw new Error("private cancellation failure"); }; } };
  const second = new BackupScheduler({ intervalSeconds: 3, timer: cancellationTimer, logger, async attempt() {} });
  second.start(); await settle(); await expect(second.stop()).resolves.toBeUndefined();
});
