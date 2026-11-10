import { expect, test } from "bun:test";
import { Readable } from "node:stream";
import { settingsDaemon } from "../apps/web/tests/settings.runtime";
import { readWebConfig } from "../apps/web/src/server/config";
import { requestDaemon, type DaemonRequest } from "../apps/web/src/server/daemon";
import { isTrustedRequest } from "../apps/web/src/server/request-guard";
import { createLogger, type LogRecord } from "../src/logging";

const origin = "http://127.0.0.1:4310";
const token = "owned-settings-user-token";
const config = readWebConfig({ THOUGHTLOOM_WEB_ORIGIN: origin, THOUGHTLOOM_DAEMON_URL: "http://127.0.0.1:4311", THOUGHTLOOM_USER_TOKEN: token });

test("Settings daemon fixture preserves exact UTF-8 when a request chunk splits a multibyte character", async () => {
  const value = { weaver: "a".repeat(16384), evolve: "🌱".repeat(4096), search: "\uFEFF  café 雪\r\n", export: "", revision: 0 };
  const wire = JSON.stringify(value), bytes = Buffer.from(wire, "utf8");
  const emoji = bytes.indexOf(Buffer.from("🌱", "utf8"));
  expect(emoji).toBeGreaterThanOrEqual(0);
  expect(Buffer.byteLength(value.weaver, "utf8")).toBe(16384);
  expect(Buffer.byteLength(value.evolve, "utf8")).toBe(16384);
  for (const chunks of [[bytes], [bytes.subarray(0, emoji + 2), bytes.subarray(emoji + 2)]]) {
    const daemon = settingsDaemon(token);
    // Object mode preserves these exact Buffer boundaries without TCP timing.
    const request = Object.assign(Readable.from(chunks, { objectMode: true }), {
      method: "PUT", url: "/settings/agent-instructions",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    });
    let status = 0, reply = "";
    const response = { writeHead(code: number) { status = code; return { end(body = "") { reply = body; } }; } };
    try {
      await daemon.handler(request, response);
      expect(status).toBe(200);
      expect(JSON.parse(reply)).toEqual({ ...value, revision: 1 });
      expect(daemon.snapshot()).toEqual({ ...value, revision: 1 });
      expect(daemon.attempts).toHaveLength(1);
      expect(daemon.attempts[0]?.body).toBe(wire);
    } finally { daemon.release(); request.destroy(); }
  }
});

test("Settings transport preserves all exact guidance and the body CAS revision without logging either", async () => {
  const value = { weaver: "\uFEFF  café 雪\r\nnext line  ", evolve: "\t", search: "", export: "🌱\n", revision: 7 };
  const records: LogRecord[] = [], calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return Response.json(value);
  }) as typeof fetch;
  const deps = { fetch: fetcher, logger: createLogger("verbose", record => records.push(record)), timeoutMs: 1000 };
  const commands: DaemonRequest[] = [
    { method: "GET", path: "/settings/agent-instructions" },
    { method: "PUT", path: "/settings/agent-instructions", body: JSON.stringify(value) },
  ];
  for (const command of commands) await requestDaemon(config, command, deps);
  expect(calls.map(call => call.url)).toEqual(Array(2).fill("http://127.0.0.1:4311/settings/agent-instructions"));
  expect(calls.map(call => call.init.method)).toEqual(["GET", "PUT"]);
  expect(JSON.parse(String(calls[1]?.init.body))).toEqual(value);
  for (const { init } of calls) {
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${token}`);
    expect(headers.has("cookie")).toBe(false);
    expect(headers.has("if-match")).toBe(false);
    expect(init.cache).toBe("no-store");
    expect(init.redirect).toBe("error");
  }
  expect(JSON.stringify(records)).not.toContain(token);
  expect(JSON.stringify(records)).not.toContain("café");
});

test("Settings reads and writes use actual web authority, with exact mutation Origin rather than forwarded headers", () => {
  const request = (method: string, headers: Record<string, string>) => new Request(`${origin}/api/settings/agent-instructions`, { method, headers });
  expect(isTrustedRequest(config, request("GET", { host: "127.0.0.1:4310" }))).toBe(true);
  expect(isTrustedRequest(config, request("GET", { host: "foreign.invalid", "x-forwarded-host": "127.0.0.1:4310" }))).toBe(false);
  expect(isTrustedRequest(config, request("PUT", { host: "127.0.0.1:4310", origin }))).toBe(true);
  const rejectedHeaders: Array<Record<string, string>> = [
    { host: "127.0.0.1:4310" },
    { host: "127.0.0.1:4310", origin: "https://foreign.invalid" },
    { host: "foreign.invalid", origin, "x-forwarded-host": "127.0.0.1:4310" },
  ];
  for (const headers of rejectedHeaders) expect(isTrustedRequest(config, request("PUT", headers))).toBe(false);
});
