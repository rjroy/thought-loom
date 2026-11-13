import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { OpenCodeAdapter } from "../src/agent/opencode-adapter";
import { RunWorker, type ScreeningPair } from "../src/agent/worker";
import { RunService } from "../src/domain/run";
import { ScriptedClient } from "./agentic-search-capability-fixture";
import { bounded } from "./fixtures/media-files";
import { mediaPathFixture, pathBinding, pathComplete, pathRequest, type MediaPathFixture } from "./fixtures/media-path-worker";
import { connectionDiscoveryIntent, resolveWeavePurpose } from "../src/domain/weave-scheduling";
import { RunFenceError, RunForbiddenError } from "../src/domain/run";
import { SqliteReinterpretations } from "../src/storage/reinterpretation";
import { SqliteRunRepository } from "../src/storage/run";
import { SqliteCapabilityDispatcher } from "../src/storage/capability";

type Owner = {id:string;status:string;triggerId:string};
function owners(db: Database, subjectId:string): Owner[] {
  return db.query<Owner,[string]>("SELECT id,status,weave_trigger_id AS triggerId FROM runs WHERE kind='weave' AND weave_subject_id=? ORDER BY rowid").all(subjectId);
}
function issued(db: Database, runId:string): string[] {
  return db.query<{id:string},[string]>("SELECT thought_id AS id FROM run_issued_thoughts WHERE run_id=? ORDER BY position").all(runId).map(row => row.id);
}
function oneOwner(db: Database, subjectId:string): Owner {
  const found = owners(db,subjectId);
  expect(found).toHaveLength(1);
  const owner = found[0];
  if (!owner) throw new Error("Expected the saved thought's discovery owner");
  expect(resolveWeavePurpose("ai-interpretation",owner.triggerId)).toBe("connection-only");
  return owner;
}
function screenedWorker(f: MediaPathFixture, script: (index:number,input:string) => object) {
  const pairs: ScreeningPair[] = [], client = new ScriptedClient(script);
  const instance = new RunWorker({db:f.db,...f.sources,bindingFor:run => pathBinding(run,f.directory),
    mediaPath:async sourceId => { if (sourceId !== f.source.mediaSource.id) throw new Error("Unexpected source"); return f.path; },
    connectionScreening:{identity:"owned-creation-judge",async judge(pair) { pairs.push(pair); return pair.thoughtB.id === f.subjectId ? 0.6 : 0.1; }},
    native:bindings => new OpenCodeAdapter(client,bindings,bindings.assertActive.bind(bindings),f.sources.logger)});
  return {instance,client,pairs};
}

test("each sibling interpretation has one connection-only owner and replay creates no recursive work or public reply", async () => mediaPathFixture(async f => {
  const run = f.ops.admitWeave("user",{subjectId:f.subjectId,triggerId:"sibling-discovery"});
  const w = f.worker(index => index === 0 ? pathRequest("interpretation",{text:"First owned interpretation",sourceIds:[]}) :
    index === 1 ? pathRequest("interpretation",{text:"Second owned interpretation",sourceIds:[]}) : pathComplete("Parent weave complete"));
  await f.until(w.instance,run.id,() => issued(f.db,run.id).length === 2);
  const ids = issued(f.db,run.id);
  expect(ids).toHaveLength(2);
  const discovery = ids.map(id => oneOwner(f.db,id));
  expect(new Set(discovery.map(item => item.id)).size).toBe(2);
  const current = f.steps.steps(run.id).at(-1);
  if (!current || current.envelope?.kind !== "request") throw new Error("Expected committed interpretation request");
  const replay = f.capabilities.dispatch({runId:run.id,generation:f.run(run.id).generation},current.promptId,current.envelope.request);
  expect(replay.type).toBe("interpretation");
  expect(ids.map(id => owners(f.db,id).map(owner => owner.id))).toEqual(discovery.map(owner => [owner.id]));
  await f.finish(w.instance,run.id);
  const originalThoughts = f.db.query("SELECT id FROM thoughts ORDER BY rowid").all();
  for (const owner of discovery) {
    const child = f.worker(() => pathComplete("No connection warranted"));
    await f.finish(child.instance,owner.id);
    expect(f.run(owner.id).status).toBe("completed");
    const initial = child.client.prompts[0];
    if (!initial) throw new Error("Expected discovery prompt");
    const prompt = JSON.parse(initial.text) as {capabilities:{capability:string}[]};
    const capabilities = prompt.capabilities.map(item => item.capability);
    expect(capabilities).toContain("connection");
    expect(capabilities).toContain("readThought");
    expect(capabilities).not.toContain("interpretation");
    expect(capabilities).not.toContain("development");
    expect(capabilities).not.toContain("title-fill");
    expect(f.runs.reply(owner.id)).toBeNull();
    expect(f.steps.steps(owner.id).at(-1)?.envelope).toEqual({version:1,kind:"complete",reply:"No connection warranted"});
  }
  await w.instance.tick(run.id);
  expect(ids.map(id => owners(f.db,id).map(owner => owner.id))).toEqual(discovery.map(owner => [owner.id]));
  expect(f.db.query("SELECT id FROM thoughts ORDER BY rowid").all()).toEqual(originalThoughts);
},null));

