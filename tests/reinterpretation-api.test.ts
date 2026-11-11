import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { OpenCodeAdapter } from "../src/agent/opencode-adapter";
import { RunSupervisor } from "../src/agent/supervisor";
import { RunWorker } from "../src/agent/worker";
import { SqliteAgentBindings } from "../src/storage/agent-binding";
import { SqliteStore } from "../src/storage/sqlite";
import { admitWeave } from "../src/storage/weave-admission";
import { body, bounded, mediaApiFixture, object, text, type MediaApiFixture } from "./fixtures/media-import-api";
import { insertMediaSource, mediaThought } from "./fixtures/media-source";

const stamp = "2030-01-01T00:00:00.000Z";
const endpoint = (subject = "subject") => `/thoughts/${subject}/reinterpret`;
const command = (key?: string, raw = "{}"): RequestInit => ({ method: "POST", headers: {
  "content-type": "application/json", ...(key === undefined ? {} : { "Idempotency-Key": key }),
}, body: raw });

function write(f: MediaApiFixture, action: (db: Database) => void): void {
  const db = new Database(f.dbPath);
  try { db.exec("PRAGMA foreign_keys=ON"); action(db); } finally { db.close(); }
}
function seed(f: MediaApiFixture): void {
  write(f, db => {
    const store = new SqliteStore(db);
    store.saveThought({ id: "root", text: "PRIVATE ROOT TEXT", title: null, author: "user", kind: "captured-original", createdAt: stamp, origin: "fixture", parentId: null, sourceIds: [] });
    store.saveThought({ id: "subject", text: "PRIVATE AI SUBJECT", title: null, author: "ai", kind: "ai-interpretation", createdAt: stamp, origin: "fixture", parentId: "root", sourceIds: [] });
    store.saveThought({ id: "prior", text: "PRIVATE PRIOR INTERPRETATION", title: null, author: "ai", kind: "ai-interpretation", createdAt: stamp, origin: "fixture", parentId: "subject", sourceIds: [] });
  });
}
function control(value: Record<string, unknown>) {
  const receipt = object(value.receipt), run = object(value.run);
  const runId = text(run.id);
  expect(receipt.runId).toBe(runId);
  return { receipt, run, runId };
}
function terminal(f: MediaApiFixture, runId: string, status: "completed" | "failed", cancellation = "none"): void {
  write(f, db => { db.query("UPDATE runs SET status=?, cancellation_state=? WHERE id=?").run(status, cancellation, runId); });
}

const retirement = (subject: string, runId: string) => `${endpoint(subject)}/retire/${runId}`;
const acknowledge = (raw = '{"acknowledgeRemoteUncertainty":true}'): RequestInit => ({
  method: "POST", headers: { "content-type": "application/json" }, body: raw,
});

for (const status of ["failed", "interrupted"] as const) test(`explicitly retired ${status} legacy work admits and dispatches a fresh weave without changing native facts`, async () => mediaApiFixture(async f => {
  seed(f);
  const oldResponse = await f.request(endpoint(), command("legacy"));
  expect(oldResponse.status).toBe(202);
  const old = control(await body(oldResponse));
  expect(f.read(db => db.query("SELECT input,state,native_state FROM run_steps WHERE run_id=?").get(old.runId)))
    .toEqual({ input: null, state: "prepared", native_state: "unknown" });
  write(f, db => {
    db.run("UPDATE run_steps SET state='uncertain' WHERE run_id=?", [old.runId]);
    db.run("UPDATE runs SET status=?,cancellation_state='pending' WHERE id=?", [status, old.runId]);
  });
  const facts = () => f.read(db => ({
    run: db.query("SELECT status,generation,cancellation_state FROM runs WHERE id=?").get(old.runId),
    steps: db.query("SELECT * FROM run_steps WHERE run_id=?").all(old.runId),
  }));
  const before = facts(), graph = f.read(db => db.query("SELECT * FROM thoughts ORDER BY id").all());
  expect((await f.request(endpoint(), command("fresh"))).status).toBe(409);
  const lookup = await f.request(retirement("subject", old.runId));
  expect(lookup.status).toBe(200);
  expect(lookup.headers.get("cache-control")).toContain("no-store");
  const initial = await body(lookup);
  expect(initial.runId).toBe(old.runId); expect(initial.retiredAt).toBeNull();
  expect(object(initial.eligibility).eligible).toBe(false);
  const response = await f.request(retirement("subject", old.runId), acknowledge());
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toContain("no-store");
  const retired = await body(response), retiredAt = text(retired.retiredAt);
  expect(retired).toMatchObject({ runId: old.runId, retiredAt, remoteState: "unknown" });
  expect(object(retired.eligibility).eligible).toBe(true);
  expect(facts()).toEqual(before);
  expect(f.read(db => db.query("SELECT count(*) AS n FROM runs").get())).toEqual({ n: 1 });
  const replay = await body(await f.request(retirement("subject", old.runId), acknowledge()));
  expect(replay.retiredAt).toBe(retiredAt);
  const readBack = await body(await f.request(retirement("subject", old.runId)));
  expect(readBack.retiredAt).toBe(retiredAt);
  expect(f.read(db => db.query("SELECT weave_retired_at FROM runs WHERE id=?").get(old.runId))).toEqual({ weave_retired_at: retiredAt });
  expect(() => write(f, db => db.run("UPDATE runs SET weave_retired_at=NULL WHERE id=?", [old.runId]))).toThrow();
  expect(() => write(f, db => db.run("UPDATE runs SET weave_retired_at='2040-01-01T00:00:00.000Z' WHERE id=?", [old.runId]))).toThrow();
  expect(f.read(db => db.query("SELECT * FROM thoughts ORDER BY id").all())).toEqual(graph);
  const replacement = await f.request(endpoint(), command("fresh"));
  expect(replacement.status).toBe(202);
  const next = control(await body(replacement));
  expect(next.runId).not.toBe(old.runId);
  await f.stop();
  await f.start({ THOUGHTLOOM_AGENT_CONFIG: JSON.stringify(f.agent) });
  await f.until(() => f.client.prompts.length === 1, "replacement native dispatch");
  expect(f.client.prompts).toHaveLength(1);
  expect(facts()).toEqual(before);
  expect(f.client.scriptErrors).toEqual([]);
}, { script: () => ({ version: 1, kind: "complete", reply: "Owned replacement" }) }), 20000);

