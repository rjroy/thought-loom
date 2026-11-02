import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { openDatabase, saveCapture } from "../src/storage";
import { KnowledgeService } from "../src/knowledge";
import { writeTitle } from "../src/title-write";
import { createFuzzyRetriever } from "../src/fuzzy-retrieval";

const directories: string[] = [];
afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture() {
  const dir = await mkdtemp("/tmp/opencode/fuzzy-retrieval-test-"); directories.push(dir);
  const databasePath = join(dir, "fixture.sqlite"), db = openDatabase(databasePath); db.close();
  let sequence = 0;
  function capture(text: string) {
    const result = saveCapture(databasePath, `fuzzy-reader-${++sequence}`, { text, provenance: "controlled fixture" });
    if (result.kind !== "created") throw new Error("Fixture capture failed");
    return result.source;
  }
  return { databasePath, capture, knowledge: new KnowledgeService(databasePath) };
}

test("phase2-reader scans whole fields, including beyond 240 and the old 50-candidate gate", async () => {
  const f = await fixture();
  const late = f.capture(`${"q".repeat(300)} SoftwareDevelopmentKit`);
  const distant = f.capture(`shoulD${"q".repeat(16_500)} Know`);
  for (let n = 0; n < 55; n++) f.capture(`q${n}q`);
  const last = f.capture("sdk");
  const result = await createFuzzyRetriever({ databasePath: f.databasePath }).search({ query: "sdk", limit: 100 });
  expect(result.hasMore).toBe(false);
  const hit = (sourceId: string) => result.matches.find((match) => match.target.kind === "source" && match.target.sourceId === sourceId);
  expect(hit(last.id)?.match.class).toBe("whole-word");
  expect(hit(late.id)?.match.class).toBe("initials");
  expect(hit(distant.id)).toBeDefined();
  const lateMatch = hit(late.id);
  expect(lateMatch?.match.field).toBe("source-body");
  expect(lateMatch?.passage.matchStart).toBeGreaterThan(240);
  expect(lateMatch?.passage.fragments.some((fragment) => fragment.text.includes("SoftwareDevelopmentKit"))).toBe(true);
  expect(result.matches[0]?.target.sourceId).toBe(last.id);
});

test("phase2-reader global top K equals an independent full-sort oracle and hasMore", async () => {
  const f = await fixture();
  // All candidates are lowercase lexical words: the first is whole-word, the
  // second contiguous interior, and the rest scattered with distinct gaps.
  const samples = [{ source: f.capture("sdk"), rank: [0, 0] }, { source: f.capture("xsdkx"), rank: [1, 0] }];
  for (let n = 60; n >= 1; n--) samples.push({ source: f.capture(`s${"x".repeat(n)}dxk`), rank: [3, n + 1] });
  const expected = [...samples].sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1]).map((entry) => entry.source.id);
  const retriever = createFuzzyRetriever({ databasePath: f.databasePath });
  const all = await retriever.search({ query: "sdk", limit: 100 });
  const small = await retriever.search({ query: "sdk", limit: 7 });
  expect(all.matches.map((match) => match.target.sourceId)).toEqual(expected);
  expect(all.hasMore).toBe(false);
  expect(small.matches.map((match) => match.target.sourceId)).toEqual(expected.slice(0, 7));
  expect(small.hasMore).toBe(true);
});