test("generated thought, receipt, issued result and discovery owner roll back together on admission failure", async () => mediaPathFixture(async f => {
  const run = f.ops.admitWeave("user",{subjectId:f.subjectId,triggerId:"discovery-rollback"});
  const w = f.worker(() => pathRequest("interpretation",{text:"Owned atomic interpretation",sourceIds:[]}));
  await f.until(w.instance,run.id,() => f.steps.steps(run.id).at(-1)?.envelope?.kind === "request");
  const step = f.steps.steps(run.id).at(-1);
  if (!step || step.envelope?.kind !== "request") throw new Error("Expected interpretation request");
  const before = f.db.query("SELECT id FROM thoughts ORDER BY rowid").all();
  f.db.exec(`CREATE TRIGGER owned_discovery_fault BEFORE INSERT ON runs
    WHEN NEW.weave_trigger_id LIKE 'connection-discovery:%' BEGIN SELECT RAISE(ABORT,'owned discovery admission fault'); END;`);
  const claim = {runId:run.id,generation:f.run(run.id).generation};
  try {
    expect(() => f.capabilities.dispatch(claim,step.promptId,step.envelope?.kind === "request" ? step.envelope.request : null)).toThrow("owned discovery admission fault");
    expect(f.db.query("SELECT id FROM thoughts ORDER BY rowid").all()).toEqual(before);
    expect(issued(f.db,run.id)).toEqual([]);
    expect(f.ops.stepReceipt(run.id,step.promptId)).toBeNull();
    expect(f.steps.steps(run.id).at(-1)?.result).toBeNull();
  } finally { f.db.exec("DROP TRIGGER owned_discovery_fault"); }
  const result = f.capabilities.dispatch(claim,step.promptId,step.envelope.request);
  if (result.type !== "interpretation") throw new Error("Expected interpretation");
  oneOwner(f.db,result.thought.id);
},null));

test("Evolve contribution, original run and discovery owner roll back together on admission failure", async () => mediaPathFixture(async f => {
  const thoughts = f.db.query("SELECT id FROM thoughts ORDER BY rowid").all(), runs = f.db.query("SELECT id FROM runs ORDER BY rowid").all();
  f.db.exec(`CREATE TRIGGER owned_contribution_fault BEFORE INSERT ON runs
    WHEN NEW.weave_trigger_id LIKE 'connection-discovery:%' BEGIN SELECT RAISE(ABORT,'owned contribution discovery fault'); END;`);
  try {
    expect(() => f.admissions.admit("user","evolve",{parentId:f.subjectId,text:"Owned atomic contribution"})).toThrow("owned contribution discovery fault");
    expect(f.db.query("SELECT id FROM thoughts ORDER BY rowid").all()).toEqual(thoughts);
    expect(f.db.query("SELECT id FROM runs ORDER BY rowid").all()).toEqual(runs);
  } finally { f.db.exec("DROP TRIGGER owned_contribution_fault"); }
}));

