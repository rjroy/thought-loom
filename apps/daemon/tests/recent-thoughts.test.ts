import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { DialogueService } from "../src/dialogue";
import { KnowledgeService } from "../src/knowledge";
import { openDatabase } from "../src/storage";
import { WeavingWorker } from "../src/weaving";
import { INQUIRY_LIMITS, parseInquiryView } from "@thoughtloom/contracts";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

test("schema 17 migration preserves controlled history and leaves legacy item creation unknown", async () => {
  const directory = await mkdtemp(join(tmpdir(), "thoughtloom-v17-migration-")); directories.push(directory);
  const databasePath = join(directory, "baseline.sqlite");
  const schema = await readFile(new URL("../../../tests/fixtures/thoughtloom-schema-v17.sql", import.meta.url), "utf8");
  const db = new Database(databasePath, { create: true });
  const original = "  Original fixture \nwith exact spacing.  ";
  const projections = [
    "SELECT id,CAST(text AS BLOB) AS bytes,provenance,created_at FROM sources ORDER BY id",
    "SELECT id,kind,source_id FROM knowledge_items ORDER BY id",
    "SELECT * FROM formulations ORDER BY rowid",
    "SELECT * FROM formulation_evidence ORDER BY formulation_id,position",
    "SELECT id,source_id,status,priority,kind FROM jobs ORDER BY rowid",
    "SELECT * FROM weaving_runs ORDER BY rowid",
    "SELECT * FROM owned_grants ORDER BY rowid",
    "SELECT * FROM native_commands ORDER BY rowid",
    "SELECT * FROM capture_receipts ORDER BY rowid",
    "SELECT * FROM knowledge_receipts ORDER BY rowid",
  ];
  let before: unknown[][];
  try {
    db.exec(schema); db.run("PRAGMA foreign_keys=ON");
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 17 });
    db.run("INSERT INTO sources(id,text,provenance,created_at) VALUES (?,?,?,?)", ["v17-source", original, "fixture", "2001-01-01T00:00:00.000Z"]);
    db.run("INSERT INTO source_search(source_id,text) VALUES (?,?)", ["v17-source", original]);
    db.run("INSERT INTO capture_receipts(idempotency_key,payload_hash,source_id,response_version) VALUES ('v17-capture','fixture-capture-hash','v17-source',2)");
    db.run("INSERT INTO jobs(id,source_id,status,priority,kind) VALUES ('v17-job','v17-source','uncertain',0,'capture')");
    db.run("INSERT INTO weaving_runs(id,job_id,attempt,session_id,prompt_id,state,created_at,updated_at) VALUES ('v17-run','v17-job',1,'ses_v17','msg_v17','uncertain',1,2)");
    db.run("INSERT INTO owned_grants(session_id,run_id,location,agent,source_ids,operations,scope_hash,revoked) VALUES ('ses_v17','v17-run','/fixture/location','fixture-agent','[\"v17-source\"]','[\"record_interpretation\"]','fixture-grant-hash',0)");
    db.run("INSERT INTO native_commands(run_id,payload,payload_hash,attempted) VALUES ('v17-run','fixture-command','fixture-command-hash',1)");
    db.run("INSERT INTO knowledge_items(id,kind,source_id) VALUES ('v17-item','interpretation','v17-source')");
    db.run("INSERT INTO formulations(id,item_id,text,author,operation_id,run_id) VALUES ('v17-formulation-1','v17-item','Earlier fixture reading','ai','v17-op-1','v17-run')");
    db.run("INSERT INTO formulations(id,item_id,text,author,operation_id) VALUES ('v17-formulation-2','v17-item','Current fixture reading','user','v17-op-2')");
    db.run("INSERT INTO formulation_evidence(formulation_id,source_id,position) VALUES ('v17-formulation-1','v17-source',0),('v17-formulation-2','v17-source',0)");
    db.run("INSERT INTO formulation_search(item_id,text) VALUES ('v17-item','Current fixture reading')");
    db.run("INSERT INTO knowledge_receipts(operation_id,payload_hash,result_id,revision_id) VALUES ('v17-op-1','fixture-hash-1','v17-item','v17-formulation-1'),('v17-op-2','fixture-hash-2','v17-item','v17-formulation-2')");
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    before = projections.map((sql) => db.query(sql).all());
  } finally { db.close(); }

  const migrated = openDatabase(databasePath);
  try {
    expect(migrated.query<{ name: string }, []>("PRAGMA table_info(knowledge_items)").all().map((column) => column.name)).toContain("created_at");
    expect(migrated.query("SELECT created_at FROM knowledge_items WHERE id='v17-item'").get()).toEqual({ created_at: null });
    expect(projections.map((sql) => migrated.query(sql).all())).toEqual(before);
    expect(migrated.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { migrated.close(); }
  const clock = spyOn(Date, "now").mockReturnValue(Date.parse("2032-03-04T05:06:07.000Z"));
  try {
    const created = new KnowledgeService(databasePath).createItem({ actor: "ai", operationId: "post-migration-operation", runId: "fixture-run" },
      { kind: "interpretation", sourceId: "v17-source", text: "New fixture reading", evidenceSourceIds: ["v17-source"] });
    const read = new Database(databasePath, { readonly: true });
    try { expect(read.query("SELECT created_at FROM knowledge_items WHERE id=?").get(created.id)).toEqual({ created_at: "2032-03-04T05:06:07.000Z" }); }
    finally { read.close(); }
  } finally { clock.mockRestore(); }
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "thoughtloom-recent-")); directories.push(directory);
  const databasePath = join(directory, "test.sqlite"), app = createApp({ databasePath });
  const db = openDatabase(databasePath);
  // Reconstructed old capture: fixture-owned date, not the machine clock.
  try {
    db.run("INSERT INTO sources(id,text,provenance,created_at) VALUES ('old-source','Old source retained exactly','fixture','2001-01-01T00:00:00.000Z')");
    db.run("INSERT INTO source_search(source_id,text) VALUES ('old-source','Old source retained exactly')");
    db.run("INSERT INTO jobs(id,source_id,status,kind) VALUES ('old-job','old-source','completed','capture')");
  } finally { db.close(); }
  return { databasePath, app, knowledge: new KnowledgeService(databasePath), root: "old-source" };
}
async function capture(f: Awaited<ReturnType<typeof fixture>>, key: string) {
  const response = await f.app.request("/captures", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify({ text: `Fresh original ${key}`, provenance: "fixture" }) });
  expect(response.status).toBe(201); return await response.json() as { id: string; text: string; createdAt: string };
}
function item(f: Awaited<ReturnType<typeof fixture>>, key: string, sourceId = f.root) {
  return f.knowledge.createItem({ actor: "ai", operationId: `create-${key}`, runId: "fixture-run" }, { kind: "interpretation", sourceId, text: `Reading ${key}`, evidenceSourceIds: [sourceId] });
}
async function idea(f: Awaited<ReturnType<typeof fixture>>) {
  const service = new DialogueService(f.databasePath), dialogue = service.create(f.root, { selection: { kind: "source", id: f.root } }, "fixture-dialogue");
  const turn = service.submit(dialogue.id, "fixture-turn", { text: "Fixture user turn" }).receipt;
  const worker = new WeavingWorker({ databasePath: f.databasePath, adapter: { async prepareSession() {}, async admit() { return { kind: "admitted" }; }, async inspect() { return { kind: "pending" }; } } });
  const started = await worker.startNext();
  if (started.kind !== "started" || started.run.jobId !== turn.jobId) throw new Error("Expected fixture dialogue run");
  const result = f.knowledge.recordIdea({ actor: "ai", operationId: "fixture-idea", runId: started.run.runId }, { rootSourceId: f.root, turnSourceId: turn.sourceId, dialogueId: dialogue.id, turnId: turn.id, text: "New idea on old source", evidenceSourceIds: [f.root, turn.sourceId] });
  await worker.close(); return { result, turn };
}