test("phase2-reader selects effective user title and exact current formulation, never historical text", async () => {
  const f = await fixture(), root = f.capture("Plain original without the sought letters.");
  const item = f.knowledge.createItem({ actor: "ai", operationId: "reader-item", runId: "fixture-run" }, { kind: "interpretation", sourceId: root.id, text: "olduniquefragment", evidenceSourceIds: [root.id] });
  const db = openDatabase(f.databasePath);
  const title = (() => { try { return db.transaction(() => writeTitle(db, { sourceId: root.id, target: { kind: "item", itemId: item.id, versionId: item.current.id }, author: "user", text: "sdk", key: "reader-user-title", payloadHash: "reader-user-title", expectedTitleRevisionId: null })).immediate(); } finally { db.close(); } })();
  const revised = f.knowledge.reviseItem({ actor: "ai", operationId: "reader-revised", runId: "fixture-run" }, { itemId: item.id, expectedVersionId: item.current.id, text: "sdk", evidenceSourceIds: [root.id] });
  const retriever = createFuzzyRetriever({ databasePath: f.databasePath });
  const result = await retriever.search({ query: "sdk", limit: 50 });
  const matches = result.matches.filter((match) => match.target.kind === "item" && match.target.itemId === item.id);
  expect(matches).toHaveLength(1);
  expect(matches[0]).toMatchObject({ target: { kind: "item", sourceId: root.id, itemId: item.id, formulationId: revised.current.id, titleRevisionId: title.revisionId }, match: { field: "title", class: "whole-word" } });
  expect(matches[0].passage.fragments.map((fragment) => fragment.text).join("")).toBe("sdk");
  expect((await retriever.search({ query: "olduniquefragment", limit: 50 })).matches.some((match) => match.target.kind === "item" && match.target.itemId === item.id)).toBe(false);
});

test("phase2-reader rejects a missing canonical target projection even if another target matches", async () => {
  const f = await fixture(), absent = f.capture("unrelated canonical source"), match = f.capture("sdk");
  const db = openDatabase(f.databasePath);
  try { db.run("DELETE FROM fuzzy_targets WHERE target_kind='source' AND target_id=?", [absent.id]); }
  finally { db.close(); }
  // Enumerating projection rows alone would silently return the valid hit.
  expect(match.id).not.toBe(absent.id);
  await expect(createFuzzyRetriever({ databasePath: f.databasePath }).search({ query: "sdk", limit: 50 })).rejects.toThrow();
});

test("phase2-reader holds one snapshot across a concurrent canonical writer", async () => {
  const f = await fixture(), root = f.capture("plain original");
  const item = f.knowledge.createItem({ actor: "ai", operationId: "snapshot-item", runId: "fixture-run" }, { kind: "interpretation", sourceId: root.id, text: "sdk", evidenceSourceIds: [root.id] });
  let revised = false;
  const retriever = createFuzzyRetriever({ databasePath: f.databasePath, yieldControl: async () => {
    if (revised) return;
    revised = true;
    f.knowledge.reviseItem({ actor: "ai", operationId: "snapshot-revision", runId: "fixture-run" }, { itemId: item.id, expectedVersionId: item.current.id, text: "qqqq", evidenceSourceIds: [root.id] });
  } });
  const old = await retriever.search({ query: "sdk", limit: 50 });
  expect(revised).toBe(true);
  expect(old.matches.find((match) => match.target.kind === "item" && match.target.itemId === item.id)).toMatchObject({ target: { formulationId: item.current.id }, match: { field: "formulation-body" }, passage: { fragments: expect.arrayContaining([expect.objectContaining({ text: "sdk" })]) } });
  const current = await retriever.search({ query: "sdk", limit: 50 });
  expect(current.matches.some((match) => match.target.kind === "item" && match.target.itemId === item.id)).toBe(false);
});

test("phase2-guards pre-cancelled and deadline-expired scans release their slot", async () => {
  const f = await fixture(); f.capture("sdk");
  let now = 0, expire = true;
  const retriever = createFuzzyRetriever({ databasePath: f.databasePath, now: () => now,
    policy: { deadlineMs: 10, workingSetBytes: 1_000_000 }, yieldControl: async () => { if (expire) now = 10; } });
  const controller = new AbortController(); controller.abort();
  await expect(retriever.search({ query: "sdk", limit: 1, signal: controller.signal })).rejects.toMatchObject({ code: "cancelled" });
  await expect(retriever.search({ query: "sdk", limit: 1 })).rejects.toMatchObject({ code: "deadline" });
  now = 0; expire = false;
  expect((await retriever.search({ query: "sdk", limit: 1 })).matches).toHaveLength(1);
});