test.each(["stopped","restored"] as const)("a %s legacy creator cannot admit fresh discovery for historical output", async reason => mediaPathFixture(async f => {
  const origin = f.ops.admitWeave("user",{subjectId:f.subjectId,triggerId:"owned-historical-creator"});
  const historical = {id:"owned-historical-output",text:"Owned historical development",title:null,author:"ai" as const,kind:"developing-idea" as const,createdAt:f.sources.now(),origin:"development",parentId:f.subjectId,sourceIds:[]};
  f.store.saveThought(historical);
  const operation = {id:"owned-historical-operation",type:"development",parentId:f.subjectId,text:historical.text,sourceIds:[]};
  f.db.run("INSERT INTO run_operation_receipts(run_id,operation_id,operation_json,thought_id,result_json) VALUES (?,?,?,?,?)",[origin.id,operation.id,JSON.stringify(operation),historical.id,JSON.stringify(historical)]);
  f.db.run("INSERT INTO run_issued_thoughts(run_id,operation_id,thought_id,position) VALUES (?,?,?,0)",[origin.id,operation.id,historical.id]);
  if (reason === "stopped") f.runs.stop(origin.id);
  else f.db.run("INSERT INTO restore_fences(entity_kind,entity_id,snapshot_sha256,restored_at,original_state_json) VALUES ('run',?,?,?,'{}')",[origin.id,"a".repeat(64),f.sources.now()]);
  expect(() => f.ops.admitWeave("user",connectionDiscoveryIntent(historical.id,origin.id))).toThrow(RunFenceError);
  expect(owners(f.db,historical.id)).toEqual([]);
}));

test("connection-only Weaver creates a warranted fixed-subject connection from nominated full reads with stable receipt replay", async () => mediaPathFixture(async f => {
  const admission = f.admissions.admit("user","evolve",{parentId:f.subjectId,text:"Owned connection subject"});
  const contribution = admission.contribution; if (!contribution) throw new Error("Expected contribution");
  const owner = oneOwner(f.db,contribution.id);
  const w = screenedWorker(f,index => index === 0 ? pathRequest("connection",{fromId:contribution.id,toId:f.subjectId,category:"extends",explanation:"Owned conceptual explanation",sourceIds:[f.subjectId]}) : pathComplete("One warranted connection"));
  const responses = f.db.query("SELECT id FROM responses ORDER BY rowid").all();
  try {
    await f.until(w.instance,owner.id,() => f.db.query("SELECT 1 FROM connections").get() !== null);
    const step = f.steps.steps(owner.id).at(-1);
    if (!step || step.envelope?.kind !== "request") throw new Error("Expected connection receipt");
    const result = f.capabilities.dispatch({runId:owner.id,generation:f.run(owner.id).generation},step.promptId,step.envelope.request);
    expect(result.type).toBe("connection");
    if (result.type !== "connection" || result.status !== "created") throw new Error("Expected created connection");
    expect(result.connection).toMatchObject({fromId:contribution.id,toId:f.subjectId,category:"extends",proposedBy:"ai",explanation:"Owned conceptual explanation",sourceIds:[f.subjectId]});
    expect(f.db.query("SELECT id FROM connections").all()).toEqual([{id:result.connection.id}]);
    expect(f.db.query("SELECT full_read FROM run_context WHERE run_id=? AND kind='thought' AND ref_id=?").get(owner.id,f.subjectId)).toEqual({full_read:1});
    await f.finish(w.instance,owner.id);
    expect(f.run(owner.id).status).toBe("completed"); expect(f.runs.reply(owner.id)).toBeNull();
    expect(issued(f.db,owner.id)).toEqual([]);
    expect(f.db.query("SELECT id FROM responses ORDER BY rowid").all()).toEqual(responses);
  } finally { w.instance.pause(); await w.instance.drain(); }
}));

