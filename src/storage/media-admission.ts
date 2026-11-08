import type { Database } from "bun:sqlite";
import type { Actor } from "../domain/rejection";
import { RunConflictError, RunForbiddenError, type RunRecord, type RunSources } from "../domain/run";
import { createThought, type MediaThought } from "../domain/thought";
import { equalBytes, importRequestKey } from "../domain/markdown-import-contract";
import { ValidationError } from "../domain/validation";
import { createLogger, type Logger } from "../logging";
import { saveMediaSource, type MediaSourceWrite } from "./media-source";
import { readRun } from "./run-record";
import { admitWeave } from "./weave-admission";
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

/** Source metadata and normal initial weaving commit together after private-file publication. */
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
        const run = admitWeave(this.db,this.sources,{subjectId:thought.id,triggerId:`media-import:${thought.mediaSource.id}`});
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
  byKey(actor: Actor, requestKey: string): MediaSourceAdmission | null {
    if (actor !== "user") throw new RunForbiddenError("Media receipts are user-only");
    const key = importRequestKey(requestKey);
    return this.db.transaction(() => {
      const source = this.db.query<{sourceId:string;thoughtId:string},[string]>(
        "SELECT id AS sourceId,source_thought_id AS thoughtId FROM media_sources WHERE request_key=?").get(key);
      return source ? this.initial(source) : null;
    })();
  }
  private initial(source: {readonly thoughtId: string; readonly sourceId: string}): MediaSourceAdmission {
    const row = this.db.query<{id:string},[string,string]>(
      "SELECT id FROM runs WHERE kind='weave' AND weave_subject_id=? AND weave_trigger_id=?").get(source.thoughtId,`media-import:${source.sourceId}`);
    const run = row ? readRun(this.db,row.id) : null;
    if (!run) throw new RunConflictError("Media source has no initial admission");
    return {thought:this.sourceThought(source.thoughtId),run,replayed:true};
  }
  private replay(existing: RetainedSource, input: MediaSourceWrite): MediaSourceAdmission {
    const source = input.thought.mediaSource;
    // IDs and creation times are daemon allocations, not the upload payload. Titles are independently editable metadata.
    if (existing.name !== source.name || existing.mimeType !== source.mimeType || existing.byteLength !== source.byteLength ||
        existing.clarification !== source.clarification || !equalBytes(existing.sha256,input.sha256)) {
      throw new RunConflictError("Media idempotency conflict");
    }
    return this.initial(existing);
  }
  /** A deliberate user retry reuses the retained source, never an unknown active native outcome. */
  retry(actor: Actor, sourceId: string, requestKey: string): RunRecord {
    return this.retryAdmission(actor,sourceId,requestKey).run;
  }
  retryAdmission(actor: Actor, sourceId: string, requestKey: string): {readonly run: RunRecord; readonly replayed: boolean} {
    if (actor !== "user") throw new RunForbiddenError("Media retry is user-only");
    const key = importRequestKey(requestKey);
    return immediate(this.db,() => {
      const source = this.db.query<{thoughtId:string},[string]>("SELECT source_thought_id AS thoughtId FROM media_sources WHERE id=?").get(sourceId);
      if (!source) throw new RunConflictError("Retained source is unavailable");
      const triggerId = `media-retry:${sourceId}:${key}`;
      const replayed = this.db.query("SELECT 1 FROM runs WHERE kind='weave' AND weave_subject_id=? AND weave_trigger_id=?").get(source.thoughtId,triggerId) !== null;
      return {run:admitWeave(this.db,this.sources,{subjectId:source.thoughtId,triggerId}),replayed};
    });
  }
}
