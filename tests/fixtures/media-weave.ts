import { Database } from "bun:sqlite";
import { expect } from "bun:test";
import type { AgentBinding, PersistedPrompt } from "../../src/agent/opencode-adapter";
import { RunWorker, type WorkerNative } from "../../src/agent/worker";
import { capabilityResultPrompt, initialWorkerPrompt } from "../../src/agent/worker-prompts";
import type { ReadCapabilityRequest, ReadCapabilityResult } from "../../src/domain/capability";
import { RunAdmissionService, type RunRecord } from "../../src/domain/run";
import type { InitialRunContext } from "../../src/domain/run-context";
import { protocolJson } from "../../src/domain/run-protocol";
import type { TextThought } from "../../src/domain/thought";
import { TitleService } from "../../src/domain/title";
import { createLogger } from "../../src/logging";
import { SqliteAgentBindings } from "../../src/storage/agent-binding";
import { SqliteCapabilityDispatcher } from "../../src/storage/capability";
import { SqliteRunRepository } from "../../src/storage/run";
import { SqliteRunOperations } from "../../src/storage/run-operations";
import { SqliteRunProtocolRepository } from "../../src/storage/run-protocol";
import { insertRun } from "../../src/storage/run-record";
import { SqliteRunWorkerState } from "../../src/storage/run-worker";
import { migrate, SqliteStore } from "../../src/storage/sqlite";
import { SqliteTitleRepository } from "../../src/storage/title";
import { immediate } from "../../src/storage/transaction";
import { mediaDigest, mediaStoreId, mediaThought, mediaTime } from "./media-source";
import { mediaChildPredecessor, type RetainedMediaChild } from "./media-child-predecessor";

export const mediaNeighbor: TextThought = {
  id: "media-purpose-neighbor", text: "A separate recorded thought", title: null, titleAuthor: null,
  author: "user", kind: "captured-original", createdAt: mediaTime, origin: "fixture", parentId: null, sourceIds: [],
};

function setup(db: Database, source: "fresh" | "retained" = "fresh") {
  let sequence = 0;
  const sources = { id: () => `media-purpose-${++sequence}`, now: () => mediaTime, logger: createLogger("verbose", () => {}) };
  const store = new SqliteStore(db, undefined, sources.logger);
  if (source === "fresh") {
    store.initializeMediaStore(mediaStoreId);
    // Real metadata admission, not a file-admission or format-validation fixture.
    store.saveMediaSource({ thought: mediaThought, requestKey: "media-purpose-source", sha256: mediaDigest });
  } else {
    expect(store.mediaStoreId()).toBe(mediaStoreId);
    expect(store.getThought(mediaThought.id)).toEqual(mediaThought);
  }
  store.saveThought(mediaNeighbor);
  const titles = new TitleService(new SqliteTitleRepository(db, sources));
  titles.setUser("user", mediaThought.id, "Existing source label");
  const runs = new SqliteRunRepository(db, sources);
  return {
    db, store, sources, titles, runs,
    admissions: new RunAdmissionService({ ...sources, repository: runs }),
    ops: new SqliteRunOperations(db, sources),
    steps: new SqliteRunProtocolRepository(db, sources.logger),
    state: new SqliteRunWorkerState(db, sources),
    dispatcher: new SqliteCapabilityDispatcher(db, sources),
  };
}

export type MediaWeaveFixture = ReturnType<typeof setup>;

export function mediaWeaveFixture(action: (fixture: MediaWeaveFixture) => void): void {
  const db = new Database(":memory:");
  try { migrate(db); action(setup(db)); } finally { db.close(); }
}

/** Start current services only after the child-only predecessor has survived migration and a real file reopen. */
export function retainedChildMediaWeaveFixture(child: RetainedMediaChild, action: (fixture: MediaWeaveFixture) => void): void {
  mediaChildPredecessor(mediaThought, child, db => action(setup(db,"retained")));
}

export async function asyncMediaWeaveFixture(action: (fixture: MediaWeaveFixture) => Promise<void>): Promise<void> {
  const db = new Database(":memory:");
  try { migrate(db); await action(setup(db)); } finally { db.close(); }
}

export function prepareMediaRun(f: MediaWeaveFixture, run: RunRecord) {
  const claim = f.runs.claim(run.id);
  const contexts: InitialRunContext[] = [];
  const step = f.state.prepareInitial(claim, context => {
    contexts.push(context);
    return initialWorkerPrompt(context);
  });
  const context = contexts[0];
  if (!context || step.input === null) throw new Error("Expected newly prepared worker context");
  return { run, claim, step, context, input: step.input };
}

export type PreparedMediaRun = ReturnType<typeof prepareMediaRun>;

export function startMediaTitleClear(f: MediaWeaveFixture): PreparedMediaRun {
  f.titles.setUser("user", mediaThought.id, null);
  const row = f.db.query<{ id: string }, [string]>(`SELECT id FROM runs
    WHERE kind='weave' AND weave_subject_id=? ORDER BY rowid DESC LIMIT 1`).get(mediaThought.id);
  const run = row ? f.runs.get(row.id) : null;
  if (!run) throw new Error("Expected a persisted title-clear invitation");
  return prepareMediaRun(f, run);
}