test("recent read model returns bounded capture and current item identities with actual authorship", async () => {
  const f = await fixture(), original = await capture(f, "recent"), reading = item(f, "corrected");
  const corrected = f.knowledge.reviseItem({ actor: "user", operationId: "fixture-user-revision" }, { itemId: reading.id, expectedVersionId: reading.current.id, text: "My corrected reading", evidenceSourceIds: [f.root] });
  const response = await f.app.request("/springboard/recent?limit=2");
  expect(response.status).toBe(200);
  const data: unknown = await response.json();
  if (typeof data !== "object" || data === null || !("items" in data) || !Array.isArray(data.items)) throw new Error("Missing bounded items");
  expect(data.items).toHaveLength(2);
  expect(data).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ kind: "source", id: original.id, sourceId: original.id, author: "user", excerpt: original.text }),
    expect.objectContaining({ kind: "interpretation", id: corrected.id, sourceId: f.root, versionId: corrected.current.id, author: "user", excerpt: corrected.current.text })]) });
});

test("recent ordering is bounded, newest first and stable for equal creation times", async () => {
  const f = await fixture(), db = new Database(f.databasePath);
  try {
    for (const [id, date] of [["fixture-tie-a", "2030-01-01T00:00:00.000Z"], ["fixture-tie-b", "2030-01-01T00:00:00.000Z"], ["fixture-earlier", "2020-01-01T00:00:00.000Z"]]) {
      db.run("INSERT INTO sources(id,text,provenance,created_at) VALUES (?,?,?,?)", [id, `Text ${id}`, "fixture", date]);
    }
  } finally { db.close(); }
  const first = await f.app.request("/springboard/recent?limit=2"); expect(first.status).toBe(200);
  const body: unknown = await first.json();
  if (typeof body !== "object" || body === null || !("items" in body) || !Array.isArray(body.items)) throw new Error("Missing bounded items");
  expect(body.items).toHaveLength(2);
  expect(body.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: "fixture-tie-a", createdAt: "2030-01-01T00:00:00.000Z" }), expect.objectContaining({ id: "fixture-tie-b", createdAt: "2030-01-01T00:00:00.000Z" })]));
  const second = await f.app.request("/springboard/recent?limit=2"); expect(await second.json()).toEqual(body);
});

