import { spawn } from "node:child_process";
import { access, appendFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { installTerminationCleanup } from "./lifecycle";

// This driver launches only the current Bun executable, never OpenCode or a shared service.
const root = process.argv[2];
const mode = process.argv[3];
if (!root || !["signal", "failure", "hang", "normal"].includes(mode ?? "")) throw new Error("Invalid owned fixture arguments");
const owned = join(root, "owned-state");
const audit = join(root, "cleanup-audit");
const lifecycle = installTerminationCleanup({ actionTimeoutMs: 1500 });
let child: ReturnType<typeof spawn> | undefined;
let exited: Promise<void> | undefined;
lifecycle.add(async () => {
  await appendFile(audit, "cleanup\n");
  console.log(JSON.stringify({ event: "cleanup-start" }));
  if (mode === "failure") throw new Error("test-owned cleanup failure");
  if (mode === "hang") await new Promise<void>(() => {});
  if (mode === "signal") {
    for (let i = 0; i < 100; i++) {
      try { await access(join(root, "release")); return; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await Bun.sleep(10);
    }
    throw new Error("fixture release timed out");
  }
});
lifecycle.add(async () => {
  if (!child?.pid || !exited) return;
  try { process.kill(-child.pid, "SIGTERM"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  await Promise.race([exited, Bun.sleep(250).then(() => { if (child?.pid) try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } })]);
  await Promise.race([exited, Bun.sleep(300).then(() => { throw new Error("owned child reap timed out"); })]);
});
lifecycle.add(async () => { await rm(owned, { recursive: true, force: true }); });

try {
  await mkdir(owned);
  await writeFile(join(owned, "sentinel"), "test-owned state");
  child = spawn(process.execPath, ["--no-env-file", "-e", "console.log('owned-ready'); setInterval(() => {}, 1000)"], {
    cwd: root, env: { HOME: root, TMPDIR: root }, detached: true, stdio: ["ignore", "pipe", "ignore"],
  });
  if (child.pid) await writeFile(join(root, "child-pid"), String(child.pid));
  const started = child;
  exited = new Promise<void>((resolve, reject) => { started.once("exit", () => resolve()); started.once("error", reject); });
  await Promise.race([
    new Promise<void>((resolve, reject) => { started.stdout?.once("data", () => resolve()); started.once("error", reject); }),
    Bun.sleep(1500).then(() => { throw new Error("owned child readiness timed out"); }),
  ]);
  if (!child.pid) throw new Error("Missing owned child PID");
  console.log(JSON.stringify({ event: "ready", pid: child.pid }));
  if (mode === "normal") {
    await lifecycle.cleanup();
  } else await new Promise<void>(() => {});
} finally {
  await lifecycle.cleanup();
  lifecycle.dispose();
}
