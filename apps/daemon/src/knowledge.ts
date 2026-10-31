// Internal boundary: context must be supplied by trusted server code, never copied
// from a request body. Run authentication and scope binding belong to the caller.
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { openDatabase } from "./storage";
import { parseIdea, parseIdeaDerivation, type IdeaInput, type IdeaDerivation } from "@thoughtloom/contracts";
export type KnowledgeContext =
  | { actor: "user"; operationId: string }
  | { actor: "ai"; operationId: string; runId: string };

export type Formulation = {
  id: string;
  text: string;
  author: "user" | "ai";
  evidenceSourceIds: string[];
  operationId: string;
};

export type KnowledgeItem = {
  id: string;
  kind: "interpretation" | "developing-idea";
  sourceId: string;
  current: Formulation;
  history: Formulation[];
  derivation?: IdeaDerivation;
};

export type RelationshipRevision = {
  id: string;
  status: "active" | "rejected";
  rationale: string;
  evidenceSourceIds: string[];
  author: "user" | "ai";
  operationId: string;
};

export type Relationship = {
  id: string;
  fromItemId: string;
  toItemId: string;
  type: "supports" | "challenges" | "suggests";
  current: RelationshipRevision;
  history: RelationshipRevision[];
};

export type KnowledgeErrorCode = "invalid_reference" | "version_conflict" | "operation_conflict" | "forbidden" | "invalid_input" | "storage_error";

export type SearchAlias = { id: string; alias: string; expansion: string; author: "user" | "ai"; evidenceSourceIds: string[] };

export class KnowledgeError extends Error {
  constructor(readonly code: KnowledgeErrorCode) {
    super(code);
  }
}

function requireText(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new KnowledgeError("invalid_input");
}

function validateContext(context: KnowledgeContext) {
  if (!context || (context.actor !== "user" && context.actor !== "ai")) throw new KnowledgeError("invalid_input");
  requireText(context.operationId);
  if (context.actor === "ai") requireText(context.runId);
}

function evidence(db: Database, ids: string[]) {
  if (!Array.isArray(ids) || ids.length === 0 || new Set(ids).size !== ids.length) throw new KnowledgeError("invalid_input");
  const exists = db.query<{ found: number }, [string]>("SELECT 1 AS found FROM sources WHERE id = ?");
  for (const id of ids) {
    requireText(id);
    if (!exists.get(id)) throw new KnowledgeError("invalid_reference");
  }
}

function readItem(db: Database, id: string): KnowledgeItem {
  const item = db.query<{ id: string; kind: KnowledgeItem["kind"]; sourceId: string }, [string]>(
    "SELECT id, kind, source_id AS sourceId FROM knowledge_items WHERE id = ?",
  ).get(id);
  if (!item) throw new KnowledgeError("invalid_reference");
  const versions = db.query<Omit<Formulation, "evidenceSourceIds">, [string]>(
    "SELECT id, text, author, operation_id AS operationId FROM formulations WHERE item_id = ? ORDER BY rowid",
  ).all(id);
  const getEvidence = db.query<{ sourceId: string }, [string]>(
    "SELECT source_id AS sourceId FROM formulation_evidence WHERE formulation_id = ? ORDER BY position",
  );
  const history = versions.map((version) => ({ ...version, evidenceSourceIds: getEvidence.all(version.id).map((row) => row.sourceId) }));
  const current = history.at(-1);
  if (!current) throw new KnowledgeError("storage_error");
  const derivation = readIdeaDerivation(db, id);
  return { ...item, current, history, ...(derivation ? { derivation } : {}) };
}
export function readIdeaDerivation(db: Database, id: string): IdeaDerivation | undefined {
  const derived = db.query<{ dialogueId: string; turnId: string; turnSourceId: string; itemId: string | null; versionId: string | null }, [string]>(
    "SELECT dialogue_id AS dialogueId,turn_id AS turnId,turn_source_id AS turnSourceId,from_item_id AS itemId,from_version_id AS versionId FROM idea_derivations WHERE item_id=?",
  ).get(id);
  if (!derived) return undefined;
  const derivation = parseIdeaDerivation({ dialogueId: derived.dialogueId, turnId: derived.turnId, turnSourceId: derived.turnSourceId,
    ...(derived.itemId && derived.versionId ? { itemId: derived.itemId, versionId: derived.versionId } : {}) });
  if (!derivation) throw new KnowledgeError("storage_error");
  return derivation;
}

