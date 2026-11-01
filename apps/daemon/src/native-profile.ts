import { isAbsolute, normalize } from "node:path";
import { isLegacyNativeAction, isNativeCapabilityAction, NATIVE_CAPABILITY_ACTIONS, parseNativeCapabilities, toolKeys, toolRecord, toolId, type LegacyNativeAction, type NativeCapabilityAction, type NativeCapabilities } from "@thoughtloom/contracts";

export type NativeRunProfile = { version: 1; actions: NativeCapabilityAction[]; capability: NativeCapabilities | null };
export type NativeConfiguration = {
  location: string; agent: string; model: { providerID: string; id: string; variant: string };
  permissions: ReturnType<typeof nativePermissions>; profile: NativeRunProfile;
};
export type NativeCommand = NativeConfiguration & { text: string; intentHash?: string };
export function nativePermissions(actions: readonly NativeCapabilityAction[]) {
  return [{ action: "*", resource: "*", effect: "deny" as const }, ...actions.map((action) => ({ action, resource: "*", effect: "allow" as const }))];
}
export function legacyNativeActions(actions: readonly unknown[]): LegacyNativeAction[] {
  const baseline = actions.filter(isLegacyNativeAction);
  if (!baseline.length || new Set(baseline).size !== baseline.length) throw new Error("Invalid native profile");
  return baseline;
}
// Pure decoder shared by command replay, ownership checks and grant binding.
// Missing profile means ONLY the saved, explicit legacy permission subset.
export function parseNativeCommand(value: unknown): NativeCommand | null {
  if (!toolRecord(value) || typeof value.text !== "string" || typeof value.location !== "string" || !isAbsolute(value.location) || normalize(value.location) !== value.location || value.location.includes("\0") ||
      !toolId(value.agent) || !toolRecord(value.model) || !toolId(value.model.providerID) || !toolId(value.model.id) || !toolId(value.model.variant) ||
      !Array.isArray(value.permissions) || value.permissions.length < 2 || value.permissions.length > NATIVE_CAPABILITY_ACTIONS.length + 1 || (value.intentHash !== undefined && (typeof value.intentHash !== "string" || !/^[a-f0-9]{64}$/u.test(value.intentHash)))) return null;
  const [deny, ...allows] = value.permissions;
  if (!toolRecord(deny) || !toolKeys(deny, ["action", "resource", "effect"]) || deny.action !== "*" || deny.resource !== "*" || deny.effect !== "deny") return null;
  const actions: NativeCapabilityAction[] = [];
  for (const rule of allows) {
    if (!toolRecord(rule) || !toolKeys(rule, ["action", "resource", "effect"]) || !isNativeCapabilityAction(rule.action) || rule.resource !== "*" || rule.effect !== "allow" || actions.includes(rule.action)) return null;
    actions.push(rule.action);
  }
  let capability: NativeCapabilities | null = null;
  if (value.profile !== undefined) {
    const profile = value.profile;
    if (!toolRecord(profile) || !toolKeys(profile, ["version", "actions", "capability"]) || profile.version !== 1 || JSON.stringify(profile.actions) !== JSON.stringify(actions)) return null;
    if (profile.capability !== null) {
      capability = parseNativeCapabilities(profile.capability);
      if (!capability || capability.directory !== value.location) return null;
    }
  } else if (!actions.every(isLegacyNativeAction)) return null;
  // Freshness/build/identity are checked before first persistence. On replay,
  // bind extension permissions to that saved proof, not today's configuration.
  if (actions.includes("record_title_v1") && !capability?.actions.includes("record_title_v1")) return null;
  return { text: value.text, location: value.location, agent: value.agent,
    model: { providerID: value.model.providerID, id: value.model.id, variant: value.model.variant },
    permissions: nativePermissions(actions), profile: { version: 1, actions, capability }, ...(value.intentHash ? { intentHash: value.intentHash } : {}) };
}
