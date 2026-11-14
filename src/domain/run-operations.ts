import { createConnection, type Connection, type ConnectionCategory } from "./connection";
import { RunConflictError, RunForbiddenError, type Claim, type RunRecord } from "./run";
import type { Thought } from "./thought";
import { nonEmpty, oneOf, record, references } from "./validation";
import { protocolJson, type CapabilityEnvelope } from "./run-protocol";
import type { WeavePurpose } from "./weave-scheduling";

/** Identity is the daemon-owned persisted prompt, never a model-provided field. */
export type StepOperation =
  | { readonly type: "development"; readonly parentId: string; readonly text: string; readonly sourceIds: readonly string[] }
  | { readonly type: "interpretation"; readonly text: string; readonly sourceIds: readonly string[] }
  | { readonly type: "title-fill"; readonly title: string }
  | { readonly type: "connection"; readonly fromId: string; readonly toId: string; readonly category: ConnectionCategory; readonly explanation: string; readonly sourceIds: readonly string[] };
export type StepOperationResult =
  | { readonly type: "development" | "interpretation"; readonly thought: Thought }
  | { readonly type: "title-fill"; readonly status: "filled" | "unchanged" }
  | ConnectionOperationResult;
export type ConnectionOperationResult =
  // Missing status is only the historical created-result encoding; never add it during receipt replay.
  | { readonly type: "connection"; readonly status?: "created"; readonly connection: Connection }
  | { readonly type: "connection"; readonly status: "already-present"; readonly connection: Connection }
  | { readonly type: "connection"; readonly status: "not-created" };
export interface StepReceipt { readonly operation: StepOperation; readonly result: StepOperationResult }
export interface WeaveIntent { readonly subjectId: string; readonly triggerId: string }

/** Shared authority for trusted operations and model dispatch; neither can choose another run's subject or contribution. */
export function stepOperationScope(run: RunRecord, intent: WeaveIntent | null, operation: StepOperation, purpose: WeavePurpose = "ordinary"): { readonly subjectId: string | null; readonly refs: readonly string[] } {
  if (run.kind !== "weave" && run.kind !== "evolve") throw new RunForbiddenError();
  if (run.kind === "weave" && !intent) throw new RunConflictError("Legacy weave subject is unknown");
  const subjectId = run.kind === "weave" ? intent?.subjectId ?? null : operation.type === "title-fill" ? run.inputThoughtId : null;
  if (operation.type === "development" && (run.kind !== "evolve" || operation.parentId !== run.inputThoughtId)) throw new RunConflictError("Development parent must be the admitted contribution");
  if (operation.type === "interpretation" && (run.kind !== "weave" || subjectId === null)) throw new RunForbiddenError();
  if (operation.type === "title-fill" && subjectId === null) throw new RunForbiddenError();
  if ((purpose === "connection-only" || purpose === "daily-review") && operation.type === "connection" && operation.fromId !== subjectId && operation.toId !== subjectId) {
    throw new RunForbiddenError("Discovery connections must involve the fixed subject");
  }
  const refs = operation.type === "development" ? [operation.parentId,...operation.sourceIds] :
    operation.type === "interpretation" ? [...(subjectId === null ? [] : [subjectId]),...operation.sourceIds] :
    operation.type === "connection" ? [operation.fromId,operation.toId,...operation.sourceIds] : subjectId === null ? [] : [subjectId];
  return { subjectId, refs };
}

export function isStepOperationCapability(capability: string): boolean {
  return ["development","interpretation","title-fill","connection"].includes(capability);
}

/** Validate the complete proposal, including its exact fields, before any effect or receipt replay. */
export function parseStepOperation(input: unknown): StepOperation {
  try {
    protocolJson(input);
    const data = record(input);
    function fields(expected: readonly string[]): void {
      if (Object.keys(data).length !== expected.length || expected.some(key => !Object.hasOwn(data,key))) throw new RunConflictError();
    }
    if (data.type === "development") {
      fields(["type","parentId","text","sourceIds"]);
      return Object.freeze({ type: "development", parentId: nonEmpty(data.parentId,"parentId"), text: nonEmpty(data.text,"text"), sourceIds: references(data.sourceIds,"sourceIds") });
    }
    if (data.type === "interpretation") {
      fields(["type","text","sourceIds"]);
      return Object.freeze({ type: "interpretation", text: nonEmpty(data.text,"text"), sourceIds: references(data.sourceIds,"sourceIds") });
    }
    if (data.type === "title-fill") {
      fields(["type","title"]);
      return Object.freeze({ type: "title-fill", title: nonEmpty(data.title,"title") });
    }
    if (data.type !== "connection") throw new RunConflictError();
    fields(["type","fromId","toId","category","explanation","sourceIds"]);
    return Object.freeze({ type: "connection", fromId: nonEmpty(data.fromId,"fromId"), toId: nonEmpty(data.toId,"toId"),
      category: oneOf(data.category,"category",["supports","contradicts","extends","related"]),
      explanation: nonEmpty(data.explanation,"explanation"), sourceIds: references(data.sourceIds,"sourceIds") });
  } catch { throw new RunConflictError("Invalid step operation proposal"); }
}

