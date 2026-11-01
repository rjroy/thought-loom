import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Database } from "bun:sqlite";
import { createHash, timingSafeEqual } from "node:crypto";
import { isAbsolute, normalize } from "node:path";
import { isLegacyNativeAction, NATIVE_CAPABILITY_ACTIONS, parseGeneratedTitle, parseIdea, parseAlias, parseInterpretation, parseInterpretationRevision, parseRelationship, parseRelationshipRevision, parseNativeIdentity, toolId, toolKeys, toolRecord, type NativeIdentity, type ToolAction } from "@thoughtloom/contracts";
import { KnowledgeError, KnowledgeService, readItem, readRelationship, type KnowledgeContext } from "./knowledge";
import { openDatabase, searchSources, sourceRecord } from "./storage";
import type { WeavingRun } from "./weaving";
import { runScope, type RunScope } from "./run-scope";
import { dialogueHeader } from "./dialogue-data";
import { parseNativeCommand } from "./native-profile";
import { writeTitle } from "./title-write";
import { readTitle } from "./title-projection";

export type OwnedGrant = {
  run: WeavingRun;
  location: string;
  agent: string;
  sourceIds: string[];
  operations: ToolAction[];
};

// Known grant vocabulary only. Extension grants also require a matching frozen
// native profile; a registered boundary alone never supplies that authority.
export const supportedToolActions: readonly ToolAction[] = NATIVE_CAPABILITY_ACTIONS;
type GrantRecord = { runId: string; location: string; agent: string; sourceIds: string; operations: string; revoked: number; jobId: string; root: string; promptId: string };
type GrantRow = GrantRecord & { scope: RunScope };

function storage<T>(path: string, write: boolean, action: (db: Database) => T): T {
  let db: Database | undefined;
  try {
    db = openDatabase(path);
    const connection = db;
    const transaction = connection.transaction(() => action(connection));
    return write ? transaction.immediate() : transaction.deferred();
  } catch (error) {
    throw error instanceof KnowledgeError ? error : new KnowledgeError("storage_error");
  } finally { db?.close(); }
}

function strings(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every(toolId)) throw new KnowledgeError("storage_error");
  return parsed;
}

function authorize(db: Database, native: NativeIdentity, location: string, action: ToolAction): GrantRow {
  const row = db.query<GrantRecord, [string]>(`SELECT g.run_id AS runId,g.location,g.agent,
    g.source_ids AS sourceIds,g.operations,g.revoked,j.id AS jobId,j.source_id AS root,r.prompt_id AS promptId FROM owned_grants g
    JOIN weaving_runs r ON r.id=g.run_id AND r.session_id=g.session_id JOIN jobs j ON j.id=r.job_id
    WHERE g.session_id=? AND r.outcome IS NULL AND r.state IN ('admitting','admitted','uncertain') AND j.status IN ('running','uncertain')
      AND NOT EXISTS (SELECT 1 FROM dialogue_stop_requests s WHERE s.job_id=j.id)`,
  ).get(native.sessionID);
  if (!row || row.revoked || row.location !== location || row.agent !== native.agent || !strings(row.operations).includes(action)) {
    throw new KnowledgeError("forbidden");
  }
  const scope = runScope(db, { runId: row.runId, jobId: row.jobId, sourceId: row.root, sessionId: native.sessionID, promptId: row.promptId });
  if (!scope || (action === "record_idea" && scope.kind !== "dialogue") || JSON.stringify(strings(row.sourceIds)) !== JSON.stringify([...scope.sourceIds].sort())) throw new KnowledgeError("forbidden");
  return { ...row, scope };
}

function titleCommandHash(db: Database, grant: GrantRow, pluginBuildId: unknown): string {
  const saved = db.query<{ payload: string; hash: string }, [string]>("SELECT payload,payload_hash AS hash FROM native_commands WHERE run_id=?").get(grant.runId);
  if (!saved || createHash("sha256").update(saved.payload).digest("hex") !== saved.hash) throw new KnowledgeError("forbidden");
  let value: unknown;
  try { value = JSON.parse(saved.payload); } catch { throw new KnowledgeError("forbidden"); }
  const command = parseNativeCommand(value), capability = command?.profile.capability;
  if (!command || !capability || !command.profile.actions.includes("record_title_v1") || !capability.actions.includes("record_title_v1") ||
      pluginBuildId !== capability.buildId || command.location !== grant.location || command.agent !== grant.agent ||
      JSON.stringify([...command.profile.actions].sort()) !== JSON.stringify(strings(grant.operations).sort())) throw new KnowledgeError("forbidden");
  return saved.hash;
}

