export interface WebConfig {
  readonly daemonOrigin: string;
  readonly webOrigin: string;
  readonly userToken: string | undefined;
}

function localOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Invalid local origin"); }
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      || url.username || url.password || (value !== url.origin && value !== `${url.origin}/`)) {
    throw new Error("Invalid local origin");
  }
  return url.origin;
}

/** Pure boundary for explicit configuration; the server wrapper owns environment access. */
export function readWebConfig(env: Readonly<Record<string, string | undefined>>): WebConfig {
  return {
    daemonOrigin: localOrigin(env.THOUGHTLOOM_DAEMON_URL ?? "http://127.0.0.1:3001"),
    webOrigin: localOrigin(env.THOUGHTLOOM_WEB_ORIGIN ?? "http://127.0.0.1:3000"),
    userToken: env.THOUGHTLOOM_USER_TOKEN,
  };
}
