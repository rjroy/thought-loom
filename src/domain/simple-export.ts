import { ForbiddenActorError, type Actor, type RejectionService } from "./rejection";
import { displayTitle } from "./thought";
import { nonEmpty, ValidationError } from "./validation";

export interface SimpleExportRequest {
  readonly rootId: string;
  readonly count: number;
  readonly traversal: "breadth" | "depth";
}
export class SimpleExportNotFoundError extends Error {}

/** Read-only Markdown export over evolution ancestry, never discovered connections. */
export class SimpleExportService {
  constructor(private readonly rejection: RejectionService) {}
  render(actor: Actor, request: SimpleExportRequest): string {
    if (actor !== "user") throw new ForbiddenActorError();
    if (!request || typeof request !== "object") throw new ValidationError("Invalid export request");
    const rootId = nonEmpty(request.rootId, "rootId");
    if (!Number.isInteger(request.count) || request.count <= 0 || (request.traversal !== "breadth" && request.traversal !== "depth")) throw new ValidationError("Invalid export request");
    const thoughts = this.rejection.exportThoughts(actor, rootId, request.count, request.traversal);
    if (!thoughts) throw new SimpleExportNotFoundError();
    return thoughts.map(thought => [
      `## ${displayTitle(thought)}`,
      `- ID: ${JSON.stringify(thought.id)}`,
      `- Author: ${thought.author}`,
      `- Kind: ${thought.kind}`,
      `- Created: ${JSON.stringify(thought.createdAt)}`,
      `- Origin: ${JSON.stringify(thought.origin)}`,
      `- Sources: ${JSON.stringify(thought.sourceIds)}`,
      "",
      ...(thought.kind === "media-original" ? [
        `- File: ${JSON.stringify(thought.mediaSource.name)}`,
        `- Media type: ${JSON.stringify(thought.mediaSource.mimeType)}`,
        `- Byte length: ${thought.mediaSource.byteLength}`,
        `- File authorship: ${thought.mediaSource.fileAuthorship}`,
        ...(thought.mediaSource.clarification === null ? [] : ["", "### Clarification (user)", "", thought.mediaSource.clarification]),
      ] : [thought.text]),
    ].join("\n")).join("\n\n") + "\n";
  }
}
