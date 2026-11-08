import { describe, expect, test } from "bun:test";
import { readWebConfig } from "../apps/web/src/server/config";
import { requestDaemon } from "../apps/web/src/server/daemon";
import { isTrustedRequest } from "../apps/web/src/server/request-guard";
import { createLogger, type LogRecord } from "../src/logging";

const token = "owned-token-sentinel";
const thought = "owned-private-thought-sentinel";
const tailscaleOrigin = "https://gsai.raptor-piranha.ts.net";
const config = () => readWebConfig({ THOUGHTLOOM_DAEMON_URL: "http://127.0.0.1:3001", THOUGHTLOOM_WEB_ORIGIN: "http://127.0.0.1:3000", THOUGHTLOOM_USER_TOKEN: token });
const logger = (records: LogRecord[]) => createLogger("verbose", record => records.push(record));
const fakeFetch = (fn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): typeof fetch => fn as typeof fetch;

describe("web server configuration", () => {
  test("Next upload proxy accommodates both bounded Markdown and media requests", async () => {
    const allowance = 4096 + 65536, nextMinimum = 10 * 1024 * 1024;
    const cases = [
      {env:{},markdown:1048576,media:16777216},
      {env:{THOUGHTLOOM_IMPORT_MAX_BYTES:"25165824",THOUGHTLOOM_MEDIA_MAX_BYTES:"20971520"},markdown:25165824,media:20971520},
      {env:{THOUGHTLOOM_IMPORT_MAX_BYTES:"1048576",THOUGHTLOOM_MEDIA_MAX_BYTES:"31457280"},markdown:1048576,media:31457280},
      {env:{THOUGHTLOOM_IMPORT_MAX_BYTES:"1024",THOUGHTLOOM_MEDIA_MAX_BYTES:"2048"},markdown:1024,media:2048},
    ];
    for (const item of cases) {
      const env: Record<string,string | undefined> = {PATH:process.env.PATH,...item.env};
      const proc = Bun.spawn([process.execPath,"--no-env-file","-e",'import config from "./apps/web/next.config.ts"; console.log(JSON.stringify(config.experimental?.proxyClientMaxBodySize))'],
        {env,stdout:"pipe",stderr:"pipe"});
      const [stdout,stderr,exitCode] = await Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text(),proc.exited]);
      expect({exitCode,stderr}).toEqual({exitCode:0,stderr:""});
      expect(JSON.parse(stdout)).toBe(Math.max(nextMinimum,item.markdown + allowance,item.media + allowance));
    }
  });

  test("Next rejects invalid configured media upload limits", async () => {
    for (const value of ["0","-1","1.5","not-a-number","9007199254740991"]) {
      const proc = Bun.spawn([process.execPath,"--no-env-file","-e",'import "./apps/web/next.config.ts"'],
        {env:{PATH:process.env.PATH,THOUGHTLOOM_MEDIA_MAX_BYTES:value},stdout:"pipe",stderr:"pipe"});
      const [stderr,exitCode] = await Promise.all([new Response(proc.stderr).text(),proc.exited]);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("THOUGHTLOOM_MEDIA_MAX_BYTES");
    }
  });

  test("Next dev allows only the configured web hostname and rejects invalid origins", async () => {
    const load = async (webOrigin?: string) => {
      const proc = Bun.spawn([process.execPath, "--no-env-file", "-e", 'import config from "./apps/web/next.config.ts"; console.log(JSON.stringify(config.allowedDevOrigins))'], {
        env: { PATH: process.env.PATH, ...(webOrigin === undefined ? {} : { THOUGHTLOOM_WEB_ORIGIN: webOrigin }) },
        stdout: "pipe", stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      return { stdout, stderr, exitCode };
    };
    for (const [origin, expected] of [[undefined, "127.0.0.1"], ["https://remote.example.test:3002", "remote.example.test"], ["http://localhost:4321", "localhost"], ["http://[::1]:4321", "[::1]"]] as const) {
      const result = await load(origin);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([expected]);
    }
    for (const origin of ["not a url", "http://remote.example.test:3002", "https://remote.example.test/path", "https://*.example.test"]) {
      const result = await load(origin);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Invalid local origin");
    }
  });

  test("has safe loopback defaults and does not require credentials during configuration", () => {
    const result = readWebConfig({});
    expect(result.daemonOrigin).toBe("http://127.0.0.1:3001");
    expect(result.webOrigin).toBe("http://127.0.0.1:3000");
    expect(result.userToken).toBeUndefined();
  });

  for (const value of ["https://example.com", tailscaleOrigin, "http://localhost.evil.test", "http://user:pass@127.0.0.1:3001", "http://127.0.0.1:3001/path", "http://127.0.0.1:3001/?q=x", "http://127.0.0.1:3001/#x", "file:///tmp/a", "not a url"]) {
    test(`rejects invalid daemon origin ${value}`, () => {
      expect(() => readWebConfig({ THOUGHTLOOM_DAEMON_URL: value })).toThrow();
    });
  }

  for (const value of ["http://evil.test:3000", "http://gsai.raptor-piranha.ts.net", "https://user@gsai.raptor-piranha.ts.net", `${tailscaleOrigin}/path`, `${tailscaleOrigin}/?q=1`, `${tailscaleOrigin}/#x`, "http://user@localhost:3000", "http://localhost:3000/path", "http://localhost:3000/?q=1", "http://localhost:3000/#x"]) {
    test(`rejects invalid web origin ${value}`, () => {
      expect(() => readWebConfig({ THOUGHTLOOM_WEB_ORIGIN: value })).toThrow();
    });
  }

  test("accepts explicitly configured remote HTTPS web origins without changing the daemon default", () => {
    for (const origin of [tailscaleOrigin, "https://other.example.test:8443"]) {
      const result = readWebConfig({ THOUGHTLOOM_WEB_ORIGIN: origin });
      expect(result.webOrigin).toBe(origin);
      expect(result.daemonOrigin).toBe("http://127.0.0.1:3001");
    }
  });

  test("accepts explicit loopback origins including IPv6 and independent configurations", () => {
    const first = readWebConfig({ THOUGHTLOOM_DAEMON_URL: "http://localhost:4567", THOUGHTLOOM_WEB_ORIGIN: "http://[::1]:4568", THOUGHTLOOM_USER_TOKEN: "first" });
    const second = readWebConfig({ THOUGHTLOOM_DAEMON_URL: "http://[::1]:4569", THOUGHTLOOM_USER_TOKEN: "second" });
    expect(first.daemonOrigin).toBe("http://localhost:4567");
    expect(first.webOrigin).toBe("http://[::1]:4568");
    expect(second.daemonOrigin).toBe("http://[::1]:4569");
    expect([first.userToken, second.userToken]).toEqual(["first", "second"]);
  });
});

