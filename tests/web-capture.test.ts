import { describe, expect, test } from "bun:test";
import { handleCapture } from "../apps/web/src/server/capture";
import { submitCapture } from "../apps/web/src/features/capture/submission";
import type { DaemonRequest } from "../apps/web/src/server/daemon";

const privateText = "owned thought sentinel";
const secret = "owned token sentinel";
const daemonReceipt = {
  id: "daemon/id & 1", text: "  canonical thought\n", title: "Canonical title",
  author: "user", kind: "captured-original", createdAt: "2031-02-03T00:00:00Z",
  origin: "capture", parentId: null, sourceIds: [], titleAuthor: "user",
};
const receipt = { id: daemonReceipt.id, text: daemonReceipt.text, title: daemonReceipt.title };
const json = (value: unknown, status = 201) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const request = (body: string) => new Request("http://127.0.0.1:3000/api/capture", { method: "POST", headers: { "content-type": "application/json" }, body });
const fakeFetch = (fn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): typeof fetch => fn as typeof fetch;

describe("fixed-purpose capture server handler", () => {
  const invalid = ["{", "null", "[]", "{}", JSON.stringify({ text: " \n\t " }), JSON.stringify({ text: 42 }), JSON.stringify({ text: "valid", title: 3 }), ...["id", "createdAt", "author", "kind", "origin", "parentId", "sourceIds", "headers", "path", "token"].map(key => JSON.stringify({ text: "valid", [key]: "caller-owned" }))];
  for (const body of invalid) {
    test(`rejects invalid or forbidden input ${body}`, async () => {
      let calls = 0;
      const response = await handleCapture(request(body), { callDaemon: async () => { calls++; return json(daemonReceipt); } });
      expect(response.status).toBe(400);
      expect(calls).toBe(0);
    });
  }

  for (const input of [{ text: "  exact words\n" }, { text: "original", title: null }, { text: "original", title: "  exact title  " }]) {
    test(`forwards only authorized fields once: ${JSON.stringify(input)}`, async () => {
      const calls: DaemonRequest[] = [];
      const response = await handleCapture(request(JSON.stringify(input)), { callDaemon: async command => { calls.push(command); return json(daemonReceipt); } });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.method).toBe("POST");
      expect(calls[0]?.path).toBe("/thoughts");
      const body = calls[0]?.body;
      if (typeof body !== "string") throw new Error("Capture must send a JSON body");
      expect(JSON.parse(body)).toEqual(input);
      expect(response.status).toBe(201);
      const result = await response.json();
      expect(result).toEqual(receipt);
      expect(response.headers.get("cache-control")).toMatch(/no-store/i);
    });
  }

  test("does not require an optional blank title", async () => {
    const calls: DaemonRequest[] = [];
    const response = await handleCapture(request(JSON.stringify({ text: "original", title: "" })), { callDaemon: async command => { calls.push(command); return json(daemonReceipt); } });
    expect(response.status).toBe(201);
    expect(calls).toHaveLength(1);
    const body = calls[0]?.body;
    if (typeof body !== "string") throw new Error("Capture must send a JSON body");
    expect([{ text: "original" }, { text: "original", title: "" }]).toContainEqual(JSON.parse(body));
  });

  for (const status of [400, 401, 403]) {
    test(`preserves pre-creation rejection ${status} without leaking daemon body`, async () => {
      const response = await handleCapture(request(JSON.stringify({ text: privateText })), { callDaemon: async () => new Response(`${secret} ${privateText}`, { status }) });
      expect(response.status).toBe(status);
      const body = await response.text();
      expect(body).not.toContain(secret);
      expect(body).not.toContain(privateText);
    });
  }

  for (const failure of ["drop", "500", "malformed", "shape"] as const) {
    test(`does not present ${failure} as confirmed creation or pre-creation rejection`, async () => {
      let calls = 0;
      const response = await handleCapture(request(JSON.stringify({ text: privateText })), { callDaemon: async () => {
        calls++;
        if (failure === "drop") throw new Error(`${secret} ${privateText}`);
        if (failure === "500") return new Response(`${secret} ${privateText}`, { status: 500 });
        if (failure === "malformed") return new Response("{", { status: 201 });
        return json({ id: "", text: 42, title: null });
      } });
      expect(calls).toBe(1);
      expect([201, 400, 401, 403]).not.toContain(response.status);
      const body = await response.text();
      expect(body).not.toContain(secret);
      expect(body).not.toContain(privateText);
    });
  }
});