test("retirement requires user authority, exact acknowledgement, terminal eligible work and the matching subject", async () => mediaApiFixture(async f => {
  seed(f);
  const created = await f.request(endpoint(), command("old"));
  const old = control(await body(created)), url = retirement("subject", old.runId);
  for (const actor of ["anonymous", "ai"] as const) {
    const status = actor === "anonymous" ? 401 : 403;
    expect((await f.request(url, {}, actor)).status).toBe(status);
    expect((await f.request(url, acknowledge(), actor)).status).toBe(status);
  }
  for (const invalid of ["{}", '{"acknowledgeRemoteUncertainty":false}', '{"acknowledgeRemoteUncertainty":true,"extra":1}', "[]", "{"]) {
    expect((await f.request(url, acknowledge(invalid))).status).toBe(400);
  }
  for (const status of ["queued", "submitting", "running", "uncertain", "completed"] as const) {
    write(f, db => db.run("UPDATE runs SET status=? WHERE id=?", [status, old.runId]));
    expect((await f.request(url, acknowledge())).status).toBe(409);
  }
  write(f, db => db.run("UPDATE runs SET status='failed',cancellation_state='pending' WHERE id=?", [old.runId]));
  expect([404, 409]).toContain((await f.request(retirement("root", old.runId), acknowledge())).status);
  expect((await f.request(retirement("subject", "missing"), acknowledge())).status).toBe(404);
  expect(f.read(db => db.query("SELECT count(*) AS n FROM runs").get())).toEqual({ n: 1 });
}));

test("retiring one historical weave does not release an independent blocker", async () => mediaApiFixture(async f => {
  seed(f);
  const first = control(await body(await f.request(endpoint(), command("first"))));
  write(f, db => {
    db.run("UPDATE runs SET status='failed',cancellation_state='pending' WHERE id=?", [first.runId]);
    let n = 0;
    const second = admitWeave(db, { id: () => `independent-${++n}`, now: () => stamp }, { subjectId: "subject", triggerId: "independent" });
    db.run("UPDATE runs SET status='interrupted',cancellation_state='pending' WHERE id=?", [second.id]);
  });
  const retired = await f.request(retirement("subject", first.runId), acknowledge());
  expect(retired.status).toBe(200);
  expect(object((await body(retired)).eligibility).eligible).toBe(false);
  const fresh = await f.request(endpoint(), command("fresh"));
  expect(fresh.status).toBe(409);
  expect((await body(fresh)).code).toBe("interpretation-unsettled");
  expect(f.read(db => db.query("SELECT count(*) AS n FROM runs").get())).toEqual({ n: 2 });
}));

