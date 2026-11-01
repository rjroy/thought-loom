import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { OpenCode } from "@opencode/client";
import { Service } from "@opencode/client/service";
import { createApp } from "../src/app";
import { createMaintainedClient, NativeWeavingAdapter } from "../src/native-adapter";
import { WeavingWorker } from "../src/weaving";
import { nativePermissions, parseNativeCommand } from "../src/native-profile";
import { createToolApp } from "../src/tool-boundary";
import { KnowledgeService } from "../src/knowledge";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

test("capability legacy command decoder retains only explicitly saved baseline permissions", () => {
  const command = { text: "fixture", location: "/fixture/location", agent: "weaver", model: { providerID: "fixture", id: "model", variant: "default" }, permissions: nativePermissions(["read_source", "record_interpretation"]) };
  expect(parseNativeCommand(command)).toMatchObject({ profile: { version: 1, actions: ["read_source", "record_interpretation"], capability: null } });
  expect(parseNativeCommand({ ...command, permissions: [...command.permissions, { action: "unknown_future_action", effect: "allow", resource: "*" }] })).toBeNull();
  expect(parseNativeCommand({ ...command, permissions: nativePermissions(["read_source", "record_title_v1"]) })).toBeNull();
});

type CapabilityFixture = "valid" | "title" | "title-wrong-build" | "title-stale-nonce" | "hold" | "wrong-nonce" | "wrong-protocol" | "wrong-directory" | "wrong-pid" | "wrong-build" | "duplicate-actions" | "unknown-action" | "missing-actions" | "wrong-envelope";
async function fixture(promptStatus = 200, capabilityStatus = 200, capabilityFixture: CapabilityFixture = "valid", readTools = false) {
  const dir = await mkdtemp(join(tmpdir(), "thoughtloom-admission-http-")); directories.push(dir);
  const databasePath = join(dir, "test.sqlite"), registrationFile = join(dir, "registration.json");
  const requests: Array<{ path: string; method: string }> = [];
  const capabilityRequests: Array<{ url: string; body: unknown }> = [];
  let session: Record<string, unknown> = {};
  let sessionReads = 0, onSessionRead: (count: number) => void = () => {};
  let entered = () => {}, release = () => {};
  const promptEntered = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let capabilityEntered = () => {}, releaseCapability = () => {};
  const capabilityStarted = new Promise<void>((resolve) => { capabilityEntered = resolve; });
  const capabilityGate = new Promise<void>((resolve) => { releaseCapability = resolve; });
  let mode = capabilityFixture;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const path = new URL(req.url).pathname; requests.push({ path, method: req.method });
    if (path === "/api/info") return Response.json({ version: "2.2.2", pid: 42 });
    if (path === "/api/plugin") return Response.json({ data: [{ id: "thoughtloom", state: { status: "active" } }] });
    if (path === "/api/rpc/thoughtloom.capabilities/inspect") {
      const body: unknown = await req.json(); capabilityRequests.push({ url: req.url, body });
      capabilityEntered(); if (mode === "hold") await capabilityGate;
      if (capabilityStatus !== 200) return new Response("fixture capability unavailable", { status: capabilityStatus });
      const nonce = typeof body === "object" && body !== null && "input" in body && typeof body.input === "object" && body.input !== null && "nonce" in body.input ? body.input.nonce : null;
      const output = { protocol: mode === "wrong-protocol" ? 2 : 1, nonce: mode === "wrong-nonce" || mode === "title-stale-nonce" ? "wrong-nonce" : nonce,
        buildId: mode === "wrong-build" || mode === "title-wrong-build" ? "other-build" : "fixture-reviewed-build", setupId: "fixture-setup",
        nativePid: mode === "wrong-pid" ? 99 : 42, directory: mode === "wrong-directory" ? "/fixture-other-location" : dir,
        actions: mode === "duplicate-actions" ? ["read_source", "read_source"] : mode === "unknown-action" ? ["unrecognized_action"] : mode.startsWith("title") ? ["read_source", "record_title_v1"] : ["read_source"] };
      if (mode === "missing-actions") { const { actions: _actions, ...withoutActions } = output; return Response.json({ output: withoutActions }); }
      return Response.json(mode === "wrong-envelope" ? { data: output } : { output });
    }
    if (path === "/api/session" && req.method === "POST") { session = { ...await req.json() as Record<string, unknown>, projectID: "project_fixture", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 } }; return Response.json({ data: session }); }
    if (/^\/api\/session\/[^/]+$/.test(path)) { onSessionRead(++sessionReads); return Response.json({ data: session }); }
    if (path.endsWith("/prompt")) {
      const body = await req.json() as { id: string; text: string };
      entered(); await gate;
      if (promptStatus !== 200) return new Response("fixture-secret-do-not-log", { status: promptStatus });
      return Response.json({ data: { id: body.id, sessionID: session.id, payload: { text: body.text } } });
    }
    if (path === "/api/session/active") return Response.json({});
    if (path.endsWith("/inbox")) return Response.json([]);
    if (path.endsWith("/message")) return Response.json({ data: [] });
    return new Response("fixture route missing", { status: 404 });
  } });
  const url = `http://127.0.0.1:${server.port}`;
  await writeFile(registrationFile, JSON.stringify({ url, version: "2.2.2", pid: 42, password: "fixture-only" }), { mode: 0o600 });
  const app = createApp({ databasePath });
  expect((await app.request("/captures", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "deadline-source" }, body: JSON.stringify({ text: "Test-owned source", provenance: "manual" }) })).status).toBe(201);
  const options = { databasePath, registrationFile, location: dir, agent: "weaver", model: { providerID: "fixture", id: "fixture" }, admissionTimeoutMs: 15_000, dialogueOperations: ["record_idea" as const], ...(readTools ? { operations: ["read_source" as const, "read_item" as const, "record_interpretation" as const] } : {}) };
  const makeClient = (path = databasePath) => createMaintainedClient({ ...options, databasePath: path }, { async discover() { return { url, auth: { type: "basic", username: "fixture", password: "fixture-only" } }; }, headers: Service.headers, make: OpenCode.make, expectedCapabilityBuildId: "fixture-reviewed-build" });
  const client = makeClient();
  const adapter = new NativeWeavingAdapter({ ...options, client });
  return { server, adapter, app, databasePath, requests, capabilityRequests, capabilityStarted, releaseCapability, directory: dir, registrationFile, makeClient, setCapability: (value: CapabilityFixture) => { mode = value; }, promptEntered, release, onSessionRead: (handler: (count: number) => void) => { onSessionRead = handler; } };
}

