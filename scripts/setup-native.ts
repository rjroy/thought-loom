import { parseArgs } from "node:util";
import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { DOMAIN_ACTIONS, CAPTURE_ACTIONS } from "../packages/contracts/src/tools";
import { provisionNativeSetup } from "../apps/daemon/src/native-setup";

if (import.meta.main) {
  try {
    const { values } = parseArgs({ args: Bun.argv.slice(2), options: {
      "runtime-directory": { type: "string" }, "location-directory": { type: "string" }, "daemon-origin": { type: "string" },
      "registration-file": { type: "string" }, agent: { type: "string" }, provider: { type: "string" }, model: { type: "string" },
      variant: { type: "string" }, "plugin-entry": { type: "string" }, "max-steps": { type: "string" },
      "admission-timeout-ms": { type: "string" },
    }, strict: true, allowPositionals: false });
    const runtimeDirectory = values["runtime-directory"], locationDirectory = values["location-directory"], daemonOrigin = values["daemon-origin"];
    const registrationFile = values["registration-file"], agent = values.agent, providerID = values.provider, id = values.model;
    if (!runtimeDirectory || !locationDirectory || !daemonOrigin || !registrationFile || !agent || !providerID || !id) throw new Error("missing input");
    const entry = values["plugin-entry"] ?? fileURLToPath(new URL("../packages/agent-tools/src/plugin.ts", import.meta.url));
    if (await realpath(entry) !== resolve(entry) || !(await stat(entry)).isFile()) throw new Error("unsafe entry");
    const result = await Bun.build({ entrypoints: [entry], target: "bun", format: "esm", packages: "bundle" });
    const output = result.outputs[0];
    if (!result.success || !output) throw new Error("bundle failed");
    const setup = await provisionNativeSetup({ runtimeDirectory, locationDirectory, daemonOrigin,
      transportCredential: randomBytes(32).toString("base64url"), pluginEntry: resolve(entry), pluginBundle: await output.text(),
      native: { registrationFile, agent, model: { providerID, id, ...(values.variant ? { variant: values.variant } : {}) },
         operations: [...CAPTURE_ACTIONS], dialogueOperations: [...DOMAIN_ACTIONS],
         ...(values["max-steps"] !== undefined ? { maxSteps: Number(values["max-steps"]) } : {}),
         ...(values["admission-timeout-ms"] !== undefined ? { admissionTimeoutMs: Number(values["admission-timeout-ms"]) } : {}) } });
    console.info("Native configuration generated; not activated or live-validated.", { nativeConfigFile: setup.nativeConfigFile });
  } catch {
    console.error("Native setup failed: supply explicit new runtime/location paths, daemon origin, registration file, agent, provider and model. Existing or linked targets are not overwritten.");
    process.exitCode = 1;
  }
}