// These administrative operations are daemon-internal, not model-facing APIs.
export class OwnedGrants {
  constructor(private readonly databasePath: string) {}

  bind(grant: OwnedGrant): void {
    console.info("tools.grant bind attempt", { runId: grant.run.runId });
    try {
      storage(this.databasePath, true, (db) => {
        const { run } = grant;
        const row = db.query<{ jobId: string; sourceId: string; sessionId: string; promptId: string; state: string }, [string]>(
          `SELECT r.job_id AS jobId,j.source_id AS sourceId,r.session_id AS sessionId,r.prompt_id AS promptId,r.state
           FROM weaving_runs r JOIN jobs j ON j.id=r.job_id WHERE r.id=? AND r.outcome IS NULL AND j.status IN ('running','uncertain')
             AND NOT EXISTS (SELECT 1 FROM dialogue_stop_requests s WHERE s.job_id=j.id)`,
        ).get(run.runId);
        if (!row || row.jobId !== run.jobId || row.sourceId !== run.sourceId || row.sessionId !== run.sessionId || row.promptId !== run.promptId ||
            !["preparing", "admitting", "admitted", "uncertain"].includes(row.state)) throw new KnowledgeError("forbidden");
        const scope = runScope(db, run);
        if (!scope || !isAbsolute(grant.location) || normalize(grant.location) !== grant.location || !toolId(grant.agent) ||
            JSON.stringify([...grant.sourceIds].sort()) !== JSON.stringify([...scope.sourceIds].sort()) || grant.operations.length < 1 || (scope.kind !== "dialogue" && grant.operations.includes("record_idea")) ||
            new Set(grant.operations).size !== grant.operations.length || grant.operations.some((action) => !supportedToolActions.includes(action))) {
          throw new KnowledgeError("forbidden");
        }
        const sourceIds = JSON.stringify([...grant.sourceIds].sort());
        const operations = JSON.stringify([...grant.operations].sort());
        const native = db.query<{ payload: string; hash: string }, [string]>("SELECT payload,payload_hash AS hash FROM native_commands WHERE run_id=?").get(run.runId);
        if (native) {
          const command = parseNativeCommand(JSON.parse(native.payload));
          if (!command || createHash("sha256").update(native.payload).digest("hex") !== native.hash || command.location !== grant.location || command.agent !== grant.agent ||
              JSON.stringify([...command.profile.actions].sort()) !== operations) throw new KnowledgeError("forbidden");
        } else if (grant.operations.some((action) => !isLegacyNativeAction(action))) throw new KnowledgeError("forbidden");
        const hash = createHash("sha256").update(JSON.stringify([
          run.runId, run.jobId, run.sourceId, run.sessionId, run.promptId, grant.location, grant.agent, sourceIds, operations,
        ])).digest("hex");
        const existing = db.query<{ scopeHash: string; revoked: number }, [string]>(
          "SELECT scope_hash AS scopeHash,revoked FROM owned_grants WHERE session_id=?",
        ).get(run.sessionId);
        if (existing) {
          if (existing.revoked || existing.scopeHash !== hash) throw new KnowledgeError("forbidden");
          return;
        }
        // A new grant must precede admission; recovery can read an existing one,
        // but cannot manufacture authority for an already-running native session.
        if (row.state !== "preparing") throw new KnowledgeError("forbidden");
        db.run("INSERT INTO owned_grants(session_id,run_id,location,agent,source_ids,operations,scope_hash) VALUES (?,?,?,?,?,?,?)",
          [run.sessionId, run.runId, grant.location, grant.agent, sourceIds, operations, hash]);
      });
      console.info("tools.grant bind succeeded", { runId: grant.run.runId });
    } catch (error) {
      console.error("tools.grant bind failed", { category: error instanceof KnowledgeError ? error.code : "invalid_input" });
      throw error;
    }
  }