test("the springboard endpoint remains behind the existing hostile-host boundary", async () => {
  const f = await fixture();
  const response = await f.app.request("http://127.0.0.1/springboard/recent?limit=2", { headers: { host: "attacker.example" } });
  expect(response.status).toBe(403);
  expect(await response.text()).not.toContain("Old source retained exactly");
});

test("new idea on an old source has a service-owned immutable creation time and excludes its discussion input", async () => {
  const f = await fixture();
  const clock = spyOn(Date, "now").mockReturnValue(Date.parse("2030-02-03T04:05:06.000Z"));
  try {
    const { result, turn } = await idea(f);
    const db = new Database(f.databasePath, { readonly: true });
    try { expect(db.query<{ name: string }, []>("PRAGMA table_info(knowledge_items)").all().map((column) => column.name)).toContain("created_at"); }
    finally { db.close(); }
    const writable = new Database(f.databasePath);
    try { expect(() => writable.run("UPDATE knowledge_items SET created_at='2040-01-01T00:00:00.000Z' WHERE id=?", [result.id])).toThrow(); }
    finally { writable.close(); }
    const response = await f.app.request("/springboard/recent?limit=10"); expect(response.status).toBe(200);
    const data: unknown = await response.json();
    expect(data).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ kind: "developing-idea", id: result.id, sourceId: f.root, versionId: result.current.id, createdAt: "2030-02-03T04:05:06.000Z" })]) });
    expect(JSON.stringify(data)).not.toContain(turn.sourceId);
    clock.mockReturnValue(Date.parse("2040-01-01T00:00:00.000Z"));
    f.knowledge.reviseItem({ actor: "ai", operationId: "fixture-idea-revision", runId: "fixture-run" }, { itemId: result.id, expectedVersionId: result.current.id, text: "Later idea formulation", evidenceSourceIds: [f.root] });
    const revised = await (await f.app.request("/springboard/recent?limit=10")).json();
    expect(revised).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ id: result.id, createdAt: "2030-02-03T04:05:06.000Z", excerpt: "Later idea formulation" })]) });
  } finally { clock.mockRestore(); }
});