export function stepOperationEnvelope(operation: StepOperation): CapabilityEnvelope {
  const { type, ...args } = operation;
  return { version: 1, kind: "request", request: { capability: type, arguments: args } };
}

/** Closed daemon-owned outcomes, including frozen status-less created receipts. Not model proposals. */
export function parseConnectionOperationResult(operation: Extract<StepOperation,{type:"connection"}>, input: unknown): ConnectionOperationResult {
  try {
    protocolJson(input);
    const data = record(input);
    const fields = (value: Record<string,unknown>, keys: readonly string[]): void => {
      if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value,key))) throw new RunConflictError();
    };
    if (data.type !== "connection") throw new RunConflictError();
    if (data.status === "not-created") { fields(data,["type","status"]); return {type:"connection",status:"not-created"}; }
    const historical = !Object.hasOwn(data,"status");
    if (!historical && data.status !== "created" && data.status !== "already-present") throw new RunConflictError();
    fields(data,historical ? ["type","connection"] : ["type","status","connection"]);
    const raw = record(data.connection);
    fields(raw,["id","fromId","toId","category","proposedBy","explanation","sourceIds"]);
    const connection = createConnection(raw);
    if (connection.fromId !== operation.fromId || connection.toId !== operation.toId || connection.category !== operation.category) throw new RunConflictError();
    if (data.status !== "already-present" && (connection.proposedBy !== "ai" || connection.explanation !== operation.explanation ||
        protocolJson(connection.sourceIds) !== protocolJson(operation.sourceIds))) throw new RunConflictError();
    return historical ? {type:"connection",connection} : data.status === "already-present"
      ? {type:"connection",status:"already-present",connection} : {type:"connection",status:"created",connection};
  } catch { throw new RunConflictError("Invalid connection operation result"); }
}

/** Stable identity/attribution and recorded content must be backed by the retained relation, not a fictitious write. */
export function assertConnectionOperationRecord(result: ConnectionOperationResult, stored: Connection | null): void {
  if (result.status === "not-created") return; // Opaque history never re-evaluates hidden matching relations.
  const value = result.connection;
  if (!stored || value.id !== stored.id || value.fromId !== stored.fromId || value.toId !== stored.toId || value.category !== stored.category ||
      value.proposedBy !== stored.proposedBy) throw new RunConflictError("Connection receipt identity differs from storage");
  // Older Bun string bindings consumed one initial BOM; keep that old receipt/store pair byte-exact, never normalize it.
  const legacyBom = result.status === undefined && value.explanation.startsWith("\uFEFF") && stored.explanation === value.explanation.slice(1);
  if (stored.explanation !== value.explanation && !legacyBom) throw new RunConflictError("Connection receipt content differs from storage");
  const selected = new Set(value.sourceIds);
  const expected = result.status === "already-present" ? stored.sourceIds.filter(id => selected.has(id)) : stored.sourceIds;
  if (protocolJson(value.sourceIds) !== protocolJson(expected)) throw new RunConflictError("Connection receipt provenance differs from storage");
}

/** Typed commands extend the existing run/step aggregate and transaction, not a second journal. */
export interface RunOperations {
  admitWeave(actor: "user", intent: WeaveIntent): RunRecord;
  weaveIntent(runId: string): WeaveIntent | null;
  executeStep(claim: Claim, promptId: string, operation: StepOperation): StepOperationResult;
  stepReceipt(runId: string, promptId: string): StepReceipt | null;
  completeWeave(claim: Claim, promptId: string): void;
  fail(claim: Claim): void;
}
