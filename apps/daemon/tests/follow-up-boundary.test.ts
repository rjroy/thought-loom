import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { parseItemView, parseRelationshipView, parseFollowUpRetryReceipt, parseFollowUpStatusView, type FollowUpJobView } from "@thoughtloom/contracts";
import { backgroundActions, followUpFixture } from "./follow-up-support";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
async function fixture() { return followUpFixture((close) => cleanups.push(close)); }
function required<T>(value: T | null | undefined): T { expect(value).not.toBeNull(); expect(value).not.toBeUndefined(); if (value === null || value === undefined) throw new Error("Missing fixture result"); return value; }
function job(jobs: FollowUpJobView[], id: string) { return required(jobs.find((entry) => entry.id === id)); }
const headers = (key: string) => ({ "content-type": "application/json", "idempotency-key": key });

test("native follow-up grants nine background actions, protects USER text, and a real successful write cannot recurse", async () => {
  const f = await fixture(), origin = await f.origin();
  const retained = required(f.read((db) => db.query<{ text: string }, [string]>("SELECT text FROM sources WHERE id=?").get(origin.turn.sourceId)));
  const correctedResponse = await f.correct(origin.item.id, origin.item.current.id, retained.text, origin.turn.sourceId);
  expect(correctedResponse.status).toBe(200);
  const corrected = required(parseItemView(await correctedResponse.json()));
  const secondItem = f.knowledge.createItem({ actor: "ai", operationId: "protected-endpoint", runId: "fixture-seed" }, { kind: "interpretation", sourceId: f.root.id, text: "Another root claim", evidenceSourceIds: [f.root.id] });
  const claim = f.knowledge.createRelationship({ actor: "ai", operationId: "protected-relationship", runId: "fixture-seed" }, { fromItemId: origin.item.id, toItemId: secondItem.id, type: "suggests", rationale: "Tentative root claim.", evidenceSourceIds: [f.root.id] });
  const rejection = await f.app.request(`/relationships/${claim.id}/reject`, { method: "POST", headers: headers("protect-rejected-claim"), body: JSON.stringify({ expectedVersionId: claim.current.id, rationale: "The user rejected this claim.", evidenceSourceIds: [f.root.id] }) });
  expect(rejection.status).toBe(200); const rejected = required(parseRelationshipView(await rejection.json()));
  const native = await f.native(), started = await native.worker.startNext();
  expect(started.kind).toBe("started"); // Current production's explicit unsupported-kind RED.
  if (started.kind !== "started") throw new Error("Expected native follow-up admission");
  expect(f.owned(started.run).kind).toBe("follow_up"); expect(started.run.kind).toBe("follow_up");
  const grant = required(f.read((db) => db.query<{ sources: string; operations: string; revoked: number }, [string]>("SELECT source_ids AS sources,operations,revoked FROM owned_grants WHERE run_id=?").get(started.run.runId)));
  expect(JSON.parse(grant.operations)).toEqual([...backgroundActions].sort());
  expect(JSON.parse(grant.operations)).toHaveLength(9); expect(JSON.parse(grant.operations)).not.toContain("record_idea");
  expect(JSON.parse(grant.sources)).toEqual([f.root.id, origin.turn.sourceId].sort()); expect(grant.revoked).toBe(0);
  expect((await f.tool(started.run, "record_idea", { rootSourceId: f.root.id, turnSourceId: origin.turn.sourceId, dialogueId: f.dialogue.id, turnId: origin.turn.id, text: "Forbidden background idea", evidenceSourceIds: [f.root.id, origin.turn.sourceId] })).status).toBe(403);
  expect((await f.tool(started.run, "revise_interpretation", { itemId: origin.item.id, expectedVersionId: corrected.current.id, text: "Forbidden overwrite", evidenceSourceIds: [f.root.id] })).status).toBe(403);
  expect((await f.tool(started.run, "read_relationship", { relationshipId: claim.id })).status).toBe(200);
  expect((await f.tool(started.run, "revise_relationship", { relationshipId: claim.id, expectedVersionId: rejected.current.id, status: "active", rationale: "Forbidden reactivation", evidenceSourceIds: [f.root.id] })).status).toBe(403);
  const written = await f.tool(started.run, "record_interpretation", { sourceId: f.root.id, text: "An actual targeted implication.", evidenceSourceIds: [f.root.id, origin.turn.sourceId] });
  expect(written.status).toBe(200); const item = await written.json() as { id: string; current: { id: string } };
  expect(f.read((db) => db.query("SELECT f.item_id,f.id AS version_id FROM formulations f JOIN knowledge_receipts k ON k.operation_id=f.operation_id WHERE f.run_id=?").all(started.run.runId))).toEqual([{ item_id: item.id, version_id: item.current.id }]);
  native.setOutcome(started.run, "succeeded"); await native.worker.recover();
  expect(f.jobs()).toEqual([{ id: started.run.jobId, status: "completed" }]);
  expect(f.knowledge.getItem(origin.item.id).current.id).toBe(corrected.current.id);
  expect(f.knowledge.getRelationship(claim.id).current.id).toBe(rejected.current.id);
  expect(f.read((db) => db.query("SELECT revoked FROM owned_grants WHERE run_id=?").get(started.run.runId))).toEqual({ revoked: 1 });
  await native.makeWorker().recover(); expect((await native.worker.startNext()).kind).toBe("empty");
  expect(native.prompts).toEqual([started.run]); expect(f.jobs()).toHaveLength(1);
  expect(await (await f.app.request(`/sources/${f.root.id}`)).json()).toMatchObject(f.root);
});

