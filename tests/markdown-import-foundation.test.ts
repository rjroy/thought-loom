import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ImportConflictError, ImportForbiddenError, type ImportPartition } from "../src/domain/markdown-import";
import { RejectionService } from "../src/domain/rejection";
import { SearchService } from "../src/domain/search";
import { SqliteCapabilityDispatcher } from "../src/storage/capability";
import { SqliteImportInspection } from "../src/storage/import-inspection";
import { SqliteMarkdownImports } from "../src/storage/markdown-import";
import { SqliteRejectionRepository } from "../src/storage/rejection";
import { SqliteRunOperations } from "../src/storage/run-operations";
import { SqliteRunProtocolRepository } from "../src/storage/run-protocol";
import { SqliteRunRepository } from "../src/storage/run";
import { SqliteSearchRepository } from "../src/storage/search";
import { migrate, SqliteStore } from "../src/storage/sqlite";
import { immediate } from "../src/storage/transaction";

const history = { actor: "user", mode: "history" } as const;
const ai = { actor: "ai", mode: "normal" } as const;
const encode = (s: string) => new TextEncoder().encode(s);
const hash = (input: string | Uint8Array) => createHash("sha256").update(input).digest("hex");

function fixture(action: (db: Database, other: Database, imports: SqliteMarkdownImports, second: SqliteMarkdownImports, inspection: SqliteImportInspection) => void) {
  const dir = mkdtempSync(join("/tmp/opencode", "import-foundation-"));
  const path = join(dir, "test.sqlite");
  const db = new Database(path), other = new Database(path);
  let n = 0;
  const sources = { id: () => `owned-${++n}`, now: () => "2030-01-02T03:04:05.000Z", logger: { verbose: () => {}, info: () => {}, warning: () => {}, error: () => {} } };
  try {
    migrate(db); migrate(other);
    action(db, other, new SqliteMarkdownImports(db, sources), new SqliteMarkdownImports(other, sources), new SqliteImportInspection(db, sources));
  } finally { other.close(); db.close(); rmSync(dir, { recursive: true, force: true }); }
}

function partition(bytes: Uint8Array, start = 0): ImportPartition {
  const manifest = { version: 1, parserVersion: "test-parser", atoms: [{ startByte: start, endByte: bytes.length }], cuts: [{ id: "b0", offset: start }, { id: "b1", offset: bytes.length }] } as const;
  return { manifest, cuts: ["b0", "b1"], parts: [...(start ? [{ kind: "bom" as const, startByte: 0, endByte: start }] : []), { kind: "thought", startByte: start, endByte: bytes.length }], segmentation: { method: "structural", reason: "ai-unconfigured" } };
}

function ready(imports: SqliteMarkdownImports, fileId: string, bytes: Uint8Array, start = 0, split = false, custom?: ImportPartition) {
  const claim = imports.claim(fileId);
  const p: ImportPartition = split ? {
    manifest: { version: 1, parserVersion: "test-parser", atoms: [{ startByte: 0, endByte: 6 }, { startByte: 6, endByte: bytes.length }], cuts: [{ id: "b0", offset: 0 }, { id: "b1", offset: 6 }, { id: "b2", offset: bytes.length }] },
    cuts: ["b0", "b1", "b2"], parts: [{ kind: "thought", startByte: 0, endByte: 6 }, { kind: "thought", startByte: 6, endByte: bytes.length }],
    segmentation: { method: "structural", reason: "ai-unconfigured" },
  } : custom ?? partition(bytes, start);
  imports.prepare(claim, p.manifest);
  const input = imports.privateInput(claim);
  if (input.input === null) throw new Error("prepared input missing");
  return imports.choose(claim, p, { state: "not-submitted", promptId: input.promptId, inputSha256: hash(input.input) });
}

