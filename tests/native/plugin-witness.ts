// Explicit opt-in integration fixture. Importing this file never starts a process.
// Security review precedes execution; this is NOT an ordinary *.test.ts test.
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as pause } from "node:timers/promises";
import { createApp } from "../../apps/daemon/src/app";
import { provisionNativeSetup } from "../../apps/daemon/src/native-setup";
import { NativeWeavingAdapter } from "../../apps/daemon/src/native-adapter";
import { findSource, openDatabase } from "../../apps/daemon/src/storage";
import { WeavingWorker, type WeavingRun } from "../../apps/daemon/src/weaving";
import { OpenCode, Service, type OpenCodeClient, type SessionMessageInfo } from "../../apps/daemon/tests/native-client-support";
import { parseNativeIdentity, toolRecord, type NativeIdentity } from "../../packages/contracts/src/tools";
import { parseDialogueTurnReceipt, parseDialogueView } from "../../packages/contracts/src/dialogue";
import { AGENT, ANCHOR, DIALOGUE_OPERATIONS, MODEL, NATIVE_BINARY, OPERATIONS, ROOT_PREFIX,
  WitnessGuardError, contained, guardedLaunch, pathsFor, requireOptIn, witnessConfig } from "./plugin-isolation";
import { validatePluginRegistry } from "./plugin-isolation";
import { inspectBinary, nodeIO } from "./node-io";
import { FINAL, INTERPRETATION, ORIGINAL, READ_CALL, WRITE_CALL, DIALOGUE_FINAL, IDEA, USER_INPUT, IDEA_CALL, TURN_READ_CALL,
  PROVIDER_LIMITS, fixtureProvider, type DialogueFixture } from "./fixture-provider";
import { startOwnedNative } from "./owned-native";
import { reviewedBundle } from "./plugin-bundle";