test("retirement waits for the actual native execution flight and fences its late result", async () => mediaApiFixture(async f => {
  seed(f);
  let entered = false;
  const release = Promise.withResolvers<void>();
  f.client.beforePrompt = async () => { entered = true; await release.promise; };
  try {
    const old = control(await body(await f.request(endpoint(), command("held-execution"))));
    await f.until(() => entered, "native prompt flight entered");
    expect((await f.request(`/runs/${old.runId}/stop`, {method:"POST",headers:{"content-type":"application/json"},body:"{}"})).status).toBe(200);
    f.client.historyMode = "outage"; // Keep best-effort cleanup unsettled while the held result arrives.
    const before = f.read(db => ({
      run: db.query("SELECT status,generation,cancellation_state,weave_retired_at FROM runs WHERE id=?").get(old.runId),
      steps: db.query("SELECT * FROM run_steps WHERE run_id=? ORDER BY position").all(old.runId),
      thoughts: db.query("SELECT id,parent_id,text FROM thoughts ORDER BY id").all(),
      replies: db.query("SELECT * FROM run_replies WHERE run_id=?").all(old.runId),
    }));
    let returned = false;
    const pending = f.request(retirement("subject", old.runId), acknowledge()).then(response => { returned = true; return response; });
    await f.until(() => f.logs.some(record => record.message === "[reinterpretation] retirement attempt" && record.context?.runId === old.runId), "retirement request entered");
    expect(returned).toBe(false);
    expect(f.read(db => db.query("SELECT weave_retired_at FROM runs WHERE id=?").get(old.runId))).toEqual({weave_retired_at:null});
    expect((await f.request(endpoint(), command("while-held"))).status).toBe(409);
    release.resolve();
    const response = await bounded(pending, "retirement after execution drain");
    expect(response.status).toBe(200);
    expect(text((await body(response)).retiredAt)).toBeTruthy();
    expect(f.client.prompts).toHaveLength(1);
    const after = f.read(db => ({
      run: db.query("SELECT status,generation,cancellation_state FROM runs WHERE id=?").get(old.runId),
      steps: db.query("SELECT * FROM run_steps WHERE run_id=? ORDER BY position").all(old.runId),
      thoughts: db.query("SELECT id,parent_id,text FROM thoughts ORDER BY id").all(),
      replies: db.query("SELECT * FROM run_replies WHERE run_id=?").all(old.runId),
    }));
    const beforeRun = object(before.run);
    expect(after.run).toEqual({status:beforeRun.status,generation:beforeRun.generation,cancellation_state:beforeRun.cancellation_state});
    expect(after.steps).toEqual(before.steps);
    expect(after.thoughts).toEqual(before.thoughts); expect(after.replies).toEqual(before.replies);
    expect(after.steps).toHaveLength(1);
  } finally { release.resolve(); f.client.beforePrompt = undefined; }
}, {configured:true,script:() => ({version:1,kind:"complete",reply:"late owned output must not publish"})}), 20000);

test("shutdown while retirement waits for an execution flight refuses the retirement write", async () => mediaApiFixture(async f => {
  seed(f);
  let entered = false;
  const release = Promise.withResolvers<void>();
  f.client.beforePrompt = async () => { entered = true; await release.promise; };
  let stopping: Promise<void> | undefined;
  try {
    const old = control(await body(await f.request(endpoint(), command("shutdown-held"))));
    await f.until(() => entered, "native prompt flight entered");
    expect((await f.request(`/runs/${old.runId}/stop`, {method:"POST",headers:{"content-type":"application/json"},body:"{}"})).status).toBe(200);
    f.client.historyMode = "outage";
    const pending = f.request(retirement("subject",old.runId),acknowledge()).then(response => response.status, () => null);
    await f.until(() => f.logs.some(record => record.message === "[reinterpretation] retirement attempt" && record.context?.runId === old.runId), "retirement request entered");
    stopping = f.stop();
    await f.until(() => f.logs.some(record => record.message === "[worker] paused"), "worker pause during shutdown");
    expect(f.read(db => db.query("SELECT weave_retired_at FROM runs WHERE id=?").get(old.runId))).toEqual({weave_retired_at:null});
    release.resolve();
    expect(await bounded(pending,"retirement response after shutdown")).not.toBe(200);
    await bounded(stopping,"daemon shutdown after flight drain"); stopping = undefined;
    expect(f.read(db => db.query("SELECT status,weave_retired_at FROM runs WHERE id=?").get(old.runId)))
      .toEqual({status:"interrupted",weave_retired_at:null});
  } finally { release.resolve(); f.client.beforePrompt = undefined; if (stopping) await stopping; }
}, {configured:true,script:() => ({version:1,kind:"complete",reply:"late output"})}), 20000);

