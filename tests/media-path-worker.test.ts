import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { MarkdownImportWorker } from "../src/agent/import-worker";
import type { ImportObservation, PersistedPrompt } from "../src/agent/opencode-adapter";
import { SearchService } from "../src/domain/search";
import { SqliteAgentBindings } from "../src/storage/agent-binding";
import { SqliteMediaAdmissions } from "../src/storage/media-admission";
import { SqliteSearchRepository } from "../src/storage/search";
import { bounded } from "./fixtures/media-files";
import { mediaPathFixture, pathBinding, pathComplete, pathRequest, promptStrings } from "./fixtures/media-path-worker";

test("normal Weaver reopens a retained source by its shared absolute file path", async () => mediaPathFixture(async f => {
  const run = f.ops.admitWeave("user",{subjectId:f.subjectId,triggerId:"compare-retained-source"});
  const w = f.worker(index => index === 0 ? pathRequest("readThought",{id:f.source.id}) : pathComplete("Compared the source."));
  await f.until(w.instance,run.id,() => w.client.prompts.length === 2);
  expect(w.client.scriptErrors).toEqual([]);
  const initial = w.client.prompts[0], reopened = w.client.prompts[1];
  if (!initial || !reopened) throw new Error("Expected normal initial and scoped-read continuation prompts");
  expect(initial.text).toContain(f.subjectId);
  expect(reopened.text).toContain(f.source.mediaSource.name);
  expect(f.capabilities.fullReadWitnesses(run.id)).toContainEqual({kind:"thought",id:f.source.id});
  expect(Array.from(await readFile(f.path))).toEqual(Array.from(f.bytes));
  // The normal completed read and continuation exist before checking the model's file access instructions.
  expect(promptStrings(reopened.text).some(text => text.includes(f.path))).toBe(true);
  expect(f.requestedSources).toEqual([f.source.mediaSource.id]);
  expect(promptStrings(reopened.text).join(" ")).toMatch(/(?:open|read|inspect).*(?:file|original)|(?:file|original).*(?:open|read|inspect)/i);
  expect(promptStrings(initial.text).some(text => text.includes(f.path))).toBe(false);
  await f.finish(w.instance,run.id);
  expect(f.run(run.id).status).toBe("completed");
}));

test("initial media weaving requests a summary and publishes its searchable interpretation through normal operations", async () => mediaPathFixture(async f => {
  const run = f.ops.admitWeave("user",{subjectId:f.source.id,triggerId:`media-import:${f.source.mediaSource.id}`});
  const summary = "Chromatic fixture summary: a red region beside a blue region.";
  const w = f.worker(index => index === 0 ? pathRequest("interpretation",{text:summary,sourceIds:[]}) : pathComplete("Saved the source summary."));
  await f.finish(w.instance,run.id);
  expect(w.client.scriptErrors).toEqual([]);
  expect(f.run(run.id).status).toBe("completed");
  const initial = w.client.prompts[0];
  if (!initial) throw new Error("Expected the ordinary initial Weaver prompt");
  const instructions = promptStrings(initial.text).join(" ");
  expect(instructions).toContain(f.path);
  expect(instructions).toMatch(/summari[sz]e|summary/i);
  expect(instructions).toMatch(/(?:open|read|inspect).*(?:file|original)|(?:file|original).*(?:open|read|inspect)/i);
  expect(f.requestedSources).toEqual([f.source.mediaSource.id]);
  expect(f.store.getThought(f.source.id)).toEqual(f.source);
  expect(Array.from(await readFile(f.path))).toEqual(Array.from(f.bytes));
  const children = f.rejection.listThoughts({actor:"user",mode:"normal"}).filter(thought => thought.parentId === f.source.id);
  expect(children).toHaveLength(1);
  const child = children[0];
  if (!child) throw new Error("Expected the saved interpretation child");
  expect(child).toMatchObject({author:"ai",kind:"ai-interpretation",text:summary,parentId:f.source.id});
  const step = f.steps.steps(run.id)[0];
  if (!step) throw new Error("Expected the completed interpretation request");
  expect(f.ops.stepReceipt(run.id,step.promptId)).toMatchObject({result:{type:"interpretation",thought:{id:child.id}}});
  expect(new SearchService(new SqliteSearchRepository(f.db)).search({actor:"user",mode:"normal"},"chromatic"))
    .toContainEqual(expect.objectContaining({kind:"thought",id:child.id}));
  expect(f.runs.reply(run.id)).toMatchObject({text:"Saved the source summary.",state:"complete"});
  await w.instance.tick(run.id);
  expect(f.rejection.listThoughts({actor:"user",mode:"normal"}).filter(thought => thought.parentId === f.source.id)).toEqual(children);
},null));

