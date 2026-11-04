import type { Actor, RejectionService } from "./rejection";
import { createThought, type Thought } from "./thought";
import { createConnection, type Connection } from "./connection";
import { nonEmpty, references } from "./validation";

export interface CreationWrites {
  createThought(thought: Thought): void;
  createConnection(connection: Connection): void;
}
export interface CreationDependencies {
  readonly writes: CreationWrites;
  readonly rejection: RejectionService;
  readonly id: () => string;
  readonly now: () => string;
}
export interface ThoughtInput { readonly text: string; readonly title?: string | null }
export interface DevelopmentInput extends ThoughtInput { readonly sourceIds?: readonly string[] }
export interface ConnectionInput {
  readonly fromId: string;
  readonly toId: string;
  readonly category: Connection["category"];
  readonly explanation: string;
  readonly sourceIds?: readonly string[];
}
export class CreationForbiddenError extends Error {}
export class CreationNotFoundError extends Error {}

/** Semantic commands own identity, time, attribution and material provenance. */
export class CreationService {
  constructor(private readonly deps: CreationDependencies) {}

  private requireReferences(actor: Actor, ids: readonly string[]): void {
    const visible = new Set(this.deps.rejection.listThoughts({ actor, mode: "normal" }).map(item => item.id));
    if (ids.some(id => !visible.has(id))) throw new CreationNotFoundError();
  }

  private thought(actor: Actor, input: ThoughtInput, parentId: string | null, sourceIds: readonly string[], kind: Thought["kind"], origin: string): Thought {
    const title = input.title === undefined ? null : input.title;
    const result = createThought({ id: this.deps.id(), createdAt: this.deps.now(), text: input.text,
      title, titleAuthor: title === null ? null : actor, author: actor, kind, origin, parentId, sourceIds });
    this.deps.writes.createThought(result);
    return result;
  }

  capture(actor: Actor, input: ThoughtInput): Thought {
    if (actor !== "user") throw new CreationForbiddenError();
    return this.thought(actor, input, null, [], "captured-original", "capture");
  }
  contribute(actor: Actor, parentId: string, input: ThoughtInput): Thought {
    if (actor !== "user") throw new CreationForbiddenError();
    nonEmpty(parentId, "parentId");
    this.requireReferences(actor, [parentId]);
    return this.thought(actor, input, parentId, [], "user-contribution", "contribution");
  }
  develop(actor: Actor, parentId: string, input: DevelopmentInput): Thought {
    if (actor !== "ai") throw new CreationForbiddenError();
    nonEmpty(parentId, "parentId");
    const sources = references(input.sourceIds ?? [], "sourceIds");
    this.requireReferences(actor, [parentId, ...sources]);
    return this.thought(actor, input, parentId, sources, "developing-idea", "development");
  }
  interpret(actor: Actor, subjectId: string, input: DevelopmentInput): Thought {
    if (actor !== "ai") throw new CreationForbiddenError();
    nonEmpty(subjectId,"subjectId");
    const sources = references(input.sourceIds ?? [],"sourceIds");
    this.requireReferences(actor,[subjectId,...sources]);
    return this.thought(actor,input,subjectId,sources,"ai-interpretation","weave");
  }
  connect(actor: Actor, input: ConnectionInput): Connection {
    if (actor !== "user" && actor !== "ai") throw new CreationForbiddenError();
    const connection = createConnection({ ...input, sourceIds: input.sourceIds ?? [], id: this.deps.id(), proposedBy: actor });
    this.requireReferences(actor, [connection.fromId, connection.toId, ...connection.sourceIds]);
    this.deps.writes.createConnection(connection);
    return connection;
  }
}