export function seedMediaRelations(f: MediaWeaveFixture): void {
  f.store.saveConnection({ id: "media-purpose-link", fromId: mediaThought.id, toId: mediaNeighbor.id,
    category: "related", explanation: "An existing relation, not title instructions", proposedBy: "ai", sourceIds: [] });
  f.store.saveResponse({ id: "media-purpose-response", text: "An unrelated retained reply", role: "addendum",
    state: "complete", thoughtIds: [mediaThought.id, mediaNeighbor.id] });
}

/** A retained predecessor row must not acquire authority merely by bypassing today's admission API. */
export function retainUnmappedMediaWeave(f: MediaWeaveFixture) {
  const run: RunRecord = {
    id: "retained-media-weave", kind: "weave", status: "queued", sessionId: "retained-media-session",
    promptId: "retained-media-prompt", createdAt: mediaTime, generation: 1, inputThoughtId: null, nativeState: "unknown",
  };
  const intent = { subjectId: mediaThought.id, triggerId: "unmapped-retained-trigger" };
  insertRun(f.db, run, intent);
  return { run, intent, claim: { runId: run.id, generation: run.generation } };
}

export function bindMediaReplay(f: MediaWeaveFixture, prepared: PreparedMediaRun): AgentBinding {
  const binding: AgentBinding = { sessionId: prepared.run.sessionId, serviceUrl: "https://media-purpose.example.invalid",
    location: { directory: "/tmp/opencode/media-purpose-owned-binding" }, model: { providerID: "fixture", id: "media-purpose" },
    permissions: [{ action: "*", resource: "*", effect: "deny" }], protocolVersion: 1 };
  new SqliteAgentBindings(f.db, f.sources.logger).bind(prepared.run.id, binding, prepared.claim);
  return binding;
}

/** An old, already-processed read bypasses today's dispatch/advance gates, not the immutable journal constraints. */
export function retainForbiddenMediaSuccessor(f: MediaWeaveFixture) {
  const prepared = startMediaTitleClear(f);
  // Bind while the initial step is still prepared, exactly as a worker before the retained predecessor ran.
  const binding = bindMediaReplay(f, prepared);
  const read: ReadCapabilityRequest = { capability: "readThought", arguments: { id: mediaNeighbor.id } };
  const result = { type: "thought", thought: mediaNeighbor } satisfies ReadCapabilityResult;
  f.steps.completeStep(prepared.claim, prepared.step.promptId, { version: 1, kind: "request", request: read });
  const next = { promptId: "retained-forbidden-media-successor", input: capabilityResultPrompt(read, result, "weave", binding) };
  immediate(f.db, () => {
    f.db.run("INSERT INTO run_context(run_id,kind,ref_id,full_read) VALUES (?,'thought',?,1)", [prepared.run.id, mediaNeighbor.id]);
    f.db.run("UPDATE run_steps SET state='processed',result_json=? WHERE run_id=? AND prompt_id=?", [protocolJson(result), prepared.run.id, prepared.step.promptId]);
    f.db.run(`INSERT INTO run_steps(run_id,position,prompt_id,input,state,native_state)
      VALUES (?,1,?,?,'prepared','unknown')`, [prepared.run.id, next.promptId, next.input]);
    f.db.run("UPDATE runs SET status='queued' WHERE id=?", [prepared.run.id]);
  });
  return { prepared, binding, read, result, next };
}

/** Capture receipt of bytes at the fake native boundary before the adapter-style authorization callbacks. */
export function mediaReplayWorker(f: MediaWeaveFixture) {
  const submitted: PersistedPrompt[] = [];
  const received: { readonly boundary: "submit" | "observe" | "cancel"; readonly prompt: PersistedPrompt }[] = [];
  const ensured: string[] = [];
  const worker = new RunWorker({ db: f.db, ...f.sources,
    bindingFor: () => { throw new Error("Retained replay must use its existing immutable binding"); },
    native: bindings => {
      const native: WorkerNative = {
        ensureSession: async (claim, binding) => { ensured.push(binding.sessionId); bindings.bind(claim.runId, binding, claim); },
        submit: async (claim, _binding, prompt) => {
          received.push({ boundary: "submit", prompt: { ...prompt } });
          bindings.assertActive(claim, prompt, "history");
          bindings.assertActive(claim, prompt, "submit");
          submitted.push({ ...prompt });
          bindings.assertActive(claim, prompt, "acknowledged");
        },
        observe: async (claim, _binding, prompts) => {
          for (const prompt of prompts) received.push({ boundary: "observe", prompt: { ...prompt } });
          const last = prompts.at(-1);
          if (!last) throw new Error("Expected retained observation history");
          bindings.assertActive(claim, last, "history");
          return { state: "running" };
        },
        cancel: async (_runId, _binding, prompt) => { received.push({ boundary: "cancel", prompt: { ...prompt } }); return "settled"; },
      };
      return native;
    },
  });
  return { worker, submitted, received, ensured };
}