test.each(["interpretation","development","title-fill"] as const)("connection-only denies %s effects and cached result replay", async capability => mediaPathFixture(async f => {
  const admission = f.admissions.admit("user","evolve",{parentId:f.subjectId,text:"Owned authority contribution"});
  if (!admission.contribution) throw new Error("Expected contribution");
  const owner = oneOwner(f.db,admission.contribution.id);
  const args = capability === "title-fill" ? {title:"Forbidden title"} : capability === "development" ?
    {parentId:admission.contribution.id,text:"Forbidden development",sourceIds:[]} : {text:"Forbidden interpretation",sourceIds:[]};
  const w = f.worker(() => pathRequest(capability,args));
  await f.until(w.instance,owner.id,() => f.steps.steps(owner.id).at(-1)?.envelope?.kind === "request");
  const step = f.steps.steps(owner.id).at(-1);
  if (!step || step.envelope?.kind !== "request") throw new Error("Expected forbidden request");
  const claim = {runId:owner.id,generation:f.run(owner.id).generation};
  const before = f.db.query("SELECT id FROM thoughts ORDER BY rowid").all();
  expect(() => f.capabilities.dispatch(claim,step.promptId,step.envelope?.kind === "request" ? step.envelope.request : null)).toThrow(RunForbiddenError);
  f.db.run("UPDATE run_steps SET result_json=? WHERE run_id=? AND prompt_id=?",[JSON.stringify({type:capability,status:"unchanged"}),owner.id,step.promptId]);
  expect(() => f.capabilities.dispatch(claim,step.promptId,step.envelope?.kind === "request" ? step.envelope.request : null)).toThrow(RunForbiddenError);
  expect(() => f.ops.completeWeave(claim,step.promptId)).toThrow(RunForbiddenError);
  expect(f.db.query("SELECT id FROM thoughts ORDER BY rowid").all()).toEqual(before);
  expect(f.store.getThought(admission.contribution.id)?.title).toBeNull();
  expect(f.runs.reply(owner.id)).toBeNull();
}));

test("connection-only cannot connect unrelated endpoints or act as interpretation retirement/admission work", async () => mediaPathFixture(async f => {
  const admission = f.admissions.admit("user","evolve",{parentId:f.subjectId,text:"Owned scoped contribution"});
  if (!admission.contribution) throw new Error("Expected contribution");
  const owner = oneOwner(f.db,admission.contribution.id), interpretations = new SqliteReinterpretations(f.db,f.sources);
  const subjectId = admission.contribution.id;
  expect(interpretations.byKey(admission.contribution.id,"new").eligibility.eligible).toBe(true);
  const explicit = interpretations.admit(subjectId,"parallel-interpretation").snapshot.run;
  if (!explicit) throw new Error("Expected independent interpretation");
  expect(f.runs.claim(explicit.id).runId).toBe(explicit.id);
  const w = f.worker(() => pathRequest("connection",{fromId:f.subjectId,toId:f.source.id,category:"related",explanation:"Unrelated to fixed subject",sourceIds:[]}));
  await f.until(w.instance,owner.id,() => f.steps.steps(owner.id).at(-1)?.envelope?.kind === "request");
  const step = f.steps.steps(owner.id).at(-1);
  if (!step || step.envelope?.kind !== "request") throw new Error("Expected connection request");
  expect(() => f.ops.executeStep({runId:owner.id,generation:f.run(owner.id).generation},step.promptId,{type:"connection",fromId:f.subjectId,toId:f.source.id,category:"related",explanation:"Unrelated to fixed subject",sourceIds:[]})).toThrow(RunForbiddenError);
  expect(f.db.query("SELECT id FROM connections").all()).toEqual([]);
  f.runs.stop(owner.id);
  expect(() => interpretations.prepareRetirement(subjectId,owner.id)).toThrow();
}));

