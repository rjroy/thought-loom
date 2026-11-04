import { isAbsolute } from "node:path";
import { ConfigError } from "./config-error";
import { nonEmpty, record } from "../domain/validation";
import { validateServiceUrl } from "../agent/binding";

/** Optional explicit operator-service configuration; no defaults from a model catalog. */
export interface AgentConfig {
  readonly service: { readonly url: string; readonly token?: string } | { readonly discover: true };
  readonly directory: string;
  readonly model: { readonly providerID: string; readonly id: string };
  readonly effort: { readonly quick: string | null; readonly standard: string | null; readonly thorough: string | null };
}
/** Reads only the explicit map; malformed configured input raises the existing ConfigError. */
export function parseAgentConfig(env: Readonly<Record<string, string | undefined>>): AgentConfig | null {
  if (env.THOUGHTLOOM_AGENT_CONFIG === undefined) return null;
  try { return validateAgentConfig(JSON.parse(env.THOUGHTLOOM_AGENT_CONFIG)); }
  catch { throw new ConfigError("THOUGHTLOOM_AGENT_CONFIG must contain a valid explicit agent configuration"); }
}

export function validateAgentConfig(input: unknown): AgentConfig {
  try {
    function fields(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
      if (required.some(key => !Object.hasOwn(value,key)) || Object.keys(value).some(key => ![...required,...optional].includes(key))) throw new Error("Invalid fields");
    }
    const data = record(input);
    fields(data,["service","directory","model","effort"]);
    const service = record(data.service);
    let selected: AgentConfig["service"];
    if (service.discover === true) { fields(service,["discover"]); selected = Object.freeze({discover:true}); }
    else {
      fields(service,["url"],["token"]);
      const url = validateServiceUrl(service.url);
      const token = service.token === undefined ? undefined : nonEmpty(service.token,"token");
      if (token !== undefined && /[\r\n\0]/.test(token)) throw new Error("Invalid token");
      selected = Object.freeze({url,...(token === undefined ? {} : {token})});
    }
    const directory = nonEmpty(data.directory,"directory");
    if (!isAbsolute(directory) || directory.includes("\0")) throw new Error("Invalid directory");
    const model = record(data.model); fields(model,["providerID","id"]);
    const effort = record(data.effort); fields(effort,["quick","standard","thorough"]);
    const variant = (value: unknown) => value === null ? null : nonEmpty(value,"variant");
    return Object.freeze({ service: selected, directory,
      model: Object.freeze({providerID:nonEmpty(model.providerID,"providerID"),id:nonEmpty(model.id,"id")}),
      effort: Object.freeze({quick:variant(effort.quick),standard:variant(effort.standard),thorough:variant(effort.thorough)}),
    });
  } catch { throw new ConfigError("THOUGHTLOOM_AGENT_CONFIG must contain a valid explicit agent configuration"); }
}