test("concrete maintained mapping freezes bounded current context; later user changes create another pending job without retargeting admission", async () => {
  const f = await fixture(), oldText = `OLD_AI_VERSION_${"x".repeat(6_000)}`, origin = await f.origin(oldText);
  const retained = required(f.read((db) => db.query<{ text: string }, [string]>("SELECT text FROM sources WHERE id=?").get(origin.turn.sourceId)));
  const correction = await f.correct(origin.item.id, origin.item.current.id, retained.text, origin.turn.sourceId);
  expect(correction.status).toBe(200); const current = required(parseItemView(await correction.json()));
  f.knowledge.createItem({ actor: "ai", operationId: "unrelated-seed", runId: "fixture-seed" }, { kind: "interpretation", sourceId: f.root.id, text: `UNRELATED_CORPUS_DETAIL_${"y".repeat(6_000)}`, evidenceSourceIds: [f.root.id] });
  const native = await f.native({ maintained: true, contextCharacters: 5_000 }), started = await native.worker.startNext();
  expect(started.kind).toBe("started");
  if (started.kind !== "started") throw new Error("Expected concrete maintained-client admission");
  expect(native.creations).toHaveLength(1); expect(native.nativePrompts).toHaveLength(1);
  const prompt = required(native.nativePrompts[0]);
  expect(prompt).toMatchObject({ sessionID: started.run.sessionId, id: started.run.promptId });
  for (const value of [f.root.text, origin.item.id, current.current.id, retained.text]) expect(prompt.text).toContain(value);
  expect(prompt.text.length).toBeLessThanOrEqual(5_000);
  expect(prompt.text).not.toContain(oldText); expect(prompt.text).not.toContain("UNRELATED_CORPUS_DETAIL_");
  const snapshot = () => f.read((db) => ({ command: db.query("SELECT payload,payload_hash,attempted FROM native_commands WHERE run_id=?").get(started.run.runId),
    grant: db.query("SELECT session_id,run_id,location,agent,source_ids,operations,scope_hash FROM owned_grants WHERE run_id=?").get(started.run.runId) }));
  const frozen = snapshot(), before = job((await f.status(native.worker)).jobs, started.run.jobId);
  expect(before.targets).toEqual(expect.arrayContaining([{ kind: "item", id: origin.item.id, versionId: origin.item.current.id }, { kind: "item", id: origin.item.id, versionId: current.current.id }]));
  const text = "A later retained correction while background execution is active.", turn = await f.submit(text);
  const laterResponse = await f.correct(origin.item.id, current.current.id, text, turn.sourceId);
  expect(laterResponse.status).toBe(200); const later = required(parseItemView(await laterResponse.json()));
  expect(snapshot()).toEqual(frozen);
  const after = await f.status(native.worker), admitted = job(after.jobs, started.run.jobId), pending = required(after.jobs.find((entry) => entry.id !== started.run.jobId && entry.status === "queued"));
  expect(admitted.origins).toEqual(before.origins); expect(admitted.targets).toEqual(before.targets);
  expect(pending.targets).toContainEqual({ kind: "item", id: origin.item.id, versionId: later.current.id });
  expect(pending.origins).toContainEqual({ kind: "user", operationId: f.operation(later.current.id) });
  expect(f.jobs()).toHaveLength(2); await f.status(native.worker); expect(native.nativePrompts).toHaveLength(1);
});

