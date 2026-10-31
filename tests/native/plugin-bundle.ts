// Filesystem/build-only provenance check; importing/calling this never launches
// native, reads native configuration, writes a bundle or updates an allowlist.
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { BUNDLE_SHA256, PLUGIN_PROVENANCE, SOURCE_HASHES } from "./plugin-provenance";
import { WitnessGuardError } from "./plugin-isolation";
import { hashFile } from "./node-io";

export function validateSourceHashes(actual: Record<string, string>) {
  const expected = Object.entries(SOURCE_HASHES);
  if (Object.keys(actual).length !== expected.length || expected.some(([path, hash]) => !Object.hasOwn(actual, path) || actual[path] !== hash)) {
    throw new WitnessGuardError("plugin_source_hash_rejected");
  }
}
export async function reviewedBundle(repo: string) {
  if (`bun@${Bun.version}` !== PLUGIN_PROVENANCE.runtime || await realpath(process.cwd()) !== repo || process.cwd() !== repo) {
    throw new WitnessGuardError("fixture_runtime_rejected");
  }
  const actual: Record<string, string> = {};
  for (const name of Object.keys(SOURCE_HASHES)) {
    const path = join(repo, name);
    if (await realpath(path) !== path) throw new WitnessGuardError("plugin_source_hash_rejected");
    actual[name] = await hashFile(path);
  }
  validateSourceHashes(actual);
  const result = await Bun.build({ entrypoints: [join(repo, PLUGIN_PROVENANCE.entrypoint)], ...PLUGIN_PROVENANCE.build });
  const output = result.outputs[0];
  if (!result.success || result.outputs.length !== 1 || !output) throw new WitnessGuardError("plugin_bundle_failed");
  const text = await output.text();
  if (createHash("sha256").update(text).digest("hex") !== BUNDLE_SHA256) throw new WitnessGuardError("plugin_bundle_hash_rejected");
  return text;
}
