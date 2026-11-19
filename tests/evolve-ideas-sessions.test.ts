import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { startDaemon, type RunningDaemon } from "../src/daemon/runtime";
import { readSqlSnapshot, validateBytes } from "../src/backup/records";
import { evolveKey } from "../src/domain/evolve-sessions";

const userToken = "user-0123456789-0123456789-abcdef";
const aiToken = "agent-0123456789-0123456789-abcdef";
const config = (dbPath: string) => ({ dbPath, port: 0, credentials: { user: userToken, ai: aiToken } });

async function withDaemon(action: (fixture: {
  path: string;
  request: (path: string, options?: { actor?: "user" | "ai" | "none"; method?: string; body?: unknown; key?: string }) => Promise<Response>;
  restart: () => Promise<void>;
}) => Promise<void>) {
  // This fixture intentionally omits agent configuration. These cases exercise
  // durable admission and reads, not evidence that a model run executed.
  const dir = await mkdtemp(join("/tmp/opencode", "thoughtloom-evolve-ideas-"));
  const path = join(dir, "db.sqlite");
  let daemon: RunningDaemon | undefined;
  try {
    daemon = await startDaemon(config(path), () => {});
    const request = (route: string, options: { actor?: "user" | "ai" | "none"; method?: string; body?: unknown; key?: string } = {}) => {
      const headers: Record<string, string> = {};
      const actor = options.actor ?? "user";
      if (actor !== "none") headers.authorization = `Bearer ${actor === "user" ? userToken : aiToken}`;
      if (options.body !== undefined) headers["content-type"] = "application/json";
      if (options.key !== undefined) headers["Idempotency-Key"] = options.key;
      if (!daemon) throw new Error("daemon is not running");
      return fetch(new URL(route, daemon.url), {
        method: options.method ?? "GET", headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(3000),
      });
    };
    const restart = async () => {
      if (!daemon) throw new Error("daemon is not running");
      await daemon.stop();
      daemon = undefined;
      daemon = await startDaemon(config(path), () => {});
    };
    await action({ path, request, restart });
  } finally {
    try { if (daemon) await daemon.stop(); }
    finally { await rm(dir, { recursive: true, force: true }); }
  }
}

async function root(request: Parameters<Parameters<typeof withDaemon>[0]>[0]["request"], text = "harbor library anchor") {
  const response = await request("/thoughts", { method: "POST", body: { text } });
  expect(response.status).toBe(201);
  return await response.json() as { id: string };
}

function knowledge(path: string) {
  const db = new Database(path, { readonly: true });
  try {
    return {
      thoughts: db.query("SELECT * FROM thoughts ORDER BY id").all(),
      responses: db.query("SELECT * FROM responses ORDER BY id").all(),
      thoughtIndex: db.query("SELECT * FROM thought_search_fts ORDER BY thought_id").all(),
      responseIndex: db.query("SELECT * FROM response_search_fts ORDER BY response_id").all(),
    };
  } finally { db.close(); }
}

test("idea-anchored sessions are explicit, fresh, durable and do not create knowledge", async () => {
  await withDaemon(async ({ path, request, restart }) => {
    const anchor = await root(request);
    const before = knowledge(path);
    const create = () => request("/evolve-sessions", { method: "POST", body: { anchorThoughtId: anchor.id } });
    const first = await create();
    expect(first.status).toBe(201);
    const { session } = await first.json() as { session: { id: string } };
    expect(session).toMatchObject({ anchorThoughtId: anchor.id, mode: "ideas-only", continuationThoughtId: anchor.id });
    const second = await create();
    expect(second.status).toBe(201);
    const other = await second.json() as { session: { id: string } };
    expect(other.session.id).not.toBe(session.id);
    await restart();
    const read = await request(`/evolve-sessions/${session.id}`);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ session, turns: [] });
    expect(knowledge(path)).toEqual(before);
  });
});

