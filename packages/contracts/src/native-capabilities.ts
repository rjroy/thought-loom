import { toolKeys, toolRecord, type ToolAction } from "./tools";

// Explicit versioned baseline: adding a domain action must not upgrade an old
// bundle, configuration or immutable command that never proved that capability.
export const LEGACY_NATIVE_ACTIONS = ["read_source", "read_item", "read_relationship", "search", "record_interpretation", "record_alias", "record_relationship", "revise_interpretation", "revise_relationship", "record_idea"] as const satisfies readonly ToolAction[];
export type LegacyNativeAction = typeof LEGACY_NATIVE_ACTIONS[number];
// Wire/profile vocabulary is separate from the immutable legacy baseline and
// from the tools a particular executing build actually registers.
export const NATIVE_CAPABILITY_ACTIONS = [...LEGACY_NATIVE_ACTIONS, "record_title_v1"] as const satisfies readonly ToolAction[];
export type NativeCapabilityAction = typeof NATIVE_CAPABILITY_ACTIONS[number];
// Reviewed release identifier, embedded in the executing bundle. NOT its SHA256.
// Bundle provenance/pins must separately cover every transitive source input.
export const NATIVE_PLUGIN_BUILD_ID = "thoughtloom-generated-titles-v1";
export const NATIVE_CAPABILITY_RPC_ID = "thoughtloom.capabilities";
export type NativeCapabilities = {
  protocol: 1; nonce: string; buildId: string; setupId: string;
  nativePid: number; directory: string; actions: NativeCapabilityAction[];
};
export function isLegacyNativeAction(value: unknown): value is LegacyNativeAction {
  return typeof value === "string" && LEGACY_NATIVE_ACTIONS.some((action) => action === value);
}
export function isNativeCapabilityAction(value: unknown): value is NativeCapabilityAction {
  return typeof value === "string" && NATIVE_CAPABILITY_ACTIONS.some((action) => action === value);
}
function token(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 128 && /^[A-Za-z0-9._~-]+$/u.test(value);
}
export function parseCapabilityInput(value: unknown): { nonce: string } | null {
  return toolRecord(value) && toolKeys(value, ["nonce"]) && token(value.nonce) ? { nonce: value.nonce } : null;
}
export function parseNativeCapabilities(value: unknown): NativeCapabilities | null {
  if (!toolRecord(value) || !toolKeys(value, ["protocol", "nonce", "buildId", "setupId", "nativePid", "directory", "actions"]) ||
      value.protocol !== 1 || !token(value.nonce) || !token(value.buildId) || !token(value.setupId) ||
      typeof value.nativePid !== "number" || !Number.isSafeInteger(value.nativePid) || value.nativePid < 1 ||
      typeof value.directory !== "string" || value.directory.length < 1 || value.directory.length > 4096 || value.directory.includes("\0") ||
      !Array.isArray(value.actions) || !value.actions.length || value.actions.length > NATIVE_CAPABILITY_ACTIONS.length ||
      !value.actions.every(isNativeCapabilityAction) || new Set(value.actions).size !== value.actions.length) return null;
  return { protocol: 1, nonce: value.nonce, buildId: value.buildId, setupId: value.setupId, nativePid: value.nativePid, directory: value.directory, actions: [...value.actions] };
}
// Native's default Effect importer rejects JSON Schema patterns. Keep portable
// structural bounds here; token() enforces the grammar at both RPC boundaries.
const identifier = { type: "string" as const, minLength: 1, maxLength: 128 };
export const nativeCapabilityDefinition = {
  id: NATIVE_CAPABILITY_RPC_ID,
  methods: { inspect: {
    input: { type: "object" as const, properties: { nonce: identifier }, required: ["nonce"], additionalProperties: false },
    output: { type: "object" as const, properties: {
      protocol: { type: "integer" as const, const: 1 }, nonce: identifier, buildId: identifier, setupId: identifier,
      nativePid: { type: "integer" as const, minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
      directory: { type: "string" as const, minLength: 1, maxLength: 4096 },
      actions: { type: "array" as const, items: { type: "string" as const, enum: [...NATIVE_CAPABILITY_ACTIONS] }, minItems: 1, maxItems: NATIVE_CAPABILITY_ACTIONS.length, uniqueItems: true },
    }, required: ["protocol", "nonce", "buildId", "setupId", "nativePid", "directory", "actions"], additionalProperties: false },
  } }, events: {},
};