test("all generated text creation owners screen exhaustively, including siblings and reinterpretation, without duplicate follow-up screening", async () => mediaPathFixture(async f => {
  const admission = f.admissions.admit("user","evolve",{parentId:f.subjectId,text:"Owned screened contribution"});
  if (!admission.contribution) throw new Error("Expected contribution");
  const evolve = f.worker(index => index < 2 ? pathRequest("development",{parentId:admission.contribution?.id,text:`Owned generated development ${index}`,sourceIds:[]}) : pathComplete("Owned discussion"));
  await f.finish(evolve.instance,admission.run.id);
  const developments = issued(f.db,admission.run.id), latest = developments.at(-1);
  if (!latest) throw new Error("Expected developments");
  const ordinary = owners(f.db,latest).find(owner => resolveWeavePurpose("developing-idea",owner.triggerId) === "ordinary");
  if (!ordinary) throw new Error("Expected ordinary latest-development follow-up");
  const followup = screenedWorker(f,index => index < 2 ? pathRequest("interpretation",{text:`Owned sibling interpretation ${index}`,sourceIds:[]}) : pathComplete("Owned follow-up"));
  const reinterpretations = new SqliteReinterpretations(f.db,f.sources), reinterpretation = reinterpretations.admit(f.source.id,"new-owned-source").snapshot.run;
  if (!reinterpretation) throw new Error("Expected reinterpretation run");
  const media = screenedWorker(f,index => index === 0 ? pathRequest("interpretation",{text:"Owned fresh source interpretation",sourceIds:[]}) : pathComplete("Owned source outcome"));
  const workers = [followup,media];
  try {
    await f.finish(followup.instance,ordinary.id); await f.finish(media.instance,reinterpretation.id);
    expect(followup.pairs).toEqual([]); expect(media.pairs).toEqual([]);
    expect((JSON.parse(followup.client.prompts[0]?.text ?? "null") as {nominations?:unknown}).nominations).toBeUndefined();
    const generated = [admission.contribution.id,...developments,...issued(f.db,ordinary.id),...issued(f.db,reinterpretation.id)];
    expect(generated).toHaveLength(6);
    const textIds = f.db.query<{id:string},[]>("SELECT id FROM thoughts WHERE kind!='media-original' ORDER BY id").all().map(row => row.id);
    const before = {thoughts:f.db.query("SELECT id FROM thoughts ORDER BY rowid").all(),runs:f.db.query("SELECT id FROM runs ORDER BY rowid").all(),responses:f.db.query("SELECT id FROM responses ORDER BY rowid").all()};
    for (const subjectId of generated) {
      const discovery = owners(f.db,subjectId).filter(owner => resolveWeavePurpose("developing-idea",owner.triggerId) === "connection-only");
      expect(discovery).toHaveLength(1);
      const owner = discovery[0]; if (!owner) throw new Error("Expected creation owner");
      const w = screenedWorker(f,() => pathComplete("No useful connection")); workers.push(w);
      await f.finish(w.instance,owner.id);
      expect(f.run(owner.id).status).toBe("completed");
      expect(w.pairs.map(pair => pair.thoughtB.id).sort()).toEqual(textIds.filter(id => id !== subjectId));
      expect(w.pairs.every(pair => pair.thoughtA.id === subjectId)).toBe(true);
      const prompt = JSON.parse(w.client.prompts[0]?.text ?? "null") as {nominations:{id:string}[];context:{job:{purpose:string}}};
      expect(prompt.context.job.purpose).toBe("connection-only");
      expect(prompt.nominations.map(thought => thought.id)).toEqual([f.subjectId]);
      expect(f.runs.reply(owner.id)).toBeNull();
    }
    expect(f.db.query("SELECT id FROM thoughts ORDER BY rowid").all()).toEqual(before.thoughts);
    expect(f.db.query("SELECT id FROM runs ORDER BY rowid").all()).toEqual(before.runs);
    expect(f.db.query("SELECT id FROM responses ORDER BY rowid").all()).toEqual(before.responses);
  } finally { for (const w of workers) w.instance.pause(); await Promise.all(workers.map(w => w.instance.drain())); }
},null));