test("failed source weaving retries the retained original through the normal worker", async () => mediaPathFixture(async f => {
  const media = new SqliteMediaAdmissions(f.db,f.sources), sourceId = f.source.mediaSource.id;
  const metadata = f.db.query("SELECT rowid,* FROM media_sources ORDER BY rowid").all();
  const first = f.ops.admitWeave("user",{subjectId:f.source.id,triggerId:`media-import:${sourceId}`});
  const failed = f.worker(() => pathComplete("The original could not be understood."));
  await f.finish(failed.instance,first.id);
  expect(failed.client.scriptErrors).toEqual([]);
  expect(f.run(first.id).status).toBe("failed");
  expect(f.steps.cancellation(first.id)).toBe("pending");
  expect(failed.client.prompts).toHaveLength(1);
  const initial = failed.client.prompts[0], failureReply = f.runs.reply(first.id);
  if (!initial || !failureReply) throw new Error("Expected the failed source prompt and retained limitation reply");
  expect(promptStrings(initial.text)).toContain(f.path);
  expect(failureReply).toMatchObject({text:"The original could not be understood.",state:"complete",thoughtIds:[f.source.id]});
  expect(f.rejection.listThoughts({actor:"user",mode:"normal"}).filter(thought => thought.parentId === f.source.id)).toEqual([]);
  expect(f.store.getThought(f.source.id)).toEqual(f.source);
  expect(Array.from(await readFile(f.path))).toEqual(Array.from(f.bytes));
  expect(() => media.retry("user",sourceId,"retained-retry")).toThrow("Previous source processing is still active or unresolved");
  expect(f.db.query("SELECT id FROM runs WHERE weave_subject_id=?").all(f.source.id)).toEqual([{id:first.id}]);

  await bounded(failed.instance.tick(first.id),"normal failed-source cancellation");
  expect(failed.client.inboxCancellations).toEqual([{sessionID:initial.sessionID,inboxID:initial.id}]);
  expect(failed.client.interrupts).toEqual([initial.sessionID]);
  expect(f.steps.cancellation(first.id)).toBe("settled");
  expect(f.run(first.id).status).toBe("failed");
  expect(failed.client.prompts).toHaveLength(1);

  const retry = media.retry("user",sourceId,"retained-retry");
  expect(retry.id).not.toBe(first.id);
  expect(f.ops.weaveIntent(retry.id)).toEqual({subjectId:f.source.id,triggerId:`media-retry:${sourceId}:retained-retry`});
  expect(media.retry("user",sourceId,"retained-retry")).toEqual(retry);
  expect(() => media.retry("user",sourceId,"concurrent-retry")).toThrow("Previous source processing is still active or unresolved");
  const summary = "The retained image contains a red region beside a blue region.";
  const retried = f.worker(index => index === 0 ? pathRequest("interpretation",{text:summary,sourceIds:[]}) : pathComplete("Saved the retained source summary."));
  await f.finish(retried.instance,retry.id);
  expect(retried.client.scriptErrors).toEqual([]);
  expect(f.run(retry.id).status).toBe("completed");
  expect(retried.client.prompts).toHaveLength(2);
  const retryInitial = retried.client.prompts[0];
  if (!retryInitial) throw new Error("Expected the retry's normal initial prompt");
  expect(promptStrings(retryInitial.text)).toContain(f.path);
  expect(f.requestedSources).toEqual([sourceId,sourceId]);
  const children = f.rejection.listThoughts({actor:"user",mode:"normal"}).filter(thought => thought.parentId === f.source.id);
  expect(children).toHaveLength(1);
  const child = children[0], step = f.steps.steps(retry.id)[0];
  if (!child || !step) throw new Error("Expected the retry's canonical interpretation and request");
  expect(child).toMatchObject({author:"ai",kind:"ai-interpretation",text:summary,parentId:f.source.id});
  expect(f.ops.stepReceipt(retry.id,step.promptId)).toMatchObject({result:{type:"interpretation",thought:{id:child.id}}});
  expect(f.runs.reply(retry.id)).toMatchObject({text:"Saved the retained source summary.",state:"complete",thoughtIds:[f.source.id,child.id]});
  expect(f.runs.reply(first.id)).toEqual(failureReply);

  expect(media.retry("user",sourceId,"retained-retry")).toEqual(f.run(retry.id));
  expect(() => media.retry("user",sourceId,"duplicate-summary")).toThrow("Source already has an initial interpretation; use Evolve");
  await bounded(failed.instance.tick(first.id),"settled failed-source replay");
  await bounded(retried.instance.tick(retry.id),"completed source retry replay");
  expect(failed.client.prompts).toHaveLength(1);
  expect(retried.client.prompts).toHaveLength(2);
  expect(f.db.query("SELECT id FROM runs WHERE weave_subject_id=? ORDER BY rowid").all(f.source.id)).toEqual([{id:first.id},{id:retry.id}]);
  expect(f.db.query("SELECT rowid,* FROM media_sources ORDER BY rowid").all()).toEqual(metadata);
  expect(f.store.getThought(f.source.id)).toEqual(f.source);
  expect(Array.from(await readFile(f.path))).toEqual(Array.from(f.bytes));
  expect(f.rejection.listThoughts({actor:"user",mode:"normal"}).filter(thought => thought.parentId === f.source.id)).toEqual(children);
}));

