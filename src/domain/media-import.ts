import type { Actor, ReadScope } from "./rejection";
import type { OrdinaryAgentRunView } from "./agent";
import type { MediaThought } from "./thought";

export interface MediaUpload {
  readonly requestKey: string;
  readonly name: string;
  readonly clarification: string | null;
  readonly bytes: Uint8Array;
}
export interface MediaImportAdmission {
  readonly thought: MediaThought;
  readonly run: OrdinaryAgentRunView;
  readonly replayed: boolean;
}
export type MediaRetryEligibility =
  | {readonly eligible: true; readonly reason: null}
  | {readonly eligible: false; readonly reason: "source-rejected" | "interpretation-exists" | "work-active" | "work-unsettled" | "work-completed"};
export interface MediaSourceInspection {
  readonly thought: MediaThought;
  readonly run: OrdinaryAgentRunView | null;
  readonly retry: MediaRetryEligibility;
}
/** User workflow only. Managed paths stay inside the normal worker's private context. */
export interface MediaImports {
  admit(actor: Actor, input: MediaUpload): Promise<MediaImportAdmission>;
  byKey(actor: Actor, requestKey: string): MediaImportAdmission | null;
  source(scope: ReadScope, sourceId: string): MediaThought | null;
  inspect(scope: ReadScope, sourceId: string): MediaSourceInspection | null;
  raw(scope: ReadScope, sourceId: string): Promise<{readonly mimeType: string; readonly bytes: Uint8Array} | null>;
  retry(actor: Actor, sourceId: string, requestKey: string): {readonly run: OrdinaryAgentRunView; readonly replayed: boolean};
}
export class MediaImportError extends Error {
  constructor(readonly code: "invalid-media" | "original-unavailable" | "storage-unavailable") { super(code); }
}
