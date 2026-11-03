export interface DaemonConfig {
  readonly port: number;
  readonly dbPath: string;
  readonly credentials: { readonly user: string; readonly ai: string };
}

/** Invalid server configuration, before any listener or database is opened. */
export class ConfigError extends Error {}

/** Parse explicit server-side environment values, without opening resources. */
export function parseConfig(env: Readonly<Record<string, string | undefined>>): DaemonConfig {
  const rawPort = env.THOUGHTLOOM_PORT;
  if (rawPort !== undefined && !/^\d+$/.test(rawPort)) throw new ConfigError("Invalid daemon configuration");
  const config = {
    port: rawPort === undefined ? 3001 : Number(rawPort),
    dbPath: env.THOUGHTLOOM_DB_PATH,
    credentials: { user: env.THOUGHTLOOM_USER_TOKEN, ai: env.THOUGHTLOOM_AI_TOKEN },
  };
  return validateConfig(config);
}

/** Validate again at the resource boundary, including configs not made by parseConfig. */
export function validateConfig(input: unknown): DaemonConfig {
  if (typeof input !== "object" || input === null || !("port" in input) || !("dbPath" in input) || !("credentials" in input)) {
    throw new ConfigError("Invalid daemon configuration");
  }
  const credentials = input.credentials;
  if (typeof credentials !== "object" || credentials === null || !("user" in credentials) || !("ai" in credentials)) {
    throw new ConfigError("Invalid daemon configuration");
  }
  const { user, ai } = credentials;
  if (typeof user !== "string" || typeof ai !== "string" || user.trim().length < 32 || ai.trim().length < 32 || user === ai ||
      typeof input.dbPath !== "string" || !input.dbPath.trim() || input.dbPath.includes("\0") ||
      typeof input.port !== "number" || !Number.isInteger(input.port) || input.port < 0 || input.port > 65535) {
    throw new ConfigError("Invalid daemon configuration");
  }
  return { port: input.port, dbPath: input.dbPath, credentials: { user, ai } };
}
