import { expect, test } from "bun:test";
import { createAgenticSearchController } from "../apps/web/src/features/agentic-search/controller";
import { clientClock, SearchRequestError, type SearchClient } from "../apps/web/src/features/agentic-search/request";
import type { Composer, Discovery, Message, NormalPage, Run, Session } from "../apps/web/src/features/agentic-search/types";

const at = "2030-01-01T00:00:00.000Z";
const session = (id: string): Session => ({ id, title: `Session ${id}`, createdAt: at, lastActivityAt: at, revision: 0 });
const composer = (id: string): Composer => ({ composerId: `composer-${id}`, contextToken: `token-${id}`, eligibilityRevision: 0 });
const msg = (id: string, position: number): Message => ({ id, runId: `run-${id}`, position, role: "user", text: `text-${id}`, createdAt: at, disposition: null, evidenceThoughtIds: [], availability: "available" });
const entry = (id: string, position: number): Discovery => ({ id, position, addedAt: at, removedAt: null, thought: { id: "shared-thought", title: "Shared thought", titleAuthor: "user", author: "user", kind: "captured-original", createdAt: at }, why: `why-${id}`, evidenceThoughtIds: [], availability: "available", reasonStatus: "available" });
function page<T>(id: string, items: T[], cursor: string | null, revision = 0): NormalPage<T> {
  return { ...composer(id), items, nextCursor: cursor, sessionRevision: revision };
}
function client(overrides: Partial<SearchClient> = {}): SearchClient {
  const unused = async (): Promise<never> => { throw new Error("unexpected test call"); };
  return { catalog: unused, metadata: async id => ({ session: session(id), activeRun: null, eligibilityRevision: 0 }), create: unused,
    rename: unused, removeSession: unused, open: async id => composer(id), refresh: async id => composer(id), discard: unused,
    messages: async id => page(id, [], null), discoveries: async id => page(id, [], null), preview: unused,
    removeOccurrence: unused, admit: unused, byKey: unused, check: unused, stop: unused, cancelReads: () => {}, ...overrides };
}
function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error("uninitialized deferred"); };
  const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve };
}
async function open(controller: ReturnType<typeof createAgenticSearchController>, id: string) { await controller.loadMetadata(id); await controller.resume(id); }
function normal(controller: ReturnType<typeof createAgenticSearchController>, id: string) {
  const content = controller.get(id)?.content;
  if (!content || content.kind !== "normal") throw new Error(`missing normal owned workspace ${id}`);
  return content;
}

test("delayed first-session page cannot overwrite a switched workspace or its composer token", async () => {
  const held = deferred<NormalPage<Message>>(), started = deferred<void>(); let pause = false;
  const c = client({ messages: async id => {
    if (id === "A" && pause) { started.resolve(); return held.promise; }
    return page(id, [msg(id, 0)], null);
  } });
  const controller = createAgenticSearchController(c, () => "unused", () => ({ at, timeZone: "UTC" }));
  await open(controller, "A"); pause = true;
  const oldRead = controller.readPage("A", "messages"); await started.promise;
  controller.leave("A"); await open(controller, "B");
  held.resolve({ ...page("A", [msg("STALE-A", 1)], null), contextToken: "STALE-A-TOKEN" }); await oldRead;
  const second = controller.get("B");
  expect(normal(controller, "B").messages.items.map(item => item.text)).toEqual(["text-B"]);
  expect(second?.context).toEqual({ kind: "editable", composer: composer("B") });
  expect(JSON.stringify(second)).not.toContain("STALE-A");
  expect(JSON.stringify(controller.get("A"))).not.toContain("STALE-A");
});

test("removal revision rejects delayed E1 page and preserves distinct later E2 occurrence", async () => {
  const held = deferred<NormalPage<Discovery>>(), started = deferred<void>(); let phase: "initial" | "held" | "new" = "initial";
  const c = client({ discoveries: async id => {
    if (phase === "held") { started.resolve(); return held.promise; }
    return page(id, phase === "new" ? [entry("E2", 1)] : [entry("E1", 0)], null, phase === "new" ? 5 : 3);
  }, removeOccurrence: async () => 4 });
  const controller = createAgenticSearchController(c, () => "unused", () => ({ at, timeZone: "UTC" }));
  await open(controller, "A"); expect(normal(controller, "A").discoveries.items.map(item => item.id)).toEqual(["E1"]);
  phase = "held"; const stale = controller.readPage("A", "discoveries"); await started.promise;
  await controller.removeOccurrence("A", "E1");
  held.resolve(page("A", [entry("E1", 0)], null, 3)); await stale;
  expect(normal(controller, "A").discoveries.items).toEqual([]);
  phase = "new"; await controller.readPage("A", "discoveries");
  expect(normal(controller, "A").discoveries.items.map(item => item.id)).toEqual(["E2"]);
  await controller.removeOccurrence("A", "E1");
  expect(normal(controller, "A").discoveries.items.map(item => item.id)).toEqual(["E2"]);
});

