import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SearchService } from "../src/domain/search";
import { SqliteSearchRepository } from "../src/storage/search";
import { migrate, SqliteStore } from "../src/storage/sqlite";

const source = fileURLToPath(new URL("../vendor/sqlite/spellfix.c", import.meta.url));
const script = fileURLToPath(new URL("../scripts/build-spellfix.sh", import.meta.url));
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const expectedSource = "b961fe17a2fe7082a4a8c7a2676d16ea5450a9021b8b604ff446267312652c51";

function withBuildTree(action: (dir: string) => void) {
  const dir = mkdtempSync(join("/tmp/opencode", "spellfix-build-test-"));
  try {
    mkdirSync(join(dir, "vendor/sqlite"), { recursive: true });
    mkdirSync(join(dir, "scripts"), { recursive: true });
    copyFileSync(source, join(dir, "vendor/sqlite/spellfix.c"));
    copyFileSync(script, join(dir, "scripts/build-spellfix.sh"));
    action(dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
function build(dir: string) {
  return Bun.spawnSync({ cmd: ["/usr/bin/bash", "scripts/build-spellfix.sh"], cwd: dir, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe", timeout: 30000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 });
}

describe("native spellfix integration", () => {
  test("pinned source builds reproducibly in owned outputs and loads in Bun SQLite", () => withBuildTree(dir => {
    expect(sha256(source)).toBe(expectedSource);
    const first = build(dir);
    expect(first.exitCode).toBe(0);
    const library = join(dir, "build/sqlite/spellfix.so");
    expect(existsSync(library)).toBe(true);
    const firstHash = sha256(library);
    const second = build(dir);
    expect(second.exitCode).toBe(0);
    expect(sha256(library)).toBe(firstHash);
    const db = new Database(":memory:");
    try {
      db.loadExtension(library, "sqlite3_spellfix_init");
      db.exec("CREATE VIRTUAL TABLE terms USING spellfix1; INSERT INTO terms(word) VALUES ('thought'); CREATE VIRTUAL TABLE docs USING fts5(content); INSERT INTO docs VALUES ('connected thought');");
      expect(db.query("SELECT word FROM terms WHERE word MATCH ?").all("thoght")).toEqual([{ word: "thought" }]);
      expect(db.query("SELECT content FROM docs WHERE docs MATCH ?").all("thou*")).toEqual([{ content: "connected thought" }]);
    } finally { db.close(); }
  }), 45000);

  test("modified pinned source fails verification before producing an artifact", () => withBuildTree(dir => {
    appendFileSync(join(dir, "vendor/sqlite/spellfix.c"), "\n/* test modification */\n");
    const result = build(dir);
    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout.toString()} ${result.stderr.toString()}`).toMatch(/failed|checksum/i);
    expect(existsSync(join(dir, "build/sqlite/spellfix.so"))).toBe(false);
  }), 45000);

  test("missing native artifact fails actionably without a fuzzy fallback", () => withBuildTree(dir => {
    const db = new Database(":memory:");
    try {
      migrate(db);
      const store = new SqliteStore(db);
      store.saveThought({ id: "one", text: "thought", title: null, author: "user", kind: "captured-original", createdAt: "2030", origin: "test", parentId: null, sourceIds: [] });
      const service = new SearchService(new SqliteSearchRepository(db, join(dir, "missing.so")));
      expect(() => service.suggest({ actor: "user", mode: "normal" }, "thoght")).toThrow(/spellfix1.*build:spellfix/i);
    } finally { db.close(); }
  }));
});
