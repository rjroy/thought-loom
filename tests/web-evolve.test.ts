import { describe, expect, test } from "bun:test";
import { evolveThoughtId } from "../apps/web/src/features/evolve/location";
import { admitEvolve, observeEvolve, resolveEvolve, stopEvolve } from "../apps/web/src/features/evolve/request";
import type { EvolveReceipt, EvolveRun, RunStatus } from "../apps/web/src/features/evolve/types";
import type { IdeaThought, SharedResponse } from "../apps/web/src/features/idea/types";
import { handleEvolveAdmission, handleEvolveRun, handleEvolveThought } from "../apps/web/src/server/evolve";
import type { DaemonRequest } from "../apps/web/src/server/daemon";

const parent: IdeaThought = { id: "parent-1", text: "Owned selected thought", title: "Owned title", titleAuthor: "user", author: "user", kind: "captured-original", createdAt: "2032-01-01T00:00:00Z", origin: "capture", parentId: null, sourceIds: [] };
const contribution: IdeaThought = { ...parent, id: "contrib-1", text: "  owned contribution\n", title: null, titleAuthor: null, kind: "user-contribution", origin: "contribution", parentId: parent.id };
const output1: IdeaThought = { ...parent, id: "output-1", text: "Saved output one", author: "ai", kind: "developing-idea", origin: "development", parentId: contribution.id };
const output2: IdeaThought = { ...output1, id: "output-2", text: "Saved output two" };
const run: EvolveRun = { id: "run-1", kind: "evolve", status: "queued", confirmedThoughtIds: [], responseId: null };
const receipt: EvolveReceipt = { contribution, run };
const completed: EvolveRun = { ...run, status: "completed", confirmedThoughtIds: [output1.id, output2.id], responseId: "reply-1" };
const reply: SharedResponse = { id: "reply-1", text: "Owned retained reply", role: "addendum", state: "complete", thoughtIds: [output1.id, output2.id] };
const json = (value: unknown, status = 200) => Response.json(value, { status });
const browser = (suffix: string, method = "GET", body?: string) => new Request(`http://127.0.0.1:3000${suffix}`, { method, ...(body !== undefined ? { body, headers: { "content-type": "application/json" } } : {}) });
const fakeFetch = (fn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): typeof fetch => fn as typeof fetch;
const snapshot = { thoughtId: parent.id, text: contribution.text };

describe("fresh Evolve entry", () => {
  test("accepts only one selected thought and no browser run binding", () => {
    expect(evolveThoughtId(new URLSearchParams("thoughtId=parent-1"))).toBe("parent-1");
    for (const value of ["", "thoughtId=", "thoughtId=a&thoughtId=b", "thoughtId=a&runId=run-1", "thoughtId=a&scope=history"]) expect(evolveThoughtId(new URLSearchParams(value))).toBeUndefined();
  });
  test("reads only normally visible selected thought", async () => {
    const calls: DaemonRequest[] = [];
    const result = await handleEvolveThought(browser("/api/evolve/thoughts/parent-1"), parent.id, { callDaemon: async command => { calls.push(command); return json(parent); } });
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual(parent);
    expect(result.headers.get("cache-control")).toMatch(/no-store/i);
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]?.path ?? "", "http://daemon.invalid");
    expect(url.pathname).toBe("/thoughts/parent-1");
    expect([null, "normal"]).toContain(url.searchParams.get("scope"));
  });
  test("missing or rejected parent is not silently inspected", async () => {
    for (const upstream of [new Response(null, { status: 404 }), json({ ...parent, rejected: true })]) {
      const calls: DaemonRequest[] = [];
      const result = await handleEvolveThought(browser("/api/evolve/thoughts/parent-1"), parent.id, { callDaemon: async command => { calls.push(command); return upstream; } });
      expect(result.status).not.toBe(200);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.path).not.toContain("history");
      expect(calls[0]?.path).not.toContain("show-rejected");
    }
  });
});