for (const kind of ["source", "item"] as const) {
  test(`agent read_${kind} exposes title head and effective user override`, async () => {
    const f = await fixture(200, 200, "title", true);
    const db = new Database(f.databasePath, { readonly: true });
    let pending: Promise<unknown> | undefined;
    try {
      const source = db.query<{ id: string; text: string }, []>("SELECT id,text FROM sources").get();
      if (!source) throw new Error("Missing fixture source");
      const item = new KnowledgeService(f.databasePath).createItem({ actor: "ai", operationId: "read-title-item", runId: "fixture-seed" }, { kind: "interpretation", sourceId: source.id, text: "Fixture formulation", evidenceSourceIds: [source.id] });
      const target = kind === "source" ? { kind: "source" as const } : { kind: "item" as const, itemId: item.id, versionId: item.current.id };
      const edited = await f.app.request(`/sources/${source.id}/title`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": `read-title-${kind}` }, body: JSON.stringify({ target, text: "User protected label", expectedTitleRevisionId: null }) });
      expect(edited.status).toBe(200);
      const user: unknown = await edited.json();
      if (typeof user !== "object" || user === null || !("revisionId" in user) || typeof user.revisionId !== "string") throw new Error("Missing title revision");
      pending = new WeavingWorker({ databasePath: f.databasePath, adapter: f.adapter }).startNext();
      await Promise.race([f.promptEntered, pending.then(() => { throw new Error("Missing fixture prompt"); })]);
      const run = db.query<{ sessionId: string }, []>("SELECT session_id AS sessionId FROM weaving_runs").get(); if (!run) throw new Error("Missing run");
      const native = { sessionID: run.sessionId, agent: "weaver", messageID: "msg_read_title", callID: "call_read_title" };
      const tools = createToolApp({ databasePath: f.databasePath, transportCredential: "fixture-tool-credential", location: f.directory });
      const post = (path: string, body: unknown) => tools.request(path, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer fixture-tool-credential" }, body: JSON.stringify(body) });
      const generated = await post("/internal/tools/record-title-v1", { action: "record_title_v1", native: { ...native, callID: "call_generated_title" }, pluginBuildId: "fixture-reviewed-build", input: { rootSourceId: source.id, target, text: "Generated later label", expectedTitleRevisionId: user.revisionId } });
      expect(generated.status).toBe(200);
      const generatedBody: unknown = await generated.json();
      if (typeof generatedBody !== "object" || generatedBody === null || !("revisionId" in generatedBody) || typeof generatedBody.revisionId !== "string") throw new Error("Missing generated title head");
      const response = await post(`/internal/tools/read-${kind}`, { native, input: kind === "source" ? { sourceId: source.id } : { itemId: item.id } });
      expect(response.status).toBe(200);
      const result: unknown = await response.json();
      expect(result).toMatchObject({ id: kind === "source" ? source.id : item.id, ...(kind === "source" ? { text: source.text } : { sourceId: source.id, current: { id: item.current.id, text: item.current.text, author: "ai" } }), titleState: { headRevisionId: generatedBody.revisionId, title: { revisionId: user.revisionId, text: "User protected label", author: "user" } } });
    } finally { f.release(); await pending; await f.adapter.close(); f.server.stop(true); db.close(); }
  });
}

for (const kind of ["capture", "dialogue"] as const) {
  test(`${kind} title-capable prompt describes optional scoped title work`, async () => {
    const f = await fixture(200, 200, "title");
    const db = new Database(f.databasePath, { readonly: true });
    let pending: Promise<unknown> | undefined;
    try {
      if (kind === "dialogue") {
        const root = db.query<{ id: string }, []>("SELECT id FROM sources").get(); if (!root) throw new Error("Missing root");
        const opened = await f.app.request(`/sources/${root.id}/dialogues`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ selection: { kind: "source", id: root.id } }) });
        expect(opened.status).toBe(201); const dialogue: unknown = await opened.json();
        if (typeof dialogue !== "object" || dialogue === null || !("id" in dialogue) || typeof dialogue.id !== "string") throw new Error("Missing dialogue");
        const turn = await f.app.request(`/dialogues/${dialogue.id}/turns`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "title-prompt-turn" }, body: JSON.stringify({ text: "Fixture discussion" }) }); expect(turn.status).toBe(201);
      }
      pending = new WeavingWorker({ databasePath: f.databasePath, adapter: f.adapter }).startNext();
      await Promise.race([f.promptEntered, pending.then(() => { throw new Error("Missing fixture prompt"); })]);
      const row = db.query<{ payload: string }, []>("SELECT payload FROM native_commands").get(); if (!row) throw new Error("Missing frozen command");
      const command: unknown = JSON.parse(row.payload);
      if (typeof command !== "object" || command === null || !("text" in command) || typeof command.text !== "string") throw new Error("Missing command text");
      expect(command).toMatchObject({ profile: { capability: { buildId: "fixture-reviewed-build" }, actions: expect.arrayContaining(["record_title_v1"]) } });
      expect(command.text).toMatch(/record_title_v1/i);
      expect(command.text).toMatch(/(optional|not required|if useful)/i);
      expect(command.text).toMatch(/(current.{0,50}(formulation|version)|(formulation|version).{0,50}current)/i);
      expect(command.text).toMatch(/(user.{0,60}(title|label)|(title|label).{0,60}user)/i);
      expect(command.text).toMatch(/(head|expectedTitleRevisionId)/i);
      expect(command.text).toMatch(/(short|concise|brief)/i);
      expect(command.text).toMatch(/(source|root)/i);
      expect(command.text).toMatch(/(grant|scope|owned)/i);
      expect(command.text).toMatch(/(semantic|interpretation|idea|connection)/i);
      expect(f.requests.filter((entry) => entry.path.endsWith("/prompt") && entry.method === "POST")).toHaveLength(1);
    } finally { f.release(); await pending; await f.adapter.close(); f.server.stop(true); db.close(); }
  });
}

test("legacy capture prompt does not request an unavailable title tool", async () => {
  const f = await fixture(200, 404);
  const pending = new WeavingWorker({ databasePath: f.databasePath, adapter: f.adapter }).startNext();
  try {
    await Promise.race([f.promptEntered, pending.then(() => { throw new Error("Missing baseline prompt"); })]);
    const db = new Database(f.databasePath, { readonly: true });
    try {
      const row = db.query<{ payload: string }, []>("SELECT payload FROM native_commands").get(); if (!row) throw new Error("Missing baseline command");
      const command: unknown = JSON.parse(row.payload);
      if (typeof command !== "object" || command === null || !("text" in command) || typeof command.text !== "string") throw new Error("Missing command text");
      expect(command).toMatchObject({ profile: { actions: ["record_interpretation"], capability: null } });
      expect(command.text).not.toMatch(/record_title_v1/i);
    } finally { db.close(); }
  } finally { f.release(); await pending; await f.adapter.close(); f.server.stop(true); }
});

