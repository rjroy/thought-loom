import { spawn } from "node:child_process";
import { setTimeout as pause } from "node:timers/promises";
import { readinessFromOutput, WitnessGuardError, type LaunchSpec } from "./plugin-isolation";

// Only called by guardedLaunch in the opt-in entrypoint. The detached child is
// our process-group leader; never discover/kill services by name, port or PATH.
export function startOwnedNative(spec: LaunchSpec, signal: AbortSignal) {
  const child = spawn(spec.executable, spec.args, { cwd: spec.cwd, env: spec.env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.end();
  let output = "", bytes = 0, failure = false, exited = false;
  const exit = new Promise<void>((resolve) => {
    child.once("error", () => { failure = true; exited = true; resolve(); });
    child.once("exit", () => { exited = true; resolve(); });
  });
  child.stdout.on("data", (data: Buffer) => {
    bytes += data.length;
    if (bytes <= 131_072) output += data.toString("utf8"); else failure = true;
  });
  child.stderr.on("data", (data: Buffer) => { bytes += data.length; if (bytes > 131_072) failure = true; });
  child.stdin.on("error", () => { failure = true; });
  child.stdout.on("error", () => { failure = true; });
  child.stderr.on("error", () => { failure = true; });
  // Output never escapes the fixture, including native exception diagnostics.
  const group = child.pid;
  function alive() {
    if (!group) return false;
    try { process.kill(-group, 0); return true; }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "ESRCH") return false; throw new WitnessGuardError("owned_group_audit_failed"); }
  }
  function kill(value: NodeJS.Signals) {
    if (!group) return;
    try { process.kill(-group, value); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw new WitnessGuardError("owned_group_cleanup_failed"); }
  }
  return {
    pid: group,
    async ready() {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        signal.throwIfAborted();
        if (failure || exited || !group) throw new WitnessGuardError("owned_native_start_failed");
        const url = readinessFromOutput(output);
        if (url) { output = ""; return url; }
        await pause(25, undefined, { signal });
      }
      throw new WitnessGuardError("owned_native_readiness_timeout");
    },
    healthy() { if (failure || exited) throw new WitnessGuardError("owned_native_unavailable"); },
    async close() {
      kill("SIGTERM");
      const grace = Date.now() + 3_000;
      while (alive() && Date.now() < grace) await pause(25);
      if (alive()) kill("SIGKILL");
      const deadline = Date.now() + 3_000;
      while (alive() && Date.now() < deadline) await pause(25);
      if (alive()) throw new WitnessGuardError("owned_group_still_present");
      await Promise.race([exit, pause(1_000).then(() => { throw new WitnessGuardError("owned_child_not_reaped"); })]);
      child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy();
    },
  };
}