describe("text-only Evolve admission", () => {
  for (const value of ["{", "null", "[]", "{}", '{"text":"  "}', '{"text":3}', ...["title", "effort", "model", "context", "history", "id", "author", "sourceIds"].map(key => JSON.stringify({ text: "valid", [key]: "forbidden" }))]) {
    test(`rejects invalid body before admission: ${value}`, async () => {
      let calls = 0;
      const response = await handleEvolveAdmission(browser("/api/evolve/thoughts/parent-1", "POST", value), parent.id, { callDaemon: async () => { calls++; return json(receipt, 201); } });
      expect(response.status).toBe(400); expect(calls).toBe(0);
    });
  }
  test("posts exact original words once and returns a canonical queued admission", async () => {
    const calls: DaemonRequest[] = [];
    const response = await handleEvolveAdmission(browser("/api/evolve/thoughts/parent-1", "POST", JSON.stringify({ text: snapshot.text })), parent.id, { callDaemon: async command => { calls.push(command); return json(receipt, 201); } });
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toMatch(/no-store/i);
    expect(await response.json()).toEqual(receipt);
    expect(calls).toEqual([{ method: "POST", path: "/thoughts/parent-1/evolve", body: JSON.stringify({ text: snapshot.text }) }]);
  });
  for (const status of [404, 503]) {
    test(`keeps documented ${status} pre-admission rejection`, async () => {
      let calls = 0;
      const response = await handleEvolveAdmission(browser("/api/evolve/thoughts/parent-1", "POST", JSON.stringify({ text: snapshot.text })), parent.id, { callDaemon: async () => { calls++; return new Response("owned-private upstream", { status }); } });
      expect(response.status).toBe(status); expect(calls).toBe(1);
      expect(await response.text()).not.toContain("owned-private");
    });
  }
  for (const bad of [{ contribution: { ...contribution, parentId: "wrong" }, run }, { contribution: { ...contribution, text: "different wording" }, run }, { contribution: { ...contribution, author: "ai" }, run }, { contribution, run: { ...run, kind: "export" } }, { contribution, run: { ...run, status: "invented" } }, { contribution, run: { ...run, confirmedThoughtIds: ["duplicate", "duplicate"] } }, { contribution }]) {
    test(`does not accept malformed 201 receipt ${JSON.stringify(bad)}`, async () => {
      let calls = 0;
      const response = await handleEvolveAdmission(browser("/api/evolve/thoughts/parent-1", "POST", JSON.stringify({ text: snapshot.text })), parent.id, { callDaemon: async () => { calls++; return json(bad, 201); } });
      expect(calls).toBe(1); expect([201, 400, 404, 503]).not.toContain(response.status);
    });
  }
  test("dropped admission remains unconfirmed and sanitized", async () => {
    let calls = 0;
    const response = await handleEvolveAdmission(browser("/api/evolve/thoughts/parent-1", "POST", JSON.stringify({ text: snapshot.text })), parent.id, { callDaemon: async () => { calls++; throw new Error("owned-secret owned contribution"); } });
    expect(calls).toBe(1); expect([201, 400, 404, 503]).not.toContain(response.status);
    expect(await response.text()).not.toContain("owned-secret");
  });
});

describe("known run observation and Stop", () => {
  for (const status of ["queued", "submitting", "running", "uncertain", "completed", "interrupted", "failed"] as const) {
    test(`preserves public ${status} and ordered confirmed identities`, async () => {
      const value: EvolveRun = { ...completed, status };
      const calls: DaemonRequest[] = [];
      const response = await handleEvolveRun(browser("/api/evolve/runs/run-1"), run.id, { callDaemon: async command => { calls.push(command); return json(value); } });
      expect(response.status).toBe(200); expect(await response.json()).toEqual(value);
      expect(calls).toEqual([{ method: "GET", path: "/runs/run-1" }]);
    });
  }
  for (const invalid of [{ ...run, id: "other" }, { ...run, kind: "export" }, { ...run, status: "invented" }, { ...run, confirmedThoughtIds: ["x", "x"] }, { ...run, responseId: 3 }]) {
    test(`rejects wrong or malformed status ${JSON.stringify(invalid)}`, async () => {
      const response = await handleEvolveRun(browser("/api/evolve/runs/run-1"), run.id, { callDaemon: async () => json(invalid) });
      expect(response.status).not.toBe(200);
    });
  }
  test("Stop sends exactly one empty object and returns matching public state", async () => {
    const calls: DaemonRequest[] = [];
    const stopped = { ...completed, status: "interrupted" };
    const response = await handleEvolveRun(browser("/api/evolve/runs/run-1", "POST", "{}"), run.id, { callDaemon: async command => { calls.push(command); return json(stopped); } });
    expect(response.status).toBe(200); expect(await response.json()).toEqual(stopped);
    expect(calls).toEqual([{ method: "POST", path: "/runs/run-1/stop", body: "{}" }]);
  });
  test("Stop refuses caller fields and mismatched confirmation without retry", async () => {
    let calls = 0;
    const deps = { callDaemon: async () => { calls++; return json({ ...run, id: "other" }); } };
    expect((await handleEvolveRun(browser("/api/evolve/runs/run-1", "POST", '{"reason":"x"}'), run.id, deps)).status).toBe(400);
    expect(calls).toBe(0);
    expect((await handleEvolveRun(browser("/api/evolve/runs/run-1", "POST", "{}"), run.id, deps)).status).not.toBe(200);
    expect(calls).toBe(1);
  });
});

