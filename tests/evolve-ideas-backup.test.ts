import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { captureBackup } from "../src/backup/capture";
import { decodeManifest } from "../src/backup/decode";
import { encodeManifest } from "../src/backup/format";
import { restoreBackup } from "../src/backup/restore-staging";
import { shapesForSchema } from "../src/backup/schema";
import { startDaemon, type RunningDaemon } from "../src/daemon/runtime";
import { createLogger } from "../src/logging";
import { ValidationError } from "../src/domain/validation";
import { SqliteEvolveSessions } from "../src/storage/evolve-sessions";

const credentials = { user: "user-0123456789-0123456789-abcdef", ai: "agent-0123456789-0123456789-abcdef" };
const logger = createLogger("error", () => {});
const restoredAt = "2032-01-01T00:00:00.000Z";

async function owned(action: (f: {
  dir: string;
  dbPath: string;
  request: (route: string, method?: string, body?: unknown, key?: string) => Promise<Response>;
  capture: (name: string) => Promise<string>;
  startRestored: (path: string, mediaDirectory: string) => Promise<void>;
}) => Promise<void>) {
  const dir = await mkdtemp(join("/tmp/opencode", "evolve-backup-"));
  const dbPath = join(dir, "source.sqlite");
  let daemon: RunningDaemon | undefined;
  try {
    daemon = await startDaemon({ dbPath, port: 0, credentials }, () => {}, { logSink: () => {} });
    const request = (route: string, method = "GET", body?: unknown, key?: string) => {
      if (!daemon) throw new Error("daemon is not running");
      const headers: Record<string, string> = { authorization: `Bearer ${credentials.user}` };
      if (body !== undefined) headers["content-type"] = "application/json";
      if (key !== undefined) headers["Idempotency-Key"] = key;
      return fetch(new URL(route, daemon.url), { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(3000) });
    };
    const capture = async (name: string) => {
      const output = join(dir, name);
      await mkdir(output, { mode: 0o700 });
      return (await captureBackup({ databasePath: dbPath, mediaDirectory: `${dbPath}.media`, outputDirectory: output, logger })).snapshotDirectory;
    };
    const startRestored = async (path: string, mediaDirectory: string) => {
      await daemon?.stop();
      daemon = undefined;
      daemon = await startDaemon({ dbPath: path, mediaDir: mediaDirectory, port: 0, credentials }, () => {}, { logSink: () => {} });
    };
    await action({ dir, dbPath, request, capture, startRestored });
  } finally {
    try { await daemon?.stop(); }
    finally { await rm(dir, { recursive: true, force: true }); }
  }
}

test("empty store captures and restores the new complete logical inventory without an Evolve request", async () => {
  await owned(async f => {
    const snapshot = await f.capture("empty-output");
    const manifest = decodeManifest(await readFile(join(snapshot, "manifest.json")));
    expect(manifest.appSchema).toBe("thoughtloom-logical-10");
    const legacyNames = new Set(shapesForSchema("thoughtloom-logical-9").map(shape => shape.name));
    const added = manifest.tables.filter(table => !legacyNames.has(table.name));
    expect(added.length).toBeGreaterThanOrEqual(2);
    expect(added.every(table => table.rowCount === "0")).toBe(true);
    const restored = await restoreBackup({ snapshotDirectory: snapshot, targetDirectory: join(f.dir, "empty-target"), restoredAt, logger });
    const db = new Database(restored.databasePath, { readonly: true });
    try { expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]); }
    finally { db.close(); }
  });
}, 45000);

test("captured Evolve session and turn receipt survive restore without a duplicate admission", async () => {
  await owned(async f => {
    const created = await f.request("/thoughts", "POST", { text: "owned backup anchor" });
    expect(created.status).toBe(201);
    const anchor = await created.json() as { id: string };
    const response = await f.request("/evolve-sessions", "POST", { anchorThoughtId: anchor.id });
    expect(response.status).toBe(201);
    const { session } = await response.json() as { session: { id: string } };
    const base = `/evolve-sessions/${session.id}`;
    const input = { parentId: anchor.id, text: "owned dialogue backup sentinel" };
    const admitted = await f.request(`${base}/turns`, "POST", input, "backup-turn");
    expect(admitted.status).toBe(201);
    const original = await admitted.json() as { receipt: unknown; turn: { id: string } };
    const snapshot = await f.capture("conversation-output");
    const manifest = decodeManifest(await readFile(join(snapshot, "manifest.json")));
    expect(manifest.appSchema).toBe("thoughtloom-logical-10");
    const previous = new Set(shapesForSchema("thoughtloom-logical-9").map(shape => shape.name));
    expect(manifest.tables.filter(table => !previous.has(table.name) && Number(table.rowCount) > 0).length).toBeGreaterThanOrEqual(2);
    const restored = await restoreBackup({ snapshotDirectory: snapshot, targetDirectory: join(f.dir, "conversation-target"), restoredAt, logger });
    await f.startRestored(restored.databasePath, restored.mediaDirectory);
    const lookup = await f.request(`${base}/turns/by-key/backup-turn`);
    expect(lookup.status).toBe(200);
    const recovered = await lookup.json() as { receipt: unknown; turn: { id: string } };
    expect(recovered.receipt).toEqual(original.receipt);
    expect(recovered.turn.id).toBe(original.turn.id);
    const replay = await f.request(`${base}/turns`, "POST", input, "backup-turn");
    expect(replay.status).toBe(200);
    expect((await replay.json() as { receipt: unknown }).receipt).toEqual(original.receipt);
    const read = await f.request(base);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ session: { id: session.id, anchorThoughtId: anchor.id }, turns: [expect.objectContaining(input)] });
    const db = new Database(restored.databasePath, { readonly: true });
    try {
      expect(db.query("SELECT id FROM thoughts").all()).toEqual([{ id: anchor.id }]);
      expect(db.query("SELECT * FROM responses").all()).toEqual([]);
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { db.close(); }
  });
}, 45000);