test.each(["cancelled", "deadline"] as const)("phase2-guards %s interrupts work after scanning begins", async (reason) => {
  const f = await fixture(); f.capture(`${"x".repeat(9_000)}sdk`);
  let now = 0, yields = 0;
  const controller = new AbortController();
  const retriever = createFuzzyRetriever({ databasePath: f.databasePath, now: () => now,
    policy: { deadlineMs: 10, workingSetBytes: 1_000_000 }, yieldControl: async () => {
      yields++;
      // First yield pins the snapshot, second begins the first field; the third
      // is the 4096-update cooperative boundary within the long field.
      if (yields === 3) { if (reason === "cancelled") controller.abort(); else now = 10; }
    } });
  await expect(retriever.search({ query: "sdk", limit: 1, signal: controller.signal })).rejects.toMatchObject({ code: reason });
  expect(yields).toBe(3);
});

test("phase2-guards cancelled owner keeps its slot until held snapshot cleanup", async () => {
  const f = await fixture(); f.capture("sdk");
  let entered = () => {}, release = () => {}, first = true;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const retriever = createFuzzyRetriever({ databasePath: f.databasePath, yieldControl: async () => {
    if (first) { first = false; entered(); await gate; }
  } });
  const controller = new AbortController();
  const owned = retriever.search({ query: "sdk", limit: 1, signal: controller.signal });
  // Attach rejection observation before cancellation; cleanup must always free the gate.
  const outcome = owned.then(() => "unexpected success", (error: unknown) => error);
  try {
    await waiting;
    await expect(retriever.search({ query: "sdk", limit: 1 })).rejects.toMatchObject({ code: "busy" });
    controller.abort();
    await expect(retriever.search({ query: "sdk", limit: 1 })).rejects.toMatchObject({ code: "busy" });
  } finally { release(); }
  expect(await outcome).toMatchObject({ code: "cancelled" });
  expect((await retriever.search({ query: "sdk", limit: 1 })).matches).toHaveLength(1);
});

test("phase2-guards oversized chunk is unavailable under a controlled memory policy", async () => {
  const f = await fixture(); f.capture(`sdk${"x".repeat(16_300)}`);
  const policy = { deadlineMs: 10_000, workingSetBytes: 20_000 };
  const retriever = createFuzzyRetriever({ databasePath: f.databasePath, policy });
  await expect(retriever.search({ query: "sdk", limit: 1 })).rejects.toMatchObject({ code: "memory" });
  // Another controlled database demonstrates that the test policy admits the
  // query's own accounting and short chunks, not just an impossible budget.
  const small = await fixture(); small.capture("sdk");
  expect((await createFuzzyRetriever({ databasePath: small.databasePath, policy }).search({ query: "sdk", limit: 1 })).matches).toHaveLength(1);
});

test.each(["ordinal", "offset", "count", "missing body", "missing title", "stale item"] as const)("phase2-guards corrupt %s fails the whole scan", async (kind) => {
  const f = await fixture(), root = f.capture("sdk");
  const item = f.knowledge.createItem({ actor: "ai", operationId: "corrupt-item", runId: "fixture-run" }, { kind: "interpretation", sourceId: root.id, text: "an unrelated interpretation", evidenceSourceIds: [root.id] });
  const db = openDatabase(f.databasePath);
  try {
    if (kind === "ordinal") db.run("UPDATE fuzzy_chunks SET ordinal=1 WHERE target_kind='source' AND target_id=? AND field_kind='source-body' AND ordinal=0", [root.id]);
    if (kind === "offset") db.run("UPDATE fuzzy_chunks SET start_offset=1 WHERE target_kind='source' AND target_id=? AND field_kind='source-body' AND ordinal=0", [root.id]);
    if (kind === "count") db.run("UPDATE fuzzy_fields SET chunk_count=chunk_count+1 WHERE target_kind='source' AND target_id=? AND field_kind='source-body'", [root.id]);
    if (kind === "missing body") db.run("DELETE FROM fuzzy_fields WHERE target_kind='item' AND target_id=? AND field_kind='formulation-body'", [item.id]);
    if (kind === "missing title") {
      db.transaction(() => writeTitle(db, { sourceId: root.id, target: { kind: "item", itemId: item.id, versionId: item.current.id }, author: "user", text: "Fixture title", key: "corrupt-title", payloadHash: "corrupt-title", expectedTitleRevisionId: null })).immediate();
      db.run("DELETE FROM fuzzy_fields WHERE target_kind='item' AND target_id=? AND field_kind='title'", [item.id]);
    }
    if (kind === "stale item") {
      const old = item.current.id;
      const next = f.knowledge.reviseItem({ actor: "ai", operationId: "corrupt-revise", runId: "fixture-run" }, { itemId: item.id, expectedVersionId: old, text: "new current", evidenceSourceIds: [root.id] });
      expect(next.current.id).not.toBe(old);
      db.run("UPDATE fuzzy_targets SET formulation_id=? WHERE target_kind='item' AND target_id=?", [old, item.id]);
    }
  } finally { db.close(); }
  const retriever = createFuzzyRetriever({ databasePath: f.databasePath });
  await expect(retriever.search({ query: "sdk", limit: 1 })).rejects.toMatchObject({ code: "projection" });
  // An unavailable scan must also release its slot, not leave a busy reader.
  await expect(retriever.search({ query: "sdk", limit: 1 })).rejects.toMatchObject({ code: "projection" });
});