describe("issued output and response resolution", () => {
  test("preserves issued order, normal unavailable outputs and canonical reply associations", async () => {
    const seen: string[] = [];
    const result = await resolveEvolve(receipt, completed, { getThought: async (id, scope) => { expect(scope).toBe("normal"); seen.push(id); return id === output1.id ? output1 : null; }, getResponse: async (id, scope) => { expect(scope).toBe("normal"); return id === reply.id ? reply : null; } });
    expect(result.outputs).toEqual([{ id: output1.id, thought: output1 }, { id: output2.id, thought: null }]);
    expect(result.reply).toEqual(reply); expect(result.replyUnavailable).toBe(false);
    expect(result.continuationId).toBe(output1.id);
    expect(seen).toEqual([output1.id, output2.id]);
  });
  test("never publishes a reply associated with unknown outputs", async () => {
    const result = await resolveEvolve(receipt, completed, { getThought: async id => id === output1.id ? output1 : output2, getResponse: async () => ({ ...reply, thoughtIds: ["unrelated"] }) });
    expect(result.reply).toBeNull(); expect(result.replyUnavailable).toBe(true);
  });
  test("does not resolve outputs for a run other than the admitted run", async () => {
    let calls = 0;
    const result = await resolveEvolve(receipt, { ...completed, id: "unrelated-run" }, { getThought: async () => { calls++; return output1; }, getResponse: async () => { calls++; return reply; } });
    expect(calls).toBe(0);
    expect(result.outputs).toEqual([]); expect(result.reply).toBeNull();
    expect(result.continuationId).toBeNull();
  });
  for (const state of ["complete", "interrupted"] as const) {
    test(`${state} fallback ${state === "complete" ? "may continue from contribution" : "does not become a development"}`, async () => {
      const fallback: SharedResponse = { id: "fallback-1", text: "Fallback words", role: "fallback", state, thoughtIds: [contribution.id] };
      const value: EvolveRun = { ...run, status: state === "complete" ? "completed" : "interrupted", responseId: fallback.id };
      const result = await resolveEvolve(receipt, value, { getThought: async () => null, getResponse: async () => fallback });
      expect(result.reply).toEqual(fallback);
      expect(result.continuationId).toBe(state === "complete" ? contribution.id : null);
    });
  }
  for (const status of ["failed", "interrupted"] as const) {
    test(`${status} retains saved issued output`, async () => {
      const value: EvolveRun = { ...completed, status, responseId: null };
      const result = await resolveEvolve(receipt, value, { getThought: async id => id === output1.id ? output1 : output2, getResponse: async () => null });
      expect(result.outputs.map(item => item.thought)).toEqual([output1, output2]);
      expect(result.continuationId).toBe(output2.id); expect(result.reply).toBeNull();
    });
  }
});

