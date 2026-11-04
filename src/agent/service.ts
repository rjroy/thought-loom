import { Service } from "@opencode/client/service";
import type { AgentConfig } from "../daemon/agent-config";
import { validateServiceUrl } from "./binding";
import { AgentUnavailableError } from "./errors";
import type { AgentDiscovery, ResolvedAgentService } from "./opencode-adapter";

const managedDiscovery: AgentDiscovery = {
  async discover() {
    // No version equality filter and no service lifecycle operation. Importing this module performs no discovery.
    const endpoint = await Service.discover();
    if (!endpoint) return null;
    const headers = Service.headers(endpoint);
    return {url:endpoint.url,...(headers === undefined ? {} : {headers})};
  },
};
export function requireAgentConfig(config: AgentConfig | null): AgentConfig {
  if (!config) throw new AgentUnavailableError("Thoughtloom agents are not configured");
  return config;
}
export async function resolveAgentService(config: AgentConfig, discovery: AgentDiscovery = managedDiscovery): Promise<ResolvedAgentService> {
  try {
    if ("url" in config.service) return {url:validateServiceUrl(config.service.url),...(config.service.token === undefined ? {} : {token:config.service.token})};
    const endpoint = await discovery.discover();
    if (!endpoint) throw new AgentUnavailableError();
    const headers = endpoint.headers === undefined ? undefined : Object.fromEntries(new Headers(endpoint.headers));
    return {url:validateServiceUrl(endpoint.url),...(headers === undefined ? {} : {headers})};
  } catch { throw new AgentUnavailableError("Configured agent service is unavailable"); }
}