test("phase2-passages preserve Unicode offsets across a chunk boundary", async () => {
  const f = await fixture(), text = `${"q".repeat(16_382)}e\u0301👩‍💻 suffix`, source = f.capture(text);
  const result = await createFuzzyRetriever({ databasePath: f.databasePath }).search({ query: "É👩‍💻", limit: 1 });
  const hit = result.matches.find((match) => match.target.sourceId === source.id);
  expect(hit).toBeDefined(); if (!hit) throw new Error("Missing fixture match");
  expect(text.slice(hit.passage.matchStart, hit.passage.matchEnd)).toBe("e\u0301👩‍💻");
  const highlighted = hit.passage.fragments.flatMap((fragment) => {
    expect(text.slice(fragment.start, fragment.end)).toBe(fragment.text);
    return fragment.highlights.map((range) => fragment.text.slice(range.start, range.end));
  }).join("");
  expect(highlighted).toBe("e\u0301👩‍💻");
});

test("phase2-passages separated anchors stay bounded and reconstruct source slices", async () => {
  const f = await fixture(), text = `a${"x".repeat(500)}b${"x".repeat(500)}c`, source = f.capture(text);
  const result = await createFuzzyRetriever({ databasePath: f.databasePath }).search({ query: "abc", limit: 1 });
  const hit = result.matches.find((match) => match.target.sourceId === source.id);
  expect(hit).toBeDefined(); if (!hit) throw new Error("Missing fixture match");
  const passage = hit.passage;
  expect(passage.fragments).toHaveLength(3); expect(passage.omittedMatchedCharacters).toBe(false);
  expect(passage.fragments.reduce((sum, fragment) => sum + fragment.text.length, 0)).toBeLessThanOrEqual(4096);
  expect(passage.fragments.reduce((sum, fragment) => sum + [...new Intl.Segmenter("und", { granularity: "grapheme" }).segment(fragment.text)].length, 0)).toBeLessThanOrEqual(240);
  for (const fragment of passage.fragments) expect(text.slice(fragment.start, fragment.end)).toBe(fragment.text);
  expect(passage.fragments.flatMap((fragment) => fragment.highlights.map((range) => fragment.text.slice(range.start, range.end))).join("")).toBe("abc");
});

test("phase2-passages omit an oversized display grapheme without exceeding payload", async () => {
  const f = await fixture(), text = `b${"a" + "\u0301".repeat(5_000)}`, source = f.capture(text);
  const result = await createFuzzyRetriever({ databasePath: f.databasePath }).search({ query: "b", limit: 1 });
  const hit = result.matches.find((match) => match.target.sourceId === source.id);
  expect(hit).toBeDefined(); if (!hit) throw new Error("Missing fixture match");
  expect(hit.passage.fragments.reduce((sum, fragment) => sum + fragment.text.length, 0)).toBeLessThanOrEqual(4096);
  expect(hit.passage.omittedMatchedCharacters).toBe(true);
  expect(text.slice(hit.passage.matchStart, hit.passage.matchEnd)).toBe("b");
});
