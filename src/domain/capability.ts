import { RunConflictError, RunForbiddenError, type Claim, type ContextRef } from "./run";
import { parseStepOperation, type StepOperation, type StepOperationResult } from "./run-operations";
import { createThought, type Thought, type ThoughtAuthor } from "./thought";
import { createConnection, type Connection } from "./connection";
import { createSharedResponse, type SharedResponse } from "./shared-response";
import { protocolJson } from "./run-protocol";
import { nonEmpty, oneOf, record } from "./validation";

/** Model controls only the capability and its strictly validated arguments. */
export type ReadCapabilityRequest =
  | { readonly capability: "search"; readonly arguments: { readonly query: string } }
  | { readonly capability: "readThought" | "readConnection" | "readResponse"; readonly arguments: { readonly id: string } };
export type CapabilityRequest = ReadCapabilityRequest
  | { readonly capability: "development"; readonly arguments: { readonly parentId: string; readonly text: string; readonly sourceIds: readonly string[] } }
  | { readonly capability: "interpretation"; readonly arguments: { readonly text: string; readonly sourceIds: readonly string[] } }
  | { readonly capability: "title-fill"; readonly arguments: { readonly title: string } }
  | { readonly capability: "connection"; readonly arguments: { readonly fromId: string; readonly toId: string; readonly category: Connection["category"]; readonly explanation: string; readonly sourceIds: readonly string[] } };
export interface Candidate {
  readonly kind: "thought" | "response";
  readonly id: string;
  readonly thoughtId: string;
  readonly title: string;
  readonly author: ThoughtAuthor;
  readonly snippet: string;
}
export type ReadCapabilityResult =
  | { readonly type: "search"; readonly candidates: readonly Candidate[] }
  | { readonly type: "thought"; readonly thought: Thought | null }
  | { readonly type: "connection-read"; readonly connection: Connection | null }
  | { readonly type: "response"; readonly response: SharedResponse | null };
export type CapabilityResult = ReadCapabilityResult | StepOperationResult;

function fields(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value,key))) throw new RunConflictError("Invalid capability fields");
}

export function isReadCapability(capability: string): boolean {
  return ["search","readThought","readConnection","readResponse"].includes(capability);
}

/** Validate the whole JSON proposal, not a useful subset, before matching or replaying a persisted step. */
export function parseCapabilityRequest(input: unknown): CapabilityRequest {
  try {
    protocolJson(input);
    const data = record(input);
    fields(data,["capability","arguments"]);
    const args = record(data.arguments);
    if (data.capability === "search") {
      fields(args,["query"]);
      return { capability: "search", arguments: { query: nonEmpty(args.query,"query") } };
    }
    if (data.capability === "readThought" || data.capability === "readConnection" || data.capability === "readResponse") {
      fields(args,["id"]);
      return { capability: data.capability, arguments: { id: nonEmpty(args.id,"id") } };
    }
    if (typeof data.capability !== "string" || !["development","interpretation","title-fill","connection"].includes(data.capability)) throw new RunForbiddenError("Capability is not available");
    // A model cannot smuggle a second discriminator through the arguments object.
    if (Object.hasOwn(args,"type")) throw new RunConflictError();
    const operation = parseStepOperation({ type: data.capability, ...args });
    switch (operation.type) {
      case "development": return { capability: operation.type, arguments: { parentId: operation.parentId, text: operation.text, sourceIds: operation.sourceIds } };
      case "interpretation": return { capability: operation.type, arguments: { text: operation.text, sourceIds: operation.sourceIds } };
      case "title-fill": return { capability: operation.type, arguments: { title: operation.title } };
      case "connection": return { capability: operation.type, arguments: { fromId: operation.fromId, toId: operation.toId, category: operation.category, explanation: operation.explanation, sourceIds: operation.sourceIds } };
    }
  } catch (error) {
    if (error instanceof RunForbiddenError) throw error;
    throw new RunConflictError("Invalid capability proposal");
  }
}

/** The persisted prompt supplies operation identity; the model supplies no authority or provenance defaults. */
export function capabilityOperation(request: CapabilityRequest): StepOperation | null {
  switch (request.capability) {
    case "development": return { type: "development", ...request.arguments };
    case "interpretation": return { type: "interpretation", ...request.arguments };
    case "title-fill": return { type: "title-fill", ...request.arguments };
    case "connection": return { type: "connection", ...request.arguments };
    default: return null;
  }
}

/** Decode only daemon-owned, transactionally recorded read results. Never accept a model-supplied result. */
export function readCapabilityResult(request: ReadCapabilityRequest, input: unknown): ReadCapabilityResult {
  try {
    const data = record(input);
    if (request.capability === "search" && data.type === "search") {
      fields(data,["type","candidates"]);
      if (!Array.isArray(data.candidates)) throw new RunConflictError();
      const candidates = data.candidates.map((input: unknown): Candidate => {
        const candidate = record(input);
        fields(candidate,["kind","id","thoughtId","title","author","snippet"]);
        if (typeof candidate.snippet !== "string") throw new RunConflictError();
        return { kind: oneOf(candidate.kind,"kind",["thought","response"]), id: nonEmpty(candidate.id,"id"), thoughtId: nonEmpty(candidate.thoughtId,"thoughtId"),
          title: nonEmpty(candidate.title,"title"), author: oneOf(candidate.author,"author",["user","ai","source"]), snippet: candidate.snippet };
      });
      return { type: "search", candidates };
    }
    if (request.capability === "readThought" && data.type === "thought") {
      fields(data,["type","thought"]);
      return { type: "thought", thought: data.thought === null ? null : createThought(data.thought) };
    }
    if (request.capability === "readConnection" && data.type === "connection-read") {
      fields(data,["type","connection"]);
      return { type: "connection-read", connection: data.connection === null ? null : createConnection(data.connection) };
    }
    if (request.capability === "readResponse" && data.type === "response") {
      fields(data,["type","response"]);
      return { type: "response", response: data.response === null ? null : createSharedResponse(data.response) };
    }
    throw new RunConflictError();
  } catch { throw new RunConflictError("Invalid persisted capability result"); }
}

/** Dispatch is bound to a completed persisted step and its existing run authority. */
export interface CapabilityDispatcher {
  dispatch(claim: Claim, promptId: string, request: unknown): CapabilityResult;
  /** Trusted internal inspection; snippet exposure is separate from full-read witnesses. */
  fullReadWitnesses(runId: string): readonly ContextRef[];
}
