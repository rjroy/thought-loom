import type { Plugin } from "@opencode/plugin";
import { randomUUID } from "node:crypto";
import { isNativeCapabilityAction, nativeCapabilityDefinition, NATIVE_PLUGIN_BUILD_ID, parseCapabilityInput, parseNativeCapabilities } from "../../contracts/src/native-capabilities";

// Call only after the tool transform succeeds. Native owns registration disposal
// in this setup scope; no HTTP bridge, service, session or prompt is involved.
export async function registerCapabilities(ctx: Plugin.Context, registeredActions: readonly string[]): Promise<void> {
  if (!registeredActions.length || !registeredActions.every(isNativeCapabilityAction) || new Set(registeredActions).size !== registeredActions.length) throw new Error("Invalid capability actions");
  const actions = Object.freeze([...registeredActions]);
  const setupId = randomUUID(), nativePid = process.pid, directory = ctx.location.directory;
  await ctx.rpc.register(nativeCapabilityDefinition, {
    async inspect(value, native) {
      native.signal.throwIfAborted();
      const input = parseCapabilityInput(value);
      if (!input) throw new Error("Invalid capability input");
      const output = parseNativeCapabilities({ protocol: 1, nonce: input.nonce, buildId: NATIVE_PLUGIN_BUILD_ID, setupId, nativePid, directory, actions: [...actions] });
      if (!output) throw new Error("Invalid capability output");
      return output;
    },
  });
}
