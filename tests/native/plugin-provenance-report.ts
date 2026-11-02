// Offline candidate report only: never writes pins, starts native, or reads config.
// Review the reported sources and bundle before updating plugin-provenance.ts.
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PLUGIN_PROVENANCE, SOURCE_HASHES } from "./plugin-provenance";

const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const repo = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
if (`bun@${Bun.version}` !== PLUGIN_PROVENANCE.runtime || process.cwd() !== repo || await realpath(repo) !== repo) throw new Error("Provenance report requires the pinned runtime and repository root");
const sources: Record<string, string> = {};
for (const name of Object.keys(SOURCE_HASHES)) {
  const path = join(repo, name);
  if (await realpath(path) !== path) throw new Error("Source path must not be a symlink");
  sources[name] = digest(await readFile(path));
}
const build = await Bun.build({ entrypoints: [join(repo, PLUGIN_PROVENANCE.entrypoint)], ...PLUGIN_PROVENANCE.build });
if (!build.success || build.outputs.length !== 1 || !build.outputs[0]) throw new Error("Bundle build failed");
const bundle = await build.outputs[0].text(), a = "thoughtloom-indexed-search-v2", b = "thoughtloom-witness-B-rpc-v1", parts = bundle.split(a);
if (parts.length !== 2) throw new Error("Expected exactly one embedded build marker");
console.log(JSON.stringify({ runtime: `bun@${Bun.version}`, sources, bundleSha256: digest(bundle), watcherFixtureBSha256: digest(parts.join(b)), buildId: a }, null, 2));
