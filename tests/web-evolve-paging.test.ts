import { expect, test } from "bun:test";
import { handleEvolveSession } from "../apps/web/src/server/evolve-sessions";
import type { DaemonRequest } from "../apps/web/src/server/daemon";
import { selectiveClient } from "../apps/web/src/components/evolve-selective-client";

const session = { id: "session-1", anchorThoughtId: "anchor-1", continuationThoughtId: "anchor-1", mode: "ideas-only", createdAt: "2032-01-01T00:00:00.000Z" };
const turn = { id: "turn-1", parentId: "anchor-1", text: "Owned message", status: "running", admittedAt: session.createdAt, runId: "run-1", reply: null, saves: [] };
const admission = { receipt: { sessionId: session.id, turnId: turn.id, admittedAt: turn.admittedAt }, turn,
  run: { id: "run-1", kind: "evolve", status: "running", confirmedThoughtIds: [], responseId: null } };

test("selective Next boundary forwards bounded turn and receipt reads without widening scope", async () => {
  const calls: DaemonRequest[] = [];
  const read = async (path: string, body: object) => {
    const response = await handleEvolveSession(new Request(`http://localhost/api${path}`), async command => {
      calls.push(command);
      return Response.json(body);
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual(body);
  };
  await read("/evolve-sessions/session-1?limit=2&before=turn-3", { session, turns: [], nextBefore: null });
  await read("/evolve-sessions/session-1/turns/turn-1/saves?limit=2&after=save-1", { saves: [], nextAfter: null });
  expect(calls.map(call => call.path)).toEqual([
    "/evolve-sessions/session-1?limit=2&before=turn-3",
    "/evolve-sessions/session-1/turns/turn-1/saves?limit=2&after=save-1",
  ]);
  expect(calls.every(call => call.method === "GET")).toBe(true);
});

test("selective Next boundary rejects ambiguous or unbounded paging before daemon access", async () => {
  let calls = 0;
  for (const query of ["?limit=0", "?limit=21", "?limit=1&limit=2", "?before=turn-1", "?limit=1&unknown=1"]) {
    const response = await handleEvolveSession(new Request(`http://localhost/api/evolve-sessions/session-1${query}`), async () => {
      calls++; return Response.json({});
    });
    expect(response.status).toBe(400);
  }
  expect(calls).toBe(0);
});

test("receipt-only send and original-key lookup cross Next without broadening or dropping identity", async () => {
  const calls: DaemonRequest[] = [];
  for (const [path, method] of [
    ["/evolve-sessions/session-1/turns?view=receipt", "POST"],
    ["/evolve-sessions/session-1/turns/by-key/owned-key?view=receipt", "GET"],
  ] as const) {
    const response = await handleEvolveSession(new Request(`http://localhost/api${path}`, {
      method, ...(method === "POST" ? { headers: { "content-type": "application/json", "idempotency-key": "owned-key" }, body: JSON.stringify({ parentId: "anchor-1", text: turn.text }) } : {}),
    }), async command => { calls.push(command); return Response.json(admission, { status: method === "POST" ? 201 : 200 }); });
    expect(response.status).toBe(method === "POST" ? 201 : 200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual(admission);
  }
  expect(calls.map(call => call.path)).toEqual([
    "/evolve-sessions/session-1/turns?view=receipt",
    "/evolve-sessions/session-1/turns/by-key/owned-key?view=receipt",
  ]);
  expect(calls[0]?.idempotencyKey).toBe("owned-key");
});

test("selective client requests bounded receipt view for send and original-key recovery", async () => {
  const original = globalThis.fetch;
  const calls: { path: string; method: string; key: string | null }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ path: String(input), method: init?.method ?? "GET", key: new Headers(init?.headers).get("idempotency-key") });
    return Response.json(admission, { status: init?.method === "POST" ? 201 : 200 });
  }) as typeof fetch;
  try {
    const snapshot = { parentId: "anchor-1", text: turn.text };
    expect((await selectiveClient.send(session.id, "owned-key", snapshot)).kind).toBe("ok");
    expect((await selectiveClient.checkSend(session.id, "owned-key", snapshot)).kind).toBe("ok");
    expect(calls).toEqual([
      { path: "/api/evolve-sessions/session-1/turns?view=receipt", method: "POST", key: "owned-key" },
      { path: "/api/evolve-sessions/session-1/turns/by-key/owned-key?view=receipt", method: "GET", key: null },
    ]);
  } finally { globalThis.fetch = original; }
});