test("media title-only and missing-intent runs cannot be retired or change interpretation eligibility", async () => mediaApiFixture(async f => {
  seed(f);
  let titleRun = "";
  write(f, db => {
    insertMediaSource(db);
    let n = 0;
    titleRun = admitWeave(db,{id:() => `title-only-${++n}`,now:() => stamp},
      {subjectId:mediaThought.id,triggerId:"title-clear:owned"}).id;
    db.run("UPDATE runs SET status='failed',cancellation_state='pending' WHERE id=?",[titleRun]);
    db.run("INSERT INTO runs(id,kind,status,session_id,prompt_id,created_at,generation,cancellation_state) VALUES ('missing-intent','weave','interrupted','missing-session','missing-prompt',?,0,'pending')",[stamp]);
  });
  const eligibility = async (subject: string) => object((await body(await f.request(`${endpoint(subject)}/by-key/check`))).eligibility);
  const beforeMedia = await eligibility(mediaThought.id), beforeSubject = await eligibility("subject");
  expect(beforeMedia.eligible).toBe(true); expect(beforeSubject.eligible).toBe(true);
  expect((await f.request(retirement(mediaThought.id,titleRun),acknowledge())).status).toBe(409);
  expect((await f.request(retirement("subject","missing-intent"),acknowledge())).status).toBe(404);
  expect(f.read(db => db.query("SELECT id,weave_retired_at FROM runs WHERE id IN (?,?) ORDER BY id").all(titleRun,"missing-intent")))
    .toEqual([{id:"missing-intent",weave_retired_at:null},{id:titleRun,weave_retired_at:null}]);
  expect(await eligibility(mediaThought.id)).toEqual(beforeMedia);
  expect(await eligibility("subject")).toEqual(beforeSubject);
}));

for (const subject of ["root", "subject"] as const) test(`keyed reinterpretation admits the ${subject === "root" ? "user-authored root" : "AI subject"}, replays, and creates distinct work after completion`, async () => mediaApiFixture(async f => {
  seed(f);
  expect((await f.request("/thoughts/prior/reject", { method: "POST" })).status).toBe(204);
  const absent = await f.request(`${endpoint(subject)}/by-key/First.Key`);
  expect(absent.status).toBe(200);
  const missing = await body(absent);
  expect(missing.receipt).toBeNull(); expect(missing.run).toBeNull();
  expect(object(missing.eligibility).eligible).toBe(true);
  expect(f.read(db => db.query("SELECT count(*) AS n FROM runs").get())).toEqual({ n: 0 });

  const response = await f.request(endpoint(subject), command("First.Key"));
  expect(response.status).toBe(202);
  const first = control(await body(response));
  expect(first.receipt).toEqual({ subjectId: subject, requestKey: "First.Key", runId: first.runId });
  expect(first.run).toEqual(expect.objectContaining({ kind: "weave", status: "queued" }));
  expect(f.read(db => db.query("SELECT weave_subject_id AS subject, weave_trigger_id AS trigger FROM runs WHERE id=?").get(first.runId)))
    .toEqual({ subject, trigger: "reinterpret:First.Key" });
  const replay = await f.request(endpoint(subject), command("First.Key"));
  expect(replay.status).toBe(200); expect(control(await body(replay)).receipt).toEqual(first.receipt);
  const lookup = await f.request(`${endpoint(subject)}/by-key/First.Key`);
  expect(lookup.status).toBe(200); expect(control(await body(lookup)).receipt).toEqual(first.receipt);
  terminal(f, first.runId, "completed");
  const secondResponse = await f.request(endpoint(subject), command("second"));
  expect(secondResponse.status).toBe(202);
  const second = control(await body(secondResponse));
  expect(second.runId).not.toBe(first.runId);
  expect(f.read(db => db.query("SELECT weave_trigger_id AS trigger FROM runs WHERE id=?").get(second.runId))).toEqual({ trigger: "reinterpret:second" });
  const oldReplay = await f.request(endpoint(subject), command("First.Key"));
  expect(oldReplay.status).toBe(200); expect(control(await body(oldReplay)).receipt).toEqual(first.receipt);
  expect(f.read(db => db.query("SELECT id,parent_id AS parent FROM thoughts ORDER BY id").all())).toEqual([
    { id: "prior", parent: "subject" }, { id: "root", parent: null }, { id: "subject", parent: "root" },
  ]);
}));

test("active work conflicts without assigning its run to a different key", async () => mediaApiFixture(async f => {
  seed(f);
  const admitted = await f.request(endpoint(), command("original"));
  expect(admitted.status).toBe(202);
  const original = control(await body(admitted));
  const conflict = await f.request(endpoint(), command("not-admitted"));
  expect(conflict.status).toBe(409);
  const data = await body(conflict);
  expect(data.code).toBe("interpretation-active");
  expect(JSON.stringify(data)).toContain(original.runId);
  const lookup = await f.request(`${endpoint()}/by-key/not-admitted`);
  expect(lookup.status).toBe(200);
  const snapshot = await body(lookup);
  expect(snapshot.receipt).toBeNull(); expect(object(snapshot.eligibility).eligible).toBe(false);
  expect(f.read(db => db.query("SELECT count(*) AS n FROM runs").get())).toEqual({ n: 1 });
}));

