import { expect, test } from "bun:test";
import { candidateFromSuccessor, discovery, drive, find, fixture, knowledge, logger, now, reply, request, setup, status } from "./agentic-search-capability-fixture";
import { RejectionService } from "../src/domain/rejection";
import { SqliteRejectionRepository } from "../src/storage/rejection";

const names = ["findThoughts", "readThought", "addDiscovery", "relatedThoughts", "readConnection", "readResponse", "readSearchConversation", "listDiscoveries", "normalizeTimeRange"];
const range = { intentTurnPosition: 0, interpretation: "the repeated hour", from: "2030-11-03T01:00:00-07:00", until: "2030-11-03T02:00:00-08:00", timeZone: "America/Los_Angeles" };

test("normalize selects the current session's anchor when a foreign session already has the same position", async () => {
  await fixture(index => {
    if (index === 0) return request("normalizeTimeRange", range);
    if (index === 1) return { version: 1, kind: "search-reply", reply: "Time range checked.", disposition: "done", sourceThoughtIds: [] };
    throw new Error("unexpected native prompt");
  }, async (db, store, worker, client, id) => {
    const sessions = store.searchSessions({ id, now, logger });
    const other = sessions.create("user", "foreign", {}).session;
    const composer = sessions.openComposer("user", other.id);
    const foreign = sessions.admitTurn("user", other.id, "foreign-turn", { text: "FOREIGN-ANCHOR-SENTINEL", startingThoughtIds: [],
      requestClock: { at: "2030-01-01T03:00:00-08:00", timeZone: "America/Los_Angeles" }, composerId: composer.composerId, contextToken: composer.contextToken });
    const { runId } = setup(db, store, id);
    expect(db.query("SELECT position FROM search_turns WHERE run_id IN (?,?) ORDER BY rowid").all(foreign.run.id, runId)).toEqual([{ position: 0 }, { position: 0 }]);
    await drive(worker, db, runId);
    expect(status(db, runId)).toBe("completed");
    expect(client.scriptErrors).toEqual([]);
    const successor = client.prompts[1]; if (!successor) throw new Error("missing time result");
    const result = (JSON.parse(successor.text) as { result: { range: { requestAnchor: unknown } } }).result;
    expect(result.range.requestAnchor).toEqual({ clock: { at: "2030-01-01T12:00:00Z", timeZone: "UTC" }, daemonObservedAt: now() });
    for (const prompt of client.prompts) expect(prompt.text).not.toContain("FOREIGN-ANCHOR-SENTINEL");
  });
});

test("explicit response and connection reads retain typed witnesses without exposing rejected provenance", async () => {
  await fixture(index => {
    if (index === 0) return request("readResponse", { id: "mixed" });
    if (index === 1) return request("readResponse", { id: "safe" });
    if (index === 2) return request("readConnection", { id: "link" });
    if (index === 3) return { version: 1, kind: "search-reply", reply: "Read safe references.", disposition: "done", sourceThoughtIds: [] };
    throw new Error("unexpected native prompt");
  }, async (db, store, worker, client, id) => {
    const { runId } = setup(db, store, id);
    store.saveThought({ id: "child", text: "safe child", title: null, titleAuthor: null, author: "user", kind: "captured-original", createdAt: now(), origin: "fixture", parentId: null, sourceIds: [] });
    store.saveResponse({ id: "mixed", text: "MIXED-SECRET", role: "addendum", state: "complete", thoughtIds: ["target", "hidden"] });
    store.saveResponse({ id: "safe", text: "safe response", role: "addendum", state: "complete", thoughtIds: ["target", "child"] });
    store.saveConnection({ id: "link", fromId: "target", toId: "child", category: "related", proposedBy: "user", explanation: "safe connection", sourceIds: ["hidden"] });
    const before = knowledge(db);
    await drive(worker, db, runId);
    expect(status(db, runId)).toBe("completed");
    const rows = db.query("SELECT result_json FROM run_steps WHERE run_id=? ORDER BY position").all(runId) as { result_json: string | null }[];
    expect(JSON.parse(rows[0]?.result_json ?? "null")).toEqual({ type: "response", response: null });
    expect(rows[1]?.result_json).toContain("safe response");
    expect(rows[2]?.result_json).toContain("safe connection");
    expect(rows[2]?.result_json).not.toContain("hidden");
    for (const prompt of client.prompts) expect(prompt.text).not.toContain("MIXED-SECRET");
    const refs = db.query("SELECT kind,ref_id,full_read FROM run_context WHERE run_id=?").all(runId);
    expect(refs).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "response", ref_id: "safe", full_read: 1 }), expect.objectContaining({ kind: "connection", ref_id: "link", full_read: 1 })]));
    expect(refs).not.toEqual(expect.arrayContaining([expect.objectContaining({ kind: "thought", full_read: 1 })]));
    expect(knowledge(db)).toEqual(before);
  });
});