test("generated title attaches to an idea created by the owned dialogue tool", async () => {
  const f = await fixture(200, 200, "title");
  const db = new Database(f.databasePath, { readonly: true });
  let pending: Promise<unknown> | undefined;
  try {
    const root = db.query<{ id: string }, []>("SELECT id FROM sources").get();
    if (!root) throw new Error("Missing fixture root");
    const opened = await f.app.request(`/sources/${root.id}/dialogues`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ selection: { kind: "source", id: root.id } }) });
    expect(opened.status).toBe(201);
    const dialogue: unknown = await opened.json();
    if (typeof dialogue !== "object" || dialogue === null || !("id" in dialogue) || typeof dialogue.id !== "string") throw new Error("Missing dialogue");
    const submitted = await f.app.request(`/dialogues/${dialogue.id}/turns`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "fixture-title-idea-turn" }, body: JSON.stringify({ text: "A fixture discussion turn" }) });
    expect(submitted.status).toBe(201);
    const turn: unknown = await submitted.json();
    if (typeof turn !== "object" || turn === null || !("id" in turn) || typeof turn.id !== "string" || !("sourceId" in turn) || typeof turn.sourceId !== "string" || !("jobId" in turn) || typeof turn.jobId !== "string") throw new Error("Missing dialogue turn");
    pending = new WeavingWorker({ databasePath: f.databasePath, adapter: f.adapter }).startNext();
    await Promise.race([f.promptEntered, pending.then(() => { throw new Error(`Dialogue failed before prompt: ${JSON.stringify(f.requests)}`); })]);
    const run = db.query<{ sessionId: string; jobId: string; payload: string; operations: string }, []>(`SELECT r.session_id AS sessionId,r.job_id AS jobId,c.payload,g.operations FROM weaving_runs r JOIN native_commands c ON c.run_id=r.id JOIN owned_grants g ON g.run_id=r.id`).get();
    if (!run) throw new Error("Missing prepared dialogue command/grant");
    expect(run.jobId).toBe(turn.jobId);
    expect(JSON.parse(run.payload)).toMatchObject({ profile: { actions: ["record_idea", "record_title_v1"], capability: { buildId: "fixture-reviewed-build", actions: ["read_source", "record_title_v1"] } } });
    expect(JSON.parse(run.operations)).toEqual(["record_idea", "record_title_v1"]);
    const native = { sessionID: run.sessionId, agent: "weaver", messageID: "msg_fixture_idea", callID: "call_fixture_idea" };
    const tools = createToolApp({ databasePath: f.databasePath, transportCredential: "fixture-tool-credential", location: f.directory });
    const post = (path: string, body: unknown) => tools.request(path, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer fixture-tool-credential" }, body: JSON.stringify(body) });
    const created = await post("/internal/tools/record-idea", { native, input: { rootSourceId: root.id, turnSourceId: turn.sourceId, dialogueId: dialogue.id, turnId: turn.id, text: "A developed fixture idea", evidenceSourceIds: [root.id, turn.sourceId] } });
    expect(created.status).toBe(200);
    const idea: unknown = await created.json();
    if (typeof idea !== "object" || idea === null || !("id" in idea) || typeof idea.id !== "string" || !("current" in idea) || typeof idea.current !== "object" || idea.current === null || !("id" in idea.current) || typeof idea.current.id !== "string") throw new Error("Missing created idea/formulation");
    const queries = ["SELECT * FROM sources ORDER BY id", "SELECT * FROM knowledge_items ORDER BY id", "SELECT * FROM formulations ORDER BY id", "SELECT * FROM knowledge_receipts ORDER BY operation_id", "SELECT * FROM jobs ORDER BY id", "SELECT * FROM follow_up_origins ORDER BY run_id"];
    const before = queries.map((query) => db.query(query).all());
    const titled = await post("/internal/tools/record-title-v1", { action: "record_title_v1", native: { ...native, callID: "call_idea_title" }, pluginBuildId: "fixture-reviewed-build", input: { rootSourceId: root.id, target: { kind: "item", itemId: idea.id, versionId: idea.current.id }, text: "A developed idea title", expectedTitleRevisionId: null } });
    expect(titled.status).toBe(200);
    expect(db.query("SELECT text,author,formulation_id FROM title_revisions").all()).toEqual([{ text: "A developed idea title", author: "ai", formulation_id: idea.current.id }]);
    expect(queries.map((query) => db.query(query).all())).toEqual(before);
    const read = await f.app.request(`/sources/${root.id}/title?itemId=${encodeURIComponent(idea.id)}&versionId=${encodeURIComponent(idea.current.id)}`);
    expect(read.status).toBe(200); expect(await read.json()).toMatchObject({ title: { text: "A developed idea title", author: "ai" } });
  } finally { f.release(); await pending; await f.adapter.close(); f.server.stop(true); db.close(); }
});