function readRelationship(db: Database, id: string): Relationship {
  const relationship = db.query<{ id: string; fromItemId: string; toItemId: string; type: Relationship["type"] }, [string]>(
    "SELECT id, from_item_id AS fromItemId, to_item_id AS toItemId, type FROM relationships WHERE id = ?",
  ).get(id);
  if (!relationship) throw new KnowledgeError("invalid_reference");
  const versions = db.query<Omit<RelationshipRevision, "evidenceSourceIds">, [string]>(
    "SELECT id, status, rationale, author, operation_id AS operationId FROM relationship_revisions WHERE relationship_id = ? ORDER BY rowid",
  ).all(id);
  const getEvidence = db.query<{ sourceId: string }, [string]>(
    "SELECT source_id AS sourceId FROM relationship_evidence WHERE revision_id = ? ORDER BY position",
  );
  const history = versions.map((version) => ({ ...version, evidenceSourceIds: getEvidence.all(version.id).map((row) => row.sourceId) }));
  const current = history.at(-1);
  if (!current) throw new KnowledgeError("storage_error");
  return { ...relationship, current, history };
}

function appendFormulation(db: Database, context: KnowledgeContext, itemId: string, text: string, ids: string[], restoredFrom: string | null = null) {
  requireText(text);
  evidence(db, ids);
  const id = crypto.randomUUID();
  db.run("INSERT INTO formulations (id,item_id,text,author,operation_id,run_id,restored_from) VALUES (?,?,?,?,?,?,?)",
    [id, itemId, text, context.actor, context.operationId, context.actor === "ai" ? context.runId : null, restoredFrom]);
  ids.forEach((sourceId, position) => db.run("INSERT INTO formulation_evidence (formulation_id,source_id,position) VALUES (?,?,?)", [id, sourceId, position]));
  db.run("DELETE FROM formulation_search WHERE item_id = ?", [itemId]);
  db.run("INSERT INTO formulation_search (item_id,text) VALUES (?,?)", [itemId, text]);
}

function appendRelationship(db: Database, context: KnowledgeContext, relationshipId: string, status: RelationshipRevision["status"], rationale: string, ids: string[], restoredFrom: string | null = null) {
  if (status !== "active" && status !== "rejected") throw new KnowledgeError("invalid_input");
  requireText(rationale);
  evidence(db, ids);
  const id = crypto.randomUUID();
  db.run("INSERT INTO relationship_revisions (id,relationship_id,status,rationale,author,operation_id,run_id,restored_from) VALUES (?,?,?,?,?,?,?,?)",
    [id, relationshipId, status, rationale, context.actor, context.operationId, context.actor === "ai" ? context.runId : null, restoredFrom]);
  ids.forEach((sourceId, position) => db.run("INSERT INTO relationship_evidence (revision_id,source_id,position) VALUES (?,?,?)", [id, sourceId, position]));
}

function checkVersion(current: { id: string; author: "user" | "ai" }, expected: string, context: KnowledgeContext) {
  if (current.id !== expected) throw new KnowledgeError("version_conflict");
  if (context.actor === "ai" && current.author !== "ai") throw new KnowledgeError("forbidden");
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
  throw new KnowledgeError("invalid_input");
}

type ReceiptRef = { resultId: string; revisionId: string | null };

function itemAt(db: Database, ref: ReceiptRef): KnowledgeItem {
  const item = readItem(db, ref.resultId);
  const index = item.history.findIndex((entry) => entry.id === ref.revisionId);
  if (index < 0) throw new KnowledgeError("storage_error");
  const history = item.history.slice(0, index + 1);
  const current = history.at(-1);
  if (!current) throw new KnowledgeError("storage_error");
  return { ...item, history, current };
}

function relationshipAt(db: Database, ref: ReceiptRef): Relationship {
  const relationship = readRelationship(db, ref.resultId);
  const index = relationship.history.findIndex((entry) => entry.id === ref.revisionId);
  if (index < 0) throw new KnowledgeError("storage_error");
  const history = relationship.history.slice(0, index + 1);
  const current = history.at(-1);
  if (!current) throw new KnowledgeError("storage_error");
  return { ...relationship, history, current };
}