describe("browser request guard", () => {
  const request = (method: string, headers: Record<string, string>) => new Request("http://127.0.0.1:3000/private", { method, headers });
  test("gates private reads on the actual host, not forwarded host", () => {
    expect(isTrustedRequest(config(), request("GET", { host: "127.0.0.1:3000" }))).toBe(true);
    expect(isTrustedRequest(config(), request("GET", { host: "evil.test", "x-forwarded-host": "127.0.0.1:3000" }))).toBe(false);
    expect(isTrustedRequest(config(), request("GET", {}))).toBe(false);
    expect(isTrustedRequest(config(), request("GET", { host: "127.0.0.1:3001" }))).toBe(false);
  });
  test("mutations require the configured host and exact Origin", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(isTrustedRequest(config(), request(method, { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" }))).toBe(true);
      expect(isTrustedRequest(config(), request(method, { host: "127.0.0.1:3000" }))).toBe(false);
      expect(isTrustedRequest(config(), request(method, { host: "127.0.0.1:3000", origin: "http://localhost:3000" }))).toBe(false);
      expect(isTrustedRequest(config(), request(method, { host: "evil.test", origin: "http://127.0.0.1:3000" }))).toBe(false);
    }
  });
  test("compares IPv6 host and port without guessing", () => {
    const ipv6 = readWebConfig({ THOUGHTLOOM_WEB_ORIGIN: "http://[::1]:4312" });
    expect(isTrustedRequest(ipv6, request("GET", { host: "[::1]:4312" }))).toBe(true);
    expect(isTrustedRequest(ipv6, request("GET", { host: "[::1]:4313" }))).toBe(false);
  });
  test("checks the actual Tailscale host and exact mutation origin without trusting forwarded headers", () => {
    const served = readWebConfig({ THOUGHTLOOM_WEB_ORIGIN: tailscaleOrigin });
    const host = "gsai.raptor-piranha.ts.net";
    expect(isTrustedRequest(served, request("GET", { host }))).toBe(true);
    expect(isTrustedRequest(served, request("GET", { host: "evil.test", "x-forwarded-host": host }))).toBe(false);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(isTrustedRequest(served, request(method, { host, origin: tailscaleOrigin }))).toBe(true);
      expect(isTrustedRequest(served, request(method, { host }))).toBe(false);
      expect(isTrustedRequest(served, request(method, { host, origin: "https://evil.test", "x-forwarded-host": host, "x-forwarded-proto": "https" }))).toBe(false);
      expect(isTrustedRequest(served, request(method, { host, origin: "https://other.example.test:8443" }))).toBe(false);
      expect(isTrustedRequest(served, request(method, { host: "evil.test", origin: tailscaleOrigin, "x-forwarded-host": host }))).toBe(false);
    }
  });
});

describe("server daemon transport", () => {
  for (const path of ["https://evil.test/steal", "//evil.test/steal", "/../steal", "/a/../steal", "/%2e%2e/steal", "/a/%2e%2e/steal", "/\\evil.test/x", "relative"]) {
    test(`rejects caller-controlled unsafe path ${path} before fetch`, async () => {
      let called = false;
      const fetch = fakeFetch(async () => { called = true; return new Response(); });
      await expect(requestDaemon(config(), { method: "GET", path }, { fetch, logger: logger([]), timeoutMs: 100 })).rejects.toThrow();
      expect(called).toBe(false);
    });
  }

  test("requires token only on use, before making any request", async () => {
    let called = false;
    const fetch = fakeFetch(async () => { called = true; return new Response(); });
    await expect(requestDaemon(readWebConfig({}), { method: "GET", path: "/thoughts" }, { fetch, logger: logger([]), timeoutMs: 100 })).rejects.toThrow();
    expect(called).toBe(false);
  });

  test("forwards an encoded search query and repeated facets to the configured daemon", async () => {
    const params = new URLSearchParams();
    params.set("q", "café & 雪 and spaces");
    params.append("author", "user");
    params.append("author", "ai");
    params.append("kind", "captured-original");
    params.append("kind", "developing-idea");
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetch = fakeFetch(async (input, init) => { calls.push({ url: String(input), init }); return new Response("ok"); });
    const response = await requestDaemon(config(), { method: "GET", path: `/search?${params}` }, { fetch, logger: logger([]), timeoutMs: 1000 });
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]?.url ?? "");
    expect(url.origin).toBe("http://127.0.0.1:3001");
    expect(url.pathname).toBe("/search");
    expect(url.searchParams.get("q")).toBe("café & 雪 and spaces");
    expect(url.searchParams.getAll("author")).toEqual(["user", "ai"]);
    expect(url.searchParams.getAll("kind")).toEqual(["captured-original", "developing-idea"]);
    expect(calls[0]?.init?.method).toBe("GET");
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe(`Bearer ${token}`);
    expect(calls[0]?.init?.cache).toBe("no-store");
    expect(calls[0]?.init?.redirect).toBe("error");
  });

  test("sends only server credentials and bounded transport options, with redacted read/write logs", async () => {
    const records: LogRecord[] = [];
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetch = fakeFetch(async (input, init) => { calls.push({ url: String(input), init }); return new Response("ok"); });
    const deps = { fetch, logger: logger(records), timeoutMs: 1000 };
    await requestDaemon(config(), { method: "GET", path: "/thoughts" }, deps);
    await requestDaemon(config(), { method: "POST", path: "/thoughts", body: thought }, deps);
    expect(calls.map(call => call.url)).toEqual(["http://127.0.0.1:3001/thoughts", "http://127.0.0.1:3001/thoughts"]);
    for (const call of calls) {
      expect(new Headers(call.init?.headers).get("authorization")).toBe(`Bearer ${token}`);
      expect(call.init?.cache).toBe("no-store");
      expect(call.init?.redirect).toBe("error");
      expect(call.init?.signal).toBeInstanceOf(AbortSignal);
    }
    expect(records.length).toBeGreaterThanOrEqual(4);
    expect(JSON.stringify(records)).not.toContain(token);
    expect(JSON.stringify(records)).not.toContain(thought);
  });

  test("separate instances use only their own configuration and logger", async () => {
    const first: LogRecord[] = [], second: LogRecord[] = [];
    const seen: string[] = [];
    const fetch = fakeFetch(async (input, init) => { seen.push(`${input} ${new Headers(init?.headers).get("authorization")}`); return new Response(); });
    const a = readWebConfig({ THOUGHTLOOM_DAEMON_URL: "http://localhost:4001", THOUGHTLOOM_USER_TOKEN: "alpha" });
    const b = readWebConfig({ THOUGHTLOOM_DAEMON_URL: "http://localhost:4002", THOUGHTLOOM_USER_TOKEN: "beta" });
    await Promise.all([requestDaemon(a, { method: "GET", path: "/a" }, { fetch, logger: logger(first), timeoutMs: 1000 }), requestDaemon(b, { method: "GET", path: "/b" }, { fetch, logger: logger(second), timeoutMs: 1000 })]);
    expect(seen.sort()).toEqual(["http://localhost:4001/a Bearer alpha", "http://localhost:4002/b Bearer beta"]);
    expect(first.length).toBeGreaterThanOrEqual(2);
    expect(second.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify([first, second])).not.toContain("alpha");
    expect(JSON.stringify([first, second])).not.toContain("beta");
  });

  test("aborts timed-out requests and sanitizes upstream exceptions", async () => {
    let aborted = false;
    const fetch = fakeFetch(async (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => { aborted = true; reject(new Error(`${token} ${thought}`)); }, { once: true });
    }));
    const records: LogRecord[] = [];
    let error: unknown;
    try { await requestDaemon(config(), { method: "POST", path: "/thoughts", body: thought }, { fetch, logger: logger(records), timeoutMs: 20 }); } catch (caught) { error = caught; }
    expect(aborted).toBe(true);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(token);
    expect(String(error)).not.toContain(thought);
    expect(JSON.stringify(records)).not.toContain(token);
    expect(JSON.stringify(records)).not.toContain(thought);
  });

  test("does not expose upstream failure bodies while preserving status", async () => {
    const fetch = fakeFetch(async () => new Response(`${token} ${thought}`, { status: 403 }));
    const records: LogRecord[] = [];
    let result: Response | undefined, error: unknown;
    try { result = await requestDaemon(config(), { method: "GET", path: "/thoughts" }, { fetch, logger: logger(records), timeoutMs: 100 }); } catch (caught) { error = caught; }
    const status = result?.status ?? (error as { status?: number } | undefined)?.status;
    expect(status).toBe(403);
    const exposed = result ? await result.text() : String(error);
    expect(exposed).not.toContain(token);
    expect(exposed).not.toContain(thought);
    expect(JSON.stringify(records)).not.toContain(token);
    expect(JSON.stringify(records)).not.toContain(thought);
  });

  for (const status of [307, 308] as const) {
    test(`does not follow ${status} redirects to a second owned server`, async () => {
      let destinationRequests = 0;
      const destination = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { destinationRequests++; return new Response("unexpected"); } });
      const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return new Response(null, { status, headers: { location: `http://127.0.0.1:${destination.port}/leak` } }); } });
      try {
        const local = readWebConfig({ THOUGHTLOOM_DAEMON_URL: `http://127.0.0.1:${upstream.port}`, THOUGHTLOOM_USER_TOKEN: token });
        await expect(requestDaemon(local, { method: "POST", path: "/thoughts", body: thought }, { fetch, logger: logger([]), timeoutMs: 1000 })).rejects.toThrow();
        expect(destinationRequests).toBe(0);
      } finally {
        upstream.stop(true);
        destination.stop(true);
      }
    });
  }
});
