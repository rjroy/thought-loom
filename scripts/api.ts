export type HttpFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ApiDependencies {
  readonly fetch: HttpFetch;
  readonly stdout: (message: string) => void;
  readonly stderr: (message: string) => void;
  readonly timeoutMs: number;
}

class RequestTimeout extends Error {}
class InvalidJsonResponse extends Error {
  constructor(readonly status: number) { super("Invalid JSON response"); }
}

/** Bound operations even when an injected fetch does not honor AbortSignal. */
export async function bounded<T>(operation: Promise<T>, timeoutMs: number, abort?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => { abort?.(); reject(new RequestTimeout()); }, timeoutMs);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

export async function requestContent(fetcher: HttpFetch, url: URL, init: RequestInit, timeoutMs: number): Promise<{ status: number; value: unknown; format: "json" | "markdown" }> {
  const controller = new AbortController();
  try {
    return await bounded((async () => {
      const response = await fetcher(url, { ...init, redirect: "error", signal: controller.signal });
      const text = await response.text();
      const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (response.ok && mediaType === "text/markdown") return { status: response.status, value: text, format: "markdown" as const };
      let value: unknown = null;
      if (text) {
        try { value = JSON.parse(text); }
        catch { throw new InvalidJsonResponse(response.status); }
      }
      return { status: response.status, value, format: "json" as const };
    })(), timeoutMs, () => controller.abort());
  } finally { controller.abort(); }
}

export async function requestJson(fetcher: HttpFetch, url: URL, init: RequestInit, timeoutMs: number): Promise<{ status: number; value: unknown }> {
  const response = await requestContent(fetcher, url, init, timeoutMs);
  if (response.format !== "json") throw new InvalidJsonResponse(response.status);
  return response;
}

/** CLI shape: --role user|ai METHOD /path[?query] [JSON]. Returns a process exit code. */
export async function runApi(args: readonly string[], env: Readonly<Record<string, string | undefined>>, deps: ApiDependencies): Promise<number> {
  const fail = (message: string) => { deps.stderr(message); return 1; };
  if (args[0] !== "--role" || (args[1] !== "user" && args[1] !== "ai")) return fail("Specify --role user or ai");
  if (args.length < 4 || args.length > 5 || !/^(GET|POST|PUT|PATCH|DELETE)$/.test(args[2] ?? "")) return fail("Invalid method or arguments");
  const path = args[3] ?? "";
  if (!path.startsWith("/") || path.startsWith("//") || /[\\#\x00-\x20\x7f]/.test(path)) return fail("Invalid request path");
  let base: URL;
  try { base = new URL(env.THOUGHTLOOM_DAEMON_URL ?? ""); } catch { return fail("Invalid daemon URL"); }
  if (base.protocol !== "http:" || base.username || base.password || base.pathname !== "/" || base.search || base.hash ||
      !["127.0.0.1", "[::1]", "localhost"].includes(base.hostname)) return fail("Daemon URL must be a loopback HTTP origin without credentials");
  const token = args[1] === "user" ? env.THOUGHTLOOM_USER_TOKEN : env.THOUGHTLOOM_AI_TOKEN;
  if (!token || !token.trim() || /[\r\n]/.test(token)) return fail("Missing or invalid role token");
  let json: string | undefined;
  if (args[4] !== undefined) {
    try { json = JSON.stringify(JSON.parse(args[4])); } catch { return fail("Invalid JSON body"); }
  }
  const url = new URL(path, base);
  if (url.origin !== base.origin) return fail("Invalid request path");
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (json !== undefined) headers["content-type"] = "application/json";
  try {
    const result = await requestContent(deps.fetch, url, { method: args[2], headers, body: json }, deps.timeoutMs);
    const content = result.format === "markdown" ? `\n${result.value}` : result.value === null ? "" : `\n${JSON.stringify(result.value, null, 2)}`;
    // A server response may echo a credential; never print configured secrets.
    let output = `${result.status}${content}`;
    for (const secret of [env.THOUGHTLOOM_USER_TOKEN, env.THOUGHTLOOM_AI_TOKEN]) {
      if (secret) output = output.split(secret).join("[redacted]");
    }
    if (result.status < 200 || result.status >= 300) { deps.stderr(output); return 1; }
    deps.stdout(output);
    return 0;
  } catch (error) {
    if (error instanceof InvalidJsonResponse) return fail(`HTTP ${error.status}: invalid JSON response`);
    return fail(error instanceof RequestTimeout ? "Request timed out" : "Daemon request failed or returned invalid JSON");
  }
}

if (import.meta.main) {
  process.exitCode = await runApi(process.argv.slice(2), process.env, {
    fetch, stdout: message => console.log(message), stderr: message => console.error(message), timeoutMs: 5000,
  });
}
