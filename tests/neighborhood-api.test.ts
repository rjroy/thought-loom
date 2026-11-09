import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createApp } from "../src/daemon/app";
import { CreationService } from "../src/domain/creation";
import type { Connection } from "../src/domain/connection";
import { RejectionService, type ThoughtRead } from "../src/domain/rejection";
import { TitleService } from "../src/domain/title";
import { SqliteRejectionRepository } from "../src/storage/rejection";
import { migrate, SqliteStore } from "../src/storage/sqlite";
import { SqliteTitleRepository } from "../src/storage/title";

const credentials = { user: "neighborhood-user-token", ai: "neighborhood-ai-token" };
type Edge = { id: string; fromId: string; toId: string } & (
  | { kind: "evolution" }
  | { kind: "provenance"; position: number }
  | { kind: "connection"; connection: Connection & { rejected?: boolean } }
);
type Page = { thought: ThoughtRead; nodes: ThoughtRead[]; edges: Edge[]; nextCursor: string | null };
type Request = (path: string, actor?: "user" | "ai") => Promise<Response>;

async function fixture(action: (value: { store: SqliteStore; rejection: RejectionService; request: Request; snapshots: () => number }) => Promise<void>): Promise<void> {
  const db = new Database(":memory:");
  try {
    migrate(db);
    const store = new SqliteStore(db);
    let count = 0;
    const repository = new class extends SqliteRejectionRepository {
      override snapshot() { count++; return super.snapshot(); }
    }(db);
    const rejection = new RejectionService(repository);
    const creation = new CreationService({ rejection, writes: {
      createThought: thought => store.saveThought(thought), createConnection: connection => store.saveConnection(connection),
    }, id: () => "unused", now: () => "2030-01-01T00:00:00.000Z" });
    const titles = new TitleService(new SqliteTitleRepository(db));
    const app = createApp({ rejection, creation, titles, credentials, logger: () => {} });
    await action({ store, rejection, snapshots: () => count, request: async (path, actor = "user") =>
      app.request(path, { headers: { authorization: `Bearer ${credentials[actor]}` } }) });
  } finally { db.close(); }
}

function thought(store: SqliteStore, id: string, parentId: string | null = null, sourceIds: string[] = []): void {
  store.saveThought({ id, text: `Text ${id}`, title: null, titleAuthor: null, author: "user", kind: "captured-original",
    createdAt: "2030-01-01T00:00:00.000Z", origin: "test", parentId, sourceIds });
}

function seed(store: SqliteStore): void {
  thought(store, "root");
  thought(store, "evidence");
  thought(store, "other");
  thought(store, "focus", "root", ["root", "root"]);
  thought(store, "child", "focus", ["focus"]);
  thought(store, "supported", null, ["focus"]);
  thought(store, "disconnected");
  store.saveConnection({ id: "incoming", fromId: "other", toId: "focus", category: "contradicts", proposedBy: "ai", explanation: "Incoming rationale", sourceIds: [] });
  store.saveConnection({ id: "outgoing", fromId: "focus", toId: "child", category: "supports", proposedBy: "user", explanation: "Outgoing rationale", sourceIds: [] });
  store.saveConnection({ id: "with-evidence", fromId: "focus", toId: "supported", category: "related", proposedBy: "ai", explanation: "Evidence is not an endpoint", sourceIds: ["evidence"] });
}

async function getPage(request: Request, path: string, actor: "user" | "ai" = "user"): Promise<Page> {
  const response = await request(path, actor);
  expect(response.status).toBe(200);
  return await response.json() as Page;
}

function assertPage(page: Page, focus: string, limit: number): void {
  expect(Object.keys(page).sort()).toEqual(["edges", "nextCursor", "nodes", "thought"]);
  expect(page.thought.id).toBe(focus);
  expect(page.edges.length).toBeLessThanOrEqual(limit);
  const ids = page.nodes.map(node => node.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids).not.toContain(focus);
  const endpoints = new Set([focus, ...ids]);
  for (const edge of page.edges) {
    expect(typeof edge.id).toBe("string");
    expect(edge.id.length).toBeGreaterThan(0);
    expect(endpoints.has(edge.fromId)).toBe(true);
    expect(endpoints.has(edge.toId)).toBe(true);
    expect(edge.fromId === focus || edge.toId === focus).toBe(true);
    if (edge.kind === "connection") {
      expect(edge.connection.fromId).toBe(edge.fromId);
      expect(edge.connection.toId).toBe(edge.toId);
      expect(edge.id).not.toBe(edge.connection.id);
    }
  }
}