test("creation receipt replay and Evolve Stop use durable origins on a reopened database connection", async () => mediaPathFixture(async f => {
  const admission = f.admissions.admit("user","evolve",{parentId:f.subjectId,text:"Owned restart contribution"});
  if (!admission.contribution) throw new Error("Expected contribution");
  const w = f.worker(() => pathRequest("development",{parentId:admission.contribution?.id,text:"Owned restart development",sourceIds:[]}));
  await f.until(w.instance,admission.run.id,() => issued(f.db,admission.run.id).length === 1);
  w.instance.pause(); await w.instance.drain();
  const child = issued(f.db,admission.run.id)[0]; if (!child) throw new Error("Expected development");
  const ownerIds = [oneOwner(f.db,admission.contribution.id).id,oneOwner(f.db,child).id];
  const reopened = new Database(f.db.filename);
  try {
    const runs = new SqliteRunRepository(reopened,f.sources), step = f.steps.steps(admission.run.id).at(-1);
    if (!step || step.envelope?.kind !== "request") throw new Error("Expected replayable request");
    const result = new SqliteCapabilityDispatcher(reopened,f.sources).dispatch({runId:admission.run.id,generation:f.run(admission.run.id).generation},step.promptId,step.envelope.request);
    expect(result.type).toBe("development");
    expect([oneOwner(reopened,admission.contribution.id).id,oneOwner(reopened,child).id]).toEqual(ownerIds);
    runs.stop(admission.run.id);
    expect(ownerIds.map(id => runs.get(id)?.status)).toEqual(["interrupted","interrupted"]);
  } finally { reopened.close(); }
}));

test("Evolve Stop fences a held discovery native result before it can create a connection", async () => mediaPathFixture(async f => {
  const admission = f.admissions.admit("user","evolve",{parentId:f.subjectId,text:"Owned native-stop contribution"});
  if (!admission.contribution) throw new Error("Expected contribution");
  const owner = oneOwner(f.db,admission.contribution.id), w = f.worker(() => pathRequest("connection",{fromId:admission.contribution?.id,toId:f.subjectId,category:"related",explanation:"Late proposed link",sourceIds:[]}));
  await f.until(w.instance,owner.id,() => w.client.prompts.length === 1);
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  w.client.beforeHistory = async () => { entered.resolve(); await release.promise; };
  const flight = w.instance.tick(owner.id);
  try {
    await bounded(entered.promise,"held discovery observation");
    f.runs.stop(admission.run.id); w.client.beforeHistory = undefined; release.resolve();
    await bounded(flight,"fenced discovery observation");
    expect(f.run(owner.id).status).toBe("interrupted");
    expect(f.db.query("SELECT id FROM connections").all()).toEqual([]);
    expect(f.steps.steps(owner.id).at(-1)?.envelope).toBeNull();
    expect(f.runs.reply(owner.id)).toBeNull();
  } finally { w.client.beforeHistory = undefined; release.resolve(); await bounded(flight,"native observation cleanup"); }
}));

test("a media interpretation gets its own discovery owner, not the source descriptor", async () => mediaPathFixture(async f => {
  const run = f.ops.admitWeave("user",{subjectId:f.source.id,triggerId:`media-import:${f.source.mediaSource.id}`});
  const w = f.worker(index => index === 0 ? pathRequest("interpretation",{text:"Owned searchable image interpretation",sourceIds:[]}) : pathComplete("Source summarized"));
  await f.until(w.instance,run.id,() => issued(f.db,run.id).length === 1);
  const childId = issued(f.db,run.id)[0];
  if (!childId) throw new Error("Expected the committed media interpretation");
  expect(f.store.getThought(childId)).toMatchObject({kind:"ai-interpretation",parentId:f.source.id,text:"Owned searchable image interpretation"});
  const owner = oneOwner(f.db,childId);
  expect(owners(f.db,f.source.id).map(item => item.id)).toEqual([run.id]);
  await f.finish(w.instance,run.id);
  await w.instance.tick(run.id);
  expect(owners(f.db,childId).map(item => item.id)).toEqual([owner.id]);
},null));

test("Evolve admission atomically retains a discovery owner for its new contribution", async () => mediaPathFixture(async f => {
  const admission = f.admissions.admit("user","evolve",{parentId:f.subjectId,text:"Owned initial contribution"});
  const contribution = admission.contribution;
  if (!contribution) throw new Error("Expected a contribution");
  expect(f.store.getThought(contribution.id)).toMatchObject({kind:"user-contribution",text:"Owned initial contribution"});
  expect(f.run(admission.run.id).status).toBe("queued");
  expect(oneOwner(f.db,contribution.id).status).toBe("queued");
}));