function readAlias(db: Database, ref: ReceiptRef): SearchAlias {
  const alias = db.query<Omit<SearchAlias, "evidenceSourceIds">, [string]>(
    "SELECT id, alias, expansion, author FROM search_aliases WHERE id=?",
  ).get(ref.resultId);
  if (!alias) throw new KnowledgeError("storage_error");
  const sources = db.query<{ sourceId: string }, [string]>(
    "SELECT source_id AS sourceId FROM alias_evidence WHERE alias_id=? ORDER BY position",
  ).all(alias.id);
  return { ...alias, evidenceSourceIds: sources.map((row) => row.sourceId) };
}

export class KnowledgeService {
  // Internal callers can fence authorization in the same write transaction as
  // the mutation/receipt, including receipt replay. Never supplied by HTTP data.
  constructor(readonly databasePath: string, private readonly authorize?: (db: Database) => void,
    private readonly beforeMutation?: (db: Database) => void) {}

  recordAlias(context: KnowledgeContext, input: {
    alias: string; expansion: string; evidenceSourceIds: string[];
  }): SearchAlias {
    return this.mutate("record_alias", context, input, (db) => {
      requireText(input.alias);
      requireText(input.expansion);
      const alias = input.alias.match(/[\p{L}\p{N}\p{M}]+/gu) ?? [];
      const expansion = input.expansion.match(/[\p{L}\p{N}\p{M}]+/gu) ?? [];
      if (alias.length === 0 || expansion.length === 0 || alias.length > 16 || expansion.length > 16 || input.alias.length > 512 || input.expansion.length > 512) throw new KnowledgeError("invalid_input");
      evidence(db, input.evidenceSourceIds);
      const id = crypto.randomUUID();
      db.run("INSERT INTO search_aliases(id,alias,expansion,author,operation_id,run_id) VALUES (?,?,?,?,?,?)", [id, alias.join(" "), expansion.join(" "), context.actor, context.operationId, context.actor === "ai" ? context.runId : null]);
      input.evidenceSourceIds.forEach((sourceId, position) => db.run("INSERT INTO alias_evidence(alias_id,source_id,position) VALUES (?,?,?)", [id, sourceId, position]));
      return readAlias(db, { resultId: id, revisionId: null });
    }, (result) => ({ resultId: result.id, revisionId: null }), readAlias);
  }

  private mutate<T>(name: string, context: KnowledgeContext, input: unknown, action: (db: Database) => T,
    reference: (result: T) => ReceiptRef, restore: (db: Database, ref: ReceiptRef) => T): T {
    return this.execute(name, true, (db) => {
      this.authorize?.(db);
      validateContext(context);
      const hash = createHash("sha256").update(canonical({ name, context, input })).digest("hex");
      const receipt = db.query<{ payloadHash: string; resultId: string; revisionId: string | null }, [string]>(
        "SELECT payload_hash AS payloadHash,result_id AS resultId,revision_id AS revisionId FROM knowledge_receipts WHERE operation_id=?",
      ).get(context.operationId);
      if (receipt) {
        if (receipt.payloadHash !== hash) throw new KnowledgeError("operation_conflict");
        return restore(db, receipt);
      }
      this.beforeMutation?.(db);
      const result = action(db);
      const ref = reference(result);
      db.run("INSERT INTO knowledge_receipts(operation_id,payload_hash,result_id,revision_id) VALUES (?,?,?,?)", [context.operationId, hash, ref.resultId, ref.revisionId]);
      return result;
    });
  }

  private execute<T>(name: string, write: boolean, action: (db: Database) => T): T {
    console.info("knowledge.operation attempt", { operation: name });
    let db: Database | undefined;
    try {
      const opened = openDatabase(this.databasePath);
      db = opened;
      const result = write ? opened.transaction(() => action(opened)).immediate() : action(opened);
      console.info("knowledge.operation succeeded", { operation: name });
      return result;
    } catch (error) {
      const code = error instanceof KnowledgeError ? error.code : "storage_error";
      console.error("knowledge.operation failed", { operation: name, category: code });
      throw error instanceof KnowledgeError ? error : new KnowledgeError("storage_error");
    } finally { db?.close(); }
  }