describe("client Evolve transport outcomes", () => {
  test("admission posts only original text to fixed local endpoint", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const result = await admitEvolve(snapshot, { fetch: fakeFetch(async (input, init) => { calls.push({ url: String(input), init }); return json(receipt, 201); }) });
    expect(result).toEqual({ kind: "admitted", receipt }); expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("/api/evolve/thoughts/parent-1");
    expect(calls[0]?.init?.method).toBe("POST"); expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ text: snapshot.text });
  });
  for (const [status, kind] of [[404, "not-started"], [503, "not-started"], [500, "uncertain"], [200, "uncertain"]] as const) {
    test(`admission ${status} is ${kind}, no replay or raw errors`, async () => {
      let calls = 0;
      const result = await admitEvolve(snapshot, { fetch: fakeFetch(async () => { calls++; return new Response("owned-secret raw thought", { status }); }) });
      expect(result.kind).toBe(kind); expect(calls).toBe(1);
      if (result.kind === "admitted") throw new Error("unexpected admitted result");
      expect(result.snapshot).toEqual(snapshot); expect(result.message).not.toContain("owned-secret");
    });
  }
  test("lost admission freezes selected parent and wording without replay", async () => {
    const mutable = { ...snapshot };
    let complete: (response: Response) => void = () => { throw new Error("fetch not called"); };
    let url = "", body = "";
    const pending = admitEvolve(mutable, { fetch: fakeFetch(async (input, init) => { url = String(input); body = String(init?.body); return new Promise<Response>(resolve => { complete = resolve; }); }) });
    mutable.thoughtId = "other"; mutable.text = "later draft"; complete(new Response(null, { status: 500 }));
    const result = await pending;
    expect(url).toBe("/api/evolve/thoughts/parent-1"); expect(JSON.parse(body)).toEqual({ text: snapshot.text });
    expect(result.kind).toBe("uncertain"); if (result.kind === "admitted") throw new Error("unexpected success");
    expect(result.snapshot).toEqual(snapshot);
  });
  test("observes only receipt run and preserves typed read failure", async () => {
    const calls: string[] = [];
    const result = await observeEvolve(receipt, { fetch: fakeFetch(async input => { calls.push(String(input)); return json(completed); }) });
    expect(calls).toEqual(["/api/evolve/runs/run-1"]); expect(result).toEqual({ kind: "observed", run: completed });
    const invalid = await observeEvolve(receipt, { fetch: fakeFetch(async () => json({ ...run, id: "wrong" })) });
    expect(invalid.kind).toBe("unavailable");
  });
  for (const status of ["completed", "interrupted", "failed"] as RunStatus[]) {
    test(`terminal Stop returns matching ${status} as benign confirmation`, async () => {
      let count = 0;
      const terminal: EvolveRun = { ...completed, status };
      const result = await stopEvolve(terminal, { fetch: fakeFetch(async (input, init) => { count++; expect(String(input)).toBe("/api/evolve/runs/run-1"); expect(init?.method).toBe("POST"); expect(JSON.parse(String(init?.body))).toEqual({}); return json(terminal); }) });
      expect(count).toBe(1); expect(result).toEqual({ kind: "confirmed", run: terminal });
    });
  }
  test("unconfirmed Stop retains known run and outputs without retry or exception leak", async () => {
    let count = 0;
    const result = await stopEvolve(completed, { fetch: fakeFetch(async () => { count++; throw new Error("owned-secret reply text"); }) });
    expect(count).toBe(1); expect(result.kind).toBe("uncertain");
    if (result.kind !== "uncertain") throw new Error("unexpected confirmed result");
    expect(result.run).toEqual(completed); expect(result.message).not.toContain("owned-secret");
  });
  test("Stop snapshots the known run and its issued IDs before awaiting", async () => {
    const mutable = { ...completed, confirmedThoughtIds: [...completed.confirmedThoughtIds] };
    let complete: (response: Response) => void = () => { throw new Error("fetch not called"); };
    let url = "";
    const pending = stopEvolve(mutable, { fetch: fakeFetch(async input => { url = String(input); return new Promise<Response>(resolve => { complete = resolve; }); }) });
    mutable.id = "other"; mutable.confirmedThoughtIds.push("later");
    complete(new Response(null, { status: 500 }));
    const result = await pending;
    expect(url).toBe("/api/evolve/runs/run-1"); expect(result.kind).toBe("uncertain");
    if (result.kind !== "uncertain") throw new Error("unexpected confirmed result");
    expect(result.run).toEqual(completed);
  });
});