test("Evolve contribution and every development acquire independent discovery owners before completion", async () => mediaPathFixture(async f => {
  const admission = f.admissions.admit("user","evolve",{parentId:f.subjectId,text:"Owned contribution"});
  const contribution = admission.contribution;
  if (!contribution) throw new Error("Expected a contribution");
  const w = f.worker(index => index < 2 ? pathRequest("development",{parentId:contribution.id,text:`Owned development ${index}`,sourceIds:[]}) : pathComplete("Conversation complete"));
  await f.until(w.instance,admission.run.id,() => issued(f.db,admission.run.id).length === 2);
  const developments = issued(f.db,admission.run.id);
  expect(developments).toHaveLength(2);
  const discovery = [contribution.id,...developments].map(id => oneOwner(f.db,id));
  expect(new Set(discovery.map(item => item.id)).size).toBe(3);
  await f.finish(w.instance,admission.run.id);
  expect(f.runs.reply(admission.run.id)?.text).toBe("Conversation complete");
  for (const id of [contribution.id,...developments.slice(0,1)]) expect(owners(f.db,id)).toHaveLength(1);
  // The latest development also keeps the existing separate ordinary follow-up weave.
  const latest = developments[1];
  if (!latest) throw new Error("Expected latest development");
  expect(owners(f.db,latest)).toHaveLength(2);
}));

test("Stop on Evolve interrupts related discovery and fences a held local judgment without undoing connections", async () => mediaPathFixture(async f => {
  const admission = f.admissions.admit("user","evolve",{parentId:f.subjectId,text:"Owned stoppable contribution"});
  const contribution = admission.contribution;
  if (!contribution) throw new Error("Expected a contribution");
  const evolve = f.worker(index => index === 0 ? pathRequest("development",{parentId:contribution.id,text:"Owned saved development",sourceIds:[]}) : pathComplete("unused"));
  await f.until(evolve.instance,admission.run.id,() => issued(f.db,admission.run.id).length === 1);
  const development = issued(f.db,admission.run.id)[0];
  if (!development) throw new Error("Expected the saved development");
  const contributionOwner = oneOwner(f.db,contribution.id), developmentOwner = oneOwner(f.db,development);
  f.store.saveConnection({id:"prior-connection",fromId:contribution.id,toId:f.subjectId,category:"related",proposedBy:"ai",explanation:"Already saved",sourceIds:[]});
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const client = new ScriptedClient(() => pathComplete("unused"));
  const discovery = new RunWorker({db:f.db,...f.sources,bindingFor:run => pathBinding(run,f.directory),
    connectionScreening:{identity:"owned-stop-screen",async judge() { entered.resolve(); await release.promise; return 1; }},
    native:bindings => new OpenCodeAdapter(client,bindings,bindings.assertActive.bind(bindings),f.sources.logger)});
  const flight = discovery.tick(contributionOwner.id);
  try {
    await bounded(entered.promise,"discovery screening entry");
    const service = new RunService({...f.sources,repository:f.runs,dispatcher:{submit:async () => {},observe:async () => "running"}});
    service.stop("user",admission.run.id);
    release.resolve(); await bounded(flight,"stopped discovery flight");
    await discovery.tick(contributionOwner.id);
    expect(f.run(admission.run.id).status).toBe("interrupted");
    expect(f.run(contributionOwner.id).status).toBe("interrupted");
    expect(f.run(developmentOwner.id).status).toBe("interrupted");
    expect(client.prompts).toEqual([]);
    expect(f.runs.reply(contributionOwner.id)).toBeNull();
    expect(f.store.getConnection("prior-connection")).toMatchObject({id:"prior-connection",proposedBy:"ai"});
  } finally { release.resolve(); await bounded(flight,"discovery cleanup"); discovery.pause(); await discovery.drain(); }
}));
