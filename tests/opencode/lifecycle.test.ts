import { expect, test } from "bun:test";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

async function bound<T>(value: Promise<T>, label: string): Promise<T> {
  return Promise.race([value, Bun.sleep(3000).then(() => { throw new Error(`${label} timed out`); })]);
}
function alive(group: number): boolean {
  try { process.kill(-group, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
}
function decode(value: string): Record<string, unknown> {
  const data: unknown = JSON.parse(value);
  if (typeof data !== "object" || data === null || Array.isArray(data)) throw new Error("Invalid fixture event");
  return Object.fromEntries(Object.entries(data));
}

async function exercise(mode: "signal" | "failure" | "hang" | "normal", signal?: "SIGINT" | "SIGTERM") {
  const root = await mkdtemp(join("/tmp/opencode", "lifecycle-test-"));
  const entry = fileURLToPath(new URL("./lifecycle-child.ts", import.meta.url));
  const child = Bun.spawn([process.execPath, "--no-env-file", "run", entry, root, mode], {
    cwd: root, env: { HOME: root, TMPDIR: root }, stdin: "ignore", stdout: "pipe", stderr: "ignore",
  });
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let group: number | undefined;
  async function nextEvent() {
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline >= 0) { const line = buffered.slice(0, newline); buffered = buffered.slice(newline + 1); return decode(line); }
      const result = await bound(reader.read(), "fixture event");
      if (result.done) throw new Error("Fixture exited before expected event");
      buffered += decoder.decode(result.value, { stream: true });
      if (buffered.length > 65536) throw new Error("Fixture output exceeded limit");
    }
  }
  try {
    const ready = await nextEvent();
    expect(ready.event).toBe("ready");
    if (typeof ready.pid !== "number" || !Number.isSafeInteger(ready.pid) || ready.pid <= 1) throw new Error("Invalid owned process group");
    group = ready.pid;
    expect(alive(group)).toBe(true);
    expect(await readFile(join(root, "owned-state", "sentinel"), "utf8")).toBe("test-owned state");
    if (signal) child.kill(signal);
    expect((await nextEvent()).event).toBe("cleanup-start");
    // A second catchable termination during cleanup must join, not interrupt, the same cleanup.
    if (signal && mode === "signal") {
      child.kill(signal === "SIGINT" ? "SIGTERM" : "SIGINT");
      await writeFile(join(root, "release"), "release");
    }
    const code = await bound(child.exited, "fixture exit");
    if (mode === "normal") expect(code).toBe(0); else expect(code).not.toBe(0);
    expect(await readFile(join(root, "cleanup-audit"), "utf8")).toBe("cleanup\n");
    await expect(access(join(root, "owned-state"))).rejects.toThrow();
    expect(alive(group)).toBe(false);
  } finally {
    // These are the exact driver and detached group created above, even when an assertion or timeout fails.
    if (group === undefined) {
      try {
        const pid = Number(await readFile(join(root, "child-pid"), "utf8"));
        if (Number.isSafeInteger(pid) && pid > 1) group = pid;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    if (group !== undefined && alive(group)) {
      try { process.kill(-group, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    try { await bound(child.exited, "fixture reap"); }
    finally {
      try { await bound(reader.cancel(), "stream cleanup"); }
      finally { await rm(root, { recursive: true, force: true }); }
    }
  }
}

test.each(["SIGINT", "SIGTERM"] as const)("%s drains owned resources once even on repeated termination", async signal => {
  await exercise("signal", signal);
}, 10000);

test("normal cleanup and finally share the same idempotent cleanup", async () => {
  await exercise("normal");
}, 10000);

test.each(["failure", "hang"] as const)("%s in one cleanup action still reaps the owned process group and removes state", async mode => {
  await exercise(mode, "SIGTERM");
}, 10000);
