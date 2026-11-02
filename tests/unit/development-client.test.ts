import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { DialogueSelection } from "../../packages/contracts/src";
import { creationKey, getDialogue } from "../../apps/web/lib/development-client";

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

test("discussion keys preserve the original SHA-256 contract for Unicode and each selection identity", async () => {
  const root = 'root-雪-🧶-"quoted"';
  const cases: { selection: DialogueSelection; identity: string[] }[] = [
    { selection: { kind: "source", id: "source-雪" }, identity: ["source", "source-雪"] },
    { selection: { kind: "item", id: "item-🧶", versionId: "version-1" }, identity: ["item", "item-🧶", "version-1"] },
    { selection: { kind: "item", id: "item-🧶", versionId: "version-2" }, identity: ["item", "item-🧶", "version-2"] },
    { selection: { kind: "relationship", id: "relation-é", versionId: "version-1", fromVersionId: "from-1", toVersionId: "to-2" }, identity: ["relationship", "relation-é", "version-1", "from-1", "to-2"] },
    { selection: { kind: "relationship", id: "relation-é", versionId: "version-1", fromVersionId: "from-2", toVersionId: "to-1" }, identity: ["relationship", "relation-é", "version-1", "from-2", "to-1"] },
  ];
  const keys: string[] = [];
  for (const { selection, identity } of cases) {
    const input = JSON.stringify(["thoughtloom-context-v1", root, JSON.stringify(identity)]);
    const expected = `discussion_${createHash("sha256").update(input, "utf8").digest("hex")}`;
    const actual = await creationKey(root, selection);
    expect(actual).toBe(expected);
    expect(await creationKey(root, selection)).toBe(expected);
    keys.push(actual);
  }
  expect(new Set(keys).size).toBe(cases.length);
  expect(await creationKey(`${root}-other`, cases[0].selection)).not.toBe(keys[0]);
});
