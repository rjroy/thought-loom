import type { Database } from "bun:sqlite";
import type { Actor } from "../domain/rejection";
import { RunConflictError, RunForbiddenError, type RunRecord, type RunSources } from "../domain/run";
import { createThought, type MediaThought } from "../domain/thought";
import { equalBytes, importRequestKey } from "../domain/markdown-import-contract";
import { nonEmpty, ValidationError } from "../domain/validation";
import { createLogger, type Logger } from "../logging";
import { initialMediaAttemptRequestKey } from "./media-attempt-schema";
import { saveMediaSource, type MediaSourceWrite } from "./media-source";
import { insertRun, readRun } from "./run-record";
import { SqliteStore } from "./sqlite";
import { immediate } from "./transaction";

export interface MediaSourceAdmission {
  readonly thought: MediaThought;
  readonly run: RunRecord;
  readonly replayed: boolean;
}

interface RetainedSource {
  readonly sourceId: string;
  readonly thoughtId: string;
  readonly name: string;
  readonly mimeType: string;
  readonly byteLength: number;
  readonly sha256: Uint8Array;
  readonly clarification: string | null;
}

/** User-only, source-first storage command. Admission supplies identity, not execution or file-delivery authority. */
export class SqliteMediaAdmissions {
  private readonly logger: Logger;
  constructor(private readonly db: Database, private readonly sources: RunSources) { this.logger = sources.logger ?? createLogger(); }
  admit(actor: Actor, input: MediaSourceWrite): MediaSourceAdmission {
    if (actor !== "user") throw new RunForbiddenError("Media admission is user-only");
    const thought = createThought(input.thought), requestKey = importRequestKey(input.requestKey);
    if (thought.kind !== "media-original" || thought.title !== null || thought.titleAuthor != null) throw new ValidationError("A new media root must be untitled");
    if (!(input.sha256 instanceof Uint8Array) || input.sha256.length !== 32) throw new ValidationError("Invalid media digest");
    const write: MediaSourceWrite = { thought, requestKey, sha256: new Uint8Array(input.sha256) };
    this.logger.verbose("[media admission] attempt");
    try {
      const result = immediate(this.db,() => {
        const existing = this.db.query<RetainedSource, [string]>(`SELECT id AS sourceId,source_thought_id AS thoughtId,
          display_name AS name,mime_type AS mimeType,byte_length AS byteLength,sha256,clarification
          FROM media_sources WHERE request_key=?`).get(requestKey);
        if (existing) return this.replay(existing,write);

        // This existing metadata-only writer joins the outer transaction. It still never schedules work by itself.
        saveMediaSource(this.db,write);
        const run: RunRecord = { id: nonEmpty(this.sources.id(),"runId"), kind: "weave", status: "queued",
          sessionId: nonEmpty(this.sources.sessionId?.() ?? this.sources.id(),"sessionId"),
          promptId: nonEmpty(this.sources.promptId?.() ?? this.sources.id(),"promptId"), createdAt: nonEmpty(this.sources.now(),"createdAt"),
          generation: 0, inputThoughtId: null, nativeState: "unknown" };
        // Canonical insertion creates the existing initial run_steps row. Ordinary weave admission deliberately still denies this purpose.
        insertRun(this.db,run,{subjectId:thought.id,triggerId:`media:${thought.mediaSource.id}:0`});
        this.db.run("INSERT INTO media_weave_attempts(source_id,position,run_id,request_key) VALUES (?,0,?,?)",
          [thought.mediaSource.id,run.id,initialMediaAttemptRequestKey]);
        return {thought:this.sourceThought(thought.id),run:Object.freeze(run),replayed:false};
      });
      const context = { sourceId: result.thought.mediaSource.id, thoughtId: result.thought.id, runId: result.run.id };
      if (result.replayed) this.logger.verbose("[media admission] replay confirmed",context);
      else this.logger.info("[media admission] confirmed",context);
      return result;
    } catch (error) {
      this.logger.verbose("[media admission] failed");
      throw error;
    }
  }
  private sourceThought(id: string): MediaThought {
    const thought = new SqliteStore(this.db,undefined,this.logger).getThought(id);
    if (!thought || thought.kind !== "media-original") throw new RunConflictError("Retained media root is unavailable");
    return thought;
  }
  private replay(existing: RetainedSource, input: MediaSourceWrite): MediaSourceAdmission {
    const source = input.thought.mediaSource;
    // IDs and creation times are daemon allocations, not the upload payload. Titles are independently editable metadata.
    if (existing.name !== source.name || existing.mimeType !== source.mimeType || existing.byteLength !== source.byteLength ||
        existing.clarification !== source.clarification || !equalBytes(existing.sha256,input.sha256)) {
      throw new RunConflictError("Media idempotency conflict");
    }
    const attempt = this.db.query<{ runId: string; requestKey: string }, [string]>(
      "SELECT run_id AS runId,request_key AS requestKey FROM media_weave_attempts WHERE source_id=? AND position=0").get(existing.sourceId);
    // A metadata-only predecessor is not a lost response to this command and must never acquire a late attempt.
    if (!attempt || attempt.requestKey !== initialMediaAttemptRequestKey) throw new RunConflictError("Media source has no initial admission");
    const run = readRun(this.db,attempt.runId);
    const intent = this.db.query<{ subjectId: string | null; triggerId: string | null }, [string]>(
      "SELECT weave_subject_id AS subjectId,weave_trigger_id AS triggerId FROM runs WHERE id=?").get(attempt.runId);
    if (!run || run.kind !== "weave" || !intent || intent.subjectId !== existing.thoughtId || intent.triggerId !== `media:${existing.sourceId}:0`) {
      throw new RunConflictError("Media initial admission identity differs");
    }
    return {thought:this.sourceThought(existing.thoughtId),run,replayed:true};
  }
}
