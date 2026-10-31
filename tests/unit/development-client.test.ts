import { afterEach, expect, test } from "bun:test";
import { getDialogue } from "../../apps/web/lib/development-client";

const originalFetch = globalThis.fetch, originalTimeout = AbortSignal.timeout;
afterEach(() => { globalThis.fetch = originalFetch; AbortSignal.timeout = originalTimeout; });

function controlledFetch() {
  let observed: AbortSignal | undefined;
  globalThis.fetch = (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const signal = init?.signal;
    if (!signal) throw new Error("Expected a bounded request signal");
    observed = signal;
    return new Promise<Response>((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
  return () => observed;
}

test("dialogue reads retain the caller abort even with a timeout", async () => {
  const timeout = new AbortController(), caller = new AbortController();
  let milliseconds = 0;
  AbortSignal.timeout = (value) => { milliseconds = value; return timeout.signal; };
  const observed = controlledFetch(), pending = getDialogue("dialogue-fixture", "root-fixture", caller.signal);
  expect(milliseconds).toBe(10_000); expect(observed()?.aborted).toBe(false);
  caller.abort(); await expect(pending).rejects.toBeDefined();
  expect(observed()?.aborted).toBe(true); expect(timeout.signal.aborted).toBe(false);
});

test("dialogue reads also stop at their timeout when a caller signal is supplied", async () => {
  const timeout = new AbortController(), caller = new AbortController();
  let milliseconds = 0;
  AbortSignal.timeout = (value) => { milliseconds = value; return timeout.signal; };
  const observed = controlledFetch(), pending = getDialogue("dialogue-fixture", "root-fixture", caller.signal);
  expect(milliseconds).toBe(10_000); expect(observed()?.aborted).toBe(false);
  timeout.abort(); await expect(pending).rejects.toBeDefined();
  expect(observed()?.aborted).toBe(true); expect(caller.signal.aborted).toBe(false);
});