test("repository accepts and restores 4096 UTF-8 bytes and rejects 4097 before admission", async () => {
  await owned(async f => {
    const created = await f.request("/thoughts", "POST", { text: "owned size-boundary anchor" });
    expect(created.status).toBe(201);
    const anchor = await created.json() as { id: string };
    const acceptedText = "é".repeat(2048), oversizedText = `${acceptedText}x`;
    expect(acceptedText.length).toBe(2048);
    expect(new TextEncoder().encode(acceptedText).length).toBe(4096);
    expect(new TextEncoder().encode(oversizedText).length).toBe(4097);
    let next = 0;
    const sources = { id: () => `size-fixture-${++next}`, now: () => "2030-01-01T00:00:00.000Z" };
    const db = new Database(f.dbPath);
    let sessionId: string;
    let admitted: ReturnType<SqliteEvolveSessions["admit"]>;
    try {
      const sessions = new SqliteEvolveSessions(db, sources);
      sessionId = sessions.create(anchor.id).id;
      const before = db.query("SELECT * FROM evolve_turns").all();
      expect(() => sessions.admit(sessionId,"too-large",{ parentId:anchor.id, text:oversizedText })).toThrow(ValidationError);
      expect(db.query("SELECT * FROM evolve_turns").all()).toEqual(before);
      expect(sessions.byKey(sessionId,"too-large")).toBeNull();
      expect(next).toBe(1);
      admitted = sessions.admit(sessionId,"at-limit",{ parentId:anchor.id, text:acceptedText });
      expect(admitted.turn.text).toBe(acceptedText);
      expect(admitted.replayed).toBe(false);
    } finally { db.close(); }
    const snapshot = await f.capture("size-boundary-output");
    const restored = await restoreBackup({ snapshotDirectory:snapshot, targetDirectory:join(f.dir,"size-boundary-target"), restoredAt, logger });
    const target = new Database(restored.databasePath);
    try {
      const sessions = new SqliteEvolveSessions(target,sources);
      expect(sessions.byKey(sessionId,"at-limit")).toEqual({ receipt:admitted.receipt, turn:admitted.turn });
      expect(sessions.byKey(sessionId,"too-large")).toBeNull();
      expect(sessions.read(sessionId).turns).toEqual([admitted.turn]);
    } finally { target.close(); }
  });
}, 45000);

test("frozen logical-9 snapshot with real prior library records restores into the new store", async () => {
  await owned(async f => {
    const created = await f.request("/thoughts", "POST", { text: "owned logical nine knowledge" });
    expect(created.status).toBe(201);
    const thought = await created.json() as { id: string };
    const source = await f.capture("legacy-source-output");
    const legacy = join(f.dir, "logical-9");
    await cp(source, legacy, { recursive: true, errorOnExist: true });
    const manifestPath = join(legacy, "manifest.json");
    const captured = decodeManifest(await readFile(manifestPath));
    const names = new Set(shapesForSchema("thoughtloom-logical-9").map(shape => shape.name));
    const removed = captured.tables.filter(table => !names.has(table.name));
    // This is a real logical-9 projection: the source has no new conversation records to discard.
    expect(removed.every(table => table.rowCount === "0")).toBe(true);
    for (const entry of removed) await rm(join(legacy, entry.path));
    const manifest = { ...captured, appSchema: "thoughtloom-logical-9" as const, tables: captured.tables.filter(table => names.has(table.name)) };
    await writeFile(manifestPath, encodeManifest(manifest), { mode: 0o600 });
    expect(decodeManifest(await readFile(manifestPath))).toEqual(manifest);
    const restored = await restoreBackup({ snapshotDirectory: legacy, targetDirectory: join(f.dir, "legacy-target"), restoredAt, logger });
    await f.startRestored(restored.databasePath, restored.mediaDirectory);
    const read = await f.request(`/thoughts/${thought.id}`);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ id: thought.id, text: "owned logical nine knowledge" });
    const create = await f.request("/evolve-sessions", "POST", { anchorThoughtId: thought.id });
    expect(create.status).toBe(201);
  });
}, 45000);