function check(value: unknown, code: string): asserts value { if (!value) throw new WitnessGuardError(code); }
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
async function privateWrite(path: string, content: string) {
  const handle = await open(path, "wx", 0o600);
  try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
}
type Accepted = { native: NativeIdentity; action: string };
function requestOptions(signal: AbortSignal) { return { signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]) }; }
async function canonicalHistory(client: OpenCodeClient, run: WeavingRun, signal: AbortSignal) {
  const result: SessionMessageInfo[] = [], seen = new Set<string>(), cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const next = await client.message.list({ sessionID: run.sessionId, limit: 50, ...(cursor ? { cursor } : { order: "asc" as const }) }, requestOptions(signal));
    for (const message of next.data) { check(!seen.has(message.id), "witness_history_duplicate"); seen.add(message.id); result.push(message); }
    if (!next.cursor.next) return result;
    check(!cursors.has(next.cursor.next), "witness_history_cursor_loop");
    cursor = next.cursor.next; cursors.add(cursor);
  }
  throw new WitnessGuardError("witness_history_page_budget");
}
function verifyContext(history: SessionMessageInfo[], run: WeavingRun, accepted: Accepted[], kind: "capture" | "dialogue") {
  check(history.filter((message) => message.type === "user").length === 1 && history.some((message) => message.type === "user" && message.id === run.promptId), "witness_prompt_identity");
  const expected = kind === "capture" ? [{ action: "read_source", call: READ_CALL }, { action: "record_interpretation", call: WRITE_CALL }] :
    [{ action: "read_source", call: TURN_READ_CALL }, { action: "record_idea", call: IDEA_CALL }];
  check(accepted.length === expected.length, "witness_transport_count");
  for (const item of expected) {
    const matching = accepted.filter((entry) => entry.action === item.action && entry.native.callID === item.call);
    check(matching.length === 1, "witness_transport_context_missing");
    const entry = matching[0];
    check(entry && entry.native.sessionID === run.sessionId && entry.native.agent === AGENT && entry.native.messageID !== run.promptId, "witness_transport_context_mismatch");
    const assistant = history.find((message) => message.type === "assistant" && message.id === entry.native.messageID);
    check(assistant?.type === "assistant" && assistant.agent === AGENT && assistant.content.some((part) => part.type === "tool" && part.id === item.call && part.name === item.action && part.state.status === "completed" && part.time.completed !== undefined), "witness_canonical_tool_missing");
  }
  const actualTools = history.flatMap((message) => message.type === "assistant" ? message.content.filter((part) => part.type === "tool") : []);
  check(actualTools.length === expected.length, "witness_canonical_tool_count");
  const final = history.filter((message) => message.type === "assistant" && message.finish === "stop" && message.time.completed !== undefined && !message.error &&
    message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n") === (kind === "capture" ? FINAL : DIALOGUE_FINAL));
  check(final.length === 1 && final[0], "witness_final_missing");
  return final[0].id;
}
function verifyStorage(path: string, run: WeavingRun, accepted: Accepted[], sourceBefore: string) {
  check(JSON.stringify(findSource(path, run.sourceId)) === sourceBefore, "witness_original_changed");
  const write = accepted.find((entry) => entry.action === "record_interpretation");
  check(write, "witness_write_missing");
  const operationId = `tool_${digest(JSON.stringify([write.native.sessionID, write.native.messageID, write.native.callID]))}`;
  const db = openDatabase(path);
  try {
    const items = db.query<{ id: string; versionId: string; kind: string; source: string; author: string; text: string; run: string; operation: string }, [string]>(`SELECT i.id,f.id AS versionId,i.kind,i.source_id AS source,f.author,f.text,f.run_id AS run,f.operation_id AS operation FROM knowledge_items i JOIN formulations f ON f.item_id=i.id WHERE f.run_id=?`).all(run.runId);
    const item = items[0];
    check(items.length === 1 && item?.kind === "interpretation" && item.source === run.sourceId && item.author === "ai" && item.text === INTERPRETATION && item.run === run.runId && item.operation === operationId, "witness_durable_attribution");
    const receipts = db.query<{ id: string }, [string]>("SELECT k.operation_id AS id FROM knowledge_receipts k JOIN formulations f ON f.operation_id=k.operation_id WHERE f.run_id=?").all(run.runId);
    check(receipts.length === 1 && receipts[0]?.id === operationId, "witness_domain_receipt");
    const native = db.query<{ attempted: number; changes: number; outcome: string; revoked: number }, [string]>(`SELECT c.attempted,r.recorded_changes AS changes,r.outcome,g.revoked FROM native_commands c JOIN weaving_runs r ON r.id=c.run_id JOIN owned_grants g ON g.run_id=r.id WHERE r.id=?`).get(run.runId);
    check(native?.attempted === 1 && native.changes === 1 && native.outcome === "succeeded" && native.revoked === 1, "witness_run_receipt");
    const evidence = db.query<{ id: string }, [string]>("SELECT e.source_id AS id FROM formulation_evidence e JOIN formulations f ON f.id=e.formulation_id WHERE f.run_id=?").all(run.runId);
    check(evidence.length === 1 && evidence[0]?.id === run.sourceId, "witness_evidence_mismatch");
    return { itemId: item.id, versionId: item.versionId };
  } finally { db.close(); }
}

function verifyDialogueStorage(path: string, run: WeavingRun, accepted: Accepted[], context: DialogueFixture, assistantId: string, sourceBefore: string) {
  check(JSON.stringify(findSource(path, run.sourceId)) === sourceBefore, "witness_original_changed");
  const input = findSource(path, context.turnSourceId);
  check(input?.text === USER_INPUT && input.origin?.kind === "discussion-turn" && input.origin.dialogueId === context.dialogueId && input.origin.turnId === context.turnId && input.origin.rootSourceId === run.sourceId, "witness_turn_origin_missing");
  const write = accepted.find((entry) => entry.action === "record_idea");
  check(write, "witness_idea_missing");
  const operationId = `tool_${digest(JSON.stringify([write.native.sessionID, write.native.messageID, write.native.callID]))}`;
  const db = openDatabase(path);
  try {
    const items = db.query<{ id: string; versionId: string; kind: string; source: string; author: string; text: string; operation: string }, [string]>(`SELECT i.id,f.id AS versionId,i.kind,i.source_id AS source,f.author,f.text,f.operation_id AS operation
      FROM knowledge_items i JOIN formulations f ON f.item_id=i.id WHERE f.run_id=?`).all(run.runId);
    const idea = items[0];
    check(items.length === 1 && idea?.kind === "developing-idea" && idea.source === run.sourceId && idea.author === "ai" && idea.text === IDEA && idea.operation === operationId, "witness_idea_attribution_missing");
    const derivation = db.query<{ dialogueId: string; turnId: string; rootSourceId: string; turnSourceId: string; itemId: string; versionId: string }, [string]>(`SELECT dialogue_id AS dialogueId,turn_id AS turnId,root_source_id AS rootSourceId,turn_source_id AS turnSourceId,from_item_id AS itemId,from_version_id AS versionId FROM idea_derivations WHERE item_id=?`).get(idea.id);
    check(derivation && JSON.stringify(derivation) === JSON.stringify({ dialogueId: context.dialogueId, turnId: context.turnId, rootSourceId: run.sourceId,
      turnSourceId: context.turnSourceId, itemId: context.derivedFrom.itemId, versionId: context.derivedFrom.versionId }), "witness_idea_derivation_missing");
    const evidence = db.query<{ id: string }, [string]>("SELECT source_id AS id FROM formulation_evidence WHERE formulation_id=? ORDER BY position").all(idea.versionId);
    check(JSON.stringify(evidence.map((entry) => entry.id)) === JSON.stringify([run.sourceId, context.turnSourceId]), "witness_idea_evidence_missing");
    const receipt = db.query<{ resultId: string; versionId: string }, [string]>("SELECT result_id AS resultId,revision_id AS versionId FROM knowledge_receipts WHERE operation_id=?").get(operationId);
    check(receipt?.resultId === idea.id && receipt.versionId === idea.versionId, "witness_idea_receipt_missing");
    const outcome = db.query<{ runId: string; outcome: string; messageId: string; text: string; jobId: string; status: string }, [string]>(`SELECT o.run_id AS runId,o.outcome,o.assistant_message_id AS messageId,o.assistant_text AS text,t.job_id AS jobId,j.status
      FROM dialogue_outcomes o JOIN dialogue_turns t ON t.id=o.turn_id JOIN jobs j ON j.id=t.job_id WHERE t.id=? AND j.kind='dialogue'`).get(context.turnId);
    check(outcome?.runId === run.runId && outcome.jobId === run.jobId && outcome.outcome === "succeeded" && outcome.status === "completed" && outcome.messageId === assistantId && outcome.text === DIALOGUE_FINAL, "witness_dialogue_outcome_missing");
    const native = db.query<{ attempted: number; changes: number; outcome: string; revoked: number; sources: string; actions: string; sessionId: string }, [string]>(`SELECT c.attempted,r.recorded_changes AS changes,r.outcome,g.revoked,g.source_ids AS sources,g.operations AS actions,g.session_id AS sessionId
      FROM native_commands c JOIN weaving_runs r ON r.id=c.run_id JOIN owned_grants g ON g.run_id=r.id WHERE r.id=?`).get(run.runId);
    check(native?.attempted === 1 && native.changes === 1 && native.outcome === "succeeded" && native.revoked === 1 && native.sessionId === run.sessionId &&
      native.sources === JSON.stringify([run.sourceId, context.turnSourceId].sort()) && native.actions === JSON.stringify([...DIALOGUE_OPERATIONS].sort()), "witness_dialogue_grant_missing");
    for (const [table, expected] of [["sources", 2], ["jobs", 2], ["weaving_runs", 2], ["native_commands", 2], ["knowledge_items", 2], ["knowledge_receipts", 2], ["dialogues", 1], ["dialogue_turns", 1], ["dialogue_outcomes", 1]] as const) {
      check(db.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count === expected, "witness_unexpected_storage_count");
    }
  } finally { db.close(); }
}

async function verifyNativeSettlement(client: OpenCodeClient, run: WeavingRun, kind: "capture" | "dialogue", location: string, signal: AbortSignal, context?: DialogueFixture) {
  const session = await client.session.get({ sessionID: run.sessionId }, requestOptions(signal));
  const active = await client.session.active(requestOptions(signal));
  const inbox = await client.session.inbox.list({ sessionID: run.sessionId }, requestOptions(signal));
  const actions = kind === "capture" ? OPERATIONS : DIALOGUE_OPERATIONS;
  check(session.id === run.sessionId && session.agent === AGENT && session.location.directory === location && !session.parentID && !session.fork && session.metadata?.app === "thoughtloom" &&
    session.metadata.runId === run.runId && session.metadata.jobId === run.jobId && session.metadata.sourceId === run.sourceId && session.metadata.promptId === run.promptId &&
    JSON.stringify(session.permissions) === JSON.stringify([{ action: "*", resource: "*", effect: "deny" }, ...actions.map((action) => ({ action, resource: "*", effect: "allow" }))]), "fixture_native_scope_mismatch");
  if (kind === "dialogue") check(context && session.metadata?.dialogueId === context.dialogueId && session.metadata.turnId === context.turnId && session.metadata.turnSourceId === context.turnSourceId, "fixture_native_dialogue_scope_mismatch");
  check(session.outcome === "succeeded" && active[run.sessionId] === undefined && inbox.length === 0, "fixture_native_not_settled");
}
async function boundedClose(action: () => Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([action(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new WitnessGuardError("fixture_cleanup_timeout")), 8_000); })]); }
  finally { clearTimeout(timer); }
}

