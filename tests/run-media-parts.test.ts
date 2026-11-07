import { describe, expect, test } from "bun:test";
import type { AgentBinding } from "../src/agent/opencode-adapter";
import { initialWorkerPrompt } from "../src/agent/worker-prompts";
import { RejectionService } from "../src/domain/rejection";
import { RunConflictError, RunFenceError, RunForbiddenError, type RunRecord } from "../src/domain/run";
import type { InitialRunContext } from "../src/domain/run-context";
import { record } from "../src/domain/validation";
import { SqliteAgentBindings } from "../src/storage/agent-binding";
import { SqliteRejectionRepository } from "../src/storage/rejection";
import { insertRun } from "../src/storage/run-record";
import { migrate } from "../src/storage/sqlite";
import { immediate } from "../src/storage/transaction";
import { mediaThought, mediaTime } from "./fixtures/media-source";
import { asyncMediaWeaveFixture, mediaNeighbor, mediaReplayWorker, mediaWeaveFixture } from "./fixtures/media-weave";
import { insertOriginalPart, manifestInput, originalManifest, originalParts, partSnapshot, requireRunMediaParts,
  sealOriginalParts, startPartOwner, type OriginalManifest, type OriginalPart } from "./fixtures/run-media-parts";

describe("original run media manifests", () => {
  test("core migration creates an empty media-part journal without inventing binary observations", () => mediaWeaveFixture(f => {
    const owner = startPartOwner(f);
    f.state.prepareInitial(owner.claim, initialWorkerPrompt);
    const steps = f.steps.steps(owner.run.id), source = f.store.getThought(mediaThought.id);
    migrate(f.db, f.sources.logger);
    requireRunMediaParts(f.db);
    expect(partSnapshot(f.db)).toEqual([]);
    expect(f.steps.steps(owner.run.id)).toEqual(steps);
    expect(f.store.getThought(mediaThought.id)).toEqual(source);
    expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  }));

  test.each(["weave", "evolve"] as const)("%s preparation seals contiguous original fingerprints with exact input and scoped exposures", kind => mediaWeaveFixture(f => {
    requireRunMediaParts(f.db);
    const parts = originalParts(f), owner = startPartOwner(f, kind);
    const prepared = sealOriginalParts(f, owner, parts);
    const input = prepared.input;
    expect(input).not.toBeNull();
    if (input === null) throw new Error("Expected the sealed media input");
    expect(record(JSON.parse(input)).media).toEqual(originalManifest(parts));
    expect(partSnapshot(f.db)).toEqual(parts.map(part => ({ prompt_id: owner.run.promptId, position: part.position,
      source_id: part.sourceId, representation: "original", mime_type: part.mimeType, byte_length: part.byteLength,
      sha256: part.sha256, prepared_key: null, recipe_json: null, observed: 0 })));
    expect(f.runs.contextRefs(owner.run.id)).toEqual(expect.arrayContaining([
      { kind: "thought", id: mediaThought.id }, { kind: "thought", id: "parts-second-root" },
    ]));
    expect(f.steps.steps(owner.run.id)).toEqual([prepared]);
    expect(f.runs.get(owner.run.id)).toMatchObject({ status: "queued", nativeState: "unknown" });
    expect(f.db.query("SELECT * FROM run_operation_receipts WHERE run_id=?").all(owner.run.id)).toEqual([]);
    expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  }));

  test.each(["second part", "input seal"] as const)("failure after %s persistence rolls back parts, input and source exposures together", phase => mediaWeaveFixture(f => {
    requireRunMediaParts(f.db);
    const parts = originalParts(f), owner = startPartOwner(f), beforeSteps = f.steps.steps(owner.run.id), beforeRefs = f.runs.contextRefs(owner.run.id);
    if (phase === "second part") f.db.exec(`CREATE TRIGGER fixture_part_insert_failure AFTER INSERT ON run_media_parts
      WHEN NEW.position=1 AND EXISTS(SELECT 1 FROM run_media_parts WHERE prompt_id=NEW.prompt_id AND position=0)
      BEGIN SELECT RAISE(ABORT,'injected after second media part'); END;`);
    else f.db.exec(`CREATE TRIGGER fixture_part_seal_failure AFTER UPDATE OF input ON run_steps
      WHEN NEW.input IS NOT NULL AND (SELECT COUNT(*) FROM run_media_parts WHERE prompt_id=NEW.prompt_id)=2
        AND (SELECT COUNT(*) FROM run_context WHERE run_id=NEW.run_id AND kind='thought' AND ref_id IN ('media-root','parts-second-root'))=2
      BEGIN SELECT RAISE(ABORT,'injected after media input seal'); END;
      CREATE TRIGGER fixture_part_exposure_failure AFTER INSERT ON run_context
      WHEN (SELECT input FROM run_steps WHERE run_id=NEW.run_id AND position=0) IS NOT NULL
        AND (SELECT COUNT(*) FROM run_media_parts part JOIN run_steps step ON step.prompt_id=part.prompt_id WHERE step.run_id=NEW.run_id)=2
        AND (SELECT COUNT(*) FROM run_context WHERE run_id=NEW.run_id AND kind='thought' AND ref_id IN ('media-root','parts-second-root'))=2
      BEGIN SELECT RAISE(ABORT,'injected after media input seal'); END;`);
    expect(() => sealOriginalParts(f, owner, parts)).toThrow(phase === "second part" ? "injected after second media part" : "injected after media input seal");
    expect(partSnapshot(f.db)).toEqual([]);
    expect(f.steps.steps(owner.run.id)).toEqual(beforeSteps);
    expect(f.runs.contextRefs(owner.run.id)).toEqual(beforeRefs);
    expect(f.db.inTransaction).toBe(false);
    expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    f.db.exec(`DROP TRIGGER ${phase === "second part" ? "fixture_part_insert_failure" : "fixture_part_seal_failure"}`);
    if (phase === "input seal") f.db.exec("DROP TRIGGER fixture_part_exposure_failure");
    expect(sealOriginalParts(f, owner, parts).input).not.toBeNull();
  }));

  const forgeries: readonly { name: string; render: (context: InitialRunContext, manifest: OriginalManifest) => string }[] = [
    { name: "missing manifest", render: context => initialWorkerPrompt(context) },
    { name: "missing part", render: (context, manifest) => manifestInput(context, { ...manifest, parts: manifest.parts.slice(1) }) },
    { name: "reordered parts", render: (context, manifest) => manifestInput(context, { ...manifest, parts: [...manifest.parts].reverse() }) },
    { name: "wrong digest", render: (context, manifest) => manifestInput(context, { ...manifest,
      parts: manifest.parts.map(part => ({ ...part, sha256: `${part.sha256.startsWith("0") ? "1" : "0"}${part.sha256.slice(1)}` })) }) },
    { name: "extra observation claim", render: (context, manifest) => manifestInput(context, { ...manifest,
      parts: manifest.parts.map(part => ({ ...part, observed: true })) }) },
  ];
  for (const { name, render } of forgeries) test(`preparation rejects ${name} instead of sealing inconsistent media input`, () => mediaWeaveFixture(f => {
    requireRunMediaParts(f.db);
    const parts = originalParts(f), owner = startPartOwner(f), before = f.steps.steps(owner.run.id);
    expect(() => sealOriginalParts(f, owner, parts, render)).toThrow(RunConflictError);
    expect(partSnapshot(f.db)).toEqual([]);
    expect(f.steps.steps(owner.run.id)).toEqual(before);
    expect(f.runs.contextRefs(owner.run.id)).toEqual([]);
  }));

  test("the existing protocol prepare path cannot omit a staged part manifest", () => mediaWeaveFixture(f => {
    requireRunMediaParts(f.db);
    const parts = originalParts(f), owner = startPartOwner(f);
    expect(() => immediate(f.db, () => {
      for (const part of parts) insertOriginalPart(f.db, owner.run.promptId, part);
      f.steps.prepare(owner.claim, { promptId: owner.run.promptId, input: "Untracked text-only substitute" });
    })).toThrow(RunConflictError);
    expect(partSnapshot(f.db)).toEqual([]);
    expect(f.steps.steps(owner.run.id)[0]?.input).toBeNull();
  }));

  test("sealed media preparation replays exact retained input without rerendering or granting an observation", () => mediaWeaveFixture(f => {
    requireRunMediaParts(f.db);
    const parts = originalParts(f), owner = startPartOwner(f), prepared = sealOriginalParts(f, owner, parts), before = partSnapshot(f.db);
    const input = prepared.input;
    if (input === null) throw new Error("Expected the sealed media input");
    expect(f.state.prepareInitial(owner.claim, () => { throw new Error("Must retain exact input, not rerender"); })).toEqual(prepared);
    expect(f.steps.prepare(owner.claim, { promptId: owner.run.promptId, input })).toEqual(prepared);
    expect(() => f.steps.prepare(owner.claim, { promptId: owner.run.promptId, input: `${input}\nchanged` })).toThrow(RunConflictError);
    expect(partSnapshot(f.db)).toEqual(before);
    expect(f.db.query("SELECT observed FROM run_media_parts WHERE prompt_id=? ORDER BY position").all(owner.run.promptId)).toEqual([{ observed: 0 }, { observed: 0 }]);
  }));

  test("repeated migration preserves populated manifests and exact input without promoting observations", () => mediaWeaveFixture(f => {
    requireRunMediaParts(f.db);
    const parts = originalParts(f), owner = startPartOwner(f);
    sealOriginalParts(f, owner, parts);
    const beforeParts = partSnapshot(f.db), beforeSteps = f.steps.steps(owner.run.id), beforeRefs = f.runs.contextRefs(owner.run.id);
    migrate(f.db, f.sources.logger); migrate(f.db, f.sources.logger);
    expect(partSnapshot(f.db)).toEqual(beforeParts);
    expect(f.steps.steps(owner.run.id)).toEqual(beforeSteps);
    expect(f.runs.contextRefs(owner.run.id)).toEqual(beforeRefs);
    expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  }));

  test("original identity stays immutable and sealing forbids even a contiguous late append", () => mediaWeaveFixture(f => {
    requireRunMediaParts(f.db);
    const parts = originalParts(f), owner = startPartOwner(f);
    sealOriginalParts(f, owner, parts);
    const other = f.ops.admitWeave("user", { subjectId: mediaNeighbor.id, triggerId: "other-part-owner" }), before = partSnapshot(f.db);
    // Both alternate FKs exist; both sources deliberately share MIME/length/digest, so identity cannot hide behind FK/fingerprint failure.
    for (const [sql, value] of [
      ["UPDATE run_media_parts SET source_id=? WHERE position=0", parts[1].sourceId],
      ["UPDATE run_media_parts SET prompt_id=? WHERE position=0", other.promptId],
    ] as const) expect(() => f.db.query(sql).run(value)).toThrow();
    for (const sql of ["UPDATE run_media_parts SET byte_length=byte_length+1", "UPDATE run_media_parts SET position=position+3",
      "DELETE FROM run_media_parts", "INSERT OR REPLACE INTO run_media_parts SELECT * FROM run_media_parts", "UPDATE run_media_parts SET observed=1"]) {
      expect(() => f.db.exec(sql)).toThrow();
    }
    expect(() => insertOriginalPart(f.db, owner.run.promptId, { ...parts[0], position: 2 })).toThrow();
    expect(partSnapshot(f.db)).toEqual(before);
  }));

  const mismatches: readonly { name: string; change: (part: OriginalPart) => OriginalPart }[] = [
    { name: "MIME", change: part => ({ ...part, mimeType: "image/jpeg" }) },
    { name: "length", change: part => ({ ...part, byteLength: part.byteLength + 1 }) },
    { name: "digest", change: part => ({ ...part, sha256: part.sha256.map((byte, index) => index === 0 ? byte ^ 255 : byte) }) },
    { name: "position gap", change: part => ({ ...part, position: 1 }) },
  ];
  for (const { name, change } of mismatches) test(`SQL refuses an original with mismatched ${name}`, () => mediaWeaveFixture(f => {
    requireRunMediaParts(f.db);
    const parts = originalParts(f), owner = startPartOwner(f);
    expect(() => insertOriginalPart(f.db, owner.run.promptId, change(parts[0]))).toThrow();
    expect(partSnapshot(f.db)).toEqual([]);
  }));

  test("an original cannot carry a derived key/recipe or an inserted observed flag", () => mediaWeaveFixture(f => {
    requireRunMediaParts(f.db);
    const [part] = originalParts(f), owner = startPartOwner(f);
    for (const [key, recipe, observed] of [["fixture-prepared-key", "{}", 0], [null, null, 1]] as const) {
      expect(() => f.db.run(`INSERT INTO run_media_parts(prompt_id,position,source_id,representation,mime_type,byte_length,sha256,prepared_key,recipe_json,observed)
        VALUES (?,0,?,'original',?,?,?,?,?,?)`, [owner.run.promptId, part.sourceId, part.mimeType, part.byteLength, part.sha256, key, recipe, observed])).toThrow();
    }
    expect(partSnapshot(f.db)).toEqual([]);
  }));

  test.each(["title-only", "unknown-media", "export", "search", "import"] as const)("%s work cannot stage application media parts", role => mediaWeaveFixture(f => {
    requireRunMediaParts(f.db);
    const [part] = originalParts(f), kind = role === "title-only" || role === "unknown-media" ? "weave" : role;
    const run: RunRecord = { id: `restricted-parts-${role}`, kind, status: "queued", generation: 0, nativeState: "unknown", inputThoughtId: null,
      sessionId: `restricted-parts-session-${role}`, promptId: `restricted-parts-prompt-${role}`, createdAt: mediaTime };
    insertRun(f.db, run, kind === "weave" ? { subjectId: mediaThought.id, triggerId: role === "title-only" ? "title-clear:parts-fixture" : "unknown:parts-fixture" } : null);
    expect(f.db.query("SELECT input,state,native_state FROM run_steps WHERE run_id=?").get(run.id)).toEqual({ input: null, state: "prepared", native_state: "unknown" });
    expect(() => insertOriginalPart(f.db, run.promptId, part)).toThrow();
    expect(partSnapshot(f.db)).toEqual([]);
  }));

  test("rejected originals and stale claims cannot seal a prepared fingerprint", () => mediaWeaveFixture(f => {
    requireRunMediaParts(f.db);
    const parts = originalParts(f), owner = startPartOwner(f), newer = f.runs.claim(owner.run.id);
    expect(() => sealOriginalParts(f, owner, parts)).toThrow(RunFenceError);
    expect(partSnapshot(f.db)).toEqual([]);
    new RejectionService(new SqliteRejectionRepository(f.db)).rejectThought("user", mediaThought.id);
    expect(() => sealOriginalParts(f, { ...owner, claim: newer }, parts)).toThrow();
    expect(partSnapshot(f.db)).toEqual([]);
    expect(f.steps.steps(owner.run.id)[0]?.input).toBeNull();
    expect(f.runs.contextRefs(owner.run.id)).toEqual([]);
  }));

  test("a descriptor full read does not create part observations or a binary-read witness", () => mediaWeaveFixture(f => {
    requireRunMediaParts(f.db);
    const owner = startPartOwner(f);
    f.state.prepareInitial(owner.claim, initialWorkerPrompt);
    const request = { capability: "readThought", arguments: { id: mediaThought.id } } as const;
    f.steps.completeStep(owner.claim, owner.run.promptId, { version: 1, kind: "request", request });
    const result = f.dispatcher.dispatch(owner.claim, owner.run.promptId, request);
    expect(result.type).toBe("thought");
    if (result.type !== "thought" || result.thought === null) throw new Error("Expected the eligible media descriptor");
    expect(result.thought.kind).toBe("media-original");
    expect(f.dispatcher.fullReadWitnesses(owner.run.id)).toContainEqual({ kind: "thought", id: mediaThought.id });
    expect(partSnapshot(f.db)).toEqual([]);
  }));

  test("sealed fingerprints cannot reach a text-only native port before media delivery authority exists", async () => asyncMediaWeaveFixture(async f => {
    requireRunMediaParts(f.db);
    const parts = originalParts(f), owner = startPartOwner(f);
    const binding: AgentBinding = { sessionId: owner.run.sessionId, serviceUrl: "https://parts.example.invalid",
      location: { directory: "/tmp/opencode/parts-owned-binding" }, model: { providerID: "fixture", id: "parts-fixture" },
      permissions: [{ action: "*", resource: "*", effect: "deny" }], protocolVersion: 1 };
    new SqliteAgentBindings(f.db, f.sources.logger).bind(owner.run.id, binding, owner.claim);
    const prepared = sealOriginalParts(f, owner, parts), before = partSnapshot(f.db), replay = mediaReplayWorker(f);
    try {
      for (let tick = 0; tick < 6 && replay.received.length === 0; tick++) {
        try { await replay.worker.tick(owner.run.id); }
        catch (error) { expect(error instanceof RunForbiddenError || error instanceof RunFenceError).toBe(true); }
      }
      expect(replay.submitted).toEqual([]);
      expect(replay.received).toEqual([]); // The fake records bytes before its adapter callbacks, so a late callback rejection is insufficient.
      expect(f.steps.steps(owner.run.id)[0]?.input).toBe(prepared.input);
      expect(partSnapshot(f.db)).toEqual(before);
    } finally { replay.worker.pause(); await replay.worker.drain(); }
  }));
});
