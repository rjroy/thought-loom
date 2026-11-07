import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { MediaImportError, type MediaImportAdmission, type MediaImports, type MediaUpload } from "../domain/media-import";
import type { OrdinaryAgentRunView } from "../domain/agent";
import { importRequestKey } from "../domain/markdown-import-contract";
import type { Actor, ReadScope, RejectionService } from "../domain/rejection";
import { RunConflictError, RunForbiddenError, RunNotFoundError, type RunSources } from "../domain/run";
import type { MediaThought } from "../domain/thought";
import { nonEmpty, nullableString, ValidationError } from "../domain/validation";
import { createLogger, type Logger } from "../logging";
import { SqliteAgentRuns } from "./agent";
import { SqliteMediaAdmissions, type MediaSourceAdmission } from "./media-admission";
import { MediaFilesError, type MediaFiles } from "./media-files";

/** File-first publication and the existing SQLite admission, with user-scoped inspection. */
export class SqliteMediaImports implements MediaImports {
  private readonly admissions: SqliteMediaAdmissions;
  private readonly runs: SqliteAgentRuns;
  private readonly logger: Logger;
  private admissionTail: Promise<void> = Promise.resolve();
  constructor(private readonly db: Database, private readonly sources: RunSources,
    private readonly files: MediaFiles, private readonly rejection: RejectionService) {
    this.admissions = new SqliteMediaAdmissions(db,sources);
    this.runs = new SqliteAgentRuns(db,sources);
    this.logger = sources.logger ?? createLogger();
  }
  private user(actor: Actor): void { if (actor !== "user") throw new RunForbiddenError("Media import is user-only"); }
  private run(id: string): OrdinaryAgentRunView {
    const run = this.runs.status(id);
    if (!run || run.kind !== "weave") throw new RunConflictError("Media weave is unavailable");
    return run;
  }
  private view(admission: MediaSourceAdmission): MediaImportAdmission {
    return {thought:admission.thought,run:this.run(admission.run.id),replayed:admission.replayed};
  }
  byKey(actor: Actor, requestKey: string): MediaImportAdmission | null {
    this.user(actor);
    return this.db.transaction(() => {
      const result = this.admissions.byKey(actor,requestKey);
      return result ? this.view(result) : null;
    })();
  }
  async admit(actor: Actor, input: MediaUpload): Promise<MediaImportAdmission> {
    this.user(actor);
    const requestKey = importRequestKey(input.requestKey), name = nonEmpty(input.name,"name");
    const clarification = nullableString(input.clarification,"clarification");
    if (/[\/\\\r\n\0]/.test(name) || new TextEncoder().encode(name).length > 1024) throw new ValidationError("Invalid media filename");
    if (!(input.bytes instanceof Uint8Array) || input.bytes.length === 0) throw new MediaImportError("invalid-media");
    // The bounded HTTP receivers share this lane so two first uploads of one key cannot publish different sources.
    const previous = this.admissionTail, released = Promise.withResolvers<void>();
    this.admissionTail = released.promise;
    await previous;
    try {
      this.logger.verbose("[media import] admission attempt");
      const retained = this.admissions.byKey(actor,requestKey);
      let admission: MediaSourceAdmission;
      if (retained) {
        // Equal bytes retain their already-validated MIME; the immutable payload comparison owns replay/conflict.
        const thought: MediaThought = {...retained.thought,title:null,titleAuthor:null,mediaSource:{...retained.thought.mediaSource,
          name,clarification,clarificationAuthor:clarification === null ? null : "user",byteLength:input.bytes.length}};
        admission = this.admissions.admit(actor,{thought,requestKey,sha256:new Uint8Array(createHash("sha256").update(input.bytes).digest())});
      } else {
        const sourceId = this.sources.id(), thoughtId = this.sources.id(), createdAt = this.sources.now();
        const confirmed: {admission?: MediaSourceAdmission} = {};
        async function* chunks() { yield input.bytes; }
        await this.files.publish(sourceId,chunks(),artifact => {
          const thought: MediaThought = {id:thoughtId,text:null,title:null,titleAuthor:null,author:"source",kind:"media-original",
            origin:"media-import",parentId:null,sourceIds:[],createdAt,mediaSource:{id:sourceId,name,mimeType:artifact.mimeType,
              byteLength:artifact.byteLength,fileAuthorship:"unverified",clarification,clarificationAuthor:clarification === null ? null : "user"}};
          confirmed.admission = this.admissions.admit(actor,{thought,requestKey,sha256:artifact.sha256});
        });
        const result = confirmed.admission;
        if (!result) throw new MediaImportError("storage-unavailable");
        admission = result;
      }
      const result = this.view(admission);
      this.logger.info("[media import] admission confirmed",{sourceId:result.thought.mediaSource.id,runId:result.run.id,replayed:result.replayed});
      return result;
    } catch (error) {
      this.logger.warning("[media import] admission refused");
      if (error instanceof MediaFilesError) throw new MediaImportError(error.code === "invalid-media" ? "invalid-media" : "storage-unavailable");
      throw error;
    } finally {
      try { await this.files.cleanup(); }
      catch { this.logger.warning("[media import] orphan cleanup deferred"); }
      finally { released.resolve(); }
    }
  }
  source(scope: ReadScope, sourceId: string): MediaThought | null {
    this.user(scope.actor);
    if (scope.mode !== "normal" && scope.mode !== "history") throw new ValidationError("Invalid media inspection scope");
    const row = this.db.query<{thoughtId:string},[string]>("SELECT source_thought_id AS thoughtId FROM media_sources WHERE id=?").get(sourceId);
    if (!row) return null;
    const thought = this.rejection.listThoughts(scope).find(thought => thought.id === row.thoughtId);
    return thought?.kind === "media-original" ? thought : null;
  }
  async raw(scope: ReadScope, sourceId: string): Promise<{readonly mimeType: string; readonly bytes: Uint8Array} | null> {
    const thought = this.source(scope,sourceId);
    if (!thought) return null;
    let bytes: Uint8Array;
    try { bytes = await this.files.readOriginal(thought.mediaSource.id); }
    catch { throw new MediaImportError("original-unavailable"); }
    if (!this.source(scope,sourceId)) return null;
    return {mimeType:thought.mediaSource.mimeType,bytes};
  }
  retry(actor: Actor, sourceId: string, requestKey: string): {readonly run: OrdinaryAgentRunView; readonly replayed: boolean} {
    this.user(actor);
    this.logger.verbose("[media import] retry attempt");
    try {
      const result = this.db.transaction(() => {
        if (!this.source({actor,mode:"normal"},sourceId)) throw new RunNotFoundError();
        const admission = this.admissions.retryAdmission(actor,sourceId,requestKey);
        return {run:this.run(admission.run.id),replayed:admission.replayed};
      }).immediate();
      this.logger.info("[media import] retry confirmed",{sourceId,runId:result.run.id,replayed:result.replayed});
      return result;
    } catch (error) { this.logger.warning("[media import] retry refused"); throw error; }
  }
}