  revoke(sessionId: string): void {
    console.info("tools.grant revoke attempt", { sessionId });
    try {
      storage(this.databasePath, true, (db) => db.run("UPDATE owned_grants SET revoked=1 WHERE session_id=?", [sessionId]));
      console.info("tools.grant revoke succeeded", { sessionId });
    } catch (error) {
      console.error("tools.grant revoke failed", { sessionId, category: "storage_error" });
      throw error;
    }
  }
}

type ItemAnchor = { sourceId: string; versionId: string };
function itemAnchor(db: Database, itemId: string): ItemAnchor {
  const row = db.query<ItemAnchor, [string]>(`SELECT i.source_id AS sourceId,f.id AS versionId FROM knowledge_items i
    JOIN formulations f ON f.item_id=i.id WHERE i.id=? ORDER BY f.rowid DESC LIMIT 1`).get(itemId);
  if (!row) throw new KnowledgeError("invalid_reference");
  return row;
}
function readWitness(db: Database, grant: GrantRow, kind: "source" | "item" | "relationship", id: string, version?: string) {
  const row = db.query<{ versionId: string | null }, [string, string, string]>(
    "SELECT version_id AS versionId FROM tool_reads WHERE run_id=? AND kind=? AND record_id=?",
  ).get(grant.runId, kind, id);
  if (!row) throw new KnowledgeError("forbidden");
  if (version !== undefined && row.versionId !== version) throw new KnowledgeError("version_conflict");
}
function rootEvidence(grant: GrantRow, ids: string[]) {
  const roots = strings(grant.sourceIds);
  if (ids.some((id) => !roots.includes(id))) throw new KnowledgeError("forbidden");
}
function relationshipScope(db: Database, grant: GrantRow, fromId: string, toId: string, ids: string[]) {
  const from = itemAnchor(db, fromId), to = itemAnchor(db, toId);
  const roots = strings(grant.sourceIds);
  if (from.sourceId !== grant.scope.rootSourceId && to.sourceId !== grant.scope.rootSourceId) throw new KnowledgeError("forbidden");
  for (const [id, item] of [[fromId, from], [toId, to]] as const) {
    if (!roots.includes(item.sourceId)) {
      readWitness(db, grant, "item", id);
      readWitness(db, grant, "source", item.sourceId);
    }
  }
  const allowed = new Set([...roots, from.sourceId, to.sourceId]);
  for (const item of [from, to]) for (const evidence of db.query<{ id: string }, [string]>(
    "SELECT source_id AS id FROM formulation_evidence WHERE formulation_id=?",
  ).all(item.versionId)) allowed.add(evidence.id);
  for (const id of ids) {
    if (!allowed.has(id)) throw new KnowledgeError("forbidden");
    if (!roots.includes(id)) readWitness(db, grant, "source", id);
  }
  return { from, to };
}

