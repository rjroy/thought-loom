import { afterEach, expect, test } from "bun:test";
import { proxy } from "../../apps/web/proxy";
import { isLocalRequest } from "../../packages/contracts/src/local-request";
import { accessHost } from "../fixtures/access-host";

const originalHost = process.env.THOUGHTLOOM_ALLOWED_HOST;
const originalBind = process.env.THOUGHTLOOM_WEB_HOST;
afterEach(() => {
  if (originalHost === undefined) delete process.env.THOUGHTLOOM_ALLOWED_HOST;
  else process.env.THOUGHTLOOM_ALLOWED_HOST = originalHost;
  if (originalBind === undefined) delete process.env.THOUGHTLOOM_WEB_HOST;
  else process.env.THOUGHTLOOM_WEB_HOST = originalBind;
});

function webRequest(headers: Record<string, string>, syntheticHost = "0.0.0.0") {
  const request = new Request(`http://${syntheticHost}:4317/`, { headers });
  return proxy(request as Parameters<typeof proxy>[0]);
}

test("web wildcard bind accepts approved external authorities without trusting the bind authority", () => {
  process.env.THOUGHTLOOM_ALLOWED_HOST = accessHost;
  process.env.THOUGHTLOOM_WEB_HOST = "0.0.0.0";
  for (const host of [`${accessHost}:4317`, "127.0.0.1:4317"]) {
    for (const headers of [{ host }, { host, origin: `http://${host}` }]) {
      expect(webRequest(headers).headers.get("x-middleware-next")).toBe("1");
    }
  }
  const rejected: Record<string, string>[] = [
    { host: "0.0.0.0:4317" },
    { host: "attacker.example:4317", "x-forwarded-host": "127.0.0.1:4317" },
    { host: `${accessHost}:4317`, origin: "http://attacker.example" },
    { host: `${accessHost}:4317`, "x-forwarded-host": "attacker.example" },
    { host: `${accessHost}:4317`, "x-forwarded-proto": "https" },
    { host: `${accessHost}:4317`, forwarded: "host=localhost" },
  ];
  for (const headers of rejected) expect(webRequest(headers).status).toBe(403);
});

test("specific IPv4 bind is internal authority, not an additional trusted external host", () => {
  const bind = "100.64.0.10"; // Fixture only: no network access is made.
  process.env.THOUGHTLOOM_ALLOWED_HOST = accessHost;
  process.env.THOUGHTLOOM_WEB_HOST = bind;
  for (const host of [`${accessHost}:4317`, "127.0.0.1:4317"]) {
    for (const headers of [{ host }, { host, origin: `http://${host}` }]) {
      expect(webRequest(headers, bind).headers.get("x-middleware-next")).toBe("1");
    }
  }
  const rejected: Record<string, string>[] = [
    { host: `${bind}:4317` },
    { host: `${accessHost.replace(/\.test$/, "")}:4317` },
    { host: "attacker.example:4317", "x-forwarded-host": "127.0.0.1:4317" },
    { host: `${accessHost}:4317`, origin: "http://attacker.example" },
    { host: `${accessHost}:4317`, "x-forwarded-host": "attacker.example" },
    { host: `${accessHost}:4317`, "x-forwarded-proto": "https" },
    { host: `${accessHost}:4317`, forwarded: "host=localhost" },
  ];
  for (const headers of rejected) expect(webRequest(headers, bind).status).toBe(403);
  expect(webRequest({ host: `${accessHost}:4317` }, "100.64.0.11").status).toBe(403);
});

test("wildcard bind does not relax the shared daemon authority guard", () => {
  process.env.THOUGHTLOOM_ALLOWED_HOST = accessHost;
  process.env.THOUGHTLOOM_WEB_HOST = "0.0.0.0";
  expect(isLocalRequest(new Request("http://0.0.0.0:4318/", { headers: { host: `${accessHost}:4318` } }))).toBe(false);
  expect(isLocalRequest(new Request("http://127.0.0.1:4318/", { headers: { host: "0.0.0.0:4318" } }))).toBe(false);
});