test("Evolve receives the eligible ancestor's original path and exact user clarification", async () => mediaPathFixture(async f => {
  const admission = f.admissions.admit("user","evolve",{parentId:f.source.id,text:"Explain the color contrast."});
  const w = f.worker(() => pathComplete("The recorded original informed this reply."));
  await f.finish(w.instance,admission.run.id);
  expect(f.run(admission.run.id).status).toBe("completed");
  const initial = w.client.prompts[0];
  if (!initial) throw new Error("Expected an ordinary Evolve initial prompt");
  const clarification = f.source.mediaSource.clarification;
  if (clarification === null) throw new Error("Expected test-owned exact user clarification");
  const strings = promptStrings(initial.text);
  expect(strings.some(text => text.includes(f.path))).toBe(true);
  expect(strings).toContain(clarification);
  expect(f.requestedSources).toEqual([f.source.mediaSource.id]);
  expect(f.runs.reply(admission.run.id)).toMatchObject({text:"The recorded original informed this reply.",state:"complete"});
  expect(f.rejection.listThoughts({actor:"user",mode:"normal"}).filter(thought => thought.kind === "ai-interpretation")).toEqual([]);
}));

test("Evolve can reopen an independently read eligible supporting original without exposing paths in ordinary records", async () => mediaPathFixture(async f => {
  const admission = f.admissions.admit("user","evolve",{parentId:f.subjectId,text:"Use the retained source as a comparison."});
  const w = f.worker(index => index === 0 ? pathRequest("readThought",{id:f.source.id}) : pathComplete("Compared the supporting original."));
  await f.until(w.instance,admission.run.id,() => w.client.prompts.length === 2);
  const initial = w.client.prompts[0], next = w.client.prompts[1];
  if (!initial || !next) throw new Error("Expected the scoped supporting-source continuation");
  expect(promptStrings(initial.text).some(text => text.includes(f.path))).toBe(false);
  expect(promptStrings(next.text).some(text => text.includes(f.path))).toBe(true);
  expect(f.requestedSources).toEqual([f.source.mediaSource.id]);
  expect(JSON.stringify(f.store.getThought(f.source.id))).not.toContain(f.directory);
  expect(f.capabilities.fullReadWitnesses(admission.run.id)).toContainEqual({kind:"thought",id:f.source.id});
  await f.finish(w.instance,admission.run.id);
  expect(f.run(admission.run.id).status).toBe("completed");
}));

