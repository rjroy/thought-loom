import type { ToolContext } from "@opencode/plugin/promise/tool";
import type { Plugin } from "@opencode/plugin";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";
import { loopbackOrigin, parseIdea, parseAlias, parseInterpretation, parseInterpretationRevision, parseRelationship, parseRelationshipRevision, toolId, toolRecord, type ToolAction } from "../../contracts/src/tools";

export type NativeToolContext = ToolContext;
export type NativePluginContext = Plugin.Context;
export type ToolEnvelope = {
  native: { sessionID: string; agent: string; messageID: string; callID: string };
  action: "record_interpretation";
  input: { sourceId: string; text: string; evidenceSourceIds: string[] };
};

// This narrow seam is internal to the first-party plugin. Registration must use
// the V2 transform API; context is native-provided, not model-provided.
export async function forwardInterpretation(value: unknown, native: NativeToolContext, options: {
  assertPermission: Plugin.Context["permission"]["assert"];
  send: (envelope: ToolEnvelope, signal: AbortSignal) => Promise<unknown>;
}): Promise<unknown> {
  // Project a whitelist: model arguments are never spread into native context,
  // transport settings or application authority, even if they name those fields.
  const input = parseInterpretation(value, false);
  if (!input) throw new Error("Invalid interpretation input");
  await options.assertPermission({ sessionID: native.sessionID, agent: native.agent,
    action: "record_interpretation", resources: [input.sourceId],
    source: { type: "tool", messageID: native.messageID, id: native.id } });
  native.signal.throwIfAborted();
  return options.send({ native: { sessionID: native.sessionID, agent: native.agent,
    messageID: native.messageID, callID: native.id }, action: "record_interpretation", input }, native.signal);
}

export type ToolConnection = { url: string; transportCredential: string; location: string };

// An explicitly provisioned private runtime file, never a project config secret.
// Importing this module does not read it or register/load anything in the host.
export async function readToolConnection(path: string): Promise<ToolConnection> {
  if (!isAbsolute(path)) throw new Error("Invalid tool connection file");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size > 4096 ||
        (process.getuid && stat.uid !== process.getuid())) throw new Error("Invalid tool connection file");
    const value: unknown = JSON.parse(await handle.readFile("utf8"));
    if (!toolRecord(value) || typeof value.url !== "string" || !loopbackOrigin(value.url) ||
        typeof value.transportCredential !== "string" || value.transportCredential.length < 16 ||
        value.transportCredential.length > 256 || /\s/u.test(value.transportCredential) ||
        typeof value.location !== "string" || !isAbsolute(value.location) || normalize(value.location) !== value.location) {
      throw new Error("Invalid tool connection file");
    }
    return { url: value.url, transportCredential: value.transportCredential, location: value.location };
  } catch {
    // JSON parser diagnostics can contain the credential-bearing input.
    throw new Error("Invalid tool connection file");
  } finally { await handle.close(); }
}

async function send(connection: ToolConnection, path: string, envelope: unknown, signal: AbortSignal): Promise<unknown> {
  console.info("thoughtloom.tool send attempt", { operation: path });
  let status: number | undefined;
  try {
    const response = await fetch(new URL(path, connection.url), { method: "POST", redirect: "error",
      headers: { authorization: `Bearer ${connection.transportCredential}`, "content-type": "application/json" },
      body: JSON.stringify(envelope), signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) });
    status = response.status;
    if (!response.ok) throw new Error("Thoughtloom tool request rejected");
    const result: unknown = await response.json();
    console.info("thoughtloom.tool send succeeded", { operation: path });
    return result;
  } catch {
    console.error("thoughtloom.tool send failed", { operation: path, category: "transport_failed", status });
    throw new Error("Thoughtloom tool transport failed");
  }
}

const plugin: Plugin.Plugin = {
  id: "thoughtloom",
  async setup(ctx) {
    if (typeof ctx.options.connectionFile !== "string") throw new Error("Thoughtloom connection file required");
    const connection = await readToolConnection(ctx.options.connectionFile);
    if (ctx.location.directory !== connection.location) throw new Error("Thoughtloom plugin location mismatch");
    await ctx.tool.transform((editor) => {
      for (const definition of definitions) {
        editor.add({ ...definition, options: { codemode: false, permission: definition.name },
          execute: async (value, native) => ({ content: JSON.stringify(await forward(definition.name, value, native, ctx, connection)) }),
        });
      }
    });
  },
};

export default plugin;