test("validation and user-only authorization precede command and receipt access", async () => mediaApiFixture(async f => {
  seed(f);
  for (const actor of ["anonymous", "ai"] as const) {
    const status = actor === "anonymous" ? 401 : 403;
    expect((await f.request(endpoint(), command("valid"), actor)).status).toBe(status);
    expect((await f.request(`${endpoint()}/by-key/valid`, {}, actor)).status).toBe(status);
  }
  for (const invalid of [command(), command("bad key"), command("x".repeat(129)), command("valid", '{"text":"forbidden"}'), command("valid", "[]"), command("valid", "{")]) {
    expect((await f.request(endpoint(), invalid)).status).toBe(400);
  }
  expect((await f.request(`${endpoint()}/by-key/${"x".repeat(129)}`)).status).toBe(400);
  expect((await f.request(`${endpoint("missing")}/by-key/valid`)).status).toBe(404);
  expect(f.read(db => db.query("SELECT count(*) AS n FROM runs").get())).toEqual({ n: 0 });
}));

test("rejected subject blocks fresh work but preserves user-only receipt recovery", async () => mediaApiFixture(async f => {
  seed(f);
  const response = await f.request(endpoint(), command("retained"));
  expect(response.status).toBe(202);
  const admitted = control(await body(response));
  expect((await f.request("/thoughts/subject/reject", { method: "POST" })).status).toBe(204);
  const before = f.graph();
  const lookup = await f.request(`${endpoint()}/by-key/retained`);
  expect(lookup.status).toBe(200);
  const recovered = await body(lookup);
  expect(control(recovered).receipt).toEqual(admitted.receipt);
  expect(object(recovered.eligibility).eligible).toBe(false);
  const serialized = JSON.stringify(recovered);
  for (const secret of ["PRIVATE AI SUBJECT", "PRIVATE ROOT TEXT", "PRIVATE PRIOR INTERPRETATION", f.directory]) expect(serialized).not.toContain(secret);
  const native = f.read(db => db.query("SELECT session_id AS session, prompt_id AS prompt FROM runs WHERE id=?").get(admitted.runId)) as { session: string; prompt: string };
  expect(serialized).not.toContain(native.session); expect(serialized).not.toContain(native.prompt);
  const replay = await f.request(endpoint(), command("retained"));
  expect(replay.status).toBe(200); expect(control(await body(replay)).receipt).toEqual(admitted.receipt);
  expect([404, 409]).toContain((await f.request(endpoint(), command("fresh"))).status);
  expect((await f.request(`${endpoint()}/by-key/retained`, {}, "ai")).status).toBe(403);
  expect(f.graph()).toEqual(before);
}));

test("failed settled exact replay is stable and an unverified historical settlement blocks a new key", async () => mediaApiFixture(async f => {
  seed(f);
  const response = await f.request(endpoint(), command("failed"));
  expect(response.status).toBe(202);
  const first = control(await body(response));
  // Test-owned legacy-style journal: submission was authorized but no native identity or terminal boundary is available.
  write(f, db => {
    db.query("UPDATE run_steps SET input=?, state='uncertain' WHERE run_id=?").run("PRIVATE NATIVE INPUT", first.runId);
    db.query("UPDATE runs SET status='failed', cancellation_state='settled' WHERE id=?").run(first.runId);
  });
  const replay = await f.request(endpoint(), command("failed"));
  expect(replay.status).toBe(200); expect(control(await body(replay)).receipt).toEqual(first.receipt);
  const conflict = await f.request(endpoint(), command("replacement"));
  expect(conflict.status).toBe(409); expect((await body(conflict)).code).toBe("interpretation-unsettled");
  const lookup = await f.request(`${endpoint()}/by-key/replacement`);
  expect(lookup.status).toBe(200);
  const snapshot = await body(lookup);
  expect(snapshot.receipt).toBeNull(); expect(object(snapshot.eligibility).eligible).toBe(false);
  expect(f.read(db => db.query("SELECT count(*) AS n FROM runs").get())).toEqual({ n: 1 });
}));

test("an older unsettled subject weave blocks admission even when a newer weave completed", async () => mediaApiFixture(async f => {
  seed(f);
  write(f, db => {
    let sequence = 0;
    const sources = { id: () => `legacy-${++sequence}`, now: () => stamp };
    const older = admitWeave(db, sources, { subjectId: "subject", triggerId: "older" });
    db.query("UPDATE run_steps SET input=?, state='uncertain' WHERE run_id=?").run("PRIVATE OLD INPUT", older.id);
    db.query("UPDATE runs SET status='interrupted', cancellation_state='settled' WHERE id=?").run(older.id);
    const newer = admitWeave(db, sources, { subjectId: "subject", triggerId: "newer" });
    db.query("UPDATE runs SET status='completed' WHERE id=?").run(newer.id);
  });
  const response = await f.request(endpoint(), command("new-request"));
  expect(response.status).toBe(409);
  expect((await body(response)).code).toBe("interpretation-unsettled");
  const lookup = await f.request(`${endpoint()}/by-key/new-request`);
  expect(lookup.status).toBe(200); expect((await body(lookup)).receipt).toBeNull();
  expect(f.read(db => db.query("SELECT count(*) AS n FROM runs").get())).toEqual({ n: 2 });
}));