test("definitive failure uses bounded fenced retry receipts; uncertain admission stays owned and never resubmits", async () => {
  const f = await fixture(), origin = await f.origin(), native = await f.native({ maxAttempts: 2 });
  const started = await native.worker.startNext(); expect(started.kind).toBe("started");
  if (started.kind !== "started") throw new Error("Expected first follow-up attempt");
  const app = f.http(native.worker), path = `/sources/${f.root.id}/follow-ups/${started.run.jobId}/retry`;
  const post = (key: string, expectedRunId: string, route = path) => app.request(route, { method: "POST", headers: headers(key), body: JSON.stringify({ expectedRunId }) });
  expect((await post("running", started.run.runId)).status).toBe(409);
  native.setOutcome(started.run, "failed"); await native.worker.recover();
  expect(job((await f.status(native.worker)).jobs, started.run.jobId)).toMatchObject({ status: "failed", run: { id: started.run.runId }, attempts: 1, actions: { retry: true } });
  expect(job((await f.status()).jobs, started.run.jobId).actions.retry).toBe(false);
  expect((await f.http().request(path, { method: "POST", headers: headers("unavailable"), body: JSON.stringify({ expectedRunId: started.run.runId }) })).status).toBe(503);
  expect((await post("wrong-root", started.run.runId, `/sources/${origin.turn.sourceId}/follow-ups/${started.run.jobId}/retry`)).status).toBe(404);
  expect((await app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRunId: started.run.runId }) })).status).toBe(400);
  expect((await app.request(path, { method: "POST", headers: headers("forged-actor"), body: JSON.stringify({ expectedRunId: started.run.runId, actor: "ai" }) })).status).toBe(400);
  expect((await post("stale-first", "run-stale")).status).toBe(409);
  const captureBefore = await (await app.request(`/sources/${f.root.id}/weaving`)).json();
  expect((await post("capture-is-not-followup", started.run.runId, `/sources/${f.root.id}/weaving/retry`)).status).toBe(409);
  const accepted = await post("retry-stable", started.run.runId); expect(accepted.status).toBe(202);
  const receipt = required(parseFollowUpRetryReceipt(await accepted.json()));
  expect(receipt).toMatchObject({ sourceId: f.root.id, jobId: started.run.jobId, expectedRunId: started.run.runId, status: "queued" });
  expect(job((await f.status(native.worker)).jobs, started.run.jobId)).toMatchObject({ status: "queued", run: null, attempts: 1 });
  expect(native.prompts).toHaveLength(1); expect(f.jobs()).toHaveLength(1);
  const restarted = native.makeWorker();
  const replay = await f.http(restarted).request(path, { method: "POST", headers: headers("retry-stable"), body: JSON.stringify({ expectedRunId: started.run.runId }) });
  expect(replay.status).toBe(202); expect(await replay.json()).toEqual(receipt);
  const retried = await restarted.startNext(); expect(retried.kind).toBe("started");
  if (retried.kind !== "started") throw new Error("Expected second bounded attempt");
  expect(retried.run.jobId).toBe(started.run.jobId); expect(retried.run.runId).not.toBe(started.run.runId); expect(retried.run.sessionId).not.toBe(started.run.sessionId); expect(retried.run.promptId).not.toBe(started.run.promptId);
  expect((await post("retry-stable", retried.run.runId)).status).toBe(409);
  native.setOutcome(retried.run, "failed"); await restarted.recover();
  expect(job((await f.status(restarted)).jobs, started.run.jobId)).toMatchObject({ status: "failed", run: { id: retried.run.runId }, attempts: 2, actions: { retry: false } });
  expect((await post("exhausted", retried.run.runId)).status).toBe(409);
  expect((await post("retry-stable", started.run.runId)).status).toBe(202);
  expect(native.prompts).toEqual([started.run, retried.run]); expect(await (await app.request(`/sources/${f.root.id}/weaving`)).json()).toEqual(captureBefore);

  const uncertain = await fixture(); await uncertain.origin(); const unknown = await uncertain.native({ uncertain: true });
  const attempted = await unknown.worker.startNext(); expect(attempted.kind).toBe("started");
  if (attempted.kind !== "started") throw new Error("Expected uncertain admission attempt");
  const reopened = unknown.makeWorker(); await reopened.recover(); await reopened.recover();
  expect(job((await uncertain.status(reopened)).jobs, attempted.run.jobId)).toMatchObject({ status: "uncertain", run: { id: attempted.run.runId }, actions: { retry: false } });
  const denied = await uncertain.http(reopened).request(`/sources/${uncertain.root.id}/follow-ups/${attempted.run.jobId}/retry`, { method: "POST", headers: headers("never-resubmit"), body: JSON.stringify({ expectedRunId: attempted.run.runId }) });
  expect(denied.status).toBe(409); expect((await reopened.startNext()).kind).toBe("empty"); expect(unknown.prompts).toEqual([attempted.run]);
});

