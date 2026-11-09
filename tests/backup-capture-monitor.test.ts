import { expect, test } from "bun:test";
import { open, mkdir, mkdtemp, lstat, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { readCaptureRss, runCaptureWorker, type OpenCaptureStatus, type StartCaptureReconciliationTimer } from "../src/backup/capture-process";
import { startDaemon, type RunningDaemon } from "../src/daemon/runtime";
import { createLogger, type LogRecord } from "../src/logging";

const credentials = { user: "user-0123456789-0123456789-abcdef", ai: "agent-0123456789-0123456789-abcdef" };
const limits = { sourceReadMs: 10000, totalMs: 20000, maxRssBytes: 512 * 1024 * 1024 };
const errno = (code: string) => Object.assign(new Error("private proc status sentinel"), { code });

async function bounded<T>(promise: Promise<T>, label: string, milliseconds = 10000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds); })]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}

function status(text: string, chunkSize = 8192): { openStatus: OpenCaptureStatus; closed: () => boolean } {
  const bytes = new TextEncoder().encode(text); let closed = false;
  return { openStatus: async () => ({
    async read(buffer, offset, length, position) {
      const n = Math.max(0, Math.min(length, chunkSize, bytes.length - position));
      buffer.set(bytes.subarray(position, position + n), offset); return { bytesRead: n };
    },
    async close() { closed = true; },
  }), closed: () => closed };
}

/** Complete, EOF-terminated test-owned status without the optional mm/memory section. */
function nonterminalWithoutRss(pid: number): string {
  return [
    "Name:\towned-capture", "Umask:\t0077", "State:\tR (running)", `Tgid:\t${pid}`, "Ngid:\t0", `Pid:\t${pid}`,
    "PPid:\t1", "TracerPid:\t0", "Uid:\t1000\t1000\t1000\t1000", "Gid:\t1000\t1000\t1000\t1000",
    "FDSize:\t64", "Groups:\t1000", `NStgid:\t${pid}`, `NSpid:\t${pid}`, `NSpgid:\t${pid}`, `NSsid:\t${pid}`,
    "Kthread:\t0", "Threads:\t1", "SigQ:\t0/1024", "SigPnd:\t0000000000000000", "ShdPnd:\t0000000000000000",
    "SigBlk:\t0000000000000000", "SigIgn:\t0000000000000000", "SigCgt:\t0000000000000000",
    "CapInh:\t0000000000000000", "CapPrm:\t0000000000000000", "CapEff:\t0000000000000000",
    "CapBnd:\t0000000000000000", "CapAmb:\t0000000000000000", "NoNewPrivs:\t0", "Seccomp:\t0",
    "Cpus_allowed:\t1", "Cpus_allowed_list:\t0", "Mems_allowed:\t1", "Mems_allowed_list:\t0",
    "voluntary_ctxt_switches:\t1", "nonvoluntary_ctxt_switches:\t0", "",
  ].join("\n");
}

test("status reader treats only vanished processes as no sample and closes retained descriptors", async () => {
  for (const code of ["ENOENT", "ESRCH"]) {
    const missing: OpenCaptureStatus = async () => { throw errno(code); };
    expect(await readCaptureRss(123, missing)).toBeNull();
    let closed = false;
    const disappeared: OpenCaptureStatus = async () => ({ async read() { throw errno(code); }, async close() { closed = true; } });
    expect(await readCaptureRss(123, disappeared)).toBeNull(); expect(closed).toBe(true);
  }
  for (const code of ["EACCES", "EIO"]) {
    const denied: OpenCaptureStatus = async () => { throw errno(code); };
    await expect(readCaptureRss(123, denied)).rejects.toThrow();
    let closed = false;
    const broken: OpenCaptureStatus = async () => ({ async read() { throw errno(code); }, async close() { closed = true; } });
    await expect(readCaptureRss(123, broken)).rejects.toThrow(); expect(closed).toBe(true);
  }
  const zombie = status("Name:\towned\nState:\tZ (zombie)\n");
  expect(await readCaptureRss(123, zombie.openStatus)).toBeNull(); expect(zombie.closed()).toBe(true);
  for (const raw of ["", "Name:\towned\nState:\t", "Name:\towned\nState:\tR (running)\n",
    "Name:\towned\nState:\tR (running)\nVmRSS:\t12", "Name:\towned\nState:\tS (sleeping)\nVmRSS:\tbroken kB\n"]) {
    const bad = status(raw); await expect(readCaptureRss(123, bad.openStatus)).rejects.toThrow(); expect(bad.closed()).toBe(true);
  }
});