async function walk(request: Request, focus: string, limit: number): Promise<Edge[]> {
  const base = `/thoughts/${focus}/neighborhood?limit=${limit}`;
  const result: Edge[] = [];
  const cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const current = await getPage(request, cursor === null ? base : `${base}&cursor=${encodeURIComponent(cursor)}`);
    assertPage(current, focus, limit);
    result.push(...current.edges);
    cursor = current.nextCursor;
    if (cursor !== null) {
      expect(cursors.has(cursor)).toBe(false);
      cursors.add(cursor);
      if (cursors.size > 200) throw new Error("Unbounded neighborhood pagination");
    }
  } while (cursor !== null);
  return result;
}

describe("direct neighborhood API", () => {
  test("non-root focus retains every directed role and repeated provenance occurrence", () => fixture(async ({ store, request }) => {
    seed(store);
    const first = await getPage(request, "/thoughts/focus/neighborhood?limit=200");
    assertPage(first, "focus", 200);
    expect(first.nextCursor).toBeNull();
    expect(first.nodes.map(node => node.id).sort()).toEqual(["child", "other", "root", "supported"]);
    expect(first.edges).toHaveLength(9);
    expect(new Set(first.edges.map(edge => edge.id)).size).toBe(9);
    expect(first.edges).toContainEqual(expect.objectContaining({ kind: "evolution", fromId: "root", toId: "focus" }));
    expect(first.edges).toContainEqual(expect.objectContaining({ kind: "evolution", fromId: "focus", toId: "child" }));
    for (const position of [0, 1]) expect(first.edges).toContainEqual(expect.objectContaining({ kind: "provenance", fromId: "root", toId: "focus", position }));
    expect(first.edges).toContainEqual(expect.objectContaining({ kind: "provenance", fromId: "focus", toId: "child", position: 0 }));
    expect(first.edges).toContainEqual(expect.objectContaining({ kind: "provenance", fromId: "focus", toId: "supported", position: 0 }));
    for (const connection of [
      { id: "incoming", fromId: "other", toId: "focus", category: "contradicts", proposedBy: "ai", explanation: "Incoming rationale", sourceIds: [] },
      { id: "outgoing", fromId: "focus", toId: "child", category: "supports", proposedBy: "user", explanation: "Outgoing rationale", sourceIds: [] },
      { id: "with-evidence", fromId: "focus", toId: "supported", category: "related", proposedBy: "ai", explanation: "Evidence is not an endpoint", sourceIds: ["evidence"] },
    ]) expect(first.edges).toContainEqual(expect.objectContaining({ kind: "connection", fromId: connection.fromId, toId: connection.toId, connection }));
    const repeated = await getPage(request, "/thoughts/focus/neighborhood?limit=200");
    expect(repeated.edges).toEqual(first.edges);
    const fromRoot = await getPage(request, "/thoughts/root/neighborhood?limit=200");
    const shared = first.edges.filter(edge => edge.fromId === "root" && edge.toId === "focus");
    expect(fromRoot.edges.filter(edge => edge.fromId === "root" && edge.toId === "focus")).toEqual(expect.arrayContaining(shared));
    const paginated = await walk(request, "focus", 2);
    expect(paginated.map(edge => edge.id).sort()).toEqual(first.edges.map(edge => edge.id).sort());
  }));

  test("bounded pages walk high-degree relationships exactly once with stable IDs and complete node resolution", () => fixture(async ({ store, request, snapshots }) => {
    thought(store, "focus");
    for (let i = 0; i < 55; i++) thought(store, `child-${String(i).padStart(3, "0")}`, "focus", ["focus"]);
    const before = snapshots();
    const first = await getPage(request, "/thoughts/focus/neighborhood");
    assertPage(first, "focus", 50);
    expect(first.edges).toHaveLength(50);
    expect(typeof first.nextCursor).toBe("string");
    const all = await walk(request, "focus", 7);
    expect(all).toHaveLength(110);
    expect(new Set(all.map(edge => edge.id)).size).toBe(110);
    for (let i = 0; i < 55; i++) {
      const child = `child-${String(i).padStart(3, "0")}`;
      expect(all.filter(edge => edge.fromId === "focus" && edge.toId === child).map(edge => edge.kind).sort()).toEqual(["evolution", "provenance"]);
    }
    expect(await walk(request, "focus", 7)).toEqual(all);
    expect(snapshots()).toBe(before);
  }));

  test("rejection hides endpoints and connections while applying caller-specific evidence and thought redaction", () => fixture(async ({ store, rejection, request }) => {
    seed(store);
    rejection.rejectThought("user", "root");
    rejection.rejectThought("user", "other");
    rejection.rejectThought("user", "evidence");
    rejection.rejectConnection("user", "outgoing");
    const user = await getPage(request, "/thoughts/focus/neighborhood?limit=200");
    assertPage(user, "focus", 200);
    expect(user.thought).toMatchObject({ parentId: "root", sourceIds: ["root", "root"] });
    expect(user.nodes.map(node => node.id).sort()).toEqual(["child", "supported"]);
    expect(user.edges).toHaveLength(4);
    expect(user.edges).toContainEqual(expect.objectContaining({ kind: "connection", connection: expect.objectContaining({ id: "with-evidence", sourceIds: ["evidence"] }) }));
    const ai = await getPage(request, "/thoughts/focus/neighborhood?limit=200", "ai");
    expect(ai.thought).toMatchObject({ parentId: null, sourceIds: [] });
    expect(ai.edges).toContainEqual(expect.objectContaining({ kind: "connection", connection: expect.objectContaining({ id: "with-evidence", sourceIds: [] }) }));
    expect(ai.nodes.map(node => node.id).sort()).toEqual(["child", "supported"]);
    const inspected = await getPage(request, "/thoughts/focus/neighborhood?scope=show-rejected&limit=200");
    assertPage(inspected, "focus", 200);
    expect(inspected.thought).toMatchObject({ rejected: false, parentId: "root", sourceIds: ["root", "root"] });
    expect(inspected.nodes.find(node => node.id === "root")).toMatchObject({ rejected: true });
    expect(inspected.nodes.find(node => node.id === "other")).toMatchObject({ rejected: true });
    expect(inspected.edges).toContainEqual(expect.objectContaining({ kind: "connection", connection: expect.objectContaining({ id: "outgoing", rejected: true }) }));
    expect(inspected.edges).toContainEqual(expect.objectContaining({ kind: "connection", connection: expect.objectContaining({ id: "incoming", rejected: false }) }));
    expect(inspected.edges).toHaveLength(9);
    expect((await request("/thoughts/focus/neighborhood?scope=show-rejected", "ai")).status).toBe(403);
    expect((await request("/thoughts/root/neighborhood")).status).toBe(404);
    expect((await request("/thoughts/root/neighborhood?scope=show-rejected")).status).toBe(200);
  }));

  test("empty, missing and malformed requests and cursor bindings", () => fixture(async ({ store, request }) => {
    seed(store);
    const empty = await getPage(request, "/thoughts/disconnected/neighborhood");
    expect(empty.nodes).toEqual([]);
    expect(empty.edges).toEqual([]);
    expect(empty.nextCursor).toBeNull();
    expect((await request("/thoughts/missing/neighborhood")).status).toBe(404);
    for (const query of ["limit=0", "limit=201", "limit=-1", "limit=1.5", "limit=", "limit=1&limit=2", "scope=", "scope=bad", "scope=normal&scope=normal", "cursor=", "cursor=invalid", "cursor=x&cursor=y", "extra=x"]) {
      expect((await request(`/thoughts/focus/neighborhood?${query}`)).status).toBe(400);
    }
    const first = await getPage(request, "/thoughts/focus/neighborhood?limit=1");
    if (!first.nextCursor) throw new Error("Expected continuation cursor");
    const cursor = encodeURIComponent(first.nextCursor);
    for (const path of [`/thoughts/child/neighborhood?limit=1&cursor=${cursor}`, `/thoughts/focus/neighborhood?limit=2&cursor=${cursor}`,
      `/thoughts/focus/neighborhood?limit=1&scope=show-rejected&cursor=${cursor}`]) expect((await request(path)).status).toBe(400);
  }));
});
