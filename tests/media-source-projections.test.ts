import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { SearchThoughtSummary } from "../src/domain/agentic-search";
import type { InvestigationResult } from "../src/domain/investigative-retrieval";
import { partitionMarkdown, prepareMarkdown } from "../src/domain/markdown-import";
import { parseSearchCapabilityRequest } from "../src/domain/search-capability";
import { RejectionService } from "../src/domain/rejection";
import { SearchService } from "../src/domain/search";
import { SimpleExportService } from "../src/domain/simple-export";
import type { MediaThought } from "../src/domain/thought";
import { TitleService } from "../src/domain/title";
import { SqliteCapabilityDispatcher } from "../src/storage/capability";
import { SqliteImportInspection } from "../src/storage/import-inspection";
import { SqliteMarkdownImports } from "../src/storage/markdown-import";
import { SqliteRejectionRepository } from "../src/storage/rejection";
import { SqliteRunOperations } from "../src/storage/run-operations";
import { SqliteRunProtocolRepository } from "../src/storage/run-protocol";
import { SqliteRunRepository } from "../src/storage/run";
import { SqliteSearchRepository } from "../src/storage/search";
import { migrate, SqliteStore } from "../src/storage/sqlite";
import { SqliteTitleRepository } from "../src/storage/title";
import { initializeSqlMediaStore, insertMediaSource, mediaThought, mediaTime } from "./fixtures/media-source";

const ai = { actor: "ai", mode: "normal" } as const;
const normal = { actor: "user", mode: "normal" } as const;
const history = { actor: "user", mode: "history" } as const;
function fixture(action: (db: Database, store: SqliteStore, rejection: RejectionService, repository: SqliteSearchRepository) => void,
  thought: MediaThought = mediaThought): void {
  const db = new Database(":memory:");
  try {
    migrate(db); initializeSqlMediaStore(db); insertMediaSource(db, thought);
    action(db, new SqliteStore(db), new RejectionService(new SqliteRejectionRepository(db)), new SqliteSearchRepository(db));
  } finally { db.close(); }
}

function child(store: SqliteStore, text = "Retained independent development"): void {
  store.saveThought({ id: "child", text, title: null, titleAuthor: null, author: "ai", kind: "ai-interpretation",
    createdAt: mediaTime, origin: "weave", parentId: mediaThought.id, sourceIds: [] });
}