for (const hasUserOverride of [false, true]) {
  test(`generated item title targets the current formulation${hasUserOverride ? " with a stable user override" : ""}`, async () => {
    const f = await fixture(200, 200, "title");
    const pending = new WeavingWorker({ databasePath: f.databasePath, adapter: f.adapter }).startNext();
    try {
      await Promise.race([f.promptEntered, pending.then(() => { throw new Error(`Worker failed before prompt: ${JSON.stringify(f.requests)}`); })]);
      const db = new Database(f.databasePath, { readonly: true });
      try {
        const run = db.query<{ runId: string; sessionId: string; sourceId: string; payload: string; operations: string }, []>(`SELECT r.id AS runId,r.session_id AS sessionId,j.source_id AS sourceId,c.payload,g.operations FROM weaving_runs r JOIN jobs j ON j.id=r.job_id JOIN native_commands c ON c.run_id=r.id JOIN owned_grants g ON g.run_id=r.id`).get();
        if (!run) throw new Error("Missing prepared run, command or grant");
        expect(JSON.parse(run.payload)).toMatchObject({ profile: { actions: ["record_interpretation", "record_title_v1"], capability: { buildId: "fixture-reviewed-build", actions: ["read_source", "record_title_v1"] } } });
        expect(JSON.parse(run.operations)).toEqual(["record_interpretation", "record_title_v1"]);
        const native = { sessionID: run.sessionId, agent: "weaver", messageID: "msg_fixture_item", callID: "call_create_item" };
        const tools = createToolApp({ databasePath: f.databasePath, transportCredential: "fixture-tool-credential", location: f.directory });
        const post = (path: string, body: unknown) => tools.request(path, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer fixture-tool-credential" }, body: JSON.stringify(body) });
        const created = await post("/internal/tools/record-interpretation", { native, input: { sourceId: run.sourceId, text: "Original AI formulation", evidenceSourceIds: [run.sourceId] } });
        expect(created.status).toBe(200);
        const item: unknown = await created.json();
        if (typeof item !== "object" || item === null || !("id" in item) || typeof item.id !== "string" || !("current" in item) || typeof item.current !== "object" || item.current === null || !("id" in item.current) || typeof item.current.id !== "string") throw new Error("Missing created item/formulation");
        const itemId = item.id, versionId = item.current.id;
        const second = await post("/internal/tools/record-interpretation", { native: { ...native, callID: "call_create_other_item" }, input: { sourceId: run.sourceId, text: "Another AI formulation", evidenceSourceIds: [run.sourceId] } });
        expect(second.status).toBe(200);
        const otherItem: unknown = await second.json();
        if (typeof otherItem !== "object" || otherItem === null || !("id" in otherItem) || typeof otherItem.id !== "string") throw new Error("Missing second item");
        const captured = await f.app.request("/captures", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "fixture-other-title-root" }, body: JSON.stringify({ text: "A distinct root", provenance: "fixture" }) });
        expect(captured.status).toBe(201);
        const otherSource: unknown = await captured.json();
        if (typeof otherSource !== "object" || otherSource === null || !("id" in otherSource) || typeof otherSource.id !== "string") throw new Error("Missing second root");
        const target = { kind: "item" as const, itemId, versionId };
        let head: string | null = null;
        if (hasUserOverride) {
          const edited = await f.app.request(`/sources/${run.sourceId}/title`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "fixture-item-user-title" }, body: JSON.stringify({ target, text: "My item label", expectedTitleRevisionId: null }) });
          expect(edited.status).toBe(200);
          const body: unknown = await edited.json();
          if (typeof body !== "object" || body === null || !("revisionId" in body) || typeof body.revisionId !== "string") throw new Error("Missing user revision");
          head = body.revisionId;
        }
        const envelope = { action: "record_title_v1", native: { ...native, callID: "call_item_title" }, pluginBuildId: "fixture-reviewed-build", input: { rootSourceId: run.sourceId, target, text: "AI formulation label", expectedTitleRevisionId: head } };
        const titlePost = (body: unknown) => post("/internal/tools/record-title-v1", body);
        const immutable = ["SELECT * FROM sources ORDER BY id", "SELECT * FROM knowledge_items ORDER BY id", "SELECT * FROM formulations ORDER BY id", "SELECT * FROM knowledge_receipts ORDER BY operation_id", "SELECT * FROM jobs ORDER BY id", "SELECT * FROM follow_up_origins ORDER BY run_id"];
        const before = immutable.map((query) => db.query(query).all());
        const titleBefore = db.query("SELECT * FROM title_revisions ORDER BY rowid").all();
        for (const input of [
          { ...envelope.input, rootSourceId: otherSource.id },
          { ...envelope.input, target: { ...target, itemId: otherItem.id } },
          { ...envelope.input, target: { ...target, versionId: "other-version" } },
        ]) {
          const rejected = await titlePost({ ...envelope, native: { ...native, callID: `call_invalid_${crypto.randomUUID()}` }, input });
          expect([400, 403, 409]).toContain(rejected.status);
          expect(db.query("SELECT * FROM title_revisions ORDER BY rowid").all()).toEqual(titleBefore);
        }
        const first = await titlePost(envelope); expect(first.status).toBe(200);
        const saved: unknown = await first.json();
        if (typeof saved !== "object" || saved === null || !("revisionId" in saved) || typeof saved.revisionId !== "string") throw new Error("Missing generated title revision");
        const replay = await titlePost(envelope); expect(replay.status).toBe(200); expect(await replay.json()).toEqual(saved);
        const conflicting = await titlePost({ ...envelope, input: { ...envelope.input, target: { ...target, versionId: "other-version" } } });
        expect(conflicting.status).toBe(409);
        expect(db.query("SELECT text,author,formulation_id FROM title_revisions ORDER BY rowid").all()).toHaveLength(hasUserOverride ? 2 : 1);
        expect(db.query("SELECT text,author,formulation_id FROM title_revisions ORDER BY rowid").all().at(-1)).toEqual({ text: "AI formulation label", author: "ai", formulation_id: versionId });
        expect(immutable.map((query) => db.query(query).all())).toEqual(before);
        const readVersion = async (id: string) => {
          const response = await f.app.request(`/sources/${run.sourceId}/title?itemId=${encodeURIComponent(itemId)}&versionId=${encodeURIComponent(id)}`);
          expect(response.status).toBe(200); return response.json();
        };
        expect(await readVersion(versionId)).toMatchObject({ title: hasUserOverride ? { text: "My item label", author: "user" } : { text: "AI formulation label", author: "ai" } });
        const knowledge = new KnowledgeService(f.databasePath);
        const revised = knowledge.reviseItem({ actor: "ai", operationId: "fixture-new-formulation", runId: run.runId }, { itemId, expectedVersionId: versionId, text: "A newer AI formulation", evidenceSourceIds: [run.sourceId] });
        expect(await readVersion(revised.current.id)).toMatchObject({ title: hasUserOverride ? { text: "My item label", author: "user" } : null });
        expect(await readVersion(versionId)).toMatchObject({ title: hasUserOverride ? { text: "My item label", author: "user" } : { text: "AI formulation label", author: "ai" } });
        if (!hasUserOverride) {
          const revisionsBeforeReplay = db.query("SELECT * FROM title_revisions ORDER BY rowid").all();
          const oldReplay = await titlePost(envelope);
          expect(oldReplay.status).toBe(200); expect(await oldReplay.json()).toEqual(saved);
          expect(db.query("SELECT * FROM title_revisions ORDER BY rowid").all()).toEqual(revisionsBeforeReplay);
        }
        const stale = await titlePost({ ...envelope, native: { ...native, callID: "call_stale_formulation" }, input: { ...envelope.input, expectedTitleRevisionId: saved.revisionId } });
        expect(stale.status).toBe(409);
        expect(db.query("SELECT text,author,formulation_id FROM title_revisions ORDER BY rowid").all()).toHaveLength(hasUserOverride ? 2 : 1);
        if (!hasUserOverride) {
          const next = await titlePost({ ...envelope, native: { ...native, callID: "call_new_version_title" }, input: { ...envelope.input, target: { ...target, versionId: revised.current.id }, text: "Second formulation label", expectedTitleRevisionId: saved.revisionId } });
          expect(next.status).toBe(200);
          const nextTitle: unknown = await next.json();
          if (typeof nextTitle !== "object" || nextTitle === null || !("revisionId" in nextTitle) || typeof nextTitle.revisionId !== "string") throw new Error("Missing second generated revision");
          expect(await readVersion(versionId)).toMatchObject({ headRevisionId: nextTitle.revisionId, title: { revisionId: saved.revisionId, text: "AI formulation label", author: "ai" } });
          expect(await readVersion(revised.current.id)).toMatchObject({ headRevisionId: nextTitle.revisionId, title: { revisionId: nextTitle.revisionId, text: "Second formulation label", author: "ai" } });
          expect(db.query("SELECT text,author,formulation_id FROM title_revisions ORDER BY rowid").all()).toEqual([
            { text: "AI formulation label", author: "ai", formulation_id: versionId },
            { text: "Second formulation label", author: "ai", formulation_id: revised.current.id },
          ]);
        }
      } finally { db.close(); }
    } finally { f.release(); await pending; await f.adapter.close(); f.server.stop(true); }
  });
}