test("legacy unknown creation dates stay unknown and absent from recent while inquiry remains available", async () => {
  const f = await fixture(), db = new Database(f.databasePath);
  // Reconstructed legacy row omits a creation date rather than inventing one.
  try {
    db.run("INSERT INTO knowledge_items(id,kind,source_id) VALUES ('legacy-item','interpretation',?)", [f.root]);
    db.run("INSERT INTO formulations(id,item_id,text,author,operation_id) VALUES ('legacy-version','legacy-item','Legacy preserved','ai','legacy-operation')");
    db.run("INSERT INTO formulation_evidence(formulation_id,source_id,position) VALUES ('legacy-version',?,0)", [f.root]);
  } finally { db.close(); }
  const inquiry = await f.app.request(`/sources/${f.root}/inquiry`); expect(inquiry.status).toBe(200);
  expect(parseInquiryView(await inquiry.json())?.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: "legacy-item", current: expect.objectContaining({ text: "Legacy preserved" }) })]));
  const response = await f.app.request("/springboard/recent?limit=10"); expect(response.status).toBe(200);
  expect(JSON.stringify(await response.json())).not.toContain("legacy-item");
  const read = new Database(f.databasePath, { readonly: true });
  try { expect(read.query("SELECT created_at FROM knowledge_items WHERE id='legacy-item'").get()).toEqual({ created_at: null }); }
  finally { read.close(); }
});

test("targeted inquiry resolves the sampled old formulation beyond the ordinary bounded item window", async () => {
  const f = await fixture();
  for (let n = 0; n < INQUIRY_LIMITS.rootItems; n++) item(f, `earlier-${n}`);
  const target = item(f, "outside-window"), sampled = target.current;
  const updated = f.knowledge.reviseItem({ actor: "user", operationId: "target-update" }, { itemId: target.id, expectedVersionId: sampled.id, text: "Later current formulation", evidenceSourceIds: [f.root] });
  const ordinary = parseInquiryView(await (await f.app.request(`/sources/${f.root}/inquiry`)).json());
  expect(ordinary?.items.some((entry) => entry.id === target.id)).toBe(false);
  const response = await f.app.request(`/sources/${f.root}/inquiry?itemId=${target.id}&versionId=${sampled.id}`); expect(response.status).toBe(200);
  const body: unknown = await response.json();
  expect(body).toMatchObject({ selectedTarget: { kind: "item", id: target.id, versionId: sampled.id, text: sampled.text } });
  const parsed = parseInquiryView(body); expect(parsed).not.toBeNull();
  expect(parsed?.items.length).toBeLessThanOrEqual(INQUIRY_LIMITS.rootItems);
  expect(parsed?.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: target.id, current: expect.objectContaining({ id: updated.current.id }), history: expect.arrayContaining([expect.objectContaining({ id: sampled.id })]) })]));
  expect(parsed?.evidenceSources).toEqual(expect.arrayContaining([expect.objectContaining({ id: f.root })]));
});

test("invalid target IDs, version association and root never silently fall back to the original", async () => {
  const f = await fixture(), other = await capture(f, "other"), first = item(f, "first"), second = item(f, "other", other.id);
  for (const [root, id, version] of [[f.root, "missing-item", first.current.id], [f.root, first.id, "missing-version"], [f.root, first.id, second.current.id], [f.root, second.id, second.current.id]]) {
    const response = await f.app.request(`/sources/${root}/inquiry?itemId=${id}&versionId=${version}`);
    expect([400, 404, 409, 422]).toContain(response.status);
  }
});