test("normal revalidation retains already loaded message and discovery pages", async () => {
  const c = client({ messages: async (id, _composer, cursor) => cursor ? page(id, [msg("M2", 1)], null, 1) : page(id, [msg("M1", 0)], "message-next", 1),
    discoveries: async (id, _composer, cursor) => cursor ? page(id, [entry("E2", 1)], null, 1) : page(id, [entry("E1", 0)], "discovery-next", 1) });
  const controller = createAgenticSearchController(c, () => "unused", () => ({ at, timeZone: "UTC" }));
  await open(controller, "A");
  await controller.readPage("A", "messages", "message-next"); await controller.readPage("A", "discoveries", "discovery-next");
  expect(normal(controller, "A").messages.items.map(item => item.id)).toEqual(["M1", "M2"]);
  expect(normal(controller, "A").discoveries.items.map(item => item.id)).toEqual(["E1", "E2"]);
  await controller.readNormal("A");
  expect(normal(controller, "A").messages.items.map(item => item.id)).toEqual(["M1", "M2"]);
  expect(normal(controller, "A").discoveries.items.map(item => item.id)).toEqual(["E1", "E2"]);
});

test("a queued page from C1 cannot execute or publish after the same session resumes with C2", async () => {
  const held = deferred<NormalPage<Message>>(), started = deferred<void>();
  let hold = false; const calls: string[] = [];
  const c = client({ open: async () => composer("C1"), refresh: async () => composer("C2"),
    messages: async (_id, cid, cursor) => {
      if (cid === null) throw new Error("normal composer-scoped read expected");
      calls.push(`${cid}:${cursor ?? "first"}`);
      if (hold && cid === "composer-C1" && cursor === "held") { started.resolve(); return held.promise; }
      return page(cid === "composer-C1" ? "C1" : "C2", [msg(cid, 0)], null);
    }, discoveries: async (_id, cid) => page(cid === "composer-C1" ? "C1" : "C2", [], null) });
  const controller = createAgenticSearchController(c);
  await open(controller, "A"); hold = true;
  const old = controller.readPage("A", "messages", "held"); await started.promise;
  const queued = controller.readPage("A", "messages", "queued-C1");
  controller.leave("A"); const resumed = controller.resume("A");
  held.resolve({ ...page("C1", [msg("STALE-C1", 1)], null), contextToken: "STALE-C1-TOKEN" });
  await Promise.all([old, queued, resumed]);
  expect(calls).not.toContain("composer-C1:queued-C1");
  expect(calls).not.toContain("composer-C2:queued-C1");
  expect(controller.get("A")?.context).toEqual({ kind: "editable", composer: composer("C2") });
  expect(normal(controller, "A").messages.items.map(item => item.text)).toEqual(["text-composer-C2"]);
  expect(JSON.stringify(controller.get("A"))).not.toContain("STALE-C1");
});

test("a rejected older page invalidates the composer without exposing old text or allowing send", async () => {
  let rejected = false, admissions = 0;
  const c = client({ messages: async (id, _cid, cursor) => {
    if (cursor && rejected) throw new SearchRequestError(409, "context-changed");
    return cursor ? page(id, [msg("OLD-PRIVATE", 1)], null, 1) : page(id, [msg("M1", 0)], "next", 1);
  }, admit: async () => { admissions++; throw new Error("unexpected admission"); } });
  const controller = createAgenticSearchController(c);
  await open(controller, "A"); await controller.readPage("A", "messages", "next");
  expect(normal(controller, "A").messages.items[1]?.text).toBe("text-OLD-PRIVATE");
  controller.changeDraft("A", "preserve this draft"); rejected = true;
  await controller.readNormal("A");
  const current = controller.get("A");
  expect(current?.context.kind).toBe("changed");
  expect(current?.content.kind).toBe("unopened");
  expect(JSON.stringify(current)).not.toContain("OLD-PRIVATE");
  expect(current?.blockedDraft).toBe("preserve this draft");
  await controller.send("A"); expect(admissions).toBe(0);
});