for (const hasUserOverride of [false, true]) {
  test(`authorized generated source title is idempotent and preserves ${hasUserOverride ? "user override" : "thought and semantic state"}`, async () => {
    const f = await fixture(200, 200, "title");
    const sourceDb = new Database(f.databasePath, { readonly: true });
    let sourceId: string;
    try {
      const source = sourceDb.query<{ id: string }, []>("SELECT id FROM sources").get();
      if (!source) throw new Error("Missing fixture source");
      sourceId = source.id;
    } finally { sourceDb.close(); }
    let userRevision: string | null = null;
    if (hasUserOverride) {
      const edited = await f.app.request(`/sources/${sourceId}/title`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "fixture-user-title" }, body: JSON.stringify({ target: { kind: "source" }, text: "My own title", expectedTitleRevisionId: null }) });
      expect(edited.status).toBe(200);
      const body: unknown = await edited.json();
      if (typeof body !== "object" || body === null || !("revisionId" in body) || typeof body.revisionId !== "string") throw new Error("Missing user title revision");
      userRevision = body.revisionId;
    }
    const pending = new WeavingWorker({ databasePath: f.databasePath, adapter: f.adapter }).startNext();
    try {
      await Promise.race([f.promptEntered, pending.then(() => { throw new Error(`Worker failed before prompt: ${JSON.stringify(f.requests)}`); })]);
      const db = new Database(f.databasePath, { readonly: true });
      try {
        const run = db.query<{ sessionId: string; payload: string; operations: string }, []>(`SELECT r.session_id AS sessionId,c.payload,g.operations FROM weaving_runs r JOIN native_commands c ON c.run_id=r.id JOIN owned_grants g ON g.run_id=r.id`).get();
        if (!run) throw new Error("Missing real prepared command and owned grant");
        expect(JSON.parse(run.payload)).toMatchObject({ profile: { actions: ["record_interpretation", "record_title_v1"], capability: { buildId: "fixture-reviewed-build", actions: ["read_source", "record_title_v1"] } } });
        expect(JSON.parse(run.operations)).toEqual(["record_interpretation", "record_title_v1"]);
        const native = { sessionID: run.sessionId, agent: "weaver", messageID: "msg_fixture_title", callID: "call_fixture_title" };
        const input = { rootSourceId: sourceId, target: { kind: "source" }, text: "Generated orchard title", expectedTitleRevisionId: userRevision };
        const tools = createToolApp({ databasePath: f.databasePath, transportCredential: "fixture-tool-credential", location: f.directory });
        const post = (body: unknown) => tools.request("/internal/tools/record-title-v1", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer fixture-tool-credential" }, body: JSON.stringify(body) });
        const envelope = { action: "record_title_v1", native, input, pluginBuildId: "fixture-reviewed-build" };
        const unchanged = ["SELECT * FROM sources ORDER BY id", "SELECT * FROM knowledge_items ORDER BY id", "SELECT * FROM formulations ORDER BY id", "SELECT * FROM knowledge_receipts ORDER BY operation_id", "SELECT * FROM jobs ORDER BY id", "SELECT * FROM follow_up_origins ORDER BY run_id"];
        const before = unchanged.map((query) => db.query(query).all());
        const titleBefore = db.query("SELECT * FROM title_revisions ORDER BY rowid").all();
        const spoof = await post({ ...envelope, pluginBuildId: "other-build" });
        expect(spoof.status).toBe(403);
        expect(db.query("SELECT * FROM title_revisions ORDER BY rowid").all()).toEqual(titleBefore);
        const first = await post(envelope);
        expect(first.status).toBe(200);
        const result: unknown = await first.json();
        const replay = await post(envelope); expect(replay.status).toBe(200); expect(await replay.json()).toEqual(result);
        const conflict = await post({ ...envelope, input: { ...input, text: "Different title" } }); expect(conflict.status).toBe(409);
        const revisions = db.query<{ text: string; author: string; formulation_id: string | null }, []>("SELECT text,author,formulation_id FROM title_revisions ORDER BY rowid").all();
        expect(revisions).toHaveLength(hasUserOverride ? 2 : 1);
        expect(revisions.at(-1)).toEqual({ text: input.text, author: "ai", formulation_id: null });
        expect(unchanged.map((query) => db.query(query).all())).toEqual(before);
        const read = await f.app.request(`/sources/${sourceId}/title`); expect(read.status).toBe(200);
        expect(await read.json()).toMatchObject({ title: hasUserOverride ? { text: "My own title", author: "user", revisionId: userRevision } : { text: input.text, author: "ai" } });
        const stale = await post({ ...envelope, native: { ...native, callID: "call_stale_title" }, input: { ...input, text: "Stale generated title" } });
        expect(stale.status).toBe(409);
        expect(db.query("SELECT * FROM title_revisions ORDER BY rowid").all()).toHaveLength(hasUserOverride ? 2 : 1);
      } finally { db.close(); }
    } finally { f.release(); await pending; await f.adapter.close(); f.server.stop(true); }
  });
}