test("rejecting then restoring a source fences a held scoped path read and its late publication", async () => mediaPathFixture(async f => {
  const run = f.ops.admitWeave("user",{subjectId:f.subjectId,triggerId:"held-source-read"});
  const w = f.worker(index => index === 0 ? pathRequest("readThought",{id:f.source.id}) :
    pathRequest("interpretation",{text:"A late result must not be saved",sourceIds:[f.source.id]}));
  await f.until(w.instance,run.id,() => {
    const step = f.steps.steps(run.id).at(-1);
    return step?.state === "completed" && step.envelope?.kind === "request";
  });
  const hold = f.holdPath(), before = f.run(run.id);
  let flight: Promise<void> | undefined;
  try {
    let boundary = "tick-completed";
    // A committed descriptor may be processed on its own tick before resolving the path.
    for (let tick = 0; tick < 3 && boundary !== "path-entered"; tick++) {
      flight = w.instance.tick(run.id);
      boundary = await bounded(Promise.race([hold.entered.then(() => "path-entered"),flight.then(() => "tick-completed")]),"scoped path read entry");
    }
    expect(boundary).toBe("path-entered");
    if (!flight) throw new Error("Expected the actual worker's held path read");
    expect(f.capabilities.fullReadWitnesses(run.id)).toContainEqual({kind:"thought",id:f.source.id});
    f.rejection.rejectThought("user",f.source.id);
    expect(f.run(run.id)).toMatchObject({status:"interrupted",generation:before.generation + 1});
    f.rejection.restoreThought("user",f.source.id);
    hold.release();
    await bounded(flight,"revoked shared-file callback");
    await w.instance.tick(run.id);
    expect(f.run(run.id).status).toBe("interrupted");
    expect(w.client.prompts).toHaveLength(1);
    expect(f.runs.reply(run.id)).toBeNull();
    expect(f.rejection.listThoughts({actor:"user",mode:"normal"}).filter(thought => thought.parentId === f.subjectId)).toEqual([]);
    expect(Array.from(await readFile(f.path))).toEqual(Array.from(f.bytes));
  } finally { hold.release(); if (flight) await bounded(flight,"held path fixture release"); }
}));

