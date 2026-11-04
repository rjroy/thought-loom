import { describe, expect, test } from "bun:test";
import { parseAgentConfig } from "../src/daemon/agent-config";
import { ConfigError, parseConfig } from "../src/daemon/config";
import { AgentUnavailableError, requireAgentConfig, resolveAgentService } from "../src/agent/opencode-adapter";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { startDaemon } from "../src/daemon/runtime";

const base = { THOUGHTLOOM_USER_TOKEN: "user-0123456789-0123456789-abcdef", THOUGHTLOOM_AI_TOKEN: "agent-0123456789-0123456789-abcdef", THOUGHTLOOM_DB_PATH: "/owned/test.sqlite" };
const configured = {
  service: { url: "http://127.0.0.1:44999", token: "fixture-service-token" },
  directory: "/owned/workspace", model: { providerID: "fixture-provider", id: "fixture-model" },
  effort: { quick: "fixture-quick", standard: null, thorough: "fixture-thorough" },
};

describe("optional agent configuration", () => {
  test("absence keeps the daemon configured without choosing an arbitrary model", () => {
    expect(parseAgentConfig(base)).toBeNull();
    expect(parseConfig(base).agent ?? null).toBeNull();
    expect(() => requireAgentConfig(null)).toThrow(AgentUnavailableError);
  });
  test("explicit service, model and effort variants are parsed without leaking values", () => {
    const env = { ...base, THOUGHTLOOM_AGENT_CONFIG: JSON.stringify(configured) };
    expect(parseAgentConfig(env)).toEqual(configured);
    expect(parseConfig(env).agent).toEqual(configured);
  });
  test.each([
    "{",
    JSON.stringify({ ...configured, model: { id: "fixture-model" } }),
    JSON.stringify({ ...configured, model: { providerID: "fixture-provider", id: "" } }),
    JSON.stringify({ ...configured, directory: "" }),
    JSON.stringify({ ...configured, service: { url: "http://user:fixture-secret@127.0.0.1:9" } }),
    JSON.stringify({ ...configured, service: { url: "file:///fixture-secret" } }),
    JSON.stringify({ ...configured, effort: { quick: null, standard: null } }),
    JSON.stringify({ ...configured, unexpected: "fixture-secret" }),
  ])("malformed configured agent data fails safely during startup parsing", value => {
    const env = { ...base, THOUGHTLOOM_AGENT_CONFIG: value };
    let failure: unknown;
    try { parseConfig(env); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(ConfigError);
    if (!(failure instanceof ConfigError)) throw new Error("Expected ConfigError");
    expect(failure.message).toMatch(/THOUGHTLOOM_AGENT_CONFIG/);
    for (const secret of [value, "fixture-secret", "fixture-service-token", base.THOUGHTLOOM_USER_TOKEN, base.THOUGHTLOOM_AI_TOKEN]) expect(failure.message).not.toContain(secret);
  });
  test("discovery only attaches to a returned service; absence is explicit", async () => {
    const discovered = { ...configured, service: { discover: true } } as const;
    let calls = 0;
    expect(await resolveAgentService(discovered, { async discover() { calls++; return { url: "http://127.0.0.1:44555" }; } })).toEqual({ url: "http://127.0.0.1:44555" });
    expect(calls).toBe(1);
    await expect(resolveAgentService(discovered, { async discover() { return null; } })).rejects.toThrow(AgentUnavailableError);
  });
  test("discovery preserves authoritative managed authentication headers without emitting secrets", async () => {
    const discovered = { ...configured, service: { discover: true } } as const;
    const authorization = `Basic ${btoa("fixture-user:fixture-password")}`;
    const result = await resolveAgentService(discovered, { async discover() { return { url: "http://127.0.0.1:44555", headers: { authorization } }; } });
    expect(result).toEqual({ url: "http://127.0.0.1:44555", headers: { authorization } });
    let failure: unknown;
    try { await resolveAgentService(discovered, { async discover() { throw new Error(`untrusted ${authorization} fixture-password`); } }); }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(AgentUnavailableError);
    expect(String(failure)).not.toContain(authorization);
    expect(String(failure)).not.toContain("fixture-password");
  });
  test("without agent configuration capture, read, search and simple export stay available", async () => {
    const dir = await mkdtemp(join("/tmp/opencode", "no-agent-config-"));
    try {
      const config = parseConfig({ ...base, THOUGHTLOOM_DB_PATH: join(dir, "db.sqlite"), THOUGHTLOOM_PORT: "0" });
      const daemon = await startDaemon(config, () => {});
      try {
        const headers = { authorization: `Bearer ${base.THOUGHTLOOM_USER_TOKEN}`, "content-type": "application/json" };
        const request = (path: string, init: RequestInit = {}) => fetch(new URL(path, daemon.url), { ...init, headers, signal: AbortSignal.timeout(2000) });
        const created = await request("/thoughts", { method: "POST", body: JSON.stringify({ text: "fixture capture word" }) });
        expect(created.status).toBe(201);
        const thought = await created.json();
        expect((await request(`/thoughts/${thought.id}`)).status).toBe(200);
        expect((await request("/search?q=fixture")).status).toBe(200);
        const exported = await request("/exports/simple", { method: "POST", body: JSON.stringify({ rootId: thought.id, count: 1, traversal: "breadth" }) });
        expect(exported.status).toBe(200);
        expect(exported.headers.get("content-type")).toMatch(/^text\/markdown/i);
        expect(await exported.text()).toContain("fixture capture word");
      } finally { await Promise.race([daemon.stop(), Bun.sleep(3000).then(() => { throw new Error("Daemon stop timed out"); })]); }
    } finally { await rm(dir, { recursive: true, force: true }); }
  }, 10000);
});