test("accepted title capability freezes title permission into a new command and owned grant", async () => {
  const f = await fixture(200, 200, "title");
  const pending = new WeavingWorker({ databasePath: f.databasePath, adapter: f.adapter }).startNext();
  try {
    await Promise.race([f.promptEntered, pending.then(() => { throw new Error(`Worker failed before prompt: ${JSON.stringify(f.requests)}`); })]);
    expect(f.capabilityRequests).toHaveLength(1);
    const db = new Database(f.databasePath, { readonly: true });
    try {
      const row = db.query<{ payload: string; payload_hash: string }, []>("SELECT payload,payload_hash FROM native_commands").get();
      const grant = db.query<{ operations: string }, []>("SELECT operations FROM owned_grants").get();
      if (!row || !grant) throw new Error("Missing frozen command or grant");
      const command: unknown = JSON.parse(row.payload);
      expect(command).toMatchObject({ profile: { version: 1, actions: ["record_interpretation", "record_title_v1"], capability: { buildId: "fixture-reviewed-build", setupId: "fixture-setup", nativePid: 42, directory: f.directory, actions: ["read_source", "record_title_v1"] } } });
      expect(command).toMatchObject({ permissions: expect.arrayContaining([{ action: "record_title_v1", resource: "*", effect: "allow" }]) });
      expect(JSON.parse(grant.operations)).toEqual(["record_interpretation", "record_title_v1"]);
      expect(row.payload_hash).toBe(createHash("sha256").update(row.payload, "utf8").digest("hex"));
    } finally { db.close(); }
    f.release(); expect((await pending).kind).toBe("started");
    expect(f.requests.filter((entry) => entry.path.endsWith("/prompt") && entry.method === "POST")).toHaveLength(1);
  } finally { f.release(); await pending; await f.adapter.close(); f.server.stop(true); }
});

for (const mode of ["title-wrong-build", "title-stale-nonce"] as const) {
  test(`${mode} cannot grant the advertised title action`, async () => {
    const f = await fixture(200, 200, mode);
    const pending = new WeavingWorker({ databasePath: f.databasePath, adapter: f.adapter }).startNext();
    try {
      await Promise.race([f.promptEntered, pending.then(() => { throw new Error(`Baseline failed before prompt: ${JSON.stringify(f.requests)}`); })]);
      const db = new Database(f.databasePath, { readonly: true });
      try {
        const command = db.query<{ payload: string }, []>("SELECT payload FROM native_commands").get();
        const grant = db.query<{ operations: string }, []>("SELECT operations FROM owned_grants").get();
        if (!command || !grant) throw new Error("Missing baseline command or grant");
        expect(JSON.parse(command.payload)).toMatchObject({ profile: { actions: ["record_interpretation"], capability: null } });
        expect(JSON.parse(grant.operations)).toEqual(["record_interpretation"]);
      } finally { db.close(); }
      f.release(); expect((await pending).kind).toBe("started");
      expect(f.requests.filter((entry) => entry.path.endsWith("/prompt") && entry.method === "POST")).toHaveLength(1);
    } finally { f.release(); await pending; await f.adapter.close(); f.server.stop(true); }
  });
}

test("real SDK performs a fresh location-scoped capability RPC before admission without blocking baseline", async () => {
  const timers: number[] = [];
  const timeout = spyOn(AbortSignal, "timeout").mockImplementation((ms) => { timers.push(ms); return new AbortController().signal; });
  const f = await fixture();
  const pending = new WeavingWorker({ databasePath: f.databasePath, adapter: f.adapter }).startNext();
  try {
    await Promise.race([f.promptEntered, pending.then(() => { throw new Error(`Worker failed before fake HTTP prompt: ${JSON.stringify(f.requests)}`); })]);
    expect(f.capabilityRequests).toHaveLength(1);
    const probeIndex = f.requests.findIndex((entry) => entry.path === "/api/rpc/thoughtloom.capabilities/inspect" && entry.method === "POST");
    const sessionIndex = f.requests.findIndex((entry) => entry.path === "/api/session" && entry.method === "POST");
    const promptIndex = f.requests.findIndex((entry) => entry.path.endsWith("/prompt") && entry.method === "POST");
    expect(probeIndex).toBeGreaterThanOrEqual(0); expect(sessionIndex).toBeGreaterThan(probeIndex); expect(promptIndex).toBeGreaterThan(sessionIndex);
    const rpc = f.capabilityRequests[0]; if (!rpc) throw new Error("Missing capability request");
    expect(new URL(rpc.url).searchParams.get("location[directory]")).toBe(f.directory);
    expect(rpc.body).toMatchObject({ input: { nonce: expect.any(String) } });
    expect(timers.slice(0, -1)).toContain(5_000);
    const db = new Database(f.databasePath, { readonly: true });
    try {
      const row = db.query<{ payload: string }, []>("SELECT payload FROM native_commands").get();
      if (!row) throw new Error("Missing immutable native command");
      const command: unknown = JSON.parse(row.payload);
      expect(command).toMatchObject({ profile: { version: 1, actions: ["record_interpretation"], capability: { protocol: 1, buildId: "fixture-reviewed-build", setupId: "fixture-setup", nativePid: 42, directory: f.directory, actions: ["read_source"] } } });
      if (typeof rpc.body !== "object" || rpc.body === null || !("input" in rpc.body) || typeof rpc.body.input !== "object" || rpc.body.input === null || !("nonce" in rpc.body.input)) throw new Error("Missing RPC nonce");
      expect(command).toMatchObject({ profile: { capability: { nonce: rpc.body.input.nonce } } });
    } finally { db.close(); }
    f.release(); expect((await pending).kind).toBe("started");
    expect(f.requests.filter((entry) => entry.path.endsWith("/prompt") && entry.method === "POST")).toHaveLength(1);
  } finally { f.release(); await pending; await f.adapter.close(); f.server.stop(true); timeout.mockRestore(); }
});

test("missing capability RPC does not prevent ordinary weaving or resend its prompt", async () => {
  const f = await fixture(200, 404);
  const pending = new WeavingWorker({ databasePath: f.databasePath, adapter: f.adapter }).startNext();
  try {
    await Promise.race([f.promptEntered, pending.then(() => { throw new Error(`Baseline failed before fake HTTP prompt: ${JSON.stringify(f.requests)}`); })]);
    expect(f.capabilityRequests).toHaveLength(1);
    f.release(); expect((await pending).kind).toBe("started");
    expect(f.requests.filter((entry) => entry.path.endsWith("/prompt") && entry.method === "POST")).toHaveLength(1);
  } finally { f.release(); await pending; await f.adapter.close(); f.server.stop(true); }
});