test("a bounded short read assembles a complete status instead of misclassifying the live child", async () => {
  const source = status("Name:\towned\nState:\tR (running)\nVmRSS:\t1234 kB\n", 5);
  expect(await readCaptureRss(123, source.openStatus)).toBe(1234n * 1024n);
  expect(source.closed()).toBe(true);
});

test("actual Linux retained proc status descriptors may report ESRCH after an owned child exits", async () => {
  const child = Bun.spawn({ cmd: [process.execPath, "--no-env-file", "-e", 'console.log("ready"); await new Promise(r => { process.stdin.once("end", r); process.stdin.resume(); });'],
    env: { PATH: "/usr/bin:/bin" }, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  const reader = child.stdout.getReader();
  let first: Awaited<ReturnType<typeof open>> | undefined, second: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const ready = await bounded(reader.read(), "owned child ready");
    expect(new TextDecoder().decode(ready.value)).toContain("ready");
    first = await open(`/proc/${child.pid}/status`, "r"); second = await open(`/proc/${child.pid}/status`, "r");
    const live = Buffer.alloc(8192); expect((await first.read(live, 0, live.length, 0)).bytesRead).toBeGreaterThan(0);
    await child.stdin.end(); await bounded(child.exited, "owned child exit");
    let observed: unknown;
    try { await first.read(live, 0, live.length, 0); } catch (error) { observed = error; }
    if (!(observed instanceof Error && "code" in observed && observed.code === "ESRCH")) {
      console.info("Owned retained proc descriptor did not report ESRCH on this kernel; real-FD observation skipped");
      return;
    }
    if (!second) throw new Error("Missing retained owned status descriptor");
    const retained = second; second = undefined;
    expect(await readCaptureRss(child.pid, async () => retained)).toBeNull();
  } finally {
    reader.releaseLock();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await child.exited; await first?.close(); await second?.close();
  }
}, 15000);

async function workerFixture(action: (request: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp("/tmp/opencode/capture-monitor-"), db = join(dir, "source.sqlite"), media = `${db}.media`;
  const work = join(dir, `.capture-${randomUUID()}`), request = join(work, "request.json");
  let daemon: RunningDaemon | undefined;
  try {
    daemon = await startDaemon({ dbPath: db, port: 0, credentials }, () => {}, { logSink: () => {} });
    await mkdir(work, { mode: 0o700 }); await mkdir(join(work, "snapshot"), { mode: 0o700 });
    const identity = await lstat(db, { bigint: true });
    await writeFile(request, JSON.stringify({ version: 1, databasePath: db, mediaDirectory: media,
      databaseDev: identity.dev.toString(), databaseIno: identity.ino.toString() }), { mode: 0o600 });
    await action(request);
  } finally { await daemon?.stop(); await rm(dir, { recursive: true, force: true }); }
}

test("a real worker can finish after a retained proc read reports ESRCH before the exit observer fires", async () => workerFixture(async request => {
  const exited = Promise.withResolvers<void>(), releaseExit = Promise.withResolvers<void>(), closed = Promise.withResolvers<void>();
  const openStatus: OpenCaptureStatus = async () => ({
    async read() { await exited.promise; throw errno("ESRCH"); }, async close() { closed.resolve(); },
  });
  let settled = false;
  const running = runCaptureWorker(request, limits, new AbortController().signal, createLogger("verbose", () => {}), () => {}, {
    openStatus, observeExit: async childExit => { const code = await childExit; exited.resolve(); await releaseExit.promise; return code; },
  });
  const outcome = running.finally(() => { settled = true; }); void outcome.catch(() => {});
  try {
    await bounded(closed.promise, "retained status close"); expect(settled).toBe(false);
    releaseExit.resolve(); expect(await bounded(outcome, "worker completion")).toMatch(/^[0-9a-f]{64}$/);
  } finally { releaseExit.resolve(); await Promise.allSettled([outcome]); }
}), 20000);

test("a complete nonterminal missing-RSS frame after actual exit0 does not invalidate a completed worker", async () => workerFixture(async request => {
  const actualExit = Promise.withResolvers<number>(), releaseExit = Promise.withResolvers<void>(), closed = Promise.withResolvers<void>();
  const controller = new AbortController(), logs: LogRecord[] = [];
  let pid: number | undefined, actualExited = false, sampled = false, settled = false;
  const openStatus: OpenCaptureStatus = async ownedPid => {
    pid = ownedPid;
    if (sampled) throw errno("ESRCH");
    sampled = true;
    const retained = await status(nonterminalWithoutRss(ownedPid)).openStatus(ownedPid);
    return {
      async read(buffer, offset, length, position) {
        await actualExit.promise;
        return retained.read(buffer, offset, length, position);
      },
      async close() { await retained.close(); closed.resolve(); },
    };
  };
  const running = runCaptureWorker(request, limits, controller.signal, createLogger("verbose", record => logs.push(record)), () => {}, {
    openStatus,
    observeExit: async childExit => {
      const code = await childExit; actualExited = true; actualExit.resolve(code);
      await releaseExit.promise; return code;
    },
  });
  const outcome = running.finally(() => { settled = true; }); void outcome.catch(() => {});
  try {
    expect(await bounded(actualExit.promise, "actual completed worker exit")).toBe(0);
    await bounded(closed.promise, "missing-RSS retained status close");
    // Drain the completed read's promise reactions while exit observation remains gated, not a timed exit window.
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    releaseExit.resolve();
    const digest = await bounded(outcome, "missing-RSS completed worker join");
    const manifest = await readFile(join(dirname(request), "snapshot", "manifest.json"));
    expect(digest).toBe(createHash("sha256").update(manifest).digest("hex"));
    expect(logs.some(record => record.message === "[backup] RSS monitor failed")).toBe(false);
  } finally {
    releaseExit.resolve(); controller.abort();
    if (!actualExited && pid !== undefined) try { process.kill(pid, "SIGKILL"); } catch { /* The owned worker may already have exited. */ }
    await bounded(Promise.allSettled([outcome]), "missing-RSS completed worker cleanup");
  }
}), 30000);

for (const [scenario, title] of [
  ["exit", "missing RSS before actual exit reconciles only after the real worker completes"],
  ["expiry", "missing RSS on a live held worker fails closed when its owned reconciliation timer expires"],
  ["abort", "abort cancels missing-RSS reconciliation and a late expiry cannot replace the latched failure"],
  ["malformed", "a complete live status with a bad VmRSS token never enters missing-RSS reconciliation"],
] as const) {
  test(title, async () => workerFixture(async request => {
    const ready = Promise.withResolvers<void>(), actualExit = Promise.withResolvers<number>(), releaseExit = Promise.withResolvers<void>();
    const timerEntered = Promise.withResolvers<void>(), controller = new AbortController(), logs: LogRecord[] = [];
    const expiries: (() => void)[] = [];
    let pid: number | undefined, actualExited = false, settled = false, opened = 0, closed = 0, timerCancels = 0, timerActive = false;
    const startReconciliationTimer: StartCaptureReconciliationTimer = expire => {
      expiries.push(expire); timerActive = true; timerEntered.resolve();
      return () => { timerCancels++; timerActive = false; };
    };
    const openStatus: OpenCaptureStatus = async ownedPid => {
      pid = ownedPid;
      const frame = nonterminalWithoutRss(ownedPid);
      const retained = await status(scenario === "malformed" ? frame.replace("Threads:\t1\n", "VmRSS:\tbroken kB\nThreads:\t1\n") : frame).openStatus(ownedPid);
      opened++;
      return {
        async read(buffer, offset, length, position) {
          await ready.promise;
          return retained.read(buffer, offset, length, position);
        },
        async close() { await retained.close(); closed++; },
      };
    };
    const logger = createLogger("verbose", record => {
      logs.push(record);
      if (record.message !== "[backup] source snapshot established") return;
      const ownedPid = record.context?.pid;
      if (typeof ownedPid !== "number" || pid !== undefined && ownedPid !== pid) throw new Error("Missing owned capture process");
      pid = ownedPid; process.kill(ownedPid, "SIGSTOP"); ready.resolve();
    });
    const running = runCaptureWorker(request, { ...limits, sourceReadMs: 15000 }, controller.signal, logger, () => {}, {
      openStatus, startReconciliationTimer,
      observeExit: async childExit => {
        const code = await childExit; actualExited = true; actualExit.resolve(code);
        await releaseExit.promise; return code;
      },
    });
    const outcome = running.then(digest => ({ ok:true as const, digest }), (error: unknown) => ({ ok:false as const, error }))
      .finally(() => { settled = true; });
    try {
      await bounded(ready.promise, "owned worker held before scan authorization");
      if (scenario === "malformed") {
        await bounded(Promise.race([
          actualExit.promise,
          timerEntered.promise.then(() => { throw new Error("Bad VmRSS token incorrectly entered missing-RSS reconciliation"); }),
        ]), "bad VmRSS token fail-closed exit", 5000);
        expect(expiries).toHaveLength(0);
      } else {
        // The old implementation kills the child instead of registering a timer: fail on that behavior, not a hanging entry latch.
        await bounded(Promise.race([
          timerEntered.promise,
          actualExit.promise.then(() => { throw new Error("Owned worker exited before missing-RSS reconciliation timer registration"); }),
        ]), "missing-RSS reconciliation entry", 5000);
        expect(actualExited).toBe(false); expect(settled).toBe(false);
        expect(expiries).toHaveLength(1); expect(timerActive).toBe(true);
        expect(opened).toBeGreaterThan(0); expect(closed).toBe(opened);
        expect(await readdir(join(dirname(request), "snapshot"))).toEqual([]);
        const expire = expiries[0];
        if (!expire) throw new Error("Missing owned reconciliation expiry callback");
        if (scenario === "exit") {
          if (pid === undefined) throw new Error("Missing held owned worker PID");
          process.kill(pid, "SIGCONT");
        } else if (scenario === "expiry") expire();
        else controller.abort();
      }

      const code = await bounded(actualExit.promise, "owned worker actual exit after reconciliation decision");
      expect(settled).toBe(false); // Actual exit is independent of the deliberately held exit observer.
      if (scenario === "exit") expect(code).toBe(0);
      else expect(code).not.toBe(0);
      if (scenario === "abort") {
        const expire = expiries[0];
        if (!expire) throw new Error("Missing cancelled reconciliation callback");
        expire(); // Exercise a stale callback while the aborted result is latched but exit observation is still gated.
      }
      releaseExit.resolve();
      const result = await bounded(outcome, "owned reconciliation worker/sample join");
      if (scenario === "exit") {
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error("Missing-RSS reconciliation rejected a completed owned worker");
        const manifest = await readFile(join(dirname(request), "snapshot", "manifest.json"));
        expect(result.digest).toBe(createHash("sha256").update(manifest).digest("hex"));
        expect(logs.some(record => record.message === "[backup] RSS monitor failed")).toBe(false);
      } else {
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("Missing or malformed RSS authorized an incomplete held worker");
        expect(result.error instanceof Error).toBe(true);
        expect(result.error && typeof result.error === "object" && "code" in result.error ? result.error.code : null)
          .toBe(scenario === "abort" ? "aborted" : "monitor-unavailable");
        expect(await readdir(join(dirname(request), "snapshot"))).toEqual([]);
      }
      expect(closed).toBe(opened);
      expect(expiries).toHaveLength(scenario === "malformed" ? 0 : 1);
      if (scenario !== "malformed") expect(timerCancels).toBeGreaterThan(0);
      expect(timerActive).toBe(false);
      const errors = logs.filter(record => record.level === "error").length, readsAfterJoin = opened;
      for (const expire of expiries) expire(); // Settled callbacks must be harmless even when the timer adapter delivers one late.
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(await outcome).toBe(result); expect(opened).toBe(readsAfterJoin);
      expect(logs.filter(record => record.level === "error").length).toBe(errors);
    } finally {
      ready.resolve(); releaseExit.resolve(); controller.abort();
      for (const expire of expiries) try { expire(); } catch { /* Cleanup must still kill/join an owned worker after an assertion failure. */ }
      if (!actualExited && pid !== undefined) try { process.kill(pid, "SIGKILL"); } catch { /* The owned worker may already have exited. */ }
      await bounded(Promise.allSettled([outcome]), "owned reconciliation worker cleanup");
    }
  }), 30000);
}

test("worker joins a pending status read and never accepts an incomplete killed child", async () => workerFixture(async request => {
  const entered = Promise.withResolvers<void>(), exited = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); let closed = false, settled = false;
  const openStatus: OpenCaptureStatus = async () => ({
    async read(buffer, offset, length, position) {
      entered.resolve(); await release.promise;
      const data = new TextEncoder().encode("State:\tZ (zombie)\n"), n = Math.max(0, Math.min(length, data.length - position));
      buffer.set(data.subarray(position, position + n), offset); return { bytesRead: n };
    },
    async close() { closed = true; },
  });
  const logger = createLogger("verbose", record => {
    if (record.message === "[backup] source snapshot established") {
      const pid = record.context?.pid;
      if (typeof pid !== "number") throw new Error("Missing owned capture process");
      process.kill(pid, "SIGKILL");
    }
  });
  const running = runCaptureWorker(request, limits, new AbortController().signal, logger, () => {}, { openStatus,
    observeExit: async childExit => { const code = await childExit; exited.resolve(); return code; } });
  const outcome = running.then(() => null, (error: unknown) => error).finally(() => { settled = true; });
  try {
    await bounded(entered.promise, "status read entry"); await bounded(exited.promise, "killed worker exit");
    expect(settled).toBe(false); expect(closed).toBe(false);
    release.resolve(); const failure = await bounded(outcome, "joined killed worker");
    expect(failure).toBeInstanceOf(Error); expect(closed).toBe(true);
  } finally { release.resolve(); await outcome; }
}), 20000);

test("a latched RSS excess remains a failure after the owned worker exits", async () => workerFixture(async request => {
  const exited = Promise.withResolvers<void>(), releaseExit = Promise.withResolvers<void>();
  const source = status("State:\tR (running)\nVmRSS:\t4096 kB\n");
  const running = runCaptureWorker(request, { ...limits, maxRssBytes: 1 }, new AbortController().signal, createLogger("verbose", () => {}), () => {}, {
    openStatus: source.openStatus,
    observeExit: async childExit => { const code = await childExit; exited.resolve(); await releaseExit.promise; return code; },
  });
  const outcome = running.then(() => null, (error: unknown) => error);
  try {
    await bounded(exited.promise, "memory-limited worker exit"); expect(source.closed()).toBe(true);
    releaseExit.resolve(); const failure = await bounded(outcome, "memory-limit outcome");
    expect(failure && typeof failure === "object" && "code" in failure ? failure.code : null).toBe("memory-limit");
  } finally { releaseExit.resolve(); await outcome; }
}), 20000);

test("monitor I/O failures fail closed and emit only safe stage and category diagnostics", async () => workerFixture(async request => {
  const logs: LogRecord[] = [];
  const openStatus: OpenCaptureStatus = async () => ({ async read() { throw errno("EIO"); }, async close() {} });
  const error = await runCaptureWorker(request, limits, new AbortController().signal, createLogger("verbose", record => logs.push(record)), () => {}, { openStatus })
    .then(() => null, (failure: unknown) => failure);
  expect(error).toBeInstanceOf(Error);
  expect(error && typeof error === "object" && "code" in error ? error.code : null).toBe("monitor-unavailable");
  expect(logs.some(record => record.context?.stage === "read" && record.context?.category === "io")).toBe(true);
  const rendered = JSON.stringify(logs);
  expect(rendered).not.toContain("private proc status sentinel"); expect(rendered).not.toContain(request); expect(rendered).not.toContain("/proc/");
}), 20000);