describe("Markdown import foundation", () => {
  test("preserves a leading FEFF in the admitted path and receipt bytes", () => fixture((db, _other, imports) => {
    const path = "\ufeffname.md", bytes = encode("owned words");
    const batch = imports.createBatch("user", "batch");
    const file = imports.admitFile("user", batch.id, "file", path, bytes);
    expect(file.relativePath).toBe(path);
    expect(db.query("SELECT hex(CAST(relative_path AS BLOB)) AS path FROM markdown_import_files WHERE id=?").get(file.id)).toEqual({ path: Buffer.from(encode(path)).toString("hex").toUpperCase() });
  }));

  test("replays the same request with a leading FEFF path", () => fixture((_db, _other, imports) => {
    const path = "\ufeffname.md", bytes = encode("owned words");
    const batch = imports.createBatch("user", "batch");
    const first = imports.admitFile("user", batch.id, "file", path, bytes);
    expect(imports.admitFile("user", batch.id, "file", path, bytes)).toEqual(first);
  }));

  test("preserves leading FEFF path bytes in sealed canonical source and locator", () => fixture((db, _other, imports, _second, inspection) => {
    const path = "\ufeffname.md", bytes = encode("owned words");
    const batch = imports.createBatch("user", "batch"), file = imports.admitFile("user", batch.id, "file", path, bytes);
    const result = imports.finalize(ready(imports, file.id, bytes));
    if (!result.documentId) throw new Error("finalization returned no document");
    const expected = Buffer.from(encode(path)).toString("hex").toUpperCase();
    expect(db.query("SELECT hex(CAST(original_path AS BLOB)) AS path FROM import_documents WHERE id=?").get(result.documentId)).toEqual({ path: expected });
    expect(db.query("SELECT hex(CAST(relative_path AS BLOB)) AS path FROM import_locations WHERE document_id=?").all(result.documentId)).toEqual([{ path: expected }]);
    expect(inspection.source(history, result.documentId)?.originalPath).toBe(path);
  }));

  test("pending FEFF-prefixed and unprefixed paths reserve independently for different bytes", () => fixture((db, _other, imports, second) => {
    const batch = imports.createBatch("user", "batch");
    const prefixed = imports.admitFile("user", batch.id, "prefixed", "\ufeffname.md", encode("first words"));
    const plain = second.admitFile("user", batch.id, "plain", "name.md", encode("different words"));
    expect(prefixed.state).toBe("queued");
    expect(plain.state).toBe("queued");
    expect(plain.runId).not.toBeNull();
    expect(db.query("SELECT count(*) AS n FROM markdown_import_files WHERE outcome IS NULL AND waiting_on_file_id IS NULL").get()).toEqual({ n: 2 });
  }));

  test("committed FEFF locator is distinct and still detects changes to that exact path", () => fixture((_db, _other, imports) => {
    const batch = imports.createBatch("user", "batch"), bytes = encode("first words");
    const first = imports.admitFile("user", batch.id, "first", "\ufeffname.md", bytes);
    const committed = imports.finalize(ready(imports, first.id, bytes));
    const plain = imports.admitFile("user", batch.id, "plain", "name.md", encode("different words"));
    expect(plain.state).toBe("queued");
    const changed = imports.admitFile("user", batch.id, "changed", "\ufeffname.md", encode("changed words"));
    expect(changed).toMatchObject({ state: "skipped-changed", documentId: committed.documentId });
  }));

  test.each([false, true])("retains exact UTF-8 thought and original bytes, with optional separate BOM (%s)", bom => fixture((db, _other, imports, _second, inspection) => {
    const text = (bom ? "\ufeff" : "") + "  Café 漢字\r\n  words  \r\n";
    const bytes = encode((bom ? "\ufeff" : "") + text);
    const batch = imports.createBatch("user", "batch");
    const file = imports.admitFile("user", batch.id, "file", "private/name.md", bytes);
    const result = imports.finalize(ready(imports, file.id, bytes, bom ? 3 : 0));
    if (!result.documentId) throw new Error("document missing");
    expect(inspection.raw(history, result.documentId)).toEqual(bytes);
    const parts = inspection.parts(history, result.documentId).items;
    const thought = parts.find(part => part.kind === "thought");
    if (!thought?.thoughtId) throw new Error("thought missing");
    expect(new SqliteStore(db).getThought(thought.thoughtId)).toMatchObject({ text, author: "source", kind: "imported-original", title: null, titleAuthor: null, parentId: null, sourceIds: [] });
    expect(db.query("SELECT hex(CAST(text AS BLOB)) AS bytes FROM thoughts WHERE id=?").get(thought.thoughtId)).toEqual({ bytes: Buffer.from(encode(text)).toString("hex").toUpperCase() });
    expect(inspection.provenance({ actor: "user", mode: "normal" }, thought.thoughtId)).toEqual({ importSource: { documentId: result.documentId, ordinal: 0, startByte: bom ? 3 : 0, endByte: bytes.length } });
    const documentId = result.documentId, thoughtId = thought.thoughtId;
    expect(() => inspection.raw(ai, documentId)).toThrow(ImportForbiddenError);
    expect(() => inspection.source(ai, documentId)).toThrow(ImportForbiddenError);
    expect(() => inspection.parts(ai, documentId)).toThrow(ImportForbiddenError);
    expect(() => inspection.provenance(ai, thoughtId)).toThrow(ImportForbiddenError);
    const visible = new RejectionService(new SqliteRejectionRepository(db)).listThoughts(ai).find(value => value.id === thoughtId);
    expect(visible).toMatchObject({ text, author: "source", origin: "markdown-import" });
    expect(JSON.stringify(visible)).not.toContain("private/name.md");
    expect(db.query("SELECT kind,status FROM runs ORDER BY rowid").all()).toEqual([{ kind: "import", status: "completed" }, { kind: "weave", status: "queued" }]);
  }));

  test("replay, conflict, cross-connection waiters, skip precedence and rejected thought remain stable", () => fixture((db, _other, imports, second) => {
    const bytes = encode("first words"), otherBytes = encode("second words");
    const batch = imports.createBatch("user", "batch");
    expect(second.createBatch("user", "batch")).toEqual(batch);
    const holder = imports.admitFile("user", batch.id, "one", "first.md", bytes);
    expect(second.admitFile("user", batch.id, "one", "first.md", bytes)).toEqual(holder);
    expect(() => second.admitFile("user", batch.id, "one", "first.md", otherBytes)).toThrow(ImportConflictError);
    expect(() => second.admitFile("user", batch.id, "one", "different.md", bytes)).toThrow(ImportConflictError);
    const waiter = second.admitFile("user", batch.id, "two", "copy.md", bytes);
    expect(waiter).toMatchObject({ state: "waiting", runId: null });
    const committed = imports.finalize(ready(imports, holder.id, bytes));
    expect(second.resolveWaiters()).toBe(1);
    expect(second.file("user", batch.id, waiter.id)).toMatchObject({ state: "skipped-identical", documentId: committed.documentId });
    const thought = (db.query("SELECT id FROM thoughts WHERE import_document_id=?").get(committed.documentId) as { id: string }).id;
    new RejectionService(new SqliteRejectionRepository(db)).rejectThought("user", thought);
    expect(imports.admitFile("user", batch.id, "three", "third.md", bytes)).toMatchObject({ state: "skipped-identical", documentId: committed.documentId });
    const secondFile = imports.admitFile("user", batch.id, "four", "second.md", otherBytes);
    const secondDoc = imports.finalize(ready(imports, secondFile.id, otherBytes));
    expect(imports.admitFile("user", batch.id, "five", "first.md", otherBytes)).toMatchObject({ state: "skipped-changed", documentId: committed.documentId });
    expect(secondDoc.documentId).not.toBe(committed.documentId);
    expect(db.query("SELECT thought_id FROM rejected_thoughts").all()).toEqual([{ thought_id: thought }]);
    expect(db.query("SELECT count(*) AS n FROM import_locations").get()).toEqual({ n: 2 });
  }));

  test("failed holder releases reservation to exactly one waiting connection", () => fixture((db, _other, imports, second) => {
    const bytes = encode("retryable"), batch = imports.createBatch("user", "batch");
    const holder = imports.admitFile("user", batch.id, "holder", "same.md", bytes);
    const first = second.admitFile("user", batch.id, "first", "same.md", bytes);
    const next = imports.admitFile("user", batch.id, "next", "same.md", bytes);
    imports.fail(imports.claim(holder.id), "persistence-failed");
    expect(second.resolveWaiters()).toBe(2);
    expect(second.file("user", batch.id, first.id)?.state).toBe("queued");
    expect(imports.file("user", batch.id, next.id)?.state).toBe("waiting");
    expect(db.query("SELECT count(*) AS n FROM markdown_import_files WHERE outcome IS NULL AND waiting_on_file_id IS NULL").get()).toEqual({ n: 1 });
    const done = second.finalize(ready(second, first.id, bytes));
    expect(imports.resolveWaiters()).toBe(1);
    expect(imports.file("user", batch.id, next.id)).toMatchObject({ state: "skipped-identical", documentId: done.documentId });
  }));

  test("a new request can retry the same path and bytes after terminal failure", () => fixture((_db, _other, imports) => {
    const bytes = encode("retry words"), batch = imports.createBatch("user", "batch");
    const first = imports.admitFile("user", batch.id, "first", "retry.md", bytes);
    imports.fail(imports.claim(first.id), "persistence-failed");
    expect(imports.file("user", batch.id, first.id)).toMatchObject({ state: "failed", error: { code: "persistence-failed", retryable: true } });
    const retry = imports.admitFile("user", batch.id, "new-request", "retry.md", bytes);
    expect(retry).toMatchObject({ state: "queued" });
    expect(retry.id).not.toBe(first.id);
    expect(imports.finalize(ready(imports, retry.id, bytes)).state).toBe("imported");
  }));

  test("competing connection hits bounded write lock and cannot create a duplicate reservation", () => fixture((db, other, imports, second) => {
    const bytes = encode("locked words"), batch = imports.createBatch("user", "batch");
    other.exec("PRAGMA busy_timeout=25");
    db.exec("BEGIN IMMEDIATE");
    try {
      const holder = imports.admitFile("user", batch.id, "holder", "locked.md", bytes);
      expect(() => second.admitFile("user", batch.id, "contender", "locked.md", bytes)).toThrow(/locked|busy/i);
      expect(db.query("SELECT count(*) AS n FROM markdown_import_files WHERE outcome IS NULL AND waiting_on_file_id IS NULL").get()).toEqual({ n: 1 });
      expect(holder.runId).not.toBeNull();
      db.exec("COMMIT");
    } finally { if (db.inTransaction) db.exec("ROLLBACK"); }
    expect(second.admitFile("user", batch.id, "contender", "locked.md", bytes)).toMatchObject({ state: "waiting", runId: null });
    expect(other.query("SELECT count(*) AS n FROM markdown_import_files WHERE outcome IS NULL AND waiting_on_file_id IS NULL").get()).toEqual({ n: 1 });
  }));

  test("source metadata stays out of AI reads, search and candidates, including after rejection", () => fixture((db, _other, imports, _second, inspection) => {
    const front = "---\r\ntitle: secretfrontmattertoken\r\n---\r\n", text = "zircon visible imported wording";
    const bytes = encode(front + text), start = encode(front).length;
    const p: ImportPartition = { manifest: { version: 1, parserVersion: "test-parser", atoms: [{ startByte: start, endByte: bytes.length }], cuts: [{ id: "b0", offset: start }, { id: "b1", offset: bytes.length }] }, cuts: ["b0", "b1"], parts: [{ kind: "frontmatter", startByte: 0, endByte: start }, { kind: "thought", startByte: start, endByte: bytes.length }], segmentation: { method: "structural", reason: "ai-unconfigured" } };
    const batch = imports.createBatch("user", "batch"), file = imports.admitFile("user", batch.id, "file", "secretpathtoken.md", bytes);
    const done = imports.finalize(ready(imports, file.id, bytes, 0, false, p));
    if (!done.documentId) throw new Error("document missing");
    const part = inspection.parts(history, done.documentId).items.find(value => value.kind === "thought");
    if (!part?.thoughtId) throw new Error("thought missing");
    const thoughtId = part.thoughtId;
    const rejection = new RejectionService(new SqliteRejectionRepository(db));
    const search = new SearchService(new SqliteSearchRepository(db));
    const active = { read: rejection.listThoughts(ai), search: search.query(ai, "zircon") };
    expect(active.read.find(item => item.id === thoughtId)).toMatchObject({ text, author: "source" });
    expect(active.search.results.find(item => item.id === thoughtId)).toMatchObject({ author: "source", materialKind: "imported-original" });
    expect(search.query(ai, "secretfrontmattertoken").results).toEqual([]);
    expect(search.query(ai, "secretpathtoken").results).toEqual([]);
    const sources = { id: (() => { let n = 0; return () => `projection-${++n}`; })(), now: () => "2030" };
    new SqliteStore(db).saveThought({ id: "subject", text: "separate subject", title: null, author: "user", kind: "captured-original", createdAt: "2030", origin: "fixture", parentId: null, sourceIds: [] });
    const ops = new SqliteRunOperations(db, sources), runs = new SqliteRunRepository(db, sources), steps = new SqliteRunProtocolRepository(db), dispatcher = new SqliteCapabilityDispatcher(db, sources);
    const candidates = (triggerId: string) => {
      const run = ops.admitWeave("user", { subjectId: "subject", triggerId }), claim = runs.claim(run.id);
      steps.prepare(claim, { promptId: run.promptId, input: "test context" });
      const request = { capability: "search", arguments: { query: "zircon" } } as const;
      steps.completeStep(claim, run.promptId, { version: 1, kind: "request", request });
      return dispatcher.dispatch(claim, run.promptId, request);
    };
    const found = candidates("active");
    expect(found).toMatchObject({ type: "search", candidates: [{ id: thoughtId, author: "source" }] });
    for (const value of [active, found]) {
      expect(JSON.stringify(value)).not.toContain("secretfrontmattertoken");
      expect(JSON.stringify(value)).not.toContain("secretpathtoken");
    }
    rejection.rejectThought("user", thoughtId);
    expect(rejection.listThoughts(ai).some(item => item.id === thoughtId)).toBe(false);
    expect(search.query(ai, "zircon").results).toEqual([]);
    expect(candidates("rejected")).toEqual({ type: "search", candidates: [] });
  }));
});