test("a rejected old intent dependency cannot supply its paired clock or old prose", async () => {
  await fixture(index => {
    if (index === 0) return { version: 1, kind: "search-reply", reply: "First answer.", disposition: "done", sourceThoughtIds: [] };
    if (index === 1) return request("normalizeTimeRange", range);
    throw new Error("unexpected native prompt");
  }, async (db, store, worker, client, id) => {
    setup(db, store, id);
    const sessions = store.searchSessions({ id, now, logger }), session = sessions.create("user", "intent-session", {}).session;
    const firstComposer = sessions.openComposer("user", session.id);
    const first = sessions.admitTurn("user", session.id, "intent", { text: "UNSAFE-OLD-INTENT", startingThoughtIds: ["target"], requestClock: { at: "2030-01-01T12:00:00Z", timeZone: "UTC" }, composerId: firstComposer.composerId, contextToken: firstComposer.contextToken });
    await drive(worker, db, first.run.id); expect(status(db, first.run.id)).toBe("completed");
    new RejectionService(new SqliteRejectionRepository(db, logger)).rejectThought("user", "target");
    const composer = sessions.openComposer("user", session.id);
    const next = sessions.admitTurn("user", session.id, "restart", { text: "New independent question", contextMode: "restart", startingThoughtIds: [], requestClock: { at: "2030-01-01T12:00:00Z", timeZone: "UTC" }, composerId: composer.composerId, contextToken: composer.contextToken });
    await drive(worker, db, next.run.id);
    expect(status(db, next.run.id)).toBe("failed");
    expect(client.prompts).toHaveLength(2);
    expect(client.prompts[1]?.text).not.toContain("UNSAFE-OLD-INTENT");
    expect(db.query("SELECT result_json FROM run_steps WHERE run_id=? ORDER BY position").get(next.run.id)).toEqual({ result_json: null });
  });
});

test("discovery listing hides removed occurrences and unsafe retained rationales", async () => {
  await fixture(index => {
    if (index === 0 || index === 3) return request("readThought", { id: "target" });
    if (index === 1) return discovery("target");
    if (index === 2 || index === 6) return { version: 1, kind: "search-reply", reply: "Done.", disposition: "done", sourceThoughtIds: [] };
    if (index === 4) return request("readThought", { id: "evidence" });
    if (index === 5) return request("addDiscovery", { thoughtId: "target", why: "UNSAFE-OLD-RATIONALE", evidenceThoughtIds: ["evidence"] });
    if (index === 7) return request("listDiscoveries", { afterPosition: null, limit: 25 });
    if (index === 8) return { version: 1, kind: "search-reply", reply: "Listed.", disposition: "done", sourceThoughtIds: [] };
    throw new Error("unexpected native prompt");
  }, async (db, store, worker, client, id) => {
    const { sessions, session, runId } = setup(db, store, id);
    store.saveThought({ id: "evidence", text: "EVIDENCE-SECRET", title: null, titleAuthor: null, author: "user", kind: "captured-original", createdAt: now(), origin: "fixture", parentId: null, sourceIds: [] });
    await drive(worker, db, runId); expect(status(db, runId)).toBe("completed");
    const first = db.query("SELECT id FROM search_discoveries WHERE session_id=? AND removed_at IS NULL").get(session.id) as { id: string };
    sessions.removeDiscovery("user", session.id, first.id);
    const composer = sessions.openComposer("user", session.id);
    const second = sessions.admitTurn("user", session.id, "rediscover", { text: "Find again", startingThoughtIds: [], contextMode: "restart", requestClock: { at: "2030-01-01T12:00:00Z", timeZone: "UTC" }, composerId: composer.composerId, contextToken: composer.contextToken });
    await drive(worker, db, second.run.id); expect(status(db, second.run.id)).toBe("completed");
    const active = db.query("SELECT id FROM search_discoveries WHERE session_id=? AND removed_at IS NULL").get(session.id) as { id: string };
    expect(active.id).not.toBe(first.id);
    new RejectionService(new SqliteRejectionRepository(db, logger)).rejectThought("user", "evidence");
    const thirdComposer = sessions.openComposer("user", session.id);
    const third = sessions.admitTurn("user", session.id, "list", { text: "List current discoveries", startingThoughtIds: [], contextMode: "restart", requestClock: { at: "2030-01-01T12:00:00Z", timeZone: "UTC" }, composerId: thirdComposer.composerId, contextToken: thirdComposer.contextToken });
    await drive(worker, db, third.run.id); expect(status(db, third.run.id)).toBe("completed");
    const result = db.query("SELECT result_json FROM run_steps WHERE run_id=? ORDER BY position").get(third.run.id) as { result_json: string };
    const page = JSON.parse(result.result_json) as { items: { id: string; why: string | null; evidenceThoughtIds: string[] }[] };
    expect(page.items).toHaveLength(1); expect(page.items[0]?.id).toBe(active.id); expect(page.items[0]?.why).toBeNull();
    expect(result.result_json).not.toContain(first.id); expect(page.items[0]?.evidenceThoughtIds).toEqual([]);
    expect(result.result_json).not.toContain("EVIDENCE-SECRET");
    for (const prompt of client.prompts.slice(7)) expect(prompt.text).not.toContain("UNSAFE-OLD-RATIONALE");
  });
});