function project(action: ToolAction, value: unknown) {
  switch (action) {
    case "record_interpretation": return parseInterpretation(value, false);
    case "record_idea": return parseIdea(value, false);
    case "record_alias": return parseAlias(value, false);
    case "record_relationship": return parseRelationship(value, false);
    case "revise_interpretation": return parseInterpretationRevision(value, false);
    case "revise_relationship": return parseRelationshipRevision(value, false);
    default: {
      const field = action === "read_source" ? "sourceId" : action === "read_item" ? "itemId" : action === "read_relationship" ? "relationshipId" : "query";
      if (!toolRecord(value) || typeof value[field] !== "string" || (action !== "search" && !toolId(value[field])) ||
          (action === "search" && (String(value[field]).length > 512 || (String(value[field]).match(/[\p{L}\p{N}\p{M}]+/gu)?.length ?? 0) > 16))) return null;
      return { [field]: value[field] };
    }
  }
}
async function forward(action: ToolAction, value: unknown, native: NativeToolContext, ctx: NativePluginContext, connection: ToolConnection) {
  const input = project(action, value);
  if (!input) throw new Error("Invalid domain tool input");
  const fields: Record<string, unknown> = { ...input };
  const resources: string[] = [];
  for (const key of ["sourceId", "rootSourceId", "turnSourceId", "itemId", "relationshipId", "fromItemId", "toItemId"]) {
    if (typeof fields[key] === "string") resources.push(fields[key]);
  }
  if (resources.length === 0 && "evidenceSourceIds" in input && Array.isArray(input.evidenceSourceIds)) {
    for (const id of input.evidenceSourceIds) if (toolId(id)) resources.push(id);
  }
  await ctx.permission.assert({ sessionID: native.sessionID, agent: native.agent, action, resources: resources.length ? resources : ["*"],
    source: { type: "tool", messageID: native.messageID, id: native.id } });
  native.signal.throwIfAborted();
  return send(connection, `/internal/tools/${action.replaceAll("_", "-")}`, {
    native: { sessionID: native.sessionID, agent: native.agent, messageID: native.messageID, callID: native.id }, action, input,
  }, native.signal);
}

const string = { type: "string" as const };
const evidence = { type: "array" as const, items: string, minItems: 1, maxItems: 16 };
type Property = typeof string | typeof evidence | { type: "string"; enum: string[] } | { type: "object"; properties: Record<string, Property>; required: string[]; additionalProperties: boolean };
function schema(properties: Record<string, Property>) {
  return { type: "object" as const, properties, required: Object.keys(properties), additionalProperties: false };
}
const definitions: Array<{ name: ToolAction; description: string; input: ReturnType<typeof schema> }> = [
  { name: "read_source", description: "Read immutable original evidence anywhere in the corpus before citing it.", input: schema({ sourceId: string }) },
  { name: "read_item", description: "Read a knowledge item, its current version, attribution and source evidence.", input: schema({ itemId: string }) },
  { name: "read_relationship", description: "Read a relationship's endpoints, current version, rationale and evidence.", input: schema({ relationshipId: string }) },
  { name: "search", description: "Search sources and attributable annotations for candidate connections; similarity is not evidence.", input: schema({ query: string }) },
  { name: "record_interpretation", description: "Record a tentative interpretation anchored to this run's original source.", input: schema({ sourceId: string, text: string, evidenceSourceIds: evidence }) },
  { name: "record_idea", description: "During dialogue only, record a developing idea with original/user-turn evidence and explicit derivation. Saved immediately; no Keep approval.",
    input: { ...schema({ rootSourceId: string, turnSourceId: string, dialogueId: string, turnId: string, text: string, evidenceSourceIds: evidence, derivedFrom: schema({ itemId: string, versionId: string }) }),
      required: ["rootSourceId", "turnSourceId", "dialogueId", "turnId", "text", "evidenceSourceIds"] } },
  { name: "record_alias", description: "Record an attributable search alias supported by this run's original source.", input: schema({ alias: string, expansion: string, evidenceSourceIds: evidence }) },
  { name: "record_relationship", description: "Record an evidenced directed connection with a root endpoint and current endpoint versions; read candidate items and original evidence first.", input: schema({ fromItemId: string, toItemId: string, fromVersionId: string, toVersionId: string, type: { type: "string", enum: ["supports", "challenges", "suggests"] }, rationale: string, evidenceSourceIds: evidence }) },
  { name: "revise_interpretation", description: "Append a revision to root-scoped AI material at its expected version. User corrections cannot be rewritten.", input: schema({ itemId: string, expectedVersionId: string, text: string, evidenceSourceIds: evidence }) },
  { name: "revise_relationship", description: "Append an expected-version revision to a root-anchored AI relationship after reading it and both current endpoint items. Never reactivate rejected claims.", input: schema({ relationshipId: string, expectedVersionId: string, status: { type: "string", enum: ["active", "rejected"] }, rationale: string, evidenceSourceIds: evidence }) },
];