test("failed continuation hides loaded prose and a retry recovers the previously read coverage", async () => {
  let fail = false; const cursors: (string | undefined)[] = [];
  const c = client({ messages: async (id, _cid, cursor) => {
    cursors.push(cursor);
    if (cursor && fail) throw new SearchRequestError(400, "invalid-cursor");
    return cursor ? page(id, [msg("OLDER", 1)], null, 2) : page(id, [msg("FIRST", 0)], "next", 2);
  }, discoveries: async id => page(id, [entry("PRIVATE-REASON", 0)], null, 2) });
  const controller = createAgenticSearchController(c);
  await open(controller, "A"); await controller.readPage("A", "messages", "next");
  fail = true; await controller.readNormal("A");
  expect(controller.get("A")?.observationError).toBe(true);
  expect(controller.get("A")?.content.kind).toBe("unopened");
  expect(JSON.stringify(controller.get("A"))).not.toContain("text-OLDER");
  expect(JSON.stringify(controller.get("A"))).not.toContain("why-PRIVATE-REASON");
  fail = false; cursors.length = 0; await controller.readNormal("A");
  expect(cursors).toEqual([undefined, "next"]);
  expect(normal(controller, "A").messages.items.map(item => item.id)).toEqual(["FIRST", "OLDER"]);
  expect(controller.get("A")?.observationError).toBe(false);
});

test("removal during a multi-page rewalk cannot resurrect E1 and a later E2 remains distinct", async () => {
  const held = deferred<NormalPage<Discovery>>(), started = deferred<void>(); let phase: "initial" | "held" | "new" = "initial";
  const c = client({ messages: async id => page(id, [], null, phase === "new" ? 4 : 3),
    discoveries: async (id, _cid, cursor) => {
      if (phase === "held" && cursor) { started.resolve(); return held.promise; }
      if (phase === "new") return page(id, [entry("E2", 1)], null, 4);
      return cursor ? page(id, [entry("E1", 1)], null, 3) : page(id, [entry("FIRST", 0)], "next", 3);
    }, removeOccurrence: async () => 4 });
  const controller = createAgenticSearchController(c);
  await open(controller, "A"); await controller.readPage("A", "discoveries", "next");
  phase = "held"; const refresh = controller.readNormal("A"); await started.promise;
  await controller.removeOccurrence("A", "E1");
  held.resolve(page("A", [entry("E1", 1)], null, 3)); await refresh;
  expect(JSON.stringify(controller.get("A"))).not.toContain("why-E1");
  expect(controller.get("A")?.observationError).toBe(true);
  phase = "new"; await controller.readNormal("A");
  expect(normal(controller, "A").discoveries.items.map(item => item.id)).toEqual(["E2"]);
  await controller.removeOccurrence("A", "E1");
  expect(normal(controller, "A").discoveries.items.map(item => item.id)).toEqual(["E2"]);
});

test("late Stop of R1 cannot replace a subsequently admitted R2 after leaving and returning", async () => {
  const run = (id: string, status: Run["status"]): Run => ({ id, kind: "search", status, searchSessionId: "A", userMessageId: `message-${id}`, assistantMessageId: null, outcomeReason: null, cancellation: "none" });
  const stopped = deferred<Run>(), started = deferred<void>(); let admissions = 0;
  const c = client({ metadata: async id => ({ session: session(id), activeRun: run("R1", "running"), eligibilityRevision: 0 }),
    stop: async id => { expect(id).toBe("R1"); started.resolve(); return stopped.promise; },
    check: async id => { expect(id).toBe("R1"); return run("R1", "completed"); },
    admit: async (id, key) => { admissions++; expect(id).toBe("A"); expect(key).toBe("explicit-key"); return { session: session(id), run: run("R2", "queued"), receipt: { searchSessionId: id, runId: "R2", userMessageId: "message-R2", admittedAt: at } }; } });
  const controller = createAgenticSearchController(c, () => "explicit-key", () => ({ at, timeZone: "UTC" }));
  await open(controller, "A");
  const oldStop = controller.stop("A"); await started.promise;
  controller.leave("A"); await controller.resume("A"); await controller.check("A");
  controller.changeDraft("A", "explicit second request"); await controller.send("A");
  expect(controller.get("A")?.admission).toEqual({ kind: "known", run: run("R2", "queued") });
  stopped.resolve({ ...run("R1", "interrupted"), outcomeReason: "stopped", cancellation: "pending" }); await oldStop;
  expect(controller.get("A")?.admission).toEqual({ kind: "known", run: run("R2", "queued") });
  controller.changeDraft("A", "next draft"); await controller.send("A");
  expect(admissions).toBe(1);
});

test("client clock reports the actual zone offset on both sides of a DST fold", () => {
  expect(clientClock(new Date("2030-11-03T08:30:00.000Z"), "America/Los_Angeles")).toEqual({ at: "2030-11-03T01:30:00-07:00", timeZone: "America/Los_Angeles" });
  expect(clientClock(new Date("2030-11-03T09:30:00.000Z"), "America/Los_Angeles")).toEqual({ at: "2030-11-03T01:30:00-08:00", timeZone: "America/Los_Angeles" });
  expect(clientClock(new Date("2030-06-01T12:15:00.000Z"), "Asia/Kathmandu")).toEqual({ at: "2030-06-01T18:00:00+05:45", timeZone: "Asia/Kathmandu" });
});
