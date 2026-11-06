import type { ModelRef as SdkModelRef } from "@opencode/client";
import { isAbsolute } from "node:path";
import { nonEmpty, record } from "../domain/validation";
import { protocolJson } from "../domain/run-protocol";
import type { RunKind } from "../domain/run";

export type ModelRef = Readonly<SdkModelRef>;
export interface AgentBinding {
  readonly sessionId: string;
  readonly serviceUrl: string;
  readonly location: { readonly directory: string };
  readonly model: ModelRef;
  readonly permissions: readonly { readonly action: string; readonly resource: string; readonly effect: "allow" | "deny" }[];
  readonly protocolVersion: 1;
}
export class AgentBindingError extends Error {}

/** Only this exact session policy grants native tools; saved deny rules retain their original order and meaning. */
export function allowsNativeTools(binding: Pick<AgentBinding,"permissions">): boolean {
  const rule = binding.permissions[0];
  return binding.permissions.length === 1 && rule?.action === "*" && rule.resource === "*" && rule.effect === "allow";
}

export function assertBindingPermissions(kind: RunKind, binding: AgentBinding): void {
  if (allowsNativeTools(binding) && kind !== "weave" && kind !== "evolve") throw new AgentBindingError("Run kind requires deny-all native permissions");
}

export function validateServiceUrl(input: unknown): string {
  try {
    const value = nonEmpty(input,"service URL");
    const url = new URL(value);
    if (/[\u0000-\u0020\u007f]/.test(value) || !["http:","https:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) throw new AgentBindingError();
    return value;
  } catch { throw new AgentBindingError("Invalid agent service URL"); }
}

/** Whitelist persisted facts. Authentication headers, tokens, and arbitrary metadata never enter the binding. */
export function normalizeBinding(input: unknown): AgentBinding {
  try {
    const data = record(input);
    const fields = (value: Record<string,unknown>, required: readonly string[], optional: readonly string[] = []) => {
      if (required.some(key => !Object.hasOwn(value,key)) || Object.keys(value).some(key => ![...required,...optional].includes(key))) throw new AgentBindingError();
    };
    fields(data,["sessionId","serviceUrl","location","model","permissions","protocolVersion"]);
    if (data.protocolVersion !== 1) throw new AgentBindingError();
    const location = record(data.location); fields(location,["directory"]);
    const directory = nonEmpty(location.directory,"directory");
    if (!isAbsolute(directory) || directory.includes("\0")) throw new AgentBindingError();
    const model = record(data.model); fields(model,["providerID","id"],["variant"]);
    if (!Array.isArray(data.permissions)) throw new AgentBindingError();
    const permissions = data.permissions.map((value: unknown) => {
      const rule = record(value); fields(rule,["action","resource","effect"]);
      if (rule.effect !== "deny" && rule.effect !== "allow") throw new AgentBindingError();
      return Object.freeze({action:nonEmpty(rule.action,"action"),resource:nonEmpty(rule.resource,"resource"),effect:rule.effect});
    });
    const denied = permissions.every(rule => rule.effect === "deny") && permissions.some(rule => rule.action === "*" && rule.resource === "*");
    if (!denied && !allowsNativeTools({permissions})) throw new AgentBindingError();
    return Object.freeze({sessionId:nonEmpty(data.sessionId,"sessionId"),serviceUrl:validateServiceUrl(data.serviceUrl),
      location:Object.freeze({directory}), model:Object.freeze({providerID:nonEmpty(model.providerID,"providerID"),id:nonEmpty(model.id,"id"),
        ...(model.variant === undefined ? {} : {variant:nonEmpty(model.variant,"variant")})}),
      permissions:Object.freeze(permissions),protocolVersion:1,
    });
  } catch { throw new AgentBindingError("Invalid immutable agent binding"); }
}

export function sameBinding(left: AgentBinding, right: AgentBinding): boolean { return protocolJson(left) === protocolJson(right); }
export function sameModel(left: ModelRef, right: ModelRef): boolean {
  // Native create/get normalizes an omitted variant to "default"; this is not catalog selection.
  return left.providerID === right.providerID && left.id === right.id && (left.variant ?? "default") === (right.variant ?? "default");
}