describe("persisted media-source projections", () => {
  test("raw, scoped, inspection and Simple export reads hydrate exact separately attributed clarification", () => fixture((db, store, rejection) => {
    expect(store.getThought(mediaThought.id)).toEqual(mediaThought);
    expect(rejection.listThoughts(normal)).toEqual([mediaThought]);
    expect(rejection.listThoughts(ai)).toEqual([mediaThought]);
    expect(rejection.listThoughts(history)).toEqual([{ ...mediaThought, rejected: false }]);
    const markdown = new SimpleExportService(rejection).render("user", { rootId: mediaThought.id, count: 1, traversal: "breadth" });
    expect(markdown).toContain(mediaThought.mediaSource.name);
    expect(markdown).toContain("media-original");
    expect(markdown).toContain("unverified");
    expect(markdown).toContain("User clarification");
    expect(markdown).toContain(mediaThought.mediaSource.clarification ?? "missing fixture clarification");
    expect(markdown).not.toContain("Imported media source.");
    expect(db.query("SELECT text FROM thoughts WHERE id=?").get(mediaThought.id)).toEqual({ text: null });
    const expectedHex = Buffer.from(mediaThought.mediaSource.clarification ?? "").toString("hex").toUpperCase();
    expect(db.query("SELECT hex(CAST(clarification AS BLOB)) AS bytes FROM media_sources").get()).toEqual({ bytes: expectedHex });
  }));

  test("keyword results and counts retain the media union and use clarification rather than a null thought body", () => fixture((_db, store, _rejection, repository) => {
    child(store, "Zircon interpretation wording");
    const page = new SearchService(repository).query(ai, "zircon", { authors: ["source"], kinds: ["media-original"] });
    expect(page.results).toEqual([expect.objectContaining({ kind: "thought", id: mediaThought.id, thoughtId: mediaThought.id,
      text: null, author: "source", materialKind: "media-original", title: mediaThought.mediaSource.name,
      snippet: mediaThought.mediaSource.clarification?.slice(0, 160), mediaSource: mediaThought.mediaSource })]);
    expect(page.counts.authors.source).toBe(1);
    expect(page.counts.kinds["media-original"]).toBe(1);
    const hit = repository.search(ai, "zircon").find(item => item.id === mediaThought.id);
    expect(hit).toMatchObject({ text: null, mediaSource: mediaThought.mediaSource });
  }));

  test("both predecessor and matching-connection context hydrate the media descriptor", () => fixture((_db, store, _rejection, repository) => {
    child(store, "Chromium descendant wording");
    const predecessor = repository.query(ai, "chromium", {}).results.find(item => item.id === "child");
    expect(predecessor?.context).toEqual({ kind: "predecessor", thought: mediaThought });
    store.saveThought({ id: "neighbor", text: "Zircon neighbor", title: null, author: "user", kind: "captured-original",
      createdAt: mediaTime, origin: "fixture", parentId: null, sourceIds: [] });
    const connection = { id: "media-connection", fromId: "neighbor", toId: mediaThought.id, category: "related" as const,
      proposedBy: "ai" as const, explanation: "Recorded relation", sourceIds: [] };
    store.saveConnection(connection);
    const connected = repository.query(ai, "zircon", {}).results.find(item => item.id === "neighbor");
    expect(connected?.context).toEqual({ kind: "connection", thought: mediaThought, connection });
  }));

  test("ordinary scoped capability reads hydrate source metadata and retain thought exposure", () => fixture((db, store) => {
    let n = 0; const sources = { id: () => `read-${++n}`, now: () => mediaTime };
    store.saveThought({ id: "text-subject", text: "Controlled ordinary subject", title: null, author: "user", kind: "captured-original",
      createdAt: mediaTime, origin: "fixture", parentId: null, sourceIds: [] });
    const operations = new SqliteRunOperations(db, sources), runs = new SqliteRunRepository(db, sources), steps = new SqliteRunProtocolRepository(db);
    const run = operations.admitWeave("user", { subjectId: "text-subject", triggerId: "fixture" });
    // The subject is a regular thought, so this test does not select media interpretation/title authority.
    const claim = runs.claim(run.id), request = { capability: "readThought" as const, arguments: { id: mediaThought.id } };
    steps.prepare(claim, { promptId: run.promptId, input: "controlled ordinary read request" });
    steps.completeStep(claim, run.promptId, { version: 1, kind: "request", request });
    const dispatcher = new SqliteCapabilityDispatcher(db, sources);
    expect(dispatcher.dispatch(claim, run.promptId, request)).toEqual({ type: "thought", thought: mediaThought });
    expect(dispatcher.fullReadWitnesses(run.id)).toContainEqual({ kind: "thought", id: mediaThought.id });
  }));

  test("investigative retrieval and saved-search preview/discovery fallback share the same eligible media projection", () => fixture((db, store) => {
    const parsed = parseSearchCapabilityRequest({ capability: "findThoughts", arguments: { query: "zircon", authors: ["source"],
      kinds: ["media-original"], from: null, until: null, sort: "oldest", limit: 25, cursor: null } });
    expect(parsed.capability).toBe("findThoughts");
    const request = { query: "zircon", authors: ["source" as const], kinds: ["media-original" as const], from: null,
      until: null, sort: "oldest" as const, limit: 25, cursor: null };
    const result = store.searchInvestigation().findThoughts(request);
    const clarification = mediaThought.mediaSource.clarification;
    if (clarification === null) throw new Error("Missing test-owned retrieval clarification");
    const expected = { type: "page", items: [{ kind: "thought", id: mediaThought.id, thoughtId: mediaThought.id,
      snippet: clarification.slice(0, 160), author: "source", materialKind: "media-original", createdAt: mediaTime }], nextCursor: null } satisfies InvestigationResult;
    expect(result).toEqual(expected);
    expect(store.searchInvestigation().findThoughts({ ...request, query: null, from: "2029-01-01T00:00:00Z", until: "2031-01-01T00:00:00Z" })).toEqual(result);
    let n = 0; const sessions = store.searchSessions({ id: () => `search-${++n}`, now: () => mediaTime });
    const session = sessions.create("user", "create-key", {}).session;
    const composer = sessions.openComposer("user", session.id);
    expect(sessions.previewThought("user", session.id, composer.composerId, mediaThought.id).thought).toEqual(mediaThought);
    expect(db.query("SELECT ref_kind,ref_id FROM search_composer_dependencies WHERE composer_id=?").all(composer.composerId))
      .toEqual([{ ref_kind: "thought", ref_id: mediaThought.id }]);
    const refreshed = sessions.refreshComposer("user", session.id, composer.composerId);
    const turn = sessions.admitTurn("user", session.id, "find-key", { text: "Find the source", startingThoughtIds: [],
      requestClock: { at: mediaTime, timeZone: "UTC" }, composerId: refreshed.composerId, contextToken: refreshed.contextToken });
    const initial = db.query<{ prompt_id: string }, [string]>("SELECT prompt_id FROM runs WHERE id=?").get(turn.run.id);
    if (!initial) throw new Error("Missing test-owned search run");
    const envelope = { version: 1, kind: "request", request: { capability: "addDiscovery", arguments: { thoughtId: mediaThought.id,
      why: "Recorded test rationale", evidenceThoughtIds: [] } } };
    db.run("UPDATE run_steps SET input='fixture',state='completed',native_state='completed',envelope_json=?,result_json=? WHERE run_id=? AND prompt_id=?",
      [JSON.stringify(envelope), JSON.stringify({ type: "discovery-add", entryId: "media-occurrence", outcome: "added" }), turn.run.id, initial.prompt_id]);
    db.run(`INSERT INTO search_discoveries(id,session_id,thought_id,position,why,evidence_json,added_run_id,added_prompt_id,added_at)
      VALUES ('media-occurrence',?,?,0,'Recorded test rationale','[]',?,?,?)`, [session.id, mediaThought.id, turn.run.id, initial.prompt_id, mediaTime]);
    const viewer = sessions.openComposer("user", session.id);
    const summary = { id: mediaThought.id, title: mediaThought.mediaSource.name,
      titleAuthor: null, author: "source", kind: "media-original", createdAt: mediaTime } satisfies SearchThoughtSummary;
    expect(sessions.discoveries("user", session.id, { composerId: viewer.composerId }).items)
      .toEqual([expect.objectContaining({ thought: summary })]);
    expect(sessions.history("user", session.id).discoveries.items[0]?.thought).toEqual(summary);
  }));

  test("rejection hides metadata and vocabulary through active descendants, while explicit user inspection retains the original", () => fixture((_db, store, rejection, repository) => {
    child(store);
    expect(repository.suggest(ai, "zircon")).toContain("zircon");
    rejection.rejectThought("user", mediaThought.id);
    const visible = rejection.listThoughts(ai);
    expect(visible).toHaveLength(1);
    expect(visible[0]).toMatchObject({ id: "child", parentId: null });
    expect(JSON.stringify(visible)).not.toContain(mediaThought.mediaSource.name);
    expect(JSON.stringify(visible)).not.toContain("Zircon clarification");
    expect(repository.search(ai, "zircon")).toEqual([]);
    expect(repository.suggest(ai, "zircon")).not.toContain("zircon");
    expect(repository.suggest(history, "zircon")).toContain("zircon");
    expect(rejection.listThoughts(history)).toContainEqual({ ...mediaThought, rejected: true });
    const inspected = repository.query(history, "zircon", { kinds: ["media-original"] });
    expect(inspected.results).toEqual([expect.objectContaining({ text: null, mediaSource: mediaThought.mediaSource })]);
    rejection.restoreThought("user", mediaThought.id);
    expect(repository.suggest(ai, "zircon")).toContain("zircon");
  }));

  test("only clarification and explicit titles enter FTS/vocabulary, including after clear and reindex", () => fixture((db, store, _rejection, repository) => {
    for (const term of ["filenamevault", "binarypayloadvault", "extractedtextvault", "fixture", "media", "png"]) {
      expect(repository.search(ai, term)).toEqual([]);
      expect(repository.suggest(ai, term)).not.toContain(term);
    }
    expect(repository.suggest(ai, "zircon")).toContain("zircon");
    const titles = new TitleService(new SqliteTitleRepository(db));
    titles.setUser("user", mediaThought.id, "filenamevault");
    expect(repository.search(ai, "filenamevault").map(hit => hit.id)).toEqual([mediaThought.id]);
    expect(repository.suggest(ai, "filenamevault")).toContain("filenamevault");
    titles.setUser("user", mediaThought.id, null);
    expect(repository.search(ai, "filenamevault")).toEqual([]);
    expect(repository.suggest(ai, "filenamevault")).not.toContain("filenamevault");
    migrate(db);
    expect(repository.search(ai, "zircon").map(hit => hit.id)).toEqual([mediaThought.id]);
    expect(store.getThought(mediaThought.id)).toEqual(mediaThought);
    expect(db.query("SELECT text,title FROM thought_search_fts WHERE thought_id=?").get(mediaThought.id))
      .toEqual({ text: mediaThought.mediaSource.clarification, title: null });
  }));

  test("media without clarification indexes no synthetic body and uses filename only as a display fallback", () => {
    const unclarified: MediaThought = { ...mediaThought, mediaSource: { ...mediaThought.mediaSource, clarification: null, clarificationAuthor: null } };
    fixture((_db, store, rejection, repository) => {
      expect(store.getThought(unclarified.id)).toEqual(unclarified);
      expect(repository.search(ai, "filenamevault")).toEqual([]);
      const candidates = store.searchInvestigation().findThoughts({ query: null, authors: [], kinds: ["media-original"],
        from: "2029-01-01T00:00:00Z", until: "2031-01-01T00:00:00Z", sort: "oldest", limit: 25 });
      expect(candidates).toEqual({ type: "page", items: [{ kind: "thought", id: unclarified.id, thoughtId: unclarified.id,
        snippet: "", author: "source", materialKind: "media-original", createdAt: mediaTime }], nextCursor: null });
      expect(new SimpleExportService(rejection).render("user", { rootId: unclarified.id, count: 1, traversal: "breadth" })).not.toContain("Imported media source.");
    }, unclarified);
  });

  test("Markdown original bytes and filename stay user-only after media support hydrates ordinary scoped records", () => fixture((db, _store, rejection, repository) => {
    let n = 0; const sources = { id: () => `markdown-${++n}`, now: () => mediaTime };
    const imports = new SqliteMarkdownImports(db, sources), inspection = new SqliteImportInspection(db, sources);
    const bytes = new TextEncoder().encode("---\nsecret: frontmattervault\n---\n\nCobalt imported wording\n");
    const batch = imports.createBatch("user", "markdown-key"), file = imports.admitFile("user", batch.id, "file-key", "markdownfilenamevault.md", bytes);
    const claim = imports.claim(file.id), parsed = prepareMarkdown(bytes);
    imports.prepare(claim, parsed.manifest); const prepared = imports.privateInput(claim);
    if (prepared.input === null) throw new Error("Missing exact Markdown preparation");
    const chosen = imports.choose(claim, partitionMarkdown(bytes, parsed, parsed.fallbackCuts, { method: "structural", reason: "ai-unconfigured" }),
      { state: "not-submitted", promptId: prepared.promptId, inputSha256: createHash("sha256").update(prepared.input).digest("hex") });
    const done = imports.finalize(chosen);
    if (!done.documentId) throw new Error("Missing committed Markdown source");
    expect(inspection.raw(history, done.documentId)).toEqual(bytes);
    expect(inspection.provenance(normal, mediaThought.id)).toEqual({ importSource: null });
    expect(() => inspection.raw(ai, done.documentId ?? "missing")).toThrow();
    expect(repository.search(ai, "cobalt")).toEqual([expect.objectContaining({ text: "Cobalt imported wording" })]);
    expect(repository.search(ai, "markdownfilenamevault")).toEqual([]);
    expect(repository.search(ai, "frontmattervault")).toEqual([]);
    expect(JSON.stringify(rejection.listThoughts(ai))).not.toContain("frontmattervault");
    expect(JSON.stringify(rejection.listThoughts(ai))).not.toContain("markdownfilenamevault");
  }));
});
