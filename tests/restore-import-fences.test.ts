import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { LocalMarkdownImportDriver } from "../src/agent/import-driver";
import { partitionMarkdown, prepareMarkdown } from "../src/domain/markdown-import";
import { SqliteMarkdownImports } from "../src/storage/markdown-import";
import { migrate } from "../src/storage/sqlite";
import { createLogger } from "../src/logging";

const now = () => "2030-01-02T03:04:05.000Z", encode = (text: string) => new TextEncoder().encode(text);
const logger = createLogger("verbose", () => {});
async function fixture(action: (f: ReturnType<typeof setup>) => Promise<void> | void): Promise<void> {
  const dir = await mkdtemp("/tmp/opencode/restore-import-"), db = new Database(join(dir, "owned.sqlite"));
  try { migrate(db, logger); await action(setup(db)); }
  finally { db.close(); await rm(dir, { recursive: true, force: true }); }
}
function setup(db: Database) {
  let n = 0;
  const sources = { id: () => `owned-${++n}`, sessionId: () => `ses_owned${++n}`, promptId: () => `msg_owned${++n}`, now, logger };
  const imports = new SqliteMarkdownImports(db, sources);
  const fence = (kind: "run" | "import-batch" | "import-file", id: string) => db.run(
    "INSERT INTO restore_fences(entity_kind,entity_id,snapshot_sha256,restored_at,original_state_json) VALUES (?,?,?,?,?)", [kind, id, "a".repeat(64), now(), "{}"]);
  const snapshot = () => ["markdown_imports", "markdown_import_files", "markdown_import_payloads", "runs", "run_steps", "agent_bindings", "import_documents", "thoughts"]
    .map(table => ({ table, rows: db.query(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all() }));
  function prepared(fileId: string, bytes: Uint8Array) {
    const claim = imports.claim(fileId), parsed = prepareMarkdown(bytes);
    imports.prepare(claim, parsed.manifest);
    const input = imports.privateInput(claim);
    if (input.input === null) throw new Error("Expected owned prepared input");
    const partition = partitionMarkdown(bytes, parsed, parsed.fallbackCuts, { method: "structural", reason: "ai-unconfigured" });
    const evidence = { state: "not-submitted" as const, promptId: input.promptId, inputSha256: createHash("sha256").update(input.input).digest("hex") };
    return { claim, partition, evidence };
  }
  return { db, sources, imports, fence, snapshot, prepared };
}
function denied(action: () => unknown): void {
  let result: unknown, refused = false;
  try { result = action(); } catch (error) { if (!(error instanceof Error)) throw error; refused = true; }
  expect(refused || result === null).toBe(true);
}

test("fenced batch retains keyed receipts but refuses new file admission and sealing", async () => fixture(f => {
  const bytes = encode("owned original\n"), batch = f.imports.createBatchAdmission("user", "old-batch").batch;
  const file = f.imports.admitFileAdmission("user", batch.id, "old-file", "old.md", bytes).file;
  f.fence("import-batch", batch.id);
  const before = f.snapshot(), oldBatch = f.imports.batch("user", batch.id), oldFile = f.imports.file("user", batch.id, file.id);
  if (oldBatch === null || oldFile === null) throw new Error("Expected owned import history");
  expect(f.imports.createBatchAdmission("user", "old-batch")).toEqual({ batch: oldBatch, replayed: true });
  expect(f.imports.admitFileAdmission("user", batch.id, "old-file", "old.md", bytes)).toEqual({ file: oldFile, replayed: true });
  expect(() => f.imports.admitFileAdmission("user", batch.id, "new-file", "new.md", encode("new input"))).toThrow();
  try { f.imports.sealBatch("user", batch.id); } catch (error) { expect(error).toBeInstanceOf(Error); }
  expect(f.imports.batch("user", batch.id)?.sealedAt).toBeNull(); expect(f.snapshot()).toEqual(before);
  const fresh = f.imports.createBatch("user", "fresh-batch");
  expect(f.imports.admitFile("user", fresh.id, "fresh-file", "fresh.md", encode("fresh unique input")).state).toBe("queued");
}));

test("fenced import file denies prepared private input, partition choice and direct local/native claims", async () => fixture(f => {
  const bytes = encode("owned pending markdown\n"), batch = f.imports.createBatch("user", "batch");
  const file = f.imports.admitFile("user", batch.id, "file", "file.md", bytes), ready = f.prepared(file.id, bytes);
  const candidate = f.imports.localCandidates(0, null, 50).items.find(item => item.fileId === file.id);
  if (!candidate || !file.runId) throw new Error("Expected owned prepared local candidate");
  expect(Array.from(f.imports.privateInput(ready.claim).bytes)).toEqual(Array.from(bytes));
  f.fence("import-file", file.id);
  const before = f.snapshot();
  expect(() => f.imports.privateInput(ready.claim)).toThrow();
  expect(() => f.imports.prepare(ready.claim, ready.partition.manifest)).toThrow();
  expect(() => f.imports.choose(ready.claim, ready.partition, ready.evidence)).toThrow();
  expect(() => f.imports.fail(ready.claim, "persistence-failed")).toThrow();
  expect(() => f.imports.claim(file.id)).toThrow();
  denied(() => f.imports.claimLocal(candidate)); denied(() => f.imports.claimNative(candidate));
  expect(f.imports.localCandidates(0, null, 50).items.some(item => item.fileId === file.id)).toBe(false);
  expect(f.imports.nativeCandidates(0, null, 50).items.some(item => item.fileId === file.id)).toBe(false);
  expect(f.snapshot()).toEqual(before);
  const fresh = f.imports.admitFile("user", batch.id, "fresh", "fresh.md", encode("fresh separate bytes"));
  const next = f.prepared(fresh.id, encode("fresh separate bytes"));
  expect(f.imports.finalize(f.imports.choose(next.claim, next.partition, next.evidence)).state).toBe("imported");
}));

test("fenced already-chosen file cannot finalize; independent run fences cannot be bypassed by native claim", async () => fixture(f => {
  const batch = f.imports.createBatch("user", "chosen-batch"), bytes = encode("owned chosen bytes");
  const file = f.imports.admitFile("user", batch.id, "chosen", "chosen.md", bytes), ready = f.prepared(file.id, bytes);
  const chosen = f.imports.choose(ready.claim, ready.partition, ready.evidence);
  const other = f.imports.admitFile("user", batch.id, "run-fenced", "run.md", encode("independent pending bytes"));
  const native = f.imports.nativeCandidates(0, null, 50).items.find(item => item.fileId === other.id);
  if (!other.runId || !native) throw new Error("Expected owned native candidate");
  f.fence("import-file", file.id); f.fence("run", other.runId);
  const before = f.snapshot();
  expect(() => f.imports.finalize(chosen)).toThrow();
  denied(() => f.imports.claimNative(native));
  expect(f.snapshot()).toEqual(before);
}));

test("a fenced waiter and pending payload stay inert during direct and configless scans", async () => fixture(async f => {
  const batch = f.imports.createBatch("user", "waiter-batch"), bytes = encode("same retained bytes");
  const holder = f.imports.admitFile("user", batch.id, "holder", "holder.md", bytes);
  const waiter = f.imports.admitFile("user", batch.id, "waiter", "waiter.md", bytes);
  expect(waiter.state).toBe("waiting");
  const ready = f.prepared(holder.id, bytes); f.imports.finalize(f.imports.choose(ready.claim, ready.partition, ready.evidence));
  f.fence("import-file", waiter.id);
  const before = f.snapshot();
  expect(f.imports.resolveWaiters()).toBe(0);
  const driver = new LocalMarkdownImportDriver({ db: f.db, ...f.sources, startTimer: () => () => {} });
  try { await driver.poll(); } finally { await driver.stop(); }
  expect(f.snapshot()).toEqual(before);
  expect(f.imports.file("user", batch.id, waiter.id)?.state).toBe("waiting");
  const payload = f.db.query<{ bytes: Uint8Array }, [string]>("SELECT bytes FROM markdown_import_payloads WHERE file_id=?").get(waiter.id);
  expect(payload && Array.from(payload.bytes)).toEqual(Array.from(bytes));
}));