test("capability client restart probes fresh nonce without upgrading a frozen older command or grant", async () => {
  const f = await fixture(200, 200, "wrong-build"), firstWorker = new WeavingWorker({ databasePath: f.databasePath, adapter: f.adapter });
  let secondAdapter: NativeWeavingAdapter | undefined;
  try {
    const firstPending = firstWorker.startNext();
    await Promise.race([f.promptEntered, firstPending.then(() => { throw new Error("Old run did not reach prompt"); })]);
    f.release(); const firstResult = await firstPending; expect(firstResult.kind).toBe("started");
    if (firstResult.kind !== "started") throw new Error("Missing frozen run");
    const oldDb = new Database(f.databasePath, { readonly: true });
    let command: unknown, grant: unknown;
    try {
      command = oldDb.query("SELECT payload,payload_hash FROM native_commands").get();
      grant = oldDb.query("SELECT operations,scope_hash FROM owned_grants").get();
      if (typeof command !== "object" || command === null || !("payload" in command) || typeof command.payload !== "string") throw new Error("Missing old command");
      expect(JSON.parse(command.payload)).toMatchObject({ profile: { actions: ["record_interpretation"], capability: null } });
      expect(grant).toMatchObject({ operations: JSON.stringify(["record_interpretation"]) });
    } finally { oldDb.close(); }
    expect(f.capabilityRequests).toHaveLength(1); f.setCapability("title");
    const restartedOldClient = f.makeClient();
    try {
      expect(await restartedOldClient.discover(f.registrationFile, "2.2.2")).not.toBeNull();
      await restartedOldClient.createSession(firstResult.run);
      expect(f.capabilityRequests).toHaveLength(1);
    } finally { await restartedOldClient.close?.(); }
    const secondPath = join(f.directory, "fresh-daemon.sqlite");
    const captured = await createApp({ databasePath: secondPath }).request("/captures", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "fresh-client-source" }, body: JSON.stringify({ text: "Separate controlled capture", provenance: "fixture" }) });
    expect(captured.status).toBe(201);
    secondAdapter = new NativeWeavingAdapter({ databasePath: secondPath, registrationFile: f.registrationFile, location: f.directory, agent: "weaver", model: { providerID: "fixture", id: "fixture" }, client: f.makeClient(secondPath) });
    expect((await new WeavingWorker({ databasePath: secondPath, adapter: secondAdapter }).startNext()).kind).toBe("started");
    expect(f.capabilityRequests).toHaveLength(2);
    const nonce = (request: { body: unknown }) => {
      const body = request.body;
      if (typeof body !== "object" || body === null || !("input" in body) || typeof body.input !== "object" || body.input === null || !("nonce" in body.input) || typeof body.input.nonce !== "string") throw new Error("Missing capability nonce");
      return body.input.nonce;
    };
    expect(nonce(f.capabilityRequests[0])).not.toBe(nonce(f.capabilityRequests[1]));
    const oldAgain = new Database(f.databasePath, { readonly: true });
    try { expect(oldAgain.query("SELECT payload,payload_hash FROM native_commands").get()).toEqual(command); expect(oldAgain.query("SELECT operations,scope_hash FROM owned_grants").get()).toEqual(grant); }
    finally { oldAgain.close(); }
    const newDb = new Database(secondPath, { readonly: true });
    try {
      const fresh = newDb.query<{ payload: string }, []>("SELECT payload FROM native_commands").get(); if (!fresh) throw new Error("Missing fresh command");
      expect(JSON.parse(fresh.payload)).toMatchObject({ profile: { actions: ["record_interpretation", "record_title_v1"], capability: { setupId: "fixture-setup", buildId: "fixture-reviewed-build", nativePid: 42, directory: f.directory } } });
    } finally { newDb.close(); }
  } finally { f.release(); await secondAdapter?.close(); await f.adapter.close(); f.server.stop(true); }
});

for (const mode of ["wrong-nonce", "wrong-protocol", "wrong-envelope", "wrong-directory", "wrong-pid", "wrong-build", "duplicate-actions", "unknown-action", "missing-actions"] as const) {
  test(`invalid capability ${mode} leaves baseline weaving usable`, async () => {
    const f = await fixture(200, 200, mode);
    const pending = new WeavingWorker({ databasePath: f.databasePath, adapter: f.adapter }).startNext();
    try {
      await Promise.race([f.promptEntered, pending.then(() => { throw new Error(`Baseline failed before fake HTTP prompt: ${JSON.stringify(f.requests)}`); })]);
      expect(f.capabilityRequests).toHaveLength(1);
      const db = new Database(f.databasePath, { readonly: true });
      try {
        const grant = db.query<{ operations: string }, []>("SELECT operations FROM owned_grants").get();
        expect(grant).toBeDefined(); expect(JSON.parse(grant?.operations ?? "null")).toEqual(["record_interpretation"]);
        const row = db.query<{ payload: string }, []>("SELECT payload FROM native_commands").get();
        if (!row) throw new Error("Missing baseline command");
        expect(JSON.parse(row.payload)).toMatchObject({ profile: { version: 1, actions: ["record_interpretation"], capability: null } });
      } finally { db.close(); }
      f.release(); expect((await pending).kind).toBe("started");
      expect(f.requests.filter((entry) => entry.path.endsWith("/prompt") && entry.method === "POST")).toHaveLength(1);
      const settled = new Database(f.databasePath, { readonly: true });
      try { expect(settled.query("SELECT state,attempt FROM weaving_runs").all()).toEqual([{ state: "admitted", attempt: 1 }]); }
      finally { settled.close(); }
    } finally { f.release(); await pending; await f.adapter.close(); f.server.stop(true); }
  });
}

test("capability read deadline falls back to baseline before the separate admission deadline", async () => {
  const timers: Array<{ ms: number; controller: AbortController }> = [];
  const timeout = spyOn(AbortSignal, "timeout").mockImplementation((ms) => { const controller = new AbortController(); timers.push({ ms, controller }); return controller.signal; });
  const f = await fixture(200, 200, "hold"), pending = new WeavingWorker({ databasePath: f.databasePath, adapter: f.adapter }).startNext();
  try {
    const first = await Promise.race([f.capabilityStarted.then(() => "capability"), f.promptEntered.then(() => "prompt"), pending.then(() => "settled")]);
    expect(first).toBe("capability");
    const deadline = timers.at(-1); expect(deadline?.ms).toBe(5_000); deadline?.controller.abort();
    await f.promptEntered; expect(timers.at(-1)?.ms).toBe(15_000);
    f.release(); expect((await pending).kind).toBe("started");
    expect(f.requests.filter((entry) => entry.path.endsWith("/prompt") && entry.method === "POST")).toHaveLength(1);
  } finally { f.releaseCapability(); f.release(); await pending; await f.adapter.close(); f.server.stop(true); timeout.mockRestore(); }
});