test("bounded status preserves relationship/origin history and confirmed versions, retaining active and pending work ahead of recent jobs", async () => {
  const f = await fixture(), other = await f.capture("A controlled neighboring original."); await f.drainCapture();
  const neighbor = f.knowledge.createItem({ actor: "ai", operationId: "neighbor-seed", runId: "fixture-seed" }, { kind: "interpretation", sourceId: other.id, text: "Neighbor claim", evidenceSourceIds: [other.id] });
  const first = await f.startTurn("First relationship discussion."), a = await f.idea(first, "First changed formulation.");
  async function readNeighbor(run: typeof first.run, relationshipId?: string) {
    if (relationshipId) expect((await f.tool(run, "read_relationship", { relationshipId })).status).toBe(200);
    expect((await f.tool(run, "read_item", { itemId: a.id })).status).toBe(200);
    expect((await f.tool(run, "read_item", { itemId: neighbor.id })).status).toBe(200);
    expect((await f.tool(run, "read_source", { sourceId: other.id })).status).toBe(200);
  }
  await readNeighbor(first.run);
  const linked = await f.tool(first.run, "record_relationship", { fromItemId: a.id, toItemId: neighbor.id, fromVersionId: a.current.id, toVersionId: neighbor.current.id, type: "suggests", rationale: "First evidenced rationale.", evidenceSourceIds: [f.root.id, other.id] });
  expect(linked.status).toBe(200); const relationship = await linked.json() as { id: string; current: { id: string } }; await f.finishTurn(first.run);
  const second = await f.startTurn("Second relationship discussion."), b = await f.idea(second, "Second changed formulation.");
  await readNeighbor(second.run, relationship.id);
  const revision = await f.tool(second.run, "revise_relationship", { relationshipId: relationship.id, expectedVersionId: relationship.current.id, status: "active", rationale: "A revised evidenced rationale.", evidenceSourceIds: [f.root.id, other.id] });
  expect(revision.status).toBe(200); const revised = await revision.json() as { current: { id: string } }; await f.finishTurn(second.run);
  const response = await f.http().request(`/sources/${f.root.id}/follow-ups`); expect(response.status).toBe(200);
  const initial = required(parseFollowUpStatusView(await response.json())), queued = required(initial.jobs[0]);
  expect(initial.worker).toEqual({ configured: false, state: "unavailable" }); expect(queued.actions.retry).toBe(false);
  expect(queued.origins).toEqual(expect.arrayContaining([
    { kind: "dialogue", runId: first.run.runId, dialogueId: f.dialogue.id, turnId: first.turn.id, turnSourceId: first.turn.sourceId },
    { kind: "dialogue", runId: second.run.runId, dialogueId: f.dialogue.id, turnId: second.turn.id, turnSourceId: second.turn.sourceId },
  ]));
  expect(queued.targets).toEqual(expect.arrayContaining([{ kind: "item", id: a.id, versionId: a.current.id }, { kind: "item", id: b.id, versionId: b.current.id },
    { kind: "relationship", id: relationship.id, versionId: relationship.current.id }, { kind: "relationship", id: relationship.id, versionId: revised.current.id }]));
  expect(queued.targets).toHaveLength(4); expect(queued.changes).toEqual([]); expect(queued.recordedChanges).toBe(0);
  const native = await f.native(), started = await native.worker.startNext(); expect(started.kind).toBe("started");
  if (started.kind !== "started") throw new Error("Expected follow-up for status fixture");
  const interpretation = await f.tool(started.run, "record_interpretation", { sourceId: f.root.id, text: "Confirmed follow-up formulation.", evidenceSourceIds: [f.root.id] });
  expect(interpretation.status).toBe(200); const written = await interpretation.json() as { id: string; current: { id: string } };
  await readNeighbor(started.run, relationship.id);
  const relChange = await f.tool(started.run, "revise_relationship", { relationshipId: relationship.id, expectedVersionId: revised.current.id, status: "active", rationale: "Confirmed follow-up rationale.", evidenceSourceIds: [f.root.id, other.id] });
  expect(relChange.status).toBe(200); const relWritten = await relChange.json() as { current: { id: string } };
  native.setOutcome(started.run, "succeeded"); await native.worker.recover();
  const complete = job((await f.status(native.worker)).jobs, started.run.jobId);
  expect(complete.recordedChanges).toBe(2); expect(complete.changes).toHaveLength(2);
  expect(complete.changes).toEqual(expect.arrayContaining([{ kind: "interpretation", id: written.id, versionId: written.current.id }, { kind: "relationship", id: relationship.id, versionId: relWritten.current.id }]));
  expect(complete.targets).toEqual(queued.targets); // Immutable history is not rewritten to latest-only.
  const limited = job((await f.status(native.worker, { jobs: 2, origins: 1, targets: 2, changes: 1 })).jobs, started.run.jobId);
  expect(limited.origins).toHaveLength(1); expect(limited.targets).toHaveLength(2); expect(limited.changes).toHaveLength(1);
  expect(limited).toMatchObject({ originsTruncated: true, targetsTruncated: true, changesTruncated: true, recordedChanges: 2 });
  expect(complete.changes).toContainEqual(limited.changes[0]);

  await f.origin("A newer completed follow-up origin."); const recent = await native.worker.startNext(); expect(recent.kind).toBe("started");
  if (recent.kind !== "started") throw new Error("Expected recent follow-up"); native.setOutcome(recent.run, "succeeded"); await native.worker.recover();
  const latestOrigin = await f.origin("An active follow-up origin."), active = await native.worker.startNext(); expect(active.kind).toBe("started");
  if (active.kind !== "started") throw new Error("Expected active follow-up");
  const text = "A retained correction while active work is being inspected.", turn = await f.submit(text);
  const corrected = await f.correct(latestOrigin.item.id, latestOrigin.item.current.id, text, turn.sourceId); expect(corrected.status).toBe(200);
  const bounded = await f.status(native.worker, { jobs: 2, origins: 1, targets: 2, changes: 1 });
  expect(bounded.jobs).toHaveLength(2); expect(bounded.truncated).toBe(true);
  expect(bounded.jobs).toEqual(expect.arrayContaining([expect.objectContaining({ id: active.run.jobId, status: "running" }), expect.objectContaining({ status: "queued" })]));
  const submitted = native.prompts.length; await f.status(native.worker); await f.status(native.worker); expect(native.prompts).toHaveLength(submitted);
  const json = JSON.stringify(bounded);
  for (const privateField of [f.databasePath, "test-owned-follow-up-credential", "registrationFile", "sessionID", "sessionId", "promptID", "promptId"]) expect(json).not.toContain(privateField);
  expect((await f.http().request("/sources/missing-root/follow-ups")).status).toBe(404);
});

