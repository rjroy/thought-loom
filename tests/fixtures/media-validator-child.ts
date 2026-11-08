// Owned adversarial child for supervisor tests. It never parses media.
import { readFile, writeFile } from "node:fs/promises";

const [mode, report = ""] = process.argv.slice(2);
if (mode === "cpu") { while (true) {} }
if (mode === "early-hang") {
  process.stdout.write('{"ok":true,"mimeType":"image/png"}');
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
const chunks: Uint8Array[] = [];
for await (const chunk of Bun.stdin.stream()) chunks.push(chunk);
const input = Buffer.concat(chunks);
if (report) await writeFile(report, JSON.stringify({
  input: input.toString("base64"), limits: await readFile("/proc/self/limits", "utf8"),
  secret: process.env.MEDIA_VALIDATOR_TEST_SECRET ?? null,
}));
if (mode === "hold") {
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
switch (mode) {
  case "ok": process.stdout.write('{"ok":true,"mimeType":"image/png"}'); break;
  case "unknown": process.stdout.write('{"ok":true,"mimeType":"image/png","extra":true}'); break;
  case "bad-mime": process.stdout.write('{"ok":true,"mimeType":"image/svg+xml"}'); break;
  case "extra": process.stdout.write('{"ok":true,"mimeType":"image/png"}{}'); break;
  case "truncated": process.stdout.write('{"ok":true'); break;
  case "nonzero": process.stdout.write('{"ok":true,"mimeType":"image/png"}'); process.exitCode = 7; break;
  case "flood": process.stderr.write("private-sentinel".repeat(4096)); break;
  case "crash": throw new Error("private-sentinel");
  default: throw new Error("Unknown test fixture mode");
}