test("real worker carries safe rich reads and a same-session time anchor through one search run", async () => {
  let candidate = "";
  await fixture((index, input) => {
    if (index === 0) return find();
    if (index === 1) { candidate = candidateFromSuccessor(input); return request("readThought", { id: candidate }); }
    if (index === 2) return discovery(candidate);
    if (index === 3) return reply();
    if (index === 4) return request("relatedThoughts", { thoughtId: "target", relation: "connections", limit: 25, cursor: null });
    if (index === 5) return request("readConnection", { id: "safe-link" });
    if (index === 6) return request("relatedThoughts", { thoughtId: "target", relation: "responses", limit: 25, cursor: null });
    if (index === 7) return request("readResponse", { id: "safe-response" });
    if (index === 8) return request("readSearchConversation", { beforePosition: null, limit: 25 });
    if (index === 9) return request("listDiscoveries", { afterPosition: null, limit: 25 });
    if (index === 10) return request("normalizeTimeRange", range);
    if (index === 11) return { version: 1, kind: "search-reply", reply: "Reviewed the available context.", disposition: "done", sourceThoughtIds: [] };
    throw new Error("unexpected native prompt");
  }, async (db, store, worker, client, id) => {
    const { sessions, session, runId } = setup(db, store, id);
    store.saveThought({ id: "child", text: "safe child text", title: null, titleAuthor: null, author: "user", kind: "captured-original", createdAt: now(), origin: "fixture", parentId: null, sourceIds: [] });
    store.saveConnection({ id: "safe-link", fromId: "target", toId: "child", category: "supports", proposedBy: "user", explanation: "safe connection", sourceIds: [] });
    store.saveConnection({ id: "hidden-link", fromId: "target", toId: "hidden", category: "related", proposedBy: "user", explanation: "HIDDEN-CONNECTION-SENTINEL", sourceIds: [] });
    store.saveResponse({ id: "safe-response", text: "safe response text", role: "addendum", state: "complete", thoughtIds: ["target", "child"] });
    store.saveResponse({ id: "mixed-response", text: "HIDDEN-RESPONSE-SENTINEL", role: "addendum", state: "complete", thoughtIds: ["target", "hidden"] });
    const before = knowledge(db);
    await drive(worker, db, runId);
    expect(status(db, runId)).toBe("completed");
    expect(db.query("SELECT count(*) AS n FROM search_discoveries WHERE session_id=? AND removed_at IS NULL").get(session.id)).toEqual({ n: 1 });
    const other = sessions.create("user", "other-session", {}).session;
    const otherComposer = sessions.openComposer("user", other.id);
    sessions.admitTurn("user", other.id, "other-turn", { text: "OTHER-SESSION-SECRET", startingThoughtIds: [], requestClock: { at: "2030-01-01T00:00:00Z", timeZone: "UTC" }, composerId: otherComposer.composerId, contextToken: otherComposer.contextToken });
    const composer = sessions.openComposer("user", session.id);
    const next = sessions.admitTurn("user", session.id, "rich-turn", { text: "Review context", startingThoughtIds: [], requestClock: { at: "2030-01-01T12:00:00Z", timeZone: "UTC" }, composerId: composer.composerId, contextToken: composer.contextToken });
    expect(db.query("SELECT position FROM search_turns WHERE run_id=?").get(runId)).toEqual({ position: 0 });
    await drive(worker, db, next.run.id);
    expect(client.scriptErrors).toEqual([]);
    expect(status(db, next.run.id)).toBe("completed");
    expect(client.prompts).toHaveLength(12);
    const prompts = client.prompts.slice(4);
    const initial = prompts[0]; if (!initial) throw new Error("missing rich initial prompt");
    const advertised = JSON.parse(initial.text) as { capabilities: { capability: string }[] };
    expect(advertised.capabilities.map(item => item.capability).sort()).toEqual([...names].sort());
    expect(new Set(prompts.map(prompt => prompt.sessionID)).size).toBe(1);
    expect(initial.sessionID).not.toBe(client.prompts[0]?.sessionID);
    const steps = db.query("SELECT prompt_id,result_json FROM run_steps WHERE run_id=? ORDER BY position").all(next.run.id) as { prompt_id: string; result_json: string | null }[];
    expect(steps.map(step => step.prompt_id)).toEqual(prompts.map(prompt => prompt.id));
    for (let i = 0; i < 7; i++) {
      const stored = steps[i]?.result_json, successor = prompts[i + 1];
      if (!stored || !successor) throw new Error("missing confirmed rich result");
      expect((JSON.parse(successor.text) as { result: unknown }).result).toEqual(JSON.parse(stored));
    }
    const results = steps.slice(0, 7).map(step => step.result_json ?? "");
    expect(results[0]).toContain("safe-link"); expect(results[0]).not.toContain("hidden-link");
    expect(results[1]).toContain("safe connection");
    expect(results[2]).toContain("safe-response"); expect(results[2]).not.toContain("mixed-response");
    expect(results[3]).toContain("safe response text");
    expect(results[4]).toContain("Find cobalt"); expect(results[4]).toContain("Found the recorded thought.");
    expect(results[5]).toContain("A useful recorded thought");
    expect(results[6]).toContain("agent-interpretation"); expect(results[6]).toContain("2030-11-03T08:00:00.000Z"); expect(results[6]).toContain("2030-11-03T10:00:00.000Z");
    expect(results[6]).toContain("2030-01-01T12:00:00Z"); expect(results[6]).toContain("2030-01-01T12:00:03.000Z");
    for (const prompt of prompts) for (const secret of ["OTHER-SESSION-SECRET", "HIDDEN-CONNECTION-SENTINEL", "HIDDEN-RESPONSE-SENTINEL", "REJECTED-SENTINEL"]) expect(prompt.text).not.toContain(secret);
    const refs = db.query("SELECT kind,ref_id,full_read FROM run_context WHERE run_id=? ORDER BY kind,ref_id").all(next.run.id);
    expect(refs).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "connection", ref_id: "safe-link" }), expect.objectContaining({ kind: "response", ref_id: "safe-response" })]));
    expect(refs).not.toEqual(expect.arrayContaining([expect.objectContaining({ kind: "thought", full_read: 1 })]));
    expect(knowledge(db)).toEqual(before);
  });
});

