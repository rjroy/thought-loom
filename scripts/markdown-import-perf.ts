// Explicit, Linux-only owned-input probe; limits protect the runner, not product policy.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { partitionMarkdown, prepareMarkdown } from "../src/domain/markdown-import";

const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
function input(name: string): Uint8Array {
  if (name.startsWith("plain-")) {
    const length = Number(name.slice(6));
    return new TextEncoder().encode("a".repeat(length));
  }
  if (name.startsWith("refs-")) {
    const length = Number(name.slice(5)), prefix = "[r]: /target\n\n", unit = "[x][r] ";
    return new TextEncoder().encode(prefix + unit.repeat(Math.floor((length - prefix.length) / unit.length)) + "x".repeat((length - prefix.length) % unit.length));
  }
  if (name.startsWith("overlap-")) {
    const count = Number(name.slice(8));
    const defs = Array.from({ length: count }, (_, i) => `[r${i}]: /${i}`).join("\n\n");
    const uses = Array.from({ length: count }, (_, i) => `[x][r${i}]`).join("\n\n");
    return new TextEncoder().encode(`${defs}\n\n${uses}\n`);
  }
  throw new Error(`Unknown probe ${name}`);
}

if (process.argv[2] === "--child") {
  const name = process.argv[3];
  if (!name) throw new Error("Missing probe name");
  const bytes = input(name), prepared = prepareMarkdown(bytes);
  const segmentation = prepared.manifest.atoms.length ? { method: "structural", reason: "ai-invalid" } as const : { method: "not-needed", reason: null } as const;
  const result = partitionMarkdown(bytes, prepared, prepared.fallbackCuts, segmentation);
  let cursor = 0;
  const parts = result.parts.map(part => {
    if (part.startByte !== cursor) throw new Error("Noncontiguous partition");
    cursor = part.endByte;
    return bytes.slice(part.startByte, part.endByte);
  });
  if (cursor !== bytes.length || !Buffer.concat(parts).equals(Buffer.from(bytes))) throw new Error("Partition does not reconstruct input");
  console.log(JSON.stringify({ name, byteLength: bytes.length, sha256: digest(bytes), manifestSha256: digest(JSON.stringify(prepared)), partitionSha256: digest(JSON.stringify(result)), reconstructedSha256: digest(Buffer.concat(parts)) }));
} else {
  const sourceFiles = ["src/domain/markdown-import-parser.ts", "src/domain/markdown-import-contract.ts", "src/domain/markdown-import.ts"];
  const root = new URL("../", import.meta.url);
  const hashFile = (path: string) => digest(readFileSync(new URL(path, root)));
  const labelIndex = process.argv.indexOf("--revision-label");
  const label = labelIndex < 0 ? null : process.argv[labelIndex + 1];
  if (labelIndex >= 0 && (!label || label.startsWith("--"))) throw new Error("--revision-label requires a value");
  console.log(JSON.stringify({ type: "metadata", revisionLabel: label, bunVersion: Bun.version,
    sources: Object.fromEntries(sourceFiles.map(path => [path, hashFile(path)])),
    packageSha256: hashFile("package.json"), lockfileSha256: hashFile("bun.lock") }));
  const probes = ["plain-262144", "plain-1048576", "refs-65536", "overlap-300"];
  if (process.argv.includes("--extended")) probes.push("plain-2097152", "refs-131072", "overlap-1000");
  let failed = false;
  let active: ReturnType<typeof Bun.spawn> | undefined;
  let interrupted: "SIGINT" | "SIGTERM" | undefined;
  const cleanup = () => { if (active) { try { active.kill("SIGKILL"); } catch { /* Already exited. */ } } };
  const interrupt = (signal: "SIGINT" | "SIGTERM") => { interrupted = signal; cleanup(); };
  const onInt = () => interrupt("SIGINT"), onTerm = () => interrupt("SIGTERM");
  process.on("SIGINT", onInt); process.on("SIGTERM", onTerm); process.on("exit", cleanup);
  try {
  for (const name of probes) {
    if (interrupted) break;
    const bytes = input(name), byteLength = bytes.length, sha256 = digest(bytes);
    const start = performance.now();
    const child = Bun.spawn([process.execPath, "--no-env-file", import.meta.path, "--child", name], { stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "" } });
    active = child;
    const out = new Response(child.stdout).text(), err = new Response(child.stderr).text();
    let peak = 0, stop = "", done = false;
    void child.exited.then(() => { done = true; });
    while (!done) {
      try {
        const status = readFileSync(`/proc/${child.pid}/status`, "utf8");
        const rss = /^VmRSS:\s+(\d+)\s+kB/m.exec(status);
        if (rss?.[1]) peak = Math.max(peak, Number(rss[1]) * 1024);
      } catch { /* Process exited between samples. */ }
      if (peak > 512 * 1024 * 1024 || performance.now() - start > 10000) {
        stop = peak > 512 * 1024 * 1024 ? "rss-limit" : "time-limit";
        child.kill("SIGKILL");
        break;
      }
      await Bun.sleep(10);
    }
    const code = await child.exited, stdout = await out, stderr = await err;
    active = undefined;
    const elapsedMs = Math.round(performance.now() - start);
    if (code !== 0 || stop) failed = true;
    console.log(JSON.stringify({ name, byteLength, sha256, elapsedMs, peakRssBytes: peak, exitCode: code, stop: stop || null, result: stdout.trim(), error: stderr.trim() }));
  }
  } finally {
    cleanup();
    if (active) await active.exited;
    process.off("SIGINT", onInt); process.off("SIGTERM", onTerm); process.off("exit", cleanup);
  }
  if (interrupted) process.exitCode = interrupted === "SIGINT" ? 130 : 143;
  else if (failed) process.exitCode = 1;
}