test("recorded never-submitted settled weave permits a fresh key", async () => mediaApiFixture(async f => {
  seed(f);
  const admitted = await f.request(endpoint(), command("cancelled"));
  expect(admitted.status).toBe(202);
  const first = control(await body(admitted));
  write(f, db => {
    db.query("UPDATE run_steps SET input=? WHERE run_id=?").run("prepared fixture input", first.runId);
    db.query("UPDATE runs SET status='interrupted', cancellation_state='settled' WHERE id=?").run(first.runId);
  });
  const before = await f.request(`${endpoint()}/by-key/fresh`);
  expect(before.status).toBe(200);
  expect(object((await body(before)).eligibility).eligible).toBe(true);
  const response = await f.request(endpoint(), command("fresh"));
  expect(response.status).toBe(202);
  expect(control(await body(response)).runId).not.toBe(first.runId);
  expect(f.read(db => db.query("SELECT count(*) AS n FROM runs").get())).toEqual({ n: 2 });
}));

test("positively reconciled interrupted submission permits a fresh receipt and native dispatch", async () => mediaApiFixture(async f => {
  seed(f);
  // The native prompt is admitted but stays active until the controlled interrupted boundary is exposed.
  f.client.holdOutput = true;
  const admitted = await f.request(endpoint(), command("original-interrupted"));
  expect(admitted.status).toBe(202);
  const first = control(await body(admitted));
  await f.until(() => f.client.prompts.length === 1,"first native submission");
  const prompt = f.client.prompts[0];
  if (!prompt) throw new Error("Expected the owned submitted prompt");
  const stopped = await f.request(`/runs/${first.runId}/stop`, {method:"POST",headers:{"content-type":"application/json"},body:"{}"});
  expect(stopped.status).toBe(200);
  expect((await body(stopped)).status).toBe("interrupted");
  const before = f.read(db => db.query("SELECT position,prompt_id,input,state,native_state,envelope_json,result_json FROM run_steps WHERE run_id=? ORDER BY position").all(first.runId)) as {
    position:number;prompt_id:string;input:string;state:string;native_state:string;envelope_json:string | null;result_json:string | null;
  }[];
  expect(before).toHaveLength(1);
  expect(before[0]).toMatchObject({position:0,prompt_id:prompt.id,input:prompt.text,envelope_json:null,result_json:null});
  expect(before[0]?.state).not.toBe("completed");
  expect(before[0]?.native_state).not.toBe("completed");
  const fenced = f.read(db => db.query("SELECT status,generation FROM runs WHERE id=?").get(first.runId));
  expect(fenced).toMatchObject({status:"interrupted"});
  const blocked = await f.request(`${endpoint()}/by-key/after-stop`);
  expect(blocked.status).toBe(200);
  expect(object((await body(blocked)).eligibility).eligible).toBe(false);

  f.client.messages.set(prompt.sessionID,[
    {id:prompt.id,type:"user",time:{created:10},text:prompt.text},
    {id:`interrupted-${prompt.id}`,type:"idle",time:{created:11},outcome:"interrupted"},
  ]);
  f.client.holdOutput = false;
  await f.until(() => f.read(db => db.query<{cancellation_state:string},[string]>("SELECT cancellation_state FROM runs WHERE id=?").get(first.runId))?.cancellation_state === "settled", "positively reconciled cancellation");
  expect(f.client.interrupts).toContain(prompt.sessionID);
  expect(f.read(db => db.query("SELECT position,prompt_id,input,state,native_state,envelope_json,result_json FROM run_steps WHERE run_id=? ORDER BY position").all(first.runId))).toEqual([
    {position:0,prompt_id:prompt.id,input:prompt.text,state:"completed",native_state:"completed",envelope_json:null,result_json:null},
  ]);
  expect(f.read(db => db.query("SELECT status,generation FROM runs WHERE id=?").get(first.runId))).toEqual(fenced);
  // A configless daemon reopen must consume the committed proof without native re-observation.
  await f.stop();
  await f.start({THOUGHTLOOM_AGENT_CONFIG:undefined});
  const callsBeforeLookup = f.nativeCalls;
  const lookup = await f.request(`${endpoint()}/by-key/after-stop`);
  expect(lookup.status).toBe(200);
  const snapshot = await body(lookup);
  expect(snapshot.receipt).toBeNull();
  expect(object(snapshot.eligibility)).toEqual({eligible:true,reason:null,blockingRun:null});
  expect(f.nativeCalls).toEqual(callsBeforeLookup);
  const replay = await f.request(endpoint(), command("original-interrupted"));
  expect(replay.status).toBe(200); expect(control(await body(replay)).receipt).toEqual(first.receipt);
  await f.stop();
  await f.start();
  const replacement = await f.request(endpoint(), command("after-stop"));
  expect(replacement.status).toBe(202);
  const next = control(await body(replacement));
  expect(next.runId).not.toBe(first.runId);
  await f.until(() => f.client.prompts.length >= 2,"replacement native submission");
  expect(f.client.prompts[1]?.sessionID).not.toBe(prompt.sessionID);
  expect(f.client.scriptErrors).toEqual([]);
},{configured:true,script:() => ({version:1,kind:"complete",reply:"Owned fixture outcome"})}),20000);

