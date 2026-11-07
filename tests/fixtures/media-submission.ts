import { expect } from "bun:test";
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { AgentBinding } from "../../src/agent/opencode-adapter";
import { RunAdmissionService } from "../../src/domain/run";
import { TitleService } from "../../src/domain/title";
import { createLogger } from "../../src/logging";
import { SqliteAgentBindings } from "../../src/storage/agent-binding";
import { SqliteCapabilityDispatcher } from "../../src/storage/capability";
import { ExecutionOwnerLease } from "../../src/storage/execution-owner";
import { readMediaSubmission, type MediaSubmissionAuthorization, type MediaSubmissionPrompt } from "../../src/storage/media-submission";
import { SqliteRunRepository } from "../../src/storage/run";
import { SqliteRunOperations } from "../../src/storage/run-operations";
import { SqliteRunProtocolRepository } from "../../src/storage/run-protocol";
import { SqliteRunWorkerState } from "../../src/storage/run-worker";
import { SqliteTitleRepository } from "../../src/storage/title";
import { mediaAdmissionFixture } from "./media-admission";
import { mediaDigest, mediaThought } from "./media-source";
import { mediaNeighbor, type MediaWeaveFixture } from "./media-weave";
import { originalManifest, originalParts, sealOriginalParts, startPartOwner } from "./run-media-parts";

export interface MediaSubmissionFixture extends MediaWeaveFixture {
  readonly path: string;
  readonly other: Database;
  readonly owner: ExecutionOwnerLease;
}

export async function mediaSubmissionFixture(action: (fixture: MediaSubmissionFixture) => void | Promise<void>): Promise<void> {
  await mediaAdmissionFixture(async base => {
    const sources = { id: base.sources.id, now: base.sources.now, logger: createLogger("verbose", () => {}) };
    const owner = await ExecutionOwnerLease.acquire(base.path, sources.logger);
    try {
      owner.register(base.db);
      base.store.saveMediaSource({ thought: mediaThought, requestKey: "submission-source", sha256: mediaDigest });
      base.store.saveThought(mediaNeighbor);
      const runs = new SqliteRunRepository(base.db, sources);
      await action({ db: base.db, store: base.store, sources, runs, path: base.path, other: base.other, owner,
        titles: new TitleService(new SqliteTitleRepository(base.db, sources)),
        admissions: new RunAdmissionService({ ...sources, repository: runs }),
        ops: new SqliteRunOperations(base.db, sources), steps: new SqliteRunProtocolRepository(base.db, sources.logger),
        state: new SqliteRunWorkerState(base.db, sources), dispatcher: new SqliteCapabilityDispatcher(base.db, sources) });
    } finally { owner.release(); }
  });
}

export function submissionBinding(run: { readonly sessionId: string }): AgentBinding {
  return { sessionId: run.sessionId, serviceUrl: "https://media-submission.example.invalid",
    location: { directory: "/tmp/opencode/media-submission-owned-binding" }, model: { providerID: "fixture", id: "submission-model" },
    permissions: [{ action: "*", resource: "*", effect: "deny" }], protocolVersion: 1 };
}

export function prepareMediaSubmission(f: MediaSubmissionFixture, kind: "weave" | "evolve" = "weave", bind = true) {
  const parts = originalParts(f), holder = startPartOwner(f, kind), binding = submissionBinding(holder.run);
  if (bind) new SqliteAgentBindings(f.db, f.sources.logger, f.owner).bind(holder.run.id, binding, holder.claim);
  const step = sealOriginalParts(f, holder, parts);
  if (step.input === null) throw new Error("Expected sealed original input");
  const prompt: MediaSubmissionPrompt = { promptId: step.promptId, input: step.input, media: originalManifest(parts) };
  return { ...holder, binding, parts, step, prompt };
}
export type PreparedMediaSubmission = ReturnType<typeof prepareMediaSubmission>;

export function expectedSubmission(f: MediaSubmissionFixture, prepared: PreparedMediaSubmission): MediaSubmissionAuthorization {
  return { version: 1, runId: prepared.run.id, promptId: prepared.step.promptId, generation: prepared.claim.generation,
    executionOwnerId: f.owner.id, binding: prepared.binding,
    inputSha256: createHash("sha256").update(prepared.prompt.input, "utf8").digest("hex"), media: prepared.prompt.media };
}

export function submissionSnapshot(db: Database) {
  return ["runs", "run_steps", "run_context", "run_media_parts", "agent_bindings", "run_operation_receipts", "run_issued_thoughts", "run_replies"]
    .map(table => ({ table, rows: db.query(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all() }));
}

/** Instance-local wrapper over real SQLite. Fire only after both intent and submission states actually exist inside SQL. */
export function interceptCompleteSubmission(db: Database, promptId: string, afterWrite: () => void) {
  let witnessed: MediaSubmissionAuthorization | null = null;
  const check = () => {
    if (witnessed !== null || !db.inTransaction) return;
    const authorization = readMediaSubmission(db, promptId);
    const state = db.query<{ step: string; run: string }, [string]>(`SELECT step.state AS step,run.status AS run
      FROM run_steps step JOIN runs run ON run.id=step.run_id WHERE step.prompt_id=?`).get(promptId);
    if (authorization === null || state?.step !== "submitting" || state.run !== "submitting") return;
    witnessed = authorization;
    expect(db.inTransaction).toBe(true);
    afterWrite();
  };
  const connection = new Proxy(db, { get(target, key) {
    const value: unknown = Reflect.get(target, key, target);
    if (typeof value !== "function") return value;
    if (key === "query" || key === "prepare") return (...args: unknown[]) => {
      const statement: unknown = Reflect.apply(value, target, args);
      if (typeof statement !== "object" || statement === null) throw new Error("Expected real SQLite statement");
      return new Proxy(statement, { get(targetStatement, field) {
        const method: unknown = Reflect.get(targetStatement, field, targetStatement);
        if (typeof method !== "function") return method;
        if (field === "run" || field === "get" || field === "all") return (...parameters: unknown[]) => {
          const result: unknown = Reflect.apply(method, targetStatement, parameters); check(); return result;
        };
        return method.bind(targetStatement);
      } });
    };
    if (key === "run" || key === "exec") return (...args: unknown[]) => {
      const result: unknown = Reflect.apply(value, target, args); check(); return result;
    };
    return value.bind(target);
  } });
  return { connection, witnessed: () => witnessed };
}