export async function runPluginWitness() {
  requireOptIn(process.env.THOUGHTLOOM_PLUGIN_WITNESS, process.env.OPENCODE_TEST_BINARY);
  check(process.platform === "linux" && process.arch === "x64", "fixture_platform_rejected");
  const repo = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
  check(await nodeIO.inspect("/etc/opencode") === "missing", "system_config_not_absent");
  check(await nodeIO.inspect(ANCHOR) === "directory" && await realpath(ANCHOR) === ANCHOR, "fixture_anchor_rejected");
  // No child is executed by this filesystem-only provenance preflight.
  const facts = await inspectBinary(NATIVE_BINARY);
  const pluginBundle = await reviewedBundle(repo);
  const root = await mkdtemp(join(ANCHOR, ROOT_PREFIX));
  let owned: ReturnType<typeof startOwnedNative> | undefined;
  let provider: ReturnType<typeof fixtureProvider> | undefined;
  let daemon: ReturnType<typeof Bun.serve> | undefined;
  let worker: WeavingWorker | undefined;
  let cleanupSafe = true;
  const lifetime = new AbortController();
  const pending = new Set<Promise<unknown>>();
  async function perform<T>(action: () => Promise<T>): Promise<T> {
    lifetime.signal.throwIfAborted();
    const work = action(); pending.add(work);
    void work.then(() => pending.delete(work), () => pending.delete(work));
    let abort: (() => void) | undefined;
    try {
      return await Promise.race([work, new Promise<never>((_, reject) => {
        abort = () => reject(new WitnessGuardError("fixture_deadline"));
        lifetime.signal.addEventListener("abort", abort, { once: true });
        if (lifetime.signal.aborted) abort();
      })]);
    } finally { if (abort) lifetime.signal.removeEventListener("abort", abort); }
  }
  const timeout = setTimeout(() => lifetime.abort(), 75_000);
  const onSignal = () => lifetime.abort();
  process.on("SIGTERM", onSignal); process.on("SIGINT", onSignal);
  try {
    await chmod(root, 0o700);
    const p = pathsFor(root);
    for (const path of new Set([p.HOME, p.XDG_CONFIG_HOME, p.XDG_DATA_HOME, p.XDG_CACHE_HOME, p.XDG_STATE_HOME, p.TMPDIR, p.OPENCODE_CONFIG_DIR, join(root, "db")])) await mkdir(path, { mode: 0o700 });
    await privateWrite(p.GIT_CONFIG_GLOBAL, "");
    const credential = randomBytes(32).toString("base64url"), password = randomBytes(32).toString("base64url");
    const databasePath = join(root, "app.sqlite"), accepted: Accepted[] = [];
    const app = createApp({ databasePath, tools: { transportCredential: credential, location: p.cwd } });
    daemon = Bun.serve({ hostname: "127.0.0.1", port: 0, maxRequestBodySize: 65_536,
      async fetch(request) {
        // Observe the actual HTTP transport, not a substituted plugin/client.
        const observe = request.method === "POST" && new URL(request.url).pathname.startsWith("/internal/tools/") && request.headers.get("authorization") === `Bearer ${credential}`;
        const copy = observe ? request.clone() : undefined;
        const response = await app.fetch(request);
        if (copy && response.ok) {
          const body: unknown = await copy.json();
          const native = toolRecord(body) ? parseNativeIdentity(body.native) : null;
          check(toolRecord(body) && native && typeof body.action === "string" && accepted.length < 4, "witness_transport_invalid");
          accepted.push({ native, action: body.action });
        } else await copy?.body?.cancel();
        return response;
      }, error() { return new Response("fixture failure", { status: 500 }); },
    });
    const daemonOrigin = `http://127.0.0.1:${daemon.port}`;
    const capture = await app.request("/captures", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "native-plugin-fixture" }, body: JSON.stringify({ text: ORIGINAL, provenance: "manual" }) });
    check(capture.status === 201, "fixture_capture_failed");
    const source: unknown = await capture.json();
    check(toolRecord(source) && typeof source.id === "string", "fixture_source_missing");
    const sourceId = source.id, sourceBefore = JSON.stringify(findSource(databasePath, sourceId));
    provider = fixtureProvider(sourceId, lifetime.signal);
    await provisionNativeSetup({ runtimeDirectory: p.runtime, locationDirectory: p.cwd, daemonOrigin, transportCredential: credential,
      pluginEntry: p.bundle, pluginBundle, native: { registrationFile: p.registration, agent: AGENT, model: MODEL, operations: [...OPERATIONS], dialogueOperations: [...DIALOGUE_OPERATIONS], maxSteps: 6 } });
    const input = { optIn: process.env.THOUGHTLOOM_PLUGIN_WITNESS, executable: process.env.OPENCODE_TEST_BINARY, root,
      config: JSON.stringify(witnessConfig(root, provider.origin)), providerOrigin: provider.origin, daemonOrigin, password, transportCredential: credential };
    const url = await guardedLaunch(input, nodeIO, facts, async (spec) => {
      lifetime.signal.throwIfAborted();
      owned = startOwnedNative(spec, lifetime.signal);
      return owned.ready();
    });
    check(url !== daemonOrigin && url !== provider.origin && owned?.pid, "fixture_service_collision");
    const guardedFetch: typeof fetch = Object.assign((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => fetch(input, { ...init, redirect: "error" }), { preconnect: fetch.preconnect });
    const client = OpenCode.make({ baseUrl: url, headers: Service.headers({ url, auth: { type: "basic", username: "opencode", password } }), fetch: guardedFetch });
    const identity = await client.server.info(requestOptions(lifetime.signal));
    check(identity.version === "2.2.2" && identity.pid === owned.pid, "fixture_native_identity");
    check(contained(root, identity.paths.tmp), "fixture_native_temp_escape");
    const models = await client.model.list({ location: { directory: p.cwd }, types: ["chat"] }, requestOptions(lifetime.signal));
    const enabled = models.data.filter((model) => model.enabled && model.type === "chat");
    check(enabled.length === 1 && enabled[0]?.providerID === MODEL.providerID && enabled[0].id === MODEL.id, "fixture_enabled_model_rejected");
    // Baseline fixture registration format, written only for this owned process.
    await privateWrite(p.registration, JSON.stringify({ url, pid: owned.pid, version: "2.2.2", password }));
    owned.healthy();
    const plugins = await client.plugin.list({ location: { directory: p.cwd } }, requestOptions(lifetime.signal));
    validatePluginRegistry(root, plugins.data);
    worker = new WeavingWorker({ databasePath, adapter: new NativeWeavingAdapter({ databasePath, registrationFile: p.registration, location: p.cwd, agent: AGENT, model: MODEL, operations: [...OPERATIONS], dialogueOperations: [...DIALOGUE_OPERATIONS] }) });
    // Exactly one submission attempt per flow, each in a fresh owned session.
    // Inspection uses the production event
    // handshake + canonical history path; no lost response authorizes a retry.
    const started = await perform(() => { check(worker, "fixture_worker_missing"); return worker.startNext(); });
    check(started.kind === "started", "fixture_run_not_started");
    for (;;) {
      lifetime.signal.throwIfAborted(); owned.healthy();
      check(!provider.counts().failed, "fixture_provider_rejected");
      await perform(() => { check(worker, "fixture_worker_missing"); return worker.recover(); });
      const job = await worker.getJob(sourceId);
      if (job?.status === "completed") break;
      check(job?.status === "running" || job?.status === "uncertain", "fixture_run_failed");
      await pause(100, undefined, { signal: lifetime.signal });
    }
    const run = started.run;
    const history = await canonicalHistory(client, run, lifetime.signal);
    verifyContext(history, run, accepted, "capture");
    await verifyNativeSettlement(client, run, "capture", p.cwd, lifetime.signal);
    const derivedFrom = verifyStorage(databasePath, run, accepted, sourceBefore);
    // Negative app-policy checks deliberately replay transport, NOT a second
    // native prompt and NOT proof of an OS sandbox or hostile-plugin isolation.
    const read = accepted.find((entry) => entry.action === "read_source");
    check(read, "witness_read_missing");
    const reject = async (action: "read_source" | "record_idea", input: unknown, native: NativeIdentity, token: string, status: number) => {
      const response = await fetch(`${daemonOrigin}/internal/tools/${action.replaceAll("_", "-")}`, { method: "POST", redirect: "error", signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(5_000)]), headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ action, native, input }) });
      await response.body?.cancel();
      check(response.status === status, "witness_policy_refusal_missing");
    };
    await reject("read_source", { sourceId }, { ...read.native, sessionID: "ses_fixture_unowned" }, credential, 403);
    await reject("read_source", { sourceId }, read.native, credential, 403); // settlement has revoked the grant
    await reject("read_source", { sourceId }, read.native, "fixture-wrong-credential", 401);
    verifyStorage(databasePath, run, accepted, sourceBefore);

    // One real retained turn, pinned to the interpretation actually written by
    // capture. IDs come from application receipts, never TUI/current-session state.
    const created = await app.request(`/sources/${sourceId}/dialogues`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "native-dialogue-fixture" },
      body: JSON.stringify({ selection: { kind: "item", id: derivedFrom.itemId, versionId: derivedFrom.versionId } }) });
    check(created.status === 201, "fixture_dialogue_create_failed");
    const dialogue = parseDialogueView(await created.json());
    check(dialogue?.sourceId === sourceId && dialogue.turns.length === 0, "fixture_dialogue_context_missing");
    const submitted = await app.request(`/dialogues/${dialogue.id}/turns`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "native-dialogue-turn-fixture" }, body: JSON.stringify({ text: USER_INPUT }) });
    check(submitted.status === 201, "fixture_dialogue_turn_failed");
    const turn = parseDialogueTurnReceipt(await submitted.json());
    check(turn?.dialogueId === dialogue.id, "fixture_dialogue_turn_missing");
    const context: DialogueFixture = { dialogueId: dialogue.id, turnId: turn.id, turnSourceId: turn.sourceId, derivedFrom };
    provider.beginDialogue(context);
    const dialogueStarted = await perform(() => { check(worker, "fixture_worker_missing"); return worker.startNext(); });
    check(dialogueStarted.kind === "started" && dialogueStarted.run.jobId === turn.jobId, "fixture_dialogue_not_started");
    const dialogueRun = dialogueStarted.run;
    check(dialogueRun.sourceId === run.sourceId && dialogueRun.runId !== run.runId && dialogueRun.jobId !== run.jobId && dialogueRun.sessionId !== run.sessionId && dialogueRun.promptId !== run.promptId, "fixture_session_reuse_rejected");
    for (;;) {
      lifetime.signal.throwIfAborted(); owned.healthy();
      check(!provider.counts().failed, "fixture_provider_rejected");
      await perform(() => { check(worker, "fixture_worker_missing"); return worker.recover(); });
      const current = parseDialogueView(await (await app.request(`/dialogues/${dialogue.id}`)).json());
      const state = current?.turns.find((entry) => entry.id === turn.id);
      check(state, "fixture_dialogue_read_missing");
      if (state.status === "completed") break;
      check(state.status === "running" || state.status === "uncertain", "fixture_dialogue_run_failed");
      await pause(100, undefined, { signal: lifetime.signal });
    }
    const dialogueAccepted = accepted.filter((entry) => entry.native.sessionID === dialogueRun.sessionId);
    const dialogueHistory = await canonicalHistory(client, dialogueRun, lifetime.signal);
    const assistantId = verifyContext(dialogueHistory, dialogueRun, dialogueAccepted, "dialogue");
    await verifyNativeSettlement(client, dialogueRun, "dialogue", p.cwd, lifetime.signal, context);
    verifyDialogueStorage(databasePath, dialogueRun, dialogueAccepted, context, assistantId, sourceBefore);
    const visible = parseDialogueView(await (await app.request(`/dialogues/${dialogue.id}`)).json());
    const outcome = visible?.turns.find((entry) => entry.id === turn.id);
    check(outcome?.status === "completed" && outcome.outcome === "succeeded" && outcome.assistant?.text === DIALOGUE_FINAL && outcome.changes.length === 1 && outcome.changes[0]?.kind === "developing-idea", "fixture_dialogue_visible_outcome_missing");
    const idea = dialogueAccepted.find((entry) => entry.action === "record_idea");
    check(idea, "witness_idea_missing");
    const ideaInput = { rootSourceId: sourceId, turnSourceId: turn.sourceId, dialogueId: dialogue.id, turnId: turn.id, text: IDEA, evidenceSourceIds: [sourceId, turn.sourceId], derivedFrom };
    await reject("record_idea", ideaInput, { ...idea.native, sessionID: "ses_fixture_unowned_dialogue" }, credential, 403);
    await reject("record_idea", ideaInput, idea.native, credential, 403);
    await reject("record_idea", ideaInput, idea.native, "fixture-wrong-credential", 401);
    verifyStorage(databasePath, run, accepted.filter((entry) => entry.native.sessionID === run.sessionId), sourceBefore);
    verifyDialogueStorage(databasePath, dialogueRun, dialogueAccepted, context, assistantId, sourceBefore);
    const counts = provider.counts();
    check(accepted.length === 4 && counts.captureTurns === 3 && counts.dialogueTurns === 3 && counts.turns === PROVIDER_LIMITS.domainTurns && !counts.failed &&
      counts.captureRequests <= PROVIDER_LIMITS.captureRequests && counts.dialogueRequests <= PROVIDER_LIMITS.dialogueRequests && counts.requests <= PROVIDER_LIMITS.totalRequests, "fixture_provider_incomplete");
    return { version: "2.2.2", plugin: "active", job: "completed", dialogue: "completed", ownedSessions: 2, toolNames: ["read_source", "record_interpretation", "record_idea"],
      nativeToolCalls: accepted.length, domainReceipts: 2, policyReplayRefusals: 6, providerRequests: counts.requests, captureProviderRequests: counts.captureRequests, dialogueProviderRequests: counts.dialogueRequests };
  } finally {
    lifetime.abort(); clearTimeout(timeout);
    const clean = async (action: () => Promise<unknown>) => { try { await boundedClose(action); } catch { cleanupSafe = false; } };
    await clean(async () => { await worker?.close(); });
    await clean(async () => { await Promise.allSettled([...pending]); });
    await clean(async () => { await owned?.close(); });
    await clean(async () => { await provider?.close(); });
    await clean(async () => { await daemon?.stop(true); });
    if (cleanupSafe) {
      await clean(async () => {
        check(contained(ANCHOR, root) && await realpath(root) === root && await nodeIO.private(root), "fixture_cleanup_path_rejected");
        await rm(root, { recursive: true, force: true });
      });
    }
    // If cleanup is uncertain, retain the private root; do not erase files a
    // possibly surviving native process could still use. Never widen the kill.
    process.removeListener("SIGTERM", onSignal); process.removeListener("SIGINT", onSignal);
    if (!cleanupSafe) throw new WitnessGuardError("fixture_cleanup_uncertain");
  }
}

if (import.meta.main) {
  // Production logs intentionally suppressed: even safe IDs are not needed in
  // this witness receipt. Never print exception objects, prompts or child output.
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const saved = methods.map((name) => [name, console[name]] as const);
  for (const name of methods) console[name] = () => {};
  let result: unknown;
  try { result = { state: "passed", ...await runPluginWitness(), cleanup: "completed" }; }
  catch (error) { result = { state: "failed", category: error instanceof WitnessGuardError ? error.code : "fixture_failed" }; process.exitCode = 1; }
  finally { for (const [name, method] of saved) console[name] = method; }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