export function createToolApp(options: { databasePath: string; transportCredential: string; location: string }) {
  if (!options.transportCredential || !isAbsolute(options.location) || normalize(options.location) !== options.location) {
    throw new Error("Invalid internal tool configuration");
  }
  const app = new Hono();
  const credential = createHash("sha256").update(`Bearer ${options.transportCredential}`).digest();
  app.use("/internal/tools/*", async (context, next) => {
    console.info("tools.request attempt");
    const actual = createHash("sha256").update(context.req.header("authorization") ?? "").digest();
    if (!timingSafeEqual(credential, actual)) {
      console.info("tools.request rejected", { category: "unauthorized" });
      return context.json({ error: "Unauthorized" }, 401);
    }
    if (context.req.header("origin")) {
      console.info("tools.request rejected", { category: "browser_origin" });
      return context.json({ error: "Forbidden" }, 403);
    }
    await next();
    console.info("tools.request outcome", { status: context.res.status });
  });
  app.use("/internal/tools/*", bodyLimit({ maxSize: 65_536, onError: (context) => context.json({ error: "Tool request too large" }, 413) }));
  app.onError((error, context) => {
    const code = error instanceof KnowledgeError ? error.code : "storage_error";
    console.error("tools.request failed", { category: code });
    const status = code === "forbidden" ? 403 : code === "operation_conflict" || code === "version_conflict" ? 409 : code === "invalid_input" || code === "invalid_reference" ? 400 : 503;
    return context.json({ error: code }, status);
  });

  async function envelope(request: Request, action: ToolAction) {
    let body: unknown;
    try { body = await request.json(); } catch { throw new KnowledgeError("invalid_input"); }
    const keys = action === "record_title_v1" ? ["native", "input", "action", "pluginBuildId"] : ["native", "input", "action"];
    if (!toolRecord(body) || !toolKeys(body, keys) || (body.action !== undefined && body.action !== action)) {
      throw new KnowledgeError("invalid_input");
    }
    const native = parseNativeIdentity(body.native);
    if (!native) throw new KnowledgeError("invalid_input");
    return { native, input: body.input, pluginBuildId: body.pluginBuildId };
  }

  function mutate<T>(native: NativeIdentity, action: ToolAction, scope: (db: Database, grant: GrantRow) => void,
    change: (knowledge: KnowledgeService, actor: KnowledgeContext) => T,
    before?: (db: Database, grant: GrantRow) => void): T {
    const check = (db: Database) => {
      const grant = authorize(db, native, options.location, action);
      scope(db, grant);
      return grant;
    };
    const grant = storage(options.databasePath, false, check);
    const operationId = `tool_${createHash("sha256").update(JSON.stringify([native.sessionID, native.messageID, native.callID])).digest("hex")}`;
    const knowledge = new KnowledgeService(options.databasePath, (db) => { check(db); }, before ? (db) => before(db, check(db)) : undefined);
    return change(knowledge, { actor: "ai", operationId, runId: grant.runId });
  }
  function witness(db: Database, grant: GrantRow, kind: "source" | "item" | "relationship", id: string, version: string | null) {
    db.run(`INSERT INTO tool_reads(run_id,kind,record_id,version_id) VALUES (?,?,?,?)
      ON CONFLICT(run_id,kind,record_id) DO UPDATE SET version_id=excluded.version_id`, [grant.runId, kind, id, version]);
  }

  app.post("/internal/tools/record-interpretation", async (context) => {
    const body = await envelope(context.req.raw, "record_interpretation");
    const input = parseInterpretation(body.input);
    if (!input) throw new KnowledgeError("invalid_input");
    console.info("tools.interpretation attempt", { sessionId: body.native.sessionID, messageId: body.native.messageID });
    const check = (db: Database) => {
      const grant = authorize(db, body.native, options.location, "record_interpretation");
      const sources = strings(grant.sourceIds);
      if (input.sourceId !== grant.scope.rootSourceId || input.evidenceSourceIds.some((id) => !sources.includes(id))) throw new KnowledgeError("forbidden");
      return grant;
    };
    const grant = storage(options.databasePath, false, check);
    const operationId = `tool_${createHash("sha256").update(JSON.stringify([body.native.sessionID, body.native.messageID, body.native.callID])).digest("hex")}`;
    // The guard runs again under the knowledge mutation's IMMEDIATE transaction,
    // fencing revocation/completion even when the operation is a receipt replay.
    const knowledge = new KnowledgeService(options.databasePath, (db) => { check(db); });
    const result = knowledge.createItem({ actor: "ai", operationId, runId: grant.runId }, { ...input, kind: "interpretation" });
    console.info("tools.interpretation succeeded", { runId: grant.runId, operationId, itemId: result.id });
    return context.json(result);
  });

  app.post("/internal/tools/record-title-v1", async (context) => {
    const body = await envelope(context.req.raw, "record_title_v1");
    console.info("tools.title attempt", { sessionId: body.native.sessionID, messageId: body.native.messageID, callId: body.native.callID });
    const result = storage(options.databasePath, true, (db) => {
      // Authorization, frozen build/profile validation and replay all share the
      // write transaction: revocation or settlement cannot race a title write.
      const grant = authorize(db, body.native, options.location, "record_title_v1");
      const commandHash = titleCommandHash(db, grant, body.pluginBuildId);
      const input = parseGeneratedTitle(body.input);
      if (!input) throw new KnowledgeError("invalid_input");
      // The shared writer checks item/root association and, for a new generated
      // revision, the exact current formulation under this same transaction.
      if (input.rootSourceId !== grant.scope.rootSourceId) throw new KnowledgeError("forbidden");
      const callHash = createHash("sha256").update(JSON.stringify([body.native.sessionID, body.native.messageID, body.native.callID])).digest("hex");
      // ':' is excluded from public manual idempotency keys. The retained native
      // receipt identifies the owning run/call; its hash binds the accepted
      // command (including capability proof), native identity and exact input.
      const key = `native-title-v1:${grant.runId}:${callHash}`;
      const payloadHash = createHash("sha256").update(JSON.stringify({ action: "record_title_v1", runId: grant.runId, native: body.native, commandHash, input })).digest("hex");
      return { runId: grant.runId, title: writeTitle(db, { sourceId: input.rootSourceId, target: input.target, text: input.text,
        expectedTitleRevisionId: input.expectedTitleRevisionId, author: "ai", key, payloadHash }) };
    });
    console.info("tools.title succeeded", { runId: result.runId, revisionId: result.title.revisionId });
    return context.json(result.title);
  });

  app.post("/internal/tools/record-alias", async (context) => {
    const body = await envelope(context.req.raw, "record_alias"), input = parseAlias(body.input);
    if (!input) throw new KnowledgeError("invalid_input");
    return context.json(mutate(body.native, "record_alias", (_db, grant) => rootEvidence(grant, input.evidenceSourceIds),
      (service, actor) => service.recordAlias(actor, input)));
  });
  app.post("/internal/tools/record-idea", async (context) => {
    const body = await envelope(context.req.raw, "record_idea");
    // Reject absent dialogue authority before parsing model-supplied origin data.
    const authorized = storage(options.databasePath, false, (db) => authorize(db, body.native, options.location, "record_idea"));
    const input = parseIdea(body.input);
    if (!input) throw new KnowledgeError("invalid_input");
    console.info("tools.idea attempt", { runId: authorized.runId, messageId: body.native.messageID, callId: body.native.callID });
    const result = mutate(body.native, "record_idea", (db, grant) => {
      const scope = grant.scope;
      if (scope.kind !== "dialogue" || input.rootSourceId !== scope.rootSourceId || input.turnSourceId !== scope.turnSourceId || input.dialogueId !== scope.dialogueId || input.turnId !== scope.turnId ||
          !input.evidenceSourceIds.includes(scope.rootSourceId) || !input.evidenceSourceIds.includes(scope.turnSourceId)) throw new KnowledgeError("forbidden");
      for (const id of input.evidenceSourceIds) if (!scope.sourceIds.includes(id)) readWitness(db, grant, "source", id);
      if (input.derivedFrom) {
        const dialogue = dialogueHeader(db, scope.dialogueId), from = input.derivedFrom;
        if (!dialogue) throw new KnowledgeError("forbidden");
        const selected = dialogue.selection.kind === "item" && dialogue.selection.id === from.itemId && dialogue.selection.versionId === from.versionId;
        const endpoint = dialogue.selectedContext.kind === "relationship" && [dialogue.selectedContext.from, dialogue.selectedContext.to].some((item) => item.id === from.itemId && item.version.id === from.versionId);
        if (!selected && !endpoint) {
          readWitness(db, grant, "item", from.itemId, from.versionId);
          const anchor = itemAnchor(db, from.itemId);
          if (anchor.versionId !== from.versionId) throw new KnowledgeError("version_conflict");
          if (!scope.sourceIds.includes(anchor.sourceId)) readWitness(db, grant, "source", anchor.sourceId);
        }
      }
    }, (service, actor) => service.recordIdea(actor, input));
    console.info("tools.idea succeeded", { runId: authorized.runId, itemId: result.id, versionId: result.current.id });
    return context.json(result);
  });
  app.post("/internal/tools/record-relationship", async (context) => {
    const body = await envelope(context.req.raw, "record_relationship"), input = parseRelationship(body.input);
    if (!input) throw new KnowledgeError("invalid_input");
    return context.json(mutate(body.native, "record_relationship", (db, grant) => {
      relationshipScope(db, grant, input.fromItemId, input.toItemId, input.evidenceSourceIds);
    }, (service, actor) => service.createRelationship(actor, input), (db, grant) => {
      for (const [id, version] of [[input.fromItemId, input.fromVersionId], [input.toItemId, input.toVersionId]]) {
        const anchor = itemAnchor(db, id);
        if (anchor.versionId !== version) throw new KnowledgeError("version_conflict");
        if (!strings(grant.sourceIds).includes(anchor.sourceId)) readWitness(db, grant, "item", id, version);
      }
    }));
  });
  app.post("/internal/tools/revise-interpretation", async (context) => {
    const body = await envelope(context.req.raw, "revise_interpretation"), input = parseInterpretationRevision(body.input);
    if (!input) throw new KnowledgeError("invalid_input");
    return context.json(mutate(body.native, "revise_interpretation", (db, grant) => {
      if (itemAnchor(db, input.itemId).sourceId !== grant.scope.rootSourceId) throw new KnowledgeError("forbidden");
      rootEvidence(grant, input.evidenceSourceIds);
    }, (service, actor) => service.reviseItem(actor, input)));
  });
  app.post("/internal/tools/revise-relationship", async (context) => {
    const body = await envelope(context.req.raw, "revise_relationship"), input = parseRelationshipRevision(body.input);
    if (!input) throw new KnowledgeError("invalid_input");
    return context.json(mutate(body.native, "revise_relationship", (db, grant) => {
      const relation = db.query<{ fromId: string; toId: string }, [string]>(
        "SELECT from_item_id AS fromId,to_item_id AS toId FROM relationships WHERE id=?",
      ).get(input.relationshipId);
      if (!relation) throw new KnowledgeError("invalid_reference");
      relationshipScope(db, grant, relation.fromId, relation.toId, input.evidenceSourceIds);
      readWitness(db, grant, "relationship", input.relationshipId);
    }, (service, actor) => service.reviseRelationship(actor, input), (db, grant) => {
      readWitness(db, grant, "relationship", input.relationshipId, input.expectedVersionId);
      const relation = db.query<{ fromId: string; toId: string }, [string]>(
        "SELECT from_item_id AS fromId,to_item_id AS toId FROM relationships WHERE id=?",
      ).get(input.relationshipId);
      if (!relation) throw new KnowledgeError("invalid_reference");
      for (const id of [relation.fromId, relation.toId]) readWitness(db, grant, "item", id, itemAnchor(db, id).versionId);
    }));
  });

  app.post("/internal/tools/read-source", async (context) => {
    const body = await envelope(context.req.raw, "read_source");
    if (!toolRecord(body.input) || !toolKeys(body.input, ["sourceId"]) || !toolId(body.input.sourceId)) throw new KnowledgeError("invalid_input");
    const id = body.input.sourceId;
    const source = storage(options.databasePath, true, (db) => {
      const grant = authorize(db, body.native, options.location, "read_source");
      const source = sourceRecord(db, id);
      if (!source) return null;
      witness(db, grant, "source", source.id, null);
      return { ...source, titleState: readTitle(db, source.id) };
    });
    return source ? context.json(source) : context.json({ error: "Source not found" }, 404);
  });
  for (const action of ["read_item", "read_relationship"] as const) {
    app.post(action === "read_item" ? "/internal/tools/read-item" : "/internal/tools/read-relationship", async (context) => {
      const body = await envelope(context.req.raw, action);
      const field = action === "read_item" ? "itemId" : "relationshipId";
      if (!toolRecord(body.input) || !toolKeys(body.input, [field]) || !toolId(body.input[field])) throw new KnowledgeError("invalid_input");
      const id = body.input[field];
      // Body/current version, title state and read witness share one snapshot;
      // a concurrent formulation/title change cannot mix their identities.
      const result = storage(options.databasePath, true, (db) => {
        const grant = authorize(db, body.native, options.location, action);
        if (action === "read_item") {
          const item = readItem(db, id);
          witness(db, grant, "item", id, item.current.id);
          return { ...item, titleState: readTitle(db, item.sourceId, item.id, item.current.id) };
        }
        const relationship = readRelationship(db, id);
        witness(db, grant, "relationship", id, relationship.current.id);
        return relationship;
      });
      return context.json(result);
    });
  }
  app.post("/internal/tools/search", async (context) => {
    const body = await envelope(context.req.raw, "search");
    if (!toolRecord(body.input) || !toolKeys(body.input, ["query"]) || typeof body.input.query !== "string" || body.input.query.length > 512 ||
        (body.input.query.match(/[\p{L}\p{N}\p{M}]+/gu)?.length ?? 0) > 16) throw new KnowledgeError("invalid_input");
    storage(options.databasePath, false, (db) => authorize(db, body.native, options.location, "search"));
    return context.json({ results: searchSources(options.databasePath, body.input.query) });
  });
  return app;
}