test("trusted relationship rejection/restoration schedule both endpoint roots once, not arbitrary evidence roots, retaining both versions", async () => {
  const f = await fixture(), other = await f.capture("Other endpoint original."); await f.drainCapture();
  const evidenceOnly = await f.capture("Evidence does not make this a relationship endpoint."); await f.drainCapture();
  const laterEndpoint = await f.capture("A separate endpoint for the transaction-failure check."); await f.drainCapture();
  const a = f.knowledge.createItem({ actor: "ai", operationId: "endpoint-a", runId: "fixture-seed" }, { kind: "interpretation", sourceId: f.root.id, text: "Endpoint A", evidenceSourceIds: [f.root.id] });
  const b = f.knowledge.createItem({ actor: "ai", operationId: "endpoint-b", runId: "fixture-seed" }, { kind: "interpretation", sourceId: other.id, text: "Endpoint B", evidenceSourceIds: [other.id] });
  const relationship = f.knowledge.createRelationship({ actor: "ai", operationId: "relationship-seed", runId: "fixture-seed" }, { fromItemId: a.id, toItemId: b.id, type: "suggests", rationale: "Controlled claim.", evidenceSourceIds: [f.root.id, other.id, evidenceOnly.id] });
  const post = (action: "reject" | "restore", key: string, body: object) => f.app.request(`/relationships/${relationship.id}/${action}`, { method: "POST", headers: headers(key), body: JSON.stringify(body) });
  const input = { expectedVersionId: relationship.current.id, rationale: "The user rejects this inference.", evidenceSourceIds: [f.root.id, other.id, evidenceOnly.id] };
  expect((await post("reject", "forged-user", { ...input, actor: "ai" })).status).toBe(400); expect(f.jobs()).toEqual([]);
  const rejectedResponse = await post("reject", "reject-once", input); expect(rejectedResponse.status).toBe(200);
  const rejected = required(parseRelationshipView(await rejectedResponse.json())); expect(rejected.current.author).toBe("user"); expect(rejected.current.status).toBe("rejected");
  expect(await (await post("reject", "reject-once", input)).json()).toEqual(rejected);
  const rows = f.read((db) => db.query<{ id: string; sourceId: string }, []>("SELECT id,source_id AS sourceId FROM jobs WHERE kind='follow_up' ORDER BY source_id").all());
  expect(rows.map((row) => row.sourceId).sort()).toEqual([f.root.id, other.id].sort());
  const restore = { expectedVersionId: rejected.current.id, restoreVersionId: relationship.current.id };
  const restoredResponse = await post("restore", "restore-once", restore); expect(restoredResponse.status).toBe(200);
  const restored = required(parseRelationshipView(await restoredResponse.json())); expect(restored.current.author).toBe("user"); expect(restored.current.status).toBe("active");
  expect(await (await post("restore", "restore-once", restore)).json()).toEqual(restored);
  expect((await post("restore", "stale-restore", restore)).status).toBe(409);
  expect(f.read((db) => db.query("SELECT id,source_id AS sourceId FROM jobs WHERE kind='follow_up' ORDER BY source_id").all())).toEqual(rows);
  for (const sourceId of [f.root.id, other.id]) {
    const response = await f.http().request(`/sources/${sourceId}/follow-ups`); expect(response.status).toBe(200);
    const value = required(parseFollowUpStatusView(await response.json())), pending = required(value.jobs[0]);
    expect(pending.targets).toEqual(expect.arrayContaining([{ kind: "relationship", id: relationship.id, versionId: rejected.current.id }, { kind: "relationship", id: relationship.id, versionId: restored.current.id }]));
    expect(pending.origins).toEqual(expect.arrayContaining([{ kind: "user", operationId: f.operation(rejected.current.id, true) }, { kind: "user", operationId: f.operation(restored.current.id, true) }]));
  }
  const evidence = await f.http().request(`/sources/${evidenceOnly.id}/follow-ups`); expect(evidence.status).toBe(200);
  expect(required(parseFollowUpStatusView(await evidence.json())).jobs).toEqual([]);
  expect(f.knowledge.getRelationship(relationship.id).history.map((entry) => entry.id)).toEqual([relationship.current.id, rejected.current.id, restored.current.id]);

  // Unlike settlement rollback above, this failure crosses the trusted USER
  // mutation/receipt boundary. No revision or acknowledgment may escape alone.
  const c = f.knowledge.createItem({ actor: "ai", operationId: "endpoint-c", runId: "fixture-seed" }, { kind: "interpretation", sourceId: evidenceOnly.id, text: "Endpoint C", evidenceSourceIds: [evidenceOnly.id] });
  const d = f.knowledge.createItem({ actor: "ai", operationId: "endpoint-d", runId: "fixture-seed" }, { kind: "interpretation", sourceId: laterEndpoint.id, text: "Endpoint D", evidenceSourceIds: [laterEndpoint.id] });
  const separate = f.knowledge.createRelationship({ actor: "ai", operationId: "separate-seed", runId: "fixture-seed" }, { fromItemId: c.id, toItemId: d.id, type: "supports", rationale: "Separate controlled claim.", evidenceSourceIds: [evidenceOnly.id, laterEndpoint.id] });
  const command = () => f.app.request(`/relationships/${separate.id}/reject`, { method: "POST", headers: headers("atomic-user-command"), body: JSON.stringify({ expectedVersionId: separate.current.id, rationale: "Reject atomically.", evidenceSourceIds: [evidenceOnly.id, laterEndpoint.id] }) });
  const db = new Database(f.databasePath);
  try { db.run("CREATE TRIGGER fixture_fail_user_followup BEFORE INSERT ON jobs WHEN NEW.kind='follow_up' BEGIN SELECT RAISE(ABORT,'fixture failure'); END"); } finally { db.close(); }
  expect((await command()).status).toBe(503);
  expect(f.knowledge.getRelationship(separate.id).current.id).toBe(separate.current.id);
  expect(f.read((db) => db.query("SELECT COUNT(*) AS n FROM knowledge_receipts WHERE result_id=?").get(separate.id))).toEqual({ n: 1 });
  const reopen = new Database(f.databasePath); try { reopen.run("DROP TRIGGER fixture_fail_user_followup"); } finally { reopen.close(); }
  const committed = await command(); expect(committed.status).toBe(200); const committedView = await committed.json();
  expect(await (await command()).json()).toEqual(committedView);
  expect(f.read((db) => db.query<{ sourceId: string }, []>("SELECT source_id AS sourceId FROM jobs WHERE kind='follow_up'").all()).map((row) => row.sourceId).sort())
    .toEqual([f.root.id, other.id, evidenceOnly.id, laterEndpoint.id].sort());
});
