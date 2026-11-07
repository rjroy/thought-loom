import { expect } from "bun:test";
import { capabilityResultPrompt, initialWorkerPrompt } from "../../src/agent/worker-prompts";
import type { NextStep } from "../../src/domain/run-protocol";
import { protocolJson } from "../../src/domain/run-protocol";
import { record } from "../../src/domain/validation";
import { SqliteAgentBindings } from "../../src/storage/agent-binding";
import { submissionBinding, type MediaSubmissionFixture } from "./media-submission";
import { mediaNeighbor } from "./media-weave";
import { originalManifest, originalParts, startPartOwner, type OriginalManifest } from "./run-media-parts";

/** Intended optional extension to the existing trusted next-step argument; not a model-selected identity or native file part. */
export interface OriginalMediaSuccessor extends NextStep { readonly media: OriginalManifest }

export function completedMediaPredecessor(f: MediaSubmissionFixture, kind: "weave" | "evolve" = "weave") {
  const parts = originalParts(f), holder = startPartOwner(f, kind), binding = submissionBinding(holder.run);
  const bindings = new SqliteAgentBindings(f.db, f.sources.logger, f.owner);
  bindings.bind(holder.run.id, binding, holder.claim);
  const initial = f.state.prepareInitial(holder.claim, initialWorkerPrompt);
  if (initial.input === null) throw new Error("Expected retained text-only initial input");
  bindings.assertActive(holder.claim, { promptId: initial.promptId, input: initial.input }, "submit");
  // A controlled native envelope for a text read, not evidence of file delivery, binary observation or a media-open capability.
  const request = { capability: "readThought", arguments: { id: mediaNeighbor.id } } as const;
  f.steps.completeStep(holder.claim, initial.promptId, { version: 1, kind: "request", request });
  const result = f.dispatcher.dispatch(holder.claim, initial.promptId, request);
  expect(result.type).toBe("thought");
  if (result.type !== "thought" || result.thought === null) throw new Error("Expected the confirmed text-read result");
  expect(result.thought).toEqual(mediaNeighbor);
  const predecessor = f.steps.steps(holder.run.id)[0];
  if (!predecessor) throw new Error("Expected the real completed predecessor");
  expect(predecessor).toMatchObject({ promptId: initial.promptId, input: initial.input, state: "completed", result });
  expect(f.runs.get(holder.run.id)?.status).toBe("uncertain");
  return { ...holder, binding, parts, predecessor, request, result };
}
export type MediaSuccessorPredecessor = ReturnType<typeof completedMediaPredecessor>;

export function mediaSuccessorInput(previous: MediaSuccessorPredecessor, media: unknown): string {
  return protocolJson({ ...record(JSON.parse(capabilityResultPrompt(previous.request, previous.result, previous.run.kind, previous.binding))), media });
}

export function originalMediaSuccessor(previous: MediaSuccessorPredecessor): OriginalMediaSuccessor {
  const media = originalManifest(previous.parts);
  return { promptId: "media-successor-owned-prompt", input: mediaSuccessorInput(previous, media), media };
}

/** Test-owned prepared fingerprints stand in for external preparation; the existing advance transaction must commit all SQL effects. */
export function commitMediaSuccessor(f: MediaSubmissionFixture, previous: MediaSuccessorPredecessor,
  next: OriginalMediaSuccessor = originalMediaSuccessor(previous)) {
  return f.steps.advance(previous.claim, previous.predecessor.promptId, previous.result, next);
}

export function preparedMediaSuccessor(f: MediaSubmissionFixture, previous: MediaSuccessorPredecessor,
  next: OriginalMediaSuccessor = originalMediaSuccessor(previous)) {
  const step = commitMediaSuccessor(f, previous, next);
  if (step.input === null) throw new Error("Expected sealed successor input");
  return { run: previous.run, claim: previous.claim, binding: previous.binding, parts: previous.parts, step,
    prompt: { promptId: step.promptId, input: step.input, media: next.media }, next };
}

export function expectedSuccessorParts(previous: MediaSuccessorPredecessor, promptId: string) {
  return previous.parts.map(part => ({ prompt_id: promptId, position: part.position, source_id: part.sourceId,
    representation: "original", mime_type: part.mimeType, byte_length: part.byteLength, sha256: part.sha256,
    prepared_key: null, recipe_json: null, observed: 0 }));
}

export function failCompleteSuccessorSeal(f: MediaSubmissionFixture, previous: MediaSuccessorPredecessor): void {
  // Either input or exposures may be written last. Fail only after the complete successor graph exists, not on a chosen ordering.
  const complete = `EXISTS(SELECT 1 FROM run_steps successor JOIN run_steps predecessor ON predecessor.run_id=successor.run_id
    WHERE successor.prompt_id='media-successor-owned-prompt' AND predecessor.position=0 AND predecessor.state='processed'
      AND predecessor.result_json IS NOT NULL AND successor.input IS NOT NULL
      AND (SELECT COUNT(*) FROM run_media_parts WHERE prompt_id=successor.prompt_id)=2
      AND (SELECT COUNT(*) FROM run_context WHERE run_id=successor.run_id AND kind='thought' AND ref_id IN ('media-root','parts-second-root'))=2)`;
  f.db.exec(`CREATE TRIGGER fixture_successor_seal_failure AFTER UPDATE OF input ON run_steps
    WHEN ${complete} BEGIN SELECT RAISE(ABORT,'injected after complete media successor seal'); END;
    CREATE TRIGGER fixture_successor_exposure_failure AFTER INSERT ON run_context
    WHEN ${complete} BEGIN SELECT RAISE(ABORT,'injected after complete media successor seal'); END;`);
  expect(previous.predecessor.position).toBe(0);
}