  createItem(context: KnowledgeContext, input: {
    kind: KnowledgeItem["kind"]; sourceId: string; text: string; evidenceSourceIds: string[];
  }): KnowledgeItem {
    return this.mutate("create_item", context, input, (db) => {
      validateContext(context);
      if (input.kind !== "interpretation" && input.kind !== "developing-idea") throw new KnowledgeError("invalid_input");
      evidence(db, [input.sourceId]);
      const id = crypto.randomUUID();
      db.run("INSERT INTO knowledge_items (id, kind, source_id) VALUES (?,?,?)", [id, input.kind, input.sourceId]);
      appendFormulation(db, context, id, input.text, input.evidenceSourceIds);
      return readItem(db, id);
    }, (result) => ({ resultId: result.id, revisionId: result.current.id }), itemAt);
  }

  getItem(id: string): KnowledgeItem { return this.execute("read_item", false, (db) => readItem(db, id)); }

  recordIdea(context: KnowledgeContext, input: IdeaInput): KnowledgeItem {
    return this.mutate("record_idea", context, input, (db) => {
      if (context.actor !== "ai" || !parseIdea(input)) throw new KnowledgeError("forbidden");
      const origin = db.query(`SELECT 1 FROM dialogue_turns t JOIN dialogues d ON d.id=t.dialogue_id JOIN weaving_runs r ON r.job_id=t.job_id
        WHERE t.id=? AND d.id=? AND d.source_id=? AND t.source_id=? AND r.id=?`).get(input.turnId, input.dialogueId, input.rootSourceId, input.turnSourceId, context.runId);
      if (!origin || !input.evidenceSourceIds.includes(input.rootSourceId) || !input.evidenceSourceIds.includes(input.turnSourceId)) throw new KnowledgeError("forbidden");
      evidence(db, input.evidenceSourceIds);
      if (input.derivedFrom && !db.query("SELECT 1 FROM formulations WHERE id=? AND item_id=?").get(input.derivedFrom.versionId, input.derivedFrom.itemId)) throw new KnowledgeError("invalid_reference");
      const id = crypto.randomUUID();
      db.run("INSERT INTO knowledge_items(id,kind,source_id) VALUES (?,'developing-idea',?)", [id, input.rootSourceId]);
      appendFormulation(db, context, id, input.text, input.evidenceSourceIds);
      db.run("INSERT INTO idea_derivations(item_id,dialogue_id,turn_id,root_source_id,turn_source_id,from_item_id,from_version_id) VALUES (?,?,?,?,?,?,?)",
        [id, input.dialogueId, input.turnId, input.rootSourceId, input.turnSourceId, input.derivedFrom?.itemId ?? null, input.derivedFrom?.versionId ?? null]);
      return readItem(db, id);
    }, (result) => ({ resultId: result.id, revisionId: result.current.id }), itemAt);
  }

  reviseItem(context: KnowledgeContext, input: {
    itemId: string; expectedVersionId: string; text: string; evidenceSourceIds: string[];
  }): KnowledgeItem {
    return this.mutate("revise_item", context, input, (db) => {
      validateContext(context);
      const item = readItem(db, input.itemId);
      checkVersion(item.current, input.expectedVersionId, context);
      appendFormulation(db, context, item.id, input.text, input.evidenceSourceIds);
      return readItem(db, item.id);
    }, (result) => ({ resultId: result.id, revisionId: result.current.id }), itemAt);
  }

  correctItem(context: KnowledgeContext, input: {
    itemId: string; expectedVersionId: string; sourceId: string; text: string;
  }): KnowledgeItem {
    return this.mutate("correct_item", context, input, (db) => {
      if (context.actor !== "user") throw new KnowledgeError("forbidden");
      const item = readItem(db, input.itemId);
      checkVersion(item.current, input.expectedVersionId, context);
      // A correction cites the actual retained user input, not arbitrary text
      // relabelled as user evidence or a source from another inquiry root.
      const source = db.query<{ text: string }, [string, string]>(`SELECT s.text FROM sources s
        JOIN dialogue_turns t ON t.source_id=s.id JOIN dialogues d ON d.id=t.dialogue_id
        WHERE s.id=? AND d.source_id=?`).get(input.sourceId, item.sourceId);
      if (!source || source.text !== input.text) throw new KnowledgeError("invalid_reference");
      appendFormulation(db, context, item.id, source.text, [input.sourceId]);
      return readItem(db, item.id);
    }, (result) => ({ resultId: result.id, revisionId: result.current.id }), itemAt);
  }