describe("import commit and rollback guards", () => {
  test("a part cannot map a thought belonging to another document", () => fixture(db => {
    const namespace = (db.query("SELECT id FROM import_namespaces WHERE kind='loose-markdown'").get() as { id: string }).id;
    expect(() => immediate(db, () => {
      for (const [id, text] of [["one", "first"], ["two", "other"]]) {
        const bytes = encode(text);
        db.run("INSERT INTO import_documents(id,original_bytes,sha256,byte_length,encoding,original_namespace_id,original_path,created_at,parser_version,segmentation_method,segmentation_reason) VALUES (?,?,?,?, 'utf-8',?,?, '2030','test','structural','ai-unconfigured')", [id, bytes, Buffer.from(hash(bytes), "hex"), bytes.length, namespace, `${id}.md`]);
      }
      db.run("INSERT INTO thoughts(id,text,author,kind,created_at,origin,parent_id,import_document_id) VALUES ('thought','first','source','imported-original','2030','markdown-import',NULL,'one')");
      db.run("INSERT INTO import_document_parts VALUES ('two',0,'thought',0,5,'thought',0)");
    })).toThrow(/foreign key/i);
    expect(db.inTransaction).toBe(false);
    expect(db.query("SELECT count(*) AS n FROM import_documents").get()).toEqual({ n: 0 });
  }));

  test.each(["gap", "overlap", "missing thought", "wrong text"])("seal rejects %s in the source map", scenario => fixture((db) => {
    const namespace = (db.query("SELECT id FROM import_namespaces WHERE kind='loose-markdown'").get() as { id: string }).id;
    expect(() => immediate(db, () => {
      const bytes = encode("abcdef");
      db.run("INSERT INTO import_documents(id,original_bytes,sha256,byte_length,encoding,original_namespace_id,original_path,created_at,parser_version,segmentation_method,segmentation_reason) VALUES (?,?,?,?, 'utf-8',?,?, '2030','test','structural','ai-unconfigured')", ["doc", bytes, Buffer.from(hash(bytes), "hex"), bytes.length, namespace, "map.md"]);
      db.run("INSERT INTO import_locations VALUES (?,?,?)", [namespace, "map.md", "doc"]);
      db.run("INSERT INTO thoughts(id,text,author,kind,created_at,origin,parent_id,import_document_id) VALUES (?,?, 'source','imported-original','2030','markdown-import',NULL,'doc')", ["thought", scenario === "wrong text" ? "wrong" : "abc"]);
      db.run("INSERT INTO thought_titles VALUES ('thought',NULL,NULL)");
      db.run("INSERT INTO thought_source_seals VALUES ('thought')");
      if (scenario !== "missing thought") db.run("INSERT INTO import_document_parts VALUES ('doc',0,'thought',0,3,'thought',0)");
      const start = scenario === "gap" ? 4 : scenario === "overlap" ? 2 : scenario === "missing thought" ? 0 : 3;
      db.run("INSERT INTO import_document_parts VALUES (?,?,?,?,?,?,?)", ["doc", scenario === "missing thought" ? 0 : 1, "separator", start, 6, null, null]);
      db.run("INSERT INTO import_document_seals VALUES ('doc')");
    })).toThrow(/import/i);
    expect(db.inTransaction).toBe(false);
    expect(db.query("SELECT count(*) AS n FROM thoughts").get()).toEqual({ n: 0 });
  }));

  test("ordinary save cannot manufacture imported membership", () => fixture((db) => {
    const thought = { id: "forged", text: "source", title: null, author: "source", kind: "imported-original", createdAt: "2030", origin: "markdown-import", parentId: null, sourceIds: [] } as const;
    expect(() => new SqliteStore(db).saveThought(thought)).toThrow();
    expect(db.query("SELECT count(*) AS n FROM thoughts").get()).toEqual({ n: 0 });
  }));

  test("sealed document rejects late thought and part membership", () => fixture((db, _other, imports) => {
    const bytes = encode("sealed words"), batch = imports.createBatch("user", "batch");
    const file = imports.admitFile("user", batch.id, "file", "sealed.md", bytes);
    const result = imports.finalize(ready(imports, file.id, bytes));
    expect(() => db.run("INSERT INTO thoughts(id,text,author,kind,created_at,origin,parent_id,import_document_id) VALUES ('late','x','source','imported-original','2030','markdown-import',NULL,?)", [result.documentId])).toThrow(/sealed/i);
    expect(() => db.run("INSERT INTO import_document_parts VALUES (?,1,'separator',0,1,NULL,NULL)", [result.documentId])).toThrow(/sealed/i);
  }));

  test.each(["", "---\r\ntitle: private\r\n---\r\n", "ordinary words"])("unsealed source cannot commit and failed transaction releases identity (%s)", text => fixture((db) => {
    const bytes = encode(text);
    const hasThought = text === "ordinary words";
    const namespace = (db.query("SELECT id FROM import_namespaces WHERE kind='loose-markdown'").get() as { id: string }).id;
    const insert = () => {
      db.run("INSERT INTO import_documents(id,original_bytes,sha256,byte_length,encoding,original_namespace_id,original_path,created_at,parser_version,segmentation_method,segmentation_reason) VALUES (?,?,?,?, 'utf-8',?,?, '2030','test',?,?)", ["doc", bytes, Buffer.from(hash(bytes), "hex"), bytes.length, namespace, "owned.md", hasThought ? "structural" : "not-needed", hasThought ? "ai-unconfigured" : null]);
      db.run("INSERT INTO import_locations VALUES (?,?,?)", [namespace, "owned.md", "doc"]);
    };
    expect(() => immediate(db, insert)).toThrow(/foreign key/i);
    expect(db.inTransaction).toBe(false);
    expect(db.query("SELECT count(*) AS n FROM import_documents").get()).toEqual({ n: 0 });
    expect(db.query("SELECT count(*) AS n FROM import_locations").get()).toEqual({ n: 0 });
    immediate(db, () => {
      insert();
      if (hasThought) {
        db.run("INSERT INTO thoughts(id,text,author,kind,created_at,origin,parent_id,import_document_id) VALUES ('thought',?,'source','imported-original','2030','markdown-import',NULL,'doc')", [text]);
        db.run("INSERT INTO thought_titles VALUES ('thought',NULL,NULL)");
        db.run("INSERT INTO thought_source_seals VALUES ('thought')");
      }
      if (bytes.length) db.run("INSERT INTO import_document_parts VALUES (?,?,?,?,?,?,?)", ["doc", 0, hasThought ? "thought" : "frontmatter", 0, bytes.length, hasThought ? "thought" : null, hasThought ? 0 : null]);
      db.run("INSERT INTO import_document_seals VALUES ('doc')");
    });
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  }));

  test.each([
    ["document", "BEFORE INSERT ON import_documents"],
    ["thought", "BEFORE INSERT ON thoughts WHEN NEW.kind='imported-original'"],
    ["title", "BEFORE INSERT ON thought_titles"],
    ["source seal", "BEFORE INSERT ON thought_source_seals"],
    ["part", "BEFORE INSERT ON import_document_parts"],
    ["locator", "BEFORE INSERT ON import_locations"],
    ["document seal", "BEFORE INSERT ON import_document_seals"],
    ["last weave", "BEFORE INSERT ON runs WHEN NEW.kind='weave' AND EXISTS(SELECT 1 FROM runs WHERE kind='weave')"],
    ["file settlement", "BEFORE UPDATE OF outcome ON markdown_import_files"],
    ["run completion", "BEFORE UPDATE OF status ON runs WHEN NEW.status='completed'"],
    ["payload deletion", "BEFORE DELETE ON markdown_import_payloads"],
  ])("finalization rolls back at %s and the same owned request can retry", (_label, trigger) => fixture((db, _other, imports) => {
    const bytes = encode("atomic words"), batch = imports.createBatch("user", "batch");
    const file = imports.admitFile("user", batch.id, "file", "atomic.md", bytes);
    const claim = ready(imports, file.id, bytes, 0, true);
    const tables = ["import_documents", "thoughts", "thought_titles", "thought_source_seals", "import_document_parts", "import_locations", "import_document_seals", "markdown_import_files", "markdown_import_payloads", "runs", "run_steps"];
    const snapshot = () => tables.map(table => db.query(`SELECT * FROM ${table} ORDER BY rowid`).all());
    const before = snapshot();
    db.exec(`CREATE TRIGGER injected_failure ${trigger} BEGIN SELECT RAISE(ABORT,'injected failure'); END`);
    expect(() => imports.finalize(claim)).toThrow(/injected failure/);
    expect(db.inTransaction).toBe(false);
    expect(snapshot()).toEqual(before);
    db.exec("DROP TRIGGER injected_failure");
    expect(imports.finalize(claim).state).toBe("imported");
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  }));
});