describe("client-safe capture submission", () => {
  test("posts the submitted snapshot once to the fixed local route and returns the canonical receipt", async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    const fetch = fakeFetch(async (input, init) => { calls.push({ input: String(input), init }); return json(receipt); });
    const snapshot = { text: "  exact input\n", title: "  input title " };
    const result = await submitCapture(snapshot, { fetch });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe("/api/capture");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(new Headers(calls[0]?.init?.headers).get("content-type")).toMatch(/application\/json/i);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual(snapshot);
    expect(result).toEqual({ kind: "saved", receipt });
  });

  for (const status of [400, 401, 403]) {
    test(`classifies ${status} as not saved and retains the original draft`, async () => {
      let calls = 0;
      const snapshot = { text: privateText, title: null };
      const result = await submitCapture(snapshot, { fetch: fakeFetch(async () => { calls++; return new Response(secret, { status }); }) });
      expect(calls).toBe(1);
      expect(result.kind).toBe("not-saved");
      if (result.kind !== "not-saved") throw new Error("Expected not-saved result");
      expect(result.snapshot).toEqual(snapshot);
      expect(result.message).not.toContain(secret);
      expect(result.message).not.toContain(privateText);
    });
  }

  for (const failure of ["timeout", "drop", "500", "malformed", "missing-id", "missing-title", "bad-text", "unexpected-success"] as const) {
    test(`classifies ${failure} as uncertain without replay or raw diagnostics`, async () => {
      let calls = 0;
      const fetch = fakeFetch(async () => {
        calls++;
        if (failure === "timeout" || failure === "drop") throw new Error(`${secret} ${privateText}`);
        if (failure === "500") return new Response(`${secret} ${privateText}`, { status: 500 });
        if (failure === "malformed") return new Response("{", { status: 201 });
        if (failure === "missing-id") return json({ text: "x", title: null });
        if (failure === "missing-title") return json({ id: "id", text: "x" });
        if (failure === "bad-text") return json({ id: "id", text: 7, title: null });
        return json(receipt, 200);
      });
      const snapshot = { text: privateText, title: "my title" };
      const result = await submitCapture(snapshot, { fetch });
      expect(calls).toBe(1);
      expect(result.kind).toBe("uncertain");
      if (result.kind !== "uncertain") throw new Error("Expected uncertain result");
      expect(result.snapshot).toEqual(snapshot);
      expect(result.message).not.toContain(secret);
      expect(result.message).not.toContain(privateText);
    });
  }

  test("freezes the attempted values before awaiting the response", async () => {
    let finish: (response: Response) => void = () => { throw new Error("fetch not called"); };
    let posted = "";
    const fetch = fakeFetch(async (_input, init) => { posted = String(init?.body); return new Promise<Response>(resolve => { finish = resolve; }); });
    const mutable = { text: "first draft", title: "first title" };
    const pending = submitCapture(mutable, { fetch });
    mutable.text = "later edit";
    mutable.title = "later title";
    finish(new Response(null, { status: 500 }));
    const result = await pending;
    expect(JSON.parse(posted)).toEqual({ text: "first draft", title: "first title" });
    expect(result.kind).toBe("uncertain");
    if (result.kind !== "uncertain") throw new Error("Expected uncertain result");
    expect(result.snapshot).toEqual({ text: "first draft", title: "first title" });
  });
});