  restoreItem(context: KnowledgeContext, input: {
    itemId: string; expectedVersionId: string; restoreVersionId: string;
  }): KnowledgeItem {
    return this.mutate("restore_item", context, input, (db) => {
      validateContext(context);
      if (context.actor !== "user") throw new KnowledgeError("forbidden");
      const item = readItem(db, input.itemId);
      checkVersion(item.current, input.expectedVersionId, context);
      const previous = item.history.find((version) => version.id === input.restoreVersionId);
      if (!previous) throw new KnowledgeError("invalid_reference");
      appendFormulation(db, context, item.id, previous.text, previous.evidenceSourceIds, previous.id);
      return readItem(db, item.id);
    }, (result) => ({ resultId: result.id, revisionId: result.current.id }), itemAt);
  }

  createRelationship(context: KnowledgeContext, input: {
    fromItemId: string; toItemId: string; type: Relationship["type"];
    rationale: string; evidenceSourceIds: string[];
    fromVersionId?: string; toVersionId?: string;
  }): Relationship {
    return this.mutate("create_relationship", context, input, (db) => {
      validateContext(context);
      if (input.fromItemId === input.toItemId) throw new KnowledgeError("invalid_reference");
      if (!["supports", "challenges", "suggests"].includes(input.type)) throw new KnowledgeError("invalid_input");
      const from = readItem(db, input.fromItemId);
      const to = readItem(db, input.toItemId);
      if ((input.fromVersionId !== undefined && from.current.id !== input.fromVersionId) ||
          (input.toVersionId !== undefined && to.current.id !== input.toVersionId)) throw new KnowledgeError("version_conflict");
      requireText(input.rationale);
      evidence(db, input.evidenceSourceIds);
      const existing = db.query<{ id: string }, [string, string, string]>(
        "SELECT id FROM relationships WHERE from_item_id = ? AND to_item_id = ? AND type = ?",
      ).get(input.fromItemId, input.toItemId, input.type);
      if (existing) {
        const relationship = readRelationship(db, existing.id);
        if (relationship.current.status === "rejected") throw new KnowledgeError("forbidden");
        throw new KnowledgeError("operation_conflict");
      }
      const id = crypto.randomUUID();
      db.run("INSERT INTO relationships (id,from_item_id,to_item_id,type) VALUES (?,?,?,?)", [id, input.fromItemId, input.toItemId, input.type]);
      appendRelationship(db, context, id, "active", input.rationale, input.evidenceSourceIds);
      return readRelationship(db, id);
    }, (result) => ({ resultId: result.id, revisionId: result.current.id }), relationshipAt);
  }

  getRelationship(id: string): Relationship { return this.execute("read_relationship", false, (db) => readRelationship(db, id)); }

  reviseRelationship(context: KnowledgeContext, input: {
    relationshipId: string; expectedVersionId: string; status: RelationshipRevision["status"];
    rationale: string; evidenceSourceIds: string[];
  }): Relationship {
    return this.mutate("revise_relationship", context, input, (db) => {
      validateContext(context);
      const relationship = readRelationship(db, input.relationshipId);
      checkVersion(relationship.current, input.expectedVersionId, context);
      if (context.actor === "ai" && relationship.current.status === "rejected") throw new KnowledgeError("forbidden");
      appendRelationship(db, context, relationship.id, input.status, input.rationale, input.evidenceSourceIds);
      return readRelationship(db, relationship.id);
    }, (result) => ({ resultId: result.id, revisionId: result.current.id }), relationshipAt);
  }

  restoreRelationship(context: KnowledgeContext, input: {
    relationshipId: string; expectedVersionId: string; restoreVersionId: string;
  }): Relationship {
    return this.mutate("restore_relationship", context, input, (db) => {
      validateContext(context);
      if (context.actor !== "user") throw new KnowledgeError("forbidden");
      const relationship = readRelationship(db, input.relationshipId);
      checkVersion(relationship.current, input.expectedVersionId, context);
      const previous = relationship.history.find((version) => version.id === input.restoreVersionId);
      if (!previous) throw new KnowledgeError("invalid_reference");
      appendRelationship(db, context, relationship.id, previous.status, previous.rationale, previous.evidenceSourceIds, previous.id);
      return readRelationship(db, relationship.id);
    }, (result) => ({ resultId: result.id, revisionId: result.current.id }), relationshipAt);
  }
}
