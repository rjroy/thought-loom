import { expect, test } from "bun:test";
import { createAgentInstructionsClient } from "../apps/web/src/features/settings/request";

const snapshot = { weaver: "\uFEFF  owned guidance\r\n", evolve: "", search: "", export: "", revision: 4 };
const fetcher = (response: Response): typeof fetch => Object.assign(
  async (_input: RequestInfo | URL, _init?: RequestInit) => response,
  { preconnect: () => {} },
);
const failures = [
  { method: "GET", status: 502, expected: { kind: "error" } },
  { method: "PUT", status: 409, expected: { kind: "conflict" } },
  { method: "PUT", status: 400, expected: { kind: "error", reason: "invalid" } },
  { method: "PUT", status: 413, expected: { kind: "error", reason: "invalid" } },
  { method: "PUT", status: 415, expected: { kind: "error", reason: "invalid" } },
  { method: "PUT", status: 401, expected: { kind: "error", reason: "forbidden" } },
  { method: "PUT", status: 403, expected: { kind: "error", reason: "forbidden" } },
  { method: "PUT", status: 502, expected: { kind: "error", reason: "unavailable" } },
] as const;

for (const { method, status, expected } of failures) {
  test(`Settings ${method} ${status} cancels its discarded body without waiting or changing classification`, async () => {
    for (const mode of ["success", "throw", "reject", "pending"] as const) {
      const cleanup = Promise.withResolvers<void>();
      let cancels = 0, settled = false;
      const body = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode("owned-sensitive-error-body")); },
        cancel() {
          cancels++;
          if (mode === "throw") throw new Error("owned-sensitive-cancel-error");
          if (mode === "reject") return Promise.reject(new Error("owned-sensitive-cancel-error"));
          if (mode === "pending") return cleanup.promise;
        },
      });
      const response = new Response(body, { status });
      const client = createAgentInstructionsClient(fetcher(response));
      const work = method === "GET" ? client.read() : client.save(snapshot);
      void work.then(() => { settled = true; });
      try {
        // Promise jobs only: an unclosed body or pending cancellation must not
        // hold classification open. No browser, wall-clock delay or network.
        for (let i = 0; i < 40; i++) await Promise.resolve();
        expect(settled).toBe(true);
        expect(cancels).toBe(1);
        expect(response.bodyUsed).toBe(true);
      } finally { cleanup.resolve(); }
      expect(await work).toEqual(expected);
    }
  });
}

for (const method of ["GET", "PUT"] as const) for (const malformed of [false, true]) {
  test(`Settings ${method} 200 consumes ${malformed ? "malformed DTO" : "valid DTO"} JSON without cancelling`, async () => {
    let cancels = 0;
    const receipt = { ...snapshot, revision: 5 };
    const value = malformed ? { weaver: "owned incomplete DTO", revision: 5 } : receipt;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify(value))); controller.close(); },
      cancel() { cancels++; },
    });
    const response = new Response(body, { status: 200 });
    const client = createAgentInstructionsClient(fetcher(response));
    if (method === "GET") {
      expect(await client.read()).toEqual(malformed ? { kind: "error" } : { kind: "success", instructions: receipt });
    } else {
      expect(await client.save(snapshot)).toEqual(malformed ? { kind: "error", reason: "unavailable" } : { kind: "success", instructions: receipt });
    }
    expect(response.bodyUsed).toBe(true);
    expect(cancels).toBe(0);
  });
}
