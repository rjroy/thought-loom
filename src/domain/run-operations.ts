import type { Connection, ConnectionCategory } from "./connection";
import { RunConflictError, RunForbiddenError, type Claim, type RunRecord } from "./run";
import type { Thought } from "./thought";
import { nonEmpty, oneOf, record, references } from "./validation";
import { protocolJson, type CapabilityEnvelope } from "./run-protocol";

/** Identity is the daemon-owned persisted prompt, never a model-provided field. */
export type StepOperation =
  | { readonly type: "development"; readonly parentId: string; readonly text: string; readonly sourceIds: readonly string[] }
  | { readonly type: "interpretation"; readonly text: string; readonly sourceIds: readonly string[] }
  | { readonly type: "title-fill"; readonly title: string }
  | { readonly type: "connection"; readonly fromId: string; readonly toId: string; readonly category: ConnectionCategory; readonly explanation: string; readonly sourceIds: readonly string[] };
export type StepOperationResult =
  | { readonly type: "development" | "interpretation"; readonly thought: Thought }
  | { readonly type: "title-fill"; readonly status: "filled" | "unchanged" }
  | { readonly type: "connection"; readonly connection: Connection };
export interface StepReceipt { readonly operation: StepOperation; readonly result: StepOperationResult }
export interface WeaveIntent { readonly subjectId: string; readonly triggerId: string }

/** Shared authority for trusted operations and model dispatch; neither can choose another run's subject or contribution. */
export function stepOperationScope(run: RunRecord, intent: WeaveIntent | null, operation: StepOperation): { readonly subjectId: string | null; readonly refs: readonly string[] } {
  if (run.kind === "export") throw new RunForbiddenError();
  if (run.kind === "weave" && !intent) throw new RunConflictError("Legacy weave subject is unknown");
  const subjectId = intent?.subjectId ?? null;
  if (operation.type === "development" && (run.kind !== "evolve" || operation.parentId !== run.inputThoughtId)) throw new RunConflictError("Development parent must be the admitted contribution");
  if ((operation.type === "interpretation" || operation.type === "title-fill") && (run.kind !== "weave" || subjectId === null)) throw new RunForbiddenError();
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

/** Typed commands extend the existing run/step aggregate and transaction, not a second journal. */
export interface RunOperations {
  admitWeave(actor: "user", intent: WeaveIntent): RunRecord;
  weaveIntent(runId: string): WeaveIntent | null;
  executeStep(claim: Claim, promptId: string, operation: StepOperation): StepOperationResult;
  stepReceipt(runId: string, promptId: string): StepReceipt | null;
  completeWeave(claim: Claim, promptId: string): void;
  fail(claim: Claim): void;
}