test("Search Export and Markdown segmentation receive no original path or native file access", async () => mediaPathFixture(async f => {
  const exported = f.exports.admit("user",{request:"Describe the recorded source metadata."});
  const exportWorker = f.worker(index => index === 0 ? pathRequest("readThought",{id:f.source.id}) :
    {version:1,kind:"report",markdown:"Only the recorded descriptor is available.",sourceThoughtIds:[]});
  await f.finish(exportWorker.instance,exported.id);
  expect(f.run(exported.id).status).toBe("completed");

  const sessions = f.store.searchSessions(f.sources), session = sessions.create("user","path-search",{}).session;
  const composer = sessions.openComposer("user",session.id);
  const turn = sessions.admitTurn("user",session.id,"path-turn",{text:"Read the source metadata.",startingThoughtIds:[f.source.id],
    requestClock:{at:f.sources.now(),timeZone:"UTC"},composerId:composer.composerId,contextToken:composer.contextToken});
  const searchWorker = f.worker(index => index === 0 ? pathRequest("readThought",{id:f.source.id}) :
    {version:1,kind:"search-reply",reply:"Read the descriptor only.",disposition:"done",sourceThoughtIds:[]});
  await f.finish(searchWorker.instance,turn.run.id);
  expect(f.run(turn.run.id).status).toBe("completed");
  for (const [run,worker] of [[exported,exportWorker],[turn.run,searchWorker]] as const) {
    expect(worker.client.scriptErrors).toEqual([]);
    expect(worker.client.prompts).toHaveLength(2);
    const descriptor = worker.client.prompts[1];
    if (!descriptor) throw new Error("Expected an actual restricted descriptor-read continuation");
    expect(descriptor.text).toContain(f.source.mediaSource.name);
    for (const prompt of worker.client.prompts) expect(prompt.text).not.toContain(f.directory);
    expect(new SqliteAgentBindings(f.db).get(run.id)?.permissions).toEqual([{action:"*",resource:"*",effect:"deny"}]);
  }

  const batch = f.imports.createBatch("user","path-segmentation");
  const file = f.imports.admitFile("user",batch.id,"markdown-file","note.md",new TextEncoder().encode("A test-owned paragraph.\n\nAnother paragraph."));
  const submitted: PersistedPrompt[] = [];
  const segmenter = new MarkdownImportWorker({db:f.db,...f.sources,native:bindings => ({
    bindingFor:async run => pathBinding(run,"/tmp/opencode/segmentation-fixture"),
    ensureSession:async () => {},
    submit:async (claim,_binding,prompt) => {
      bindings.assertImportPreparation(claim,[prompt]); bindings.recordImportSubmission(claim,prompt); submitted.push(prompt);
    },
    observe:async (): Promise<ImportObservation> => ({state:"pending"}),
    cancel:async (): Promise<"pending" | "settled"> => "pending",
  })});
  try {
    const work = segmenter.candidates(0,null,10).items.find(item => item.runId === file.runId);
    if (!work) throw new Error("Expected admitted native segmentation work");
    await bounded(segmenter.tick(work),"restricted segmentation prompt");
    expect(submitted).toHaveLength(1);
    const prompt = submitted[0];
    if (!prompt) throw new Error("Expected an actual segmentation submission");
    expect(prompt.input).not.toContain(f.directory);
    expect(new SqliteAgentBindings(f.db).get(work.runId)?.permissions).toEqual([{action:"*",resource:"*",effect:"deny"}]);
    expect(f.requestedSources).toEqual([]);
  } finally { segmenter.pause(); }
}));

test("clearing a media title schedules title-only work without reopening or resummarizing the source", async () => mediaPathFixture(async f => {
  f.titles.setUser("user",f.source.id,"User label");
  f.titles.setUser("user",f.source.id,null);
  const invitation = f.db.query<{id:string},[string]>("SELECT id FROM runs WHERE kind='weave' AND weave_subject_id=? ORDER BY rowid DESC LIMIT 1").get(f.source.id);
  if (!invitation) throw new Error("Expected the normal title-clear invitation");
  const w = f.worker(index => index === 0 ? pathRequest("title-fill",{title:"Two colored regions"}) : pathComplete("Regenerated the title only."));
  await f.finish(w.instance,invitation.id);
  expect(f.run(invitation.id).status).toBe("completed");
  expect(f.store.getThought(f.source.id)).toMatchObject({title:"Two colored regions",titleAuthor:"ai"});
  expect(w.client.prompts).toHaveLength(2);
  for (const prompt of w.client.prompts) expect(prompt.text).not.toContain(f.directory);
  expect(f.requestedSources).toEqual([]);
  expect(f.rejection.listThoughts({actor:"user",mode:"normal"}).filter(thought => thought.parentId === f.source.id)).toEqual([]);
}));
