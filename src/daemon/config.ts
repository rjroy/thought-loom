import { parseAgentConfig, validateAgentConfig, type AgentConfig } from "./agent-config";
import { ConfigError } from "./config-error";
import type { LogLevel } from "../logging";
export { ConfigError } from "./config-error";

export interface DaemonConfig {
  readonly port: number;
  readonly dbPath: string;
  readonly credentials: { readonly user: string; readonly ai: string };
  readonly agent?: AgentConfig | null;
  readonly logLevel?: LogLevel;
}

const portDiagnostic = "THOUGHTLOOM_PORT must be an integer from 0 to 65535";

/** Parse explicit server-side environment values, without opening resources. */
export function parseConfig(env: Readonly<Record<string, string | undefined>>): DaemonConfig {
  const rawPort = env.THOUGHTLOOM_PORT;
  if (rawPort !== undefined && !/^\d+$/.test(rawPort)) throw new ConfigError(portDiagnostic);
  const agent = parseAgentConfig(env);
  const config = {
    port: rawPort === undefined ? 3001 : Number(rawPort),
    dbPath: env.THOUGHTLOOM_DB_PATH,
    credentials: { user: env.THOUGHTLOOM_USER_TOKEN, ai: env.THOUGHTLOOM_AI_TOKEN },
    logLevel: env.THOUGHTLOOM_LOG_LEVEL,
    ...(agent === null ? {} : {agent}),
  };
  return validateConfig(config);
}

/** Validate again at the resource boundary, including configs not made by parseConfig. */
export function validateConfig(input: unknown): DaemonConfig {
  if (typeof input !== "object" || input === null) {
    throw new ConfigError("Invalid daemon configuration");
  }
  const credentials = "credentials" in input ? input.credentials : undefined;
  const user = typeof credentials === "object" && credentials !== null && "user" in credentials ? credentials.user : undefined;
  const ai = typeof credentials === "object" && credentials !== null && "ai" in credentials ? credentials.ai : undefined;
  if (typeof user !== "string" || user.trim().length < 32) {
    throw new ConfigError("THOUGHTLOOM_USER_TOKEN is required and must be at least 32 characters");
  }
  if (typeof ai !== "string" || ai.trim().length < 32) {
    throw new ConfigError("THOUGHTLOOM_AI_TOKEN is required and must be at least 32 characters");
  }
  if (user === ai) throw new ConfigError("THOUGHTLOOM_USER_TOKEN and THOUGHTLOOM_AI_TOKEN must be different");
  if (!("dbPath" in input) || typeof input.dbPath !== "string" || !input.dbPath.trim() || input.dbPath.includes("\0")) {
    throw new ConfigError("THOUGHTLOOM_DB_PATH is required and must be a valid path");
  }
  if (!("port" in input) || typeof input.port !== "number" || !Number.isInteger(input.port) || input.port < 0 || input.port > 65535) {
    throw new ConfigError(portDiagnostic);
  }
  const agent = "agent" in input && input.agent != null ? validateAgentConfig(input.agent) : null;
  const rawLevel = "logLevel" in input ? input.logLevel : undefined;
  const level = rawLevel === undefined ? "info" : typeof rawLevel === "string" ? rawLevel.trim().toLowerCase() : "";
  if (level !== "error" && level !== "warning" && level !== "info" && level !== "verbose") throw new ConfigError("THOUGHTLOOM_LOG_LEVEL must be error, warning, info or verbose");
  return { port: input.port, dbPath: input.dbPath, credentials: { user, ai }, logLevel: level, ...(agent === null ? {} : {agent}) };
}
