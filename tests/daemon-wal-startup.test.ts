import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { startDaemon, type RunningDaemon } from "../src/daemon/runtime";
import { ExecutionOwnerLease } from "../src/storage/execution-owner";
import { migrate } from "../src/storage/sqlite";

const credentials = { user: "user-0123456789-0123456789-abcdef", ai: "agent-0123456789-0123456789-abcdef" };
const config = (dbPath: string) => ({ dbPath, port: 0, credentials, logLevel: "verbose" as const });

async function owned(action: (path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join("/tmp/opencode", "daemon-wal-"));
  try { await action(join(dir, "knowledge.sqlite")); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

function journalMode(path: string): string {
  const db = new Database(path, { readonly: true, create: false });
  try { return (db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode; }
  finally { db.close(); }
}

function seed(path: string): void {
  const db = new Database(path);
  try {
    migrate(db);
    db.run("INSERT INTO thoughts (id,text,author,kind,created_at,origin,parent_id) VALUES (?,?,?,?,?,?,NULL)",
      ["owned-seed", "existing content", "user", "captured-original", "2026-01-01T00:00:00Z", "test"]);
  } finally { db.close(); }
}

test("startup changes an existing knowledge database to WAL before migration and preserves its content", async () => owned(async path => {
  seed(path);
  expect(journalMode(path)).toBe("delete");
  let modeAtMigration: string | undefined;
  let daemon: RunningDaemon | undefined;
  try {
    daemon = await startDaemon(config(path), () => {}, { logSink: record => {
      if (record.message === "[storage] migrate attempt") modeAtMigration = journalMode(path);
    } });
    expect(modeAtMigration).toBe("wal");
    expect(journalMode(path)).toBe("wal");
    const db = new Database(path, { readonly: true, create: false });
    try {
      expect(db.query("SELECT text,author,kind FROM thoughts WHERE id = ?").get("owned-seed"))
        .toEqual({ text: "existing content", author: "user", kind: "captured-original" });
    } finally { db.close(); }
  } finally { await daemon?.stop(); }
  expect(journalMode(`${path}.execution-owner.sqlite`)).toBe("delete");
  expect(journalMode(path)).toBe("wal");
}));

test("a rejected contender cannot change journal mode before acquiring the execution owner", async () => owned(async path => {
  seed(path);
  const lease = await ExecutionOwnerLease.acquire(path);
  let contender: RunningDaemon | undefined;
  try {
    let failure: unknown;
    try { contender = await startDaemon(config(path), () => {}, { logSink: () => {} }); }
    catch (error) { failure = error; }
    expect(failure instanceof Error ? failure.message : null).toBe("Daemon startup failed: execution owner already held");
    expect(journalMode(path)).toBe("delete");
  } finally { await contender?.stop(); lease.release(); }
  let owner: RunningDaemon | undefined;
  try {
    owner = await startDaemon(config(path), () => {}, { logSink: () => {} });
    expect(journalMode(path)).toBe("wal");
  } finally { await owner?.stop(); }
}));

test("a read-only snapshot remains stable while a running daemon commits a new thought", async () => owned(async path => {
  seed(path);
  let daemon: RunningDaemon | undefined;
  let reader: Database | undefined;
  try {
    daemon = await startDaemon(config(path), () => {}, { logSink: () => {} });
    expect(journalMode(path)).toBe("wal");
    reader = new Database(path, { readonly: true, create: false });
    reader.exec("BEGIN");
    const rows = () => reader?.query("SELECT id,text FROM thoughts ORDER BY id").all();
    expect(rows()).toEqual([{ id: "owned-seed", text: "existing content" }]);
    const response = await fetch(new URL("/thoughts", daemon.url), {
      method: "POST", signal: AbortSignal.timeout(3000),
      headers: { authorization: `Bearer ${credentials.user}`, "content-type": "application/json" },
      body: JSON.stringify({ text: "committed during snapshot" }),
    });
    expect(response.status).toBe(201);
    expect(rows()).toEqual([{ id: "owned-seed", text: "existing content" }]);
    reader.exec("COMMIT");
    expect(rows()).toContainEqual({ id: "owned-seed", text: "existing content" });
    expect(rows()?.some(row => (row as { text: string }).text === "committed during snapshot")).toBe(true);
  } finally {
    if (reader?.inTransaction) reader.exec("ROLLBACK");
    reader?.close();
    await daemon?.stop();
  }
}));