async function historicalSettledWeave(f: MediaApiFixture, status: "failed" | "interrupted") {
  seed(f); f.client.holdOutput = true;
  const response = await f.request(endpoint("root"), command("historical"));
  expect(response.status).toBe(202);
  const first = control(await body(response));
  await f.until(() => f.client.prompts.length === 1, "historical native submission");
  const prompt = f.client.prompts[0]; if (!prompt) throw new Error("Expected owned native prompt");
  await f.stop();
  write(f, db => {
    const store = new SqliteStore(db);
    store.saveResponse({ id: "historical-reply", text: "PRIVATE RETAINED OUTCOME", role: "addendum", state: "complete", thoughtIds: ["root", "subject"] });
    db.run("INSERT INTO run_replies (run_id,response_id) VALUES (?,?)", [first.runId, "historical-reply"]);
    db.run("UPDATE run_steps SET state='submitting',native_state='unknown' WHERE run_id=?", [first.runId]);
    db.run("UPDATE runs SET status=?,cancellation_state='settled' WHERE id=?", [status, first.runId]);
  });
  f.client.holdOutput = false;
  f.client.messages.set(prompt.sessionID, [
    { id: prompt.id, type: "user", time: { created: 10 }, text: prompt.text },
    { id: "owned-terminal", type: "idle", time: { created: 11 }, outcome: "interrupted" },
  ]);
  await f.start({ THOUGHTLOOM_AGENT_CONFIG: undefined });
  return { first, prompt };
}

function historicalSupervisor(db: Database, f: MediaApiFixture) {
  let sequence = 0;
  const worker = new RunWorker({ db, id: () => `cleanup-owned-${++sequence}`, now: () => stamp, bindingFor: () => null,
    native: bindings => new OpenCodeAdapter(f.client, bindings, bindings.assertActive.bind(bindings)) });
  return new RunSupervisor({ db, worker, startTimer: () => () => {} });
}