test("bounded conversation pages walk backwards without gaps, duplicates or foreign cursors", async () => {
  await withDaemon(async ({ request }) => {
    const anchor = await root(request);
    const created = await request("/evolve-sessions", { method: "POST", body: { anchorThoughtId: anchor.id } });
    const { session } = await created.json() as { session: { id: string } };
    const base = `/evolve-sessions/${session.id}`;
    const ids: string[] = [];
    for (let index = 0; index < 5; index++) {
      const response = await request(`${base}/turns`, { method: "POST", key: `page-${index}`, body: { parentId: anchor.id, text: `Owned page turn ${index}` } });
      expect(response.status).toBe(201);
      ids.push((await response.json() as { turn: { id: string } }).turn.id);
    }
    const pages: string[][] = [];
    let before: string | null = null;
    do {
      const response = await request(`${base}?limit=2${before ? `&before=${encodeURIComponent(before)}` : ""}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toContain("no-store");
      const page = await response.json() as { session: { id: string }; turns: { id: string }[]; nextBefore: string | null };
      expect(page.session.id).toBe(session.id);
      expect(page.turns.length).toBeGreaterThan(0);
      expect(page.turns.length).toBeLessThanOrEqual(2);
      pages.unshift(page.turns.map(turn => turn.id));
      before = page.nextBefore;
      expect(pages.length).toBeLessThanOrEqual(3);
    } while (before !== null);
    expect(pages.flat()).toEqual(ids);
    expect(new Set(pages.flat()).size).toBe(ids.length);
    for (const query of ["limit=0", "limit=999999", "limit=2&limit=1", "limit=2&before=not-a-turn", "before=missing-limit"]) {
      expect((await request(`${base}?${query}`)).status).toBeGreaterThanOrEqual(400);
    }
    const foreignCreate = await request("/evolve-sessions", { method: "POST", body: { anchorThoughtId: anchor.id } });
    const foreignSession = (await foreignCreate.json() as { session: { id: string } }).session.id;
    const foreign = await request(`/evolve-sessions/${foreignSession}/turns`, { method: "POST", key: "foreign", body: { parentId: anchor.id, text: "Foreign cursor" } });
    const foreignTurn = (await foreign.json() as { turn: { id: string } }).turn.id;
    expect((await request(`${base}?limit=2&before=${encodeURIComponent(foreignTurn)}`)).status).toBeGreaterThanOrEqual(400);
    expect((await request(`${base}?limit=2`, { actor: "ai" })).status).toBe(403);
    const legacy = await request(base);
    expect(legacy.status).toBe(200);
    expect((await legacy.json() as { turns: { id: string }[] }).turns.map(turn => turn.id)).toEqual(ids);
  });
});

test("keyed turn admission recovers after restart and never indexes dialogue or duplicates on replay and conflict", async () => {
  await withDaemon(async ({ path, request, restart }) => {
    const anchor = await root(request);
    const create = await request("/evolve-sessions", { method: "POST", body: { anchorThoughtId: anchor.id } });
    expect(create.status).toBe(201);
    const { session } = await create.json() as { session: { id: string } };
    const base = `/evolve-sessions/${session.id}`;
    const before = knowledge(path);
    const input = { parentId: anchor.id, text: "harbor dialogueonlymarker please clarify" };
    const send = (body: typeof input) => request(`${base}/turns`, { method: "POST", key: "turn-1", body });
    expect((await request(`${base}/turns/by-key/turn-1`)).status).toBe(404);
    const admitted = await send(input);
    expect(admitted.status).toBe(201);
    const original = await admitted.json() as { receipt: unknown; turn: { id: string }; run: null };
    expect(original.run).toBeNull();
    expect(original.turn).toMatchObject({ ...input, runId: null, reply: null, saves: [] });
    expect(original.turn.id).toBeTruthy();
    expect(original.receipt).toBeTruthy();
    const replay = await send(input);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(original);
    expect((await send({ ...input, text: "different message" })).status).toBe(409);
    expect((await send({ ...input, parentId: "different-parent" })).status).toBe(409);
    await restart();
    const recovered = await request(`${base}/turns/by-key/turn-1`);
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toEqual(original);
    const replayAfterRestart = await send(input);
    expect(replayAfterRestart.status).toBe(200);
    expect(await replayAfterRestart.json()).toEqual(original);
    const workspace = await request(base);
    expect(workspace.status).toBe(200);
    const body = await workspace.json() as { session: unknown; turns: unknown[] };
    expect(body.session).toMatchObject({ continuationThoughtId: anchor.id });
    expect(body.turns).toEqual([expect.objectContaining(input)]);
    expect(knowledge(path)).toEqual(before);
    const search = await request("/search?q=harbor");
    expect(search.status).toBe(200);
    const results = await search.json() as { results: { thoughtId: string; text: string | null }[] };
    expect(results.results.map(result => result.thoughtId)).toEqual([anchor.id]);
    expect(JSON.stringify(results)).not.toContain("dialogueonlymarker");
  });
});

test("session and turn routes require user authentication and only accept normal-scope ideas", async () => {
  await withDaemon(async ({ request }) => {
    const anchor = await root(request);
    const rejected = await root(request, "rejected anchor");
    expect((await request(`/thoughts/${rejected.id}/reject`, { method: "POST" })).status).toBe(204);
    for (const anchorThoughtId of ["missing-thought", rejected.id]) {
      expect((await request("/evolve-sessions", { method: "POST", body: { anchorThoughtId } })).status).toBe(404);
    }
    const create = await request("/evolve-sessions", { method: "POST", body: { anchorThoughtId: anchor.id } });
    expect(create.status).toBe(201);
    const { session } = await create.json() as { session: { id: string } };
    const base = `/evolve-sessions/${session.id}`;
    for (const [actor, status] of [["none", 401], ["ai", 403]] as const) {
      expect((await request("/evolve-sessions", { actor, method: "POST", body: { anchorThoughtId: anchor.id } })).status).toBe(status);
      expect((await request(base, { actor })).status).toBe(status);
      expect((await request(`${base}/turns`, { actor, method: "POST", key: "key", body: { parentId: anchor.id, text: "private" } })).status).toBe(status);
      expect((await request(`${base}/turns/by-key/key`, { actor })).status).toBe(status);
    }
    for (const parentId of ["missing-thought", rejected.id]) {
      expect((await request(`${base}/turns`, { method: "POST", key: `key-${parentId}`, body: { parentId, text: "private" } })).status).toBe(404);
    }
    const read = await request(base);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ turns: [] });
  });
});

test("admission rejects malformed Unicode before writes and preserves exact valid text and identities", async () => {
  await withDaemon(async ({ path, request, restart }) => {
    const anchor = await root(request);
    const db = new Database(path, { readonly: true });
    const counts = () => ({
      sessions: db.query("SELECT count(*) AS n FROM evolve_sessions").get(),
      turns: db.query("SELECT count(*) AS n FROM evolve_turns").get(),
    });
    try {
      const before = counts();
      for (const anchorThoughtId of ["\ud800", "\udc00"]) {
        expect((await request("/evolve-sessions", { method: "POST", body: { anchorThoughtId } })).status).toBe(400);
      }
      const alteredAnchor = await request("/evolve-sessions", { method: "POST", body: { anchorThoughtId: `\ufeff${anchor.id}` } });
      expect([400, 404]).toContain(alteredAnchor.status);
      expect(counts()).toEqual(before);
      const created = await request("/evolve-sessions", { method: "POST", body: { anchorThoughtId: anchor.id } });
      expect(created.status).toBe(201);
      const { session } = await created.json() as { session: { id: string; anchorThoughtId: string } };
      expect(session.anchorThoughtId).toBe(anchor.id);
      const base = `/evolve-sessions/${session.id}`;
      const afterCreate = counts();
      for (const input of [
        { parentId: anchor.id, text: "\ud800" },
        { parentId: anchor.id, text: "\udc00" },
        { parentId: "\ud800", text: "valid message" },
      ]) {
        expect((await request(`${base}/turns`, { method: "POST", key: "unicode", body: input })).status).toBe(400);
      }
      const alteredParent = await request(`${base}/turns`, { method: "POST", key: "unicode", body: { parentId: `\ufeff${anchor.id}`, text: "valid message" } });
      expect([400, 404]).toContain(alteredParent.status);
      expect(counts()).toEqual(afterCreate);
      const input = { parentId: anchor.id, text: "\ufeffExact café and 🌱\r\nsecond line" };
      const admitted = await request(`${base}/turns`, { method: "POST", key: "unicode", body: input });
      expect(admitted.status).toBe(201);
      const original = await admitted.json() as { turn: { parentId: string; text: string } };
      expect(original.turn).toMatchObject(input);
      await restart();
      const lookup = await request(`${base}/turns/by-key/unicode`);
      expect(lookup.status).toBe(200);
      expect(await lookup.json()).toEqual(original);
      const replay = await request(`${base}/turns`, { method: "POST", key: "unicode", body: input });
      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual(original);
    } finally { db.close(); }
  });
});

test("turn request keys are addressable path segments", () => {
  for (const key of [".", ".."]) expect(() => evolveKey(key)).toThrow();
  for (const key of [".a", "a.", "a..b", "a:b-1_2"]) expect(evolveKey(key)).toBe(key);
});

test("HTTP key admission requires an addressable key and supports lookup", async () => {
  await withDaemon(async ({ path, request }) => {
    const anchor = await root(request);
    const created = await request("/evolve-sessions", { method: "POST", body: { anchorThoughtId: anchor.id } });
    expect(created.status).toBe(201);
    const { session } = await created.json() as { session: { id: string } };
    const base = `/evolve-sessions/${session.id}`;
    for (const key of [".", ".."]) {
      expect((await request(`${base}/turns`, { method: "POST", key, body: { parentId: anchor.id, text: "test message" } })).status).toBe(400);
    }
    const read = await request(base);
    expect(await read.json()).toMatchObject({ turns: [] });
    const accepted = await request(`${base}/turns`, { method: "POST", key: ".a", body: { parentId: anchor.id, text: "test message" } });
    expect(accepted.status).toBe(201);
    const lookup = await request(`${base}/turns/by-key/${encodeURIComponent(".a")}`);
    expect(lookup.status).toBe(200);
    expect(await lookup.json()).toEqual(await accepted.json());
  });
});

test("snapshot validation refuses unaddressable retained request keys", async () => {
  await withDaemon(async ({ path, request }) => {
    const anchor = await root(request);
    const created = await request("/evolve-sessions", { method: "POST", body: { anchorThoughtId: anchor.id } });
    expect(created.status).toBe(201);
    const { session } = await created.json() as { session: { id: string } };
    const accepted = await request(`/evolve-sessions/${session.id}/turns`, { method: "POST", key: "valid-key", body: { parentId: anchor.id, text: "test message" } });
    expect(accepted.status).toBe(201);
    const db = new Database(path, { readonly: true, safeIntegers: true });
    try {
      const snapshot = readSqlSnapshot(db, () => {});
      expect(() => validateBytes(snapshot)).not.toThrow();
      for (const key of [".", ".."]) {
        const mutated = {
          ...snapshot,
          tables: snapshot.tables.map(table => table.shape.name !== "evolve_turns" ? table : {
            ...table, rows: table.rows.map(row => ({ ...row, values: { ...row.values, request_key: { storage: "text" as const, bytes: new TextEncoder().encode(key) } } })),
          }),
        };
        expect(() => validateBytes(mutated)).toThrow();
      }
    } finally { db.close(); }
  });
});