test("capability probing cannot continue admission after adapter closure", async () => {
  const f = await fixture(200, 200, "hold"), pending = new WeavingWorker({ databasePath: f.databasePath, adapter: f.adapter }).startNext();
  try {
    const first = await Promise.race([f.capabilityStarted.then(() => "capability"), f.promptEntered.then(() => "prompt"), pending.then(() => "settled")]);
    expect(first).toBe("capability");
    await f.adapter.close(); f.releaseCapability(); await pending;
    expect(f.requests.filter((entry) => entry.path.endsWith("/prompt") && entry.method === "POST")).toHaveLength(0);
  } finally { f.releaseCapability(); f.release(); await pending; await f.adapter.close(); f.server.stop(true); }
});

test("real SDK prompt uses a separate 15-second admission deadline while ordinary requests retain five seconds", async () => {
  const timers: Array<{ ms: number; controller: AbortController }> = [];
  const timeout = spyOn(AbortSignal, "timeout").mockImplementation((ms) => { const controller = new AbortController(); timers.push({ ms, controller }); return controller.signal; });
  const f = await fixture();
  const pending = new WeavingWorker({ databasePath: f.databasePath, adapter: f.adapter }).startNext();
  try {
    await Promise.race([f.promptEntered, pending.then(() => { throw new Error(`Worker failed before fake HTTP prompt: ${JSON.stringify(f.requests)}`); })]);
    expect(f.requests.filter((r) => r.path.endsWith("/prompt") && r.method === "POST")).toHaveLength(1);
    expect(timers.slice(0, -1).some((timer) => timer.ms === 5_000)).toBe(true);
    expect(timers.at(-1)?.ms).toBe(15_000);
    // Advance the old deadline only; the held prompt remains live until its own deadline.
    for (const timer of timers.filter((item) => item.ms === 5_000)) timer.controller.abort();
    f.release();
    expect((await pending).kind).toBe("started");
    const db = new Database(f.databasePath, { readonly: true });
    try { expect(db.query("SELECT state FROM weaving_runs").get()).toEqual({ state: "admitted" }); }
    finally { db.close(); }
  } finally { f.release(); await pending; await f.adapter.close(); f.server.stop(true); timeout.mockRestore(); }
});

test("admission deadline expiry remains uncertain and recovery does not resend the native prompt", async () => {
  const timers: Array<{ ms: number; controller: AbortController }> = [];
  const timeout = spyOn(AbortSignal, "timeout").mockImplementation((ms) => { const controller = new AbortController(); timers.push({ ms, controller }); return controller.signal; });
  const f = await fixture();
  const worker = new WeavingWorker({ databasePath: f.databasePath, adapter: f.adapter });
  const pending = worker.startNext();
  try {
    await Promise.race([f.promptEntered, pending.then(() => { throw new Error(`Worker failed before fake HTTP prompt: ${JSON.stringify(f.requests)}`); })]);
    const admission = timers.at(-1);
    expect(admission?.ms).toBe(15_000);
    admission?.controller.abort();
    await pending;
    f.release();
    await new WeavingWorker({ databasePath: f.databasePath, adapter: f.adapter }).recover();
    expect(f.requests.filter((r) => r.path.endsWith("/prompt") && r.method === "POST")).toHaveLength(1);
    const db = new Database(f.databasePath, { readonly: true });
    try { expect(db.query("SELECT state FROM weaving_runs").get()).toEqual({ state: "uncertain" }); }
    finally { db.close(); }
  } finally { f.release(); await pending; await f.adapter.close(); f.server.stop(true); timeout.mockRestore(); }
});

test("SDK HTTP admission failure logs only safe stage and status metadata and recovery never resubmits", async () => {
  const f = await fixture(500);
  const logs: unknown[][] = [];
  const info = spyOn(console, "info").mockImplementation((...args) => { logs.push(args); });
  const error = spyOn(console, "error").mockImplementation((...args) => { logs.push(args); });
  f.release();
  try {
    const worker = new WeavingWorker({ databasePath: f.databasePath, adapter: f.adapter });
    expect((await worker.startNext()).kind).toBe("started");
    await new WeavingWorker({ databasePath: f.databasePath, adapter: f.adapter }).recover();
    expect(f.requests.filter((r) => r.path.endsWith("/prompt") && r.method === "POST")).toHaveLength(1);
    const db = new Database(f.databasePath, { readonly: true });
    try { expect(db.query("SELECT state FROM weaving_runs").get()).toEqual({ state: "uncertain" }); }
    finally { db.close(); }
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain("fixture-secret-do-not-log");
    expect(serialized).not.toContain("Test-owned source");
    expect(serialized).not.toContain("fixture-only");
    expect(serialized).toContain("promptrequest");
    expect(serialized).toContain("500");
  } finally { info.mockRestore(); error.mockRestore(); await f.adapter.close(); f.server.stop(true); }
});

test("admission reserves the configured deadline plus settlement time against the current claim", async () => {
  const f = await fixture();
  const now = Date.now();
  const pending = new WeavingWorker({ databasePath: f.databasePath, adapter: f.adapter, leaseMs: 1_000, now: () => now }).startNext();
  try {
    await Promise.race([f.promptEntered, pending.then(() => { throw new Error(`Worker failed before fake HTTP prompt: ${JSON.stringify(f.requests)}`); })]);
    const db = new Database(f.databasePath, { readonly: true });
    try {
      const claim = db.query<{ leaseUntil: number; leaseOwner: string | null }, []>("SELECT lease_until AS leaseUntil, lease_owner AS leaseOwner FROM weaving_runs").get();
      expect(claim?.leaseOwner).toBeTruthy();
      expect(claim?.leaseUntil).toBeGreaterThanOrEqual(now + 25_000);
    } finally { db.close(); }
  } finally { f.release(); await pending; await f.adapter.close(); f.server.stop(true); }
});

test("an expired or replaced claim during ownership validation never sends the native prompt", async () => {
  for (const change of ["expired", "replaced"] as const) {
    const f = await fixture();
    f.onSessionRead((count) => {
      if (count !== 2) return;
      const db = new Database(f.databasePath);
      try { if (change === "expired") db.run("UPDATE weaving_runs SET lease_until=?", [Date.now() - 1]); else db.run("UPDATE weaving_runs SET lease_owner='fixture-replacement'"); }
      finally { db.close(); }
    });
    f.release();
    try {
      await new WeavingWorker({ databasePath: f.databasePath, adapter: f.adapter }).startNext();
      expect(f.requests.filter((r) => r.path.endsWith("/prompt") && r.method === "POST"), change).toHaveLength(0);
      const db = new Database(f.databasePath, { readonly: true });
      try { expect(db.query("SELECT attempted FROM native_commands").get()).toEqual({ attempted: 0 }); }
      finally { db.close(); }
    } finally { await f.adapter.close(); f.server.stop(true); }
  }
});
