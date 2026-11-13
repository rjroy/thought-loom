import { parseAgentConfig, validateAgentConfig, type AgentConfig } from "./agent-config";
import { ConfigError } from "./config-error";
import type { LogLevel } from "../logging";
import { isAbsolute } from "node:path";
import { parseBackupConfig, validateBackupConfig, type BackupConfig } from "../backup/config";
import { validateServiceUrl } from "../agent/binding";
import { nonEmpty, record } from "../domain/validation";
export { ConfigError } from "./config-error";

/** Optional local System One service; no service is started or managed by the daemon. */
export interface ScreeningConfig {
  readonly url: string;
  readonly model: string;
  readonly timeoutMs: number;
}
export interface DaemonConfig {
  readonly port: number;
  readonly dbPath: string;
  readonly credentials: { readonly user: string; readonly ai: string };
  readonly agent?: AgentConfig | null;
  readonly logLevel?: LogLevel;
  readonly importMaxBytes?: number;
  readonly mediaDir?: string;
  readonly mediaMaxBytes?: number;
  readonly backup?: BackupConfig;
  readonly screening?: ScreeningConfig;
}

const portDiagnostic = "THOUGHTLOOM_PORT must be an integer from 0 to 65535";
const screeningDiagnostic = "THOUGHTLOOM_SCREENING_CONFIG must contain a valid screening configuration";

function validateScreeningConfig(input: unknown): ScreeningConfig {
  try {
    const data = record(input);
    const keys = Object.keys(data);
    if (keys.length !== 3 || !["url","model","timeoutMs"].every(key => Object.hasOwn(data,key))) throw new Error();
    const url = validateServiceUrl(data.url), model = nonEmpty(data.model,"model");
    if (/[\u0000-\u001f\u007f]/.test(model) || typeof data.timeoutMs !== "number" ||
        !Number.isSafeInteger(data.timeoutMs) || data.timeoutMs < 1 || data.timeoutMs > 120000) throw new Error();
    return {url,model,timeoutMs:data.timeoutMs};
  } catch { throw new ConfigError(screeningDiagnostic); }
}

/** Parse explicit server-side environment values, without opening resources. */
export function parseConfig(env: Readonly<Record<string, string | undefined>>): DaemonConfig {
  const rawPort = env.THOUGHTLOOM_PORT;
  if (rawPort !== undefined && !/^\d+$/.test(rawPort)) throw new ConfigError(portDiagnostic);
  const rawImportMax = env.THOUGHTLOOM_IMPORT_MAX_BYTES;
  if (rawImportMax !== undefined && !/^\d+$/.test(rawImportMax)) throw new ConfigError("THOUGHTLOOM_IMPORT_MAX_BYTES must be a positive safe integer");
  const rawMediaMax = env.THOUGHTLOOM_MEDIA_MAX_BYTES;
  if (rawMediaMax !== undefined && !/^\d+$/.test(rawMediaMax)) throw new ConfigError("THOUGHTLOOM_MEDIA_MAX_BYTES must be a positive safe integer");
  const agent = parseAgentConfig(env);
  let screening: ScreeningConfig | undefined;
  if (env.THOUGHTLOOM_SCREENING_CONFIG !== undefined) {
    try { screening = validateScreeningConfig(JSON.parse(env.THOUGHTLOOM_SCREENING_CONFIG)); }
    catch { throw new ConfigError(screeningDiagnostic); }
  }
  const config = {
    port: rawPort === undefined ? 3001 : Number(rawPort),
    dbPath: env.THOUGHTLOOM_DB_PATH,
    credentials: { user: env.THOUGHTLOOM_USER_TOKEN, ai: env.THOUGHTLOOM_AI_TOKEN },
    logLevel: env.THOUGHTLOOM_LOG_LEVEL,
    ...(rawImportMax === undefined ? {} : {importMaxBytes:Number(rawImportMax)}),
    ...(rawMediaMax === undefined ? {} : {mediaMaxBytes:Number(rawMediaMax)}),
    ...(env.THOUGHTLOOM_MEDIA_DIR === undefined ? {} : {mediaDir:env.THOUGHTLOOM_MEDIA_DIR}),
    ...(agent === null ? {} : {agent}),
    ...(screening === undefined ? {} : {screening}),
    ...(env.THOUGHTLOOM_BACKUP_CONFIG === undefined ? {} : {backup:parseBackupConfig(env.THOUGHTLOOM_BACKUP_CONFIG)}),
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
  const importMaxBytes = "importMaxBytes" in input ? input.importMaxBytes : undefined;
  if (importMaxBytes !== undefined && (typeof importMaxBytes !== "number" || !Number.isSafeInteger(importMaxBytes) || importMaxBytes < 1)) throw new ConfigError("THOUGHTLOOM_IMPORT_MAX_BYTES must be a positive safe integer");
  const mediaMaxBytes = "mediaMaxBytes" in input ? input.mediaMaxBytes : undefined;
  if (mediaMaxBytes !== undefined && (typeof mediaMaxBytes !== "number" || !Number.isSafeInteger(mediaMaxBytes) || mediaMaxBytes < 1)) throw new ConfigError("THOUGHTLOOM_MEDIA_MAX_BYTES must be a positive safe integer");
  const mediaDir = "mediaDir" in input ? input.mediaDir : undefined;
  if (mediaDir !== undefined && (typeof mediaDir !== "string" || !isAbsolute(mediaDir) || mediaDir.includes("\0"))) throw new ConfigError("THOUGHTLOOM_MEDIA_DIR must be an absolute directory path");
  const backup = "backup" in input ? validateBackupConfig(input.backup, input.dbPath, mediaDir) : undefined;
  const screening = "screening" in input && input.screening !== undefined ? validateScreeningConfig(input.screening) : undefined;
  return { port: input.port, dbPath: input.dbPath, credentials: { user, ai }, logLevel: level, ...(importMaxBytes === undefined ? {} : {importMaxBytes}),
    ...(mediaMaxBytes === undefined ? {} : {mediaMaxBytes}), ...(mediaDir === undefined ? {} : {mediaDir}), ...(agent === null ? {} : {agent}), ...(backup === undefined ? {} : {backup}), ...(screening === undefined ? {} : {screening}) };
}