for (const status of ["failed", "interrupted"] as const) test(`supervisor re-verifies a ${status} historical settled weave before a fresh root request`, async () => mediaApiFixture(async f => {
  const { first, prompt } = await historicalSettledWeave(f, status);
  const tables = ["thoughts", "thought_titles", "thought_sources", "responses", "response_thoughts", "run_operation_receipts", "run_issued_thoughts", "run_replies"];
  const preserved = () => f.read(db => tables.map(table => db.query(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all()));
  const before = preserved();
  const runBefore = f.read(db => db.query("SELECT * FROM runs WHERE id=?").get(first.runId));
  const stepBefore = f.read(db => db.query("SELECT * FROM run_steps WHERE run_id=?").get(first.runId));
  expect(object((await body(await f.request(`${endpoint("root")}/by-key/fresh`))).eligibility)).toMatchObject({ eligible: false, reason: "work-unverified" });
  const db = new Database(f.dbPath), supervisor = historicalSupervisor(db, f);
  const historyReads = f.client.historyRequests.length;
  try {
    await supervisor.poll();
    expect(f.client.historyRequests.slice(historyReads)).toContain(prompt.sessionID);
    expect(f.read(db => db.query("SELECT state,native_state FROM run_steps WHERE run_id=?").get(first.runId))).toEqual({ state: "completed", native_state: "completed" });
    expect(f.read(db => db.query("SELECT * FROM runs WHERE id=?").get(first.runId))).toEqual(runBefore);
    const afterStep = f.read(db => db.query("SELECT * FROM run_steps WHERE run_id=?").get(first.runId));
    expect(afterStep).toEqual({ ...object(stepBefore), state: "completed", native_state: "completed" });
    expect(preserved()).toEqual(before);
    expect(f.client.prompts).toHaveLength(1);
    expect(object((await body(await f.request(`${endpoint("root")}/by-key/fresh`))).eligibility)).toEqual({ eligible: true, reason: null, blockingRun: null });
    const replay = await f.request(endpoint("root"), command("historical"));
    expect(replay.status).toBe(200); expect(control(await body(replay)).receipt).toEqual(first.receipt);
  } finally { await supervisor.stop(); db.close(); }
  await f.stop(); await f.start();
  const replacement = await f.request(endpoint("root"), command("fresh"));
  expect(replacement.status).toBe(202);
  expect(control(await body(replacement)).runId).not.toBe(first.runId);
  expect(f.client.prompts).toHaveLength(1);
  expect(preserved()).toEqual(before);
}, { configured: true, script: () => ({ version: 1, kind: "complete", reply: "Unused" }) }), 20000);

for (const evidence of ["missing", "foreign", "active"] as const) test(`unverified settled weave remains blocked with ${evidence} native evidence`, async () => mediaApiFixture(async f => {
  const { first, prompt } = await historicalSettledWeave(f, "failed");
  if (evidence === "missing") f.client.messages.set(prompt.sessionID, []);
  if (evidence === "foreign") f.client.messages.set(prompt.sessionID, [{ id: "foreign", type: "user", time: { created: 10 }, text: "foreign input" }, { id: "foreign-idle", type: "idle", time: { created: 11 }, outcome: "interrupted" }]);
  if (evidence === "active") f.client.activeSessions.add(prompt.sessionID);
  const before = f.read(db => ({ run: db.query("SELECT * FROM runs WHERE id=?").get(first.runId), steps: db.query("SELECT * FROM run_steps WHERE run_id=?").all(first.runId) }));
  const db = new Database(f.dbPath), bindings = new SqliteAgentBindings(db), saved = bindings.get(first.runId);
  if (!saved) throw new Error("Expected saved binding");
  const adapter = new OpenCodeAdapter(f.client, bindings, bindings.assertActive.bind(bindings));
  const supervisor = historicalSupervisor(db, f);
  try {
    const result = await adapter.cancel(first.runId, saved, { promptId: prompt.id, input: prompt.text }).then(value => value, () => "conflict");
    expect(["pending", "conflict"]).toContain(result);
    const historyReads = f.client.historyRequests.length;
    const interrupts = f.client.interrupts.length;
    const cancellations = f.client.inboxCancellations.length;
    const preserved = f.graph();
    const responses = f.read(db => ["responses", "response_thoughts"].map(table => db.query(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all()));
    await supervisor.poll();
    expect(f.client.historyRequests.slice(historyReads)).toContain(prompt.sessionID);
    expect(f.client.inboxCancellations.slice(cancellations)).toEqual([]);
    // The existing cleanup may interrupt its own represented work (or an idle session), never foreign work.
    const newInterrupts = f.client.interrupts.slice(interrupts);
    if (evidence === "foreign") expect(newInterrupts).toEqual([]);
    else expect(newInterrupts.every(sessionID => sessionID === prompt.sessionID)).toBe(true);
    expect(f.graph()).toEqual(preserved);
    expect(f.read(db => ["responses", "response_thoughts"].map(table => db.query(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all()))).toEqual(responses);
    expect(f.read(db => ({ run: db.query("SELECT * FROM runs WHERE id=?").get(first.runId), steps: db.query("SELECT * FROM run_steps WHERE run_id=?").all(first.runId) }))).toEqual(before);
    expect(object((await body(await f.request(`${endpoint("root")}/by-key/fresh`))).eligibility)).toMatchObject({ eligible: false, reason: "work-unverified" });
    expect(f.client.prompts).toHaveLength(1);
    if (evidence === "foreign") expect(f.client.interrupts).toEqual([]);
  } finally { await supervisor.stop(); db.close(); }
  await f.stop(); await f.start();
  const blocked = await f.request(endpoint("root"), command("fresh"));
  expect(blocked.status).toBe(409);
  expect((await body(blocked)).code).toBe("interpretation-unsettled");
  expect(f.client.prompts).toHaveLength(1);
}, { configured: true, script: () => ({ version: 1, kind: "complete", reply: "Unused" }) }), 20000);

for (const sameKey of [true, false]) test(`simultaneous ${sameKey ? "same" : "different"}-key commands retain one durable admission`, async () => mediaApiFixture(async f => {
  seed(f);
  const keys = ["concurrent-a", sameKey ? "concurrent-a" : "concurrent-b"];
  const responses = await Promise.all(keys.map(key => f.request(endpoint(), command(key))));
  expect(responses.map(response => response.status).sort()).toEqual(sameKey ? [200, 202] : [202, 409]);
  const payloads = await Promise.all(responses.map(body));
  const winnerIndex = responses.findIndex(response => response.status === 202);
  const winnerKey = keys[winnerIndex];
  const winnerPayload = payloads[winnerIndex];
  if (winnerKey === undefined || winnerPayload === undefined) throw new Error("Expected one admitted request");
  const winner = control(winnerPayload);
  expect(winner.receipt.requestKey).toBe(winnerKey);
  for (const [index, key] of keys.entries()) {
    const lookup = await f.request(`${endpoint()}/by-key/${key}`);
    expect(lookup.status).toBe(200);
    const snapshot = await body(lookup);
    if (sameKey || index === winnerIndex) expect(control(snapshot).receipt).toEqual(winner.receipt);
    else {
      expect(snapshot.receipt).toBeNull();
      expect(payloads[index]?.code).toBe("interpretation-active");
    }
  }
  expect(f.read(db => db.query("SELECT count(*) AS n FROM runs").get())).toEqual({ n: 1 });
}));