for (const invalid of [
  request("readSearchConversation", { beforePosition: null, limit: 25, scope: "history" }),
  request("readSearchConversation", { beforePosition: null, limit: 25, actor: "user" }),
  request("listDiscoveries", { afterPosition: null, limit: 25, sessionId: "other-session" }),
  request("normalizeTimeRange", { ...range, sessionId: "other-session" }),
  request("normalizeTimeRange", { ...range, intentTurnPosition: 999 }),
  request("readImportSource", { id: "source-artifact" }),
] as const) test(`search rejects caller authority or unavailable anchor: ${invalid.request.capability} ${Object.keys(invalid.request.arguments).join(",")}`, async () => {
  await fixture(index => {
    if (index === 0) return request("readThought", { id: "target" });
    if (index === 1) return invalid;
    throw new Error("unexpected native prompt");
  }, async (db, store, worker, client, id) => {
    const { runId } = setup(db, store, id), before = knowledge(db);
    await drive(worker, db, runId);
    expect(client.scriptErrors).toEqual([]);
    expect(client.prompts).toHaveLength(2);
    expect(status(db, runId)).toBe("failed");
    expect(db.query("SELECT count(*) AS n FROM search_messages WHERE run_id=? AND role='assistant'").get(runId)).toEqual({ n: 0 });
    expect(knowledge(db)).toEqual(before);
  });
});
