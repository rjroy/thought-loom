export type ToolAction = "read_source" | "read_item" | "read_relationship" | "search" | "record_interpretation" | "record_alias" | "record_relationship" | "revise_interpretation" | "revise_relationship" | "record_idea";
export const DOMAIN_ACTIONS: readonly ToolAction[] = ["read_source", "read_item", "read_relationship", "search", "record_interpretation", "record_alias", "record_relationship", "revise_interpretation", "revise_relationship", "record_idea"];
export const CAPTURE_ACTIONS = DOMAIN_ACTIONS.filter((action) => action !== "record_idea");
export type IdeaInput = { rootSourceId: string; turnSourceId: string; dialogueId: string; turnId: string; text: string; evidenceSourceIds: string[]; derivedFrom?: { itemId: string; versionId: string } };
export type IdeaDerivation = { dialogueId: string; turnId: string; turnSourceId: string; itemId?: string; versionId?: string };
export type NativeIdentity = { sessionID: string; agent: string; messageID: string; callID: string };
export type InterpretationInput = { sourceId: string; text: string; evidenceSourceIds: string[] };
export type AliasInput = { alias: string; expansion: string; evidenceSourceIds: string[] };
export type RelationshipInput = { fromItemId: string; toItemId: string; fromVersionId: string; toVersionId: string; type: "supports" | "challenges" | "suggests"; rationale: string; evidenceSourceIds: string[] };
export type InterpretationRevisionInput = { itemId: string; expectedVersionId: string; text: string; evidenceSourceIds: string[] };
export type RelationshipRevisionInput = { relationshipId: string; expectedVersionId: string; status: "active" | "rejected"; rationale: string; evidenceSourceIds: string[] };

export function toolRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function toolKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

export function toolId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\x00-\x20\x7f]/u.test(value);
}

export function loopbackOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname) &&
      !url.username && !url.password && !url.search && !url.hash && url.pathname === "/" ? url.origin : null;
  } catch { return null; }
}

export function parseNativeIdentity(value: unknown): NativeIdentity | null {
  if (!toolRecord(value) || !toolKeys(value, ["sessionID", "agent", "messageID", "callID"])) return null;
  const { sessionID, agent, messageID, callID } = value;
  if (!toolId(sessionID) || !sessionID.startsWith("ses_") || !toolId(agent) ||
      !toolId(messageID) || !messageID.startsWith("msg_") || !toolId(callID)) return null;
  return { sessionID, agent, messageID, callID };
}

export function parseInterpretation(value: unknown, strict = true): InterpretationInput | null {
  if (!toolRecord(value) || (strict && !toolKeys(value, ["sourceId", "text", "evidenceSourceIds"]))) return null;
  const { sourceId, text, evidenceSourceIds } = value;
  if (!toolId(sourceId) || typeof text !== "string" || !text.trim() || text.length > 32_000 ||
      !Array.isArray(evidenceSourceIds) || evidenceSourceIds.length < 1 || evidenceSourceIds.length > 16 ||
      !evidenceSourceIds.every(toolId) || new Set(evidenceSourceIds).size !== evidenceSourceIds.length) return null;
  return { sourceId, text, evidenceSourceIds: [...evidenceSourceIds] };
}

function evidenceIds(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 16 && value.every(toolId) && new Set(value).size === value.length;
}
function text(value: unknown, limit = 32_000): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= limit;
}
export function parseAlias(value: unknown, strict = true): AliasInput | null {
  if (!toolRecord(value) || (strict && !toolKeys(value, ["alias", "expansion", "evidenceSourceIds"]))) return null;
  if (!text(value.alias, 512) || !text(value.expansion, 512) || !evidenceIds(value.evidenceSourceIds)) return null;
  return { alias: value.alias, expansion: value.expansion, evidenceSourceIds: [...value.evidenceSourceIds] };
}
export function parseRelationship(value: unknown, strict = true): RelationshipInput | null {
  if (!toolRecord(value) || (strict && !toolKeys(value, ["fromItemId", "toItemId", "fromVersionId", "toVersionId", "type", "rationale", "evidenceSourceIds"]))) return null;
  const { fromItemId, toItemId, fromVersionId, toVersionId, type, rationale, evidenceSourceIds } = value;
  if (!toolId(fromItemId) || !toolId(toItemId) || !toolId(fromVersionId) || !toolId(toVersionId) ||
      (type !== "supports" && type !== "challenges" && type !== "suggests") || !text(rationale) || !evidenceIds(evidenceSourceIds)) return null;
  return { fromItemId, toItemId, fromVersionId, toVersionId, type, rationale, evidenceSourceIds: [...evidenceSourceIds] };
}
export function parseInterpretationRevision(value: unknown, strict = true): InterpretationRevisionInput | null {
  if (!toolRecord(value) || (strict && !toolKeys(value, ["itemId", "expectedVersionId", "text", "evidenceSourceIds"]))) return null;
  if (!toolId(value.itemId) || !toolId(value.expectedVersionId) || !text(value.text) || !evidenceIds(value.evidenceSourceIds)) return null;
  return { itemId: value.itemId, expectedVersionId: value.expectedVersionId, text: value.text, evidenceSourceIds: [...value.evidenceSourceIds] };
}
export function parseRelationshipRevision(value: unknown, strict = true): RelationshipRevisionInput | null {
  if (!toolRecord(value) || (strict && !toolKeys(value, ["relationshipId", "expectedVersionId", "status", "rationale", "evidenceSourceIds"]))) return null;
  if (!toolId(value.relationshipId) || !toolId(value.expectedVersionId) || (value.status !== "active" && value.status !== "rejected") ||
      !text(value.rationale) || !evidenceIds(value.evidenceSourceIds)) return null;
  return { relationshipId: value.relationshipId, expectedVersionId: value.expectedVersionId, status: value.status, rationale: value.rationale, evidenceSourceIds: [...value.evidenceSourceIds] };
}
export function parseIdea(value: unknown, strict = true): IdeaInput | null {
  if (!toolRecord(value) || (strict && !toolKeys(value, ["rootSourceId", "turnSourceId", "dialogueId", "turnId", "text", "evidenceSourceIds", "derivedFrom"]))) return null;
  if (!toolId(value.rootSourceId) || !toolId(value.turnSourceId) || !toolId(value.dialogueId) || !toolId(value.turnId) || !text(value.text) || !evidenceIds(value.evidenceSourceIds)) return null;
  let derivedFrom: IdeaInput["derivedFrom"];
  if (value.derivedFrom !== undefined) {
    if (!toolRecord(value.derivedFrom) || !toolKeys(value.derivedFrom, ["itemId", "versionId"]) || !toolId(value.derivedFrom.itemId) || !toolId(value.derivedFrom.versionId)) return null;
    derivedFrom = { itemId: value.derivedFrom.itemId, versionId: value.derivedFrom.versionId };
  }
  return { rootSourceId: value.rootSourceId, turnSourceId: value.turnSourceId, dialogueId: value.dialogueId, turnId: value.turnId, text: value.text,
    evidenceSourceIds: [...value.evidenceSourceIds], ...(derivedFrom ? { derivedFrom } : {}) };
}
