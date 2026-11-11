export interface WebConfig {
  readonly daemonOrigin: string;
  readonly webOrigin: string;
  readonly webOrigins: readonly string[];
  readonly userToken: string | undefined;
}

function origin(value: string, allowRemoteHttps = false): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Invalid local origin"); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!['http:', 'https:'].includes(url.protocol) || (!loopback && !(allowRemoteHttps && url.protocol === 'https:'))
      || url.hostname.includes("*") || url.username || url.password || (value !== url.origin && value !== `${url.origin}/`)) {
    throw new Error("Invalid local origin");
  }
  return url.origin;
}

/** Pure boundary for explicit configuration; the server wrapper owns environment access. */
export function readWebConfig(env: Readonly<Record<string, string | undefined>>): WebConfig {
  const webOrigin = origin(env.THOUGHTLOOM_WEB_ORIGIN ?? "http://127.0.0.1:3000", true);
  const additionalOrigins = env.THOUGHTLOOM_WEB_ADDITIONAL_ORIGINS === undefined
    ? [] : env.THOUGHTLOOM_WEB_ADDITIONAL_ORIGINS.split(",").map(value => origin(value.trim(), true));
  return {
    daemonOrigin: origin(env.THOUGHTLOOM_DAEMON_URL ?? "http://127.0.0.1:3001"),
    webOrigin,
    webOrigins: [...new Set([webOrigin, ...additionalOrigins])],
    userToken: env.THOUGHTLOOM_USER_TOKEN,
  };
}
