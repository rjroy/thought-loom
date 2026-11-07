import type { Actor } from "./rejection";
import type { Claim, RunRecord } from "./run";
import type { Thought } from "./thought";
import { nonEmpty, oneOf, record, ValidationError } from "./validation";
import { protocolJson } from "./run-protocol";

export type ExportEffort = "quick" | "standard" | "thorough";
export interface ExportIntent { readonly request: string; readonly effort: ExportEffort }
export interface ExportSource { readonly id: string; readonly title: string; readonly author: Thought["author"]; readonly kind: Thought["kind"] }
export interface ExportReport { readonly runId: string; readonly markdown: string; readonly sources: readonly ExportSource[] }

/** Only the question and configured effort label cross this user boundary; no model/run authority fields. */
export function exportIntent(input: unknown): ExportIntent {
  protocolJson(input);
  const data = record(input);
  if (!Object.hasOwn(data,"request") || Object.keys(data).some(key => key !== "request" && key !== "effort")) throw new ValidationError("Invalid export request fields");
  return Object.freeze({request:nonEmpty(data.request,"request"),effort:data.effort === undefined ? "standard" : oneOf(data.effort,"effort",["quick","standard","thorough"])});
}

/** Decode daemon-owned publication metadata, never metadata selected by the model. */
export function exportSources(input: unknown): readonly ExportSource[] {
  if (!Array.isArray(input)) throw new ValidationError("Invalid export sources");
  const result = input.map((item: unknown) => {
    const source = record(item);
    const keys = ["id","title","author","kind"];
    if (Object.keys(source).length !== keys.length || keys.some(key => !Object.hasOwn(source,key))) throw new ValidationError("Invalid export source fields");
    const author = oneOf(source.author,"author",["user","ai","source"]);
    const kind = oneOf(source.kind,"kind",["captured-original","user-contribution","ai-interpretation","developing-idea","imported-original","media-original"]);
    if ((author === "source") !== (kind === "imported-original" || kind === "media-original")) throw new ValidationError("Invalid imported attribution");
    return Object.freeze({id:nonEmpty(source.id,"id"),title:nonEmpty(source.title,"title"),author,kind});
  });
  if (new Set(result.map(source => source.id)).size !== result.length) throw new ValidationError("Duplicate export source");
  return Object.freeze(result);
}

function label(value: string): string {
  return value.replace(/[\r\n]/g," ").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
    .replace(/([\\`*_{}\[\]()#+.!|~-])/g,"\\$1");
}
function sourceId(id: string): string {
  // JSON spelling keeps unusual historical IDs unambiguous; a longer code delimiter cannot be closed by the ID.
  const value = JSON.stringify(id);
  const delimiterLength = (value.match(/`+/g) ?? []).reduce((longest,run) => Math.max(longest,run.length),0)+1;
  const ticks = "`".repeat(delimiterLength);
  return `${ticks}${value}${ticks}`;
}

/** Keep the report body byte-for-byte; the appendix supplies validated identities, not a second generated summary. */
export function renderExportReport(markdown: string, sources: readonly ExportSource[]): string {
  nonEmpty(markdown,"markdown");
  const citations = sources.length ? "Recorded thought identities and attribution (not endorsement):\n\n" + sources.map(source =>
    `- ${label(source.title)}: ID: ${sourceId(source.id)}; thought author: ${source.author}; kind: ${source.kind}.${source.kind === "media-original" ? " Access to the descriptor or clarification does not imply binary file access." : ""}`).join("\n") :
    "No source thoughts were cited; this report has no validated thought citations.";
  return `${markdown}\n\n## Sources\n\n${citations}\n`;
}
/** Internal user commands on the existing run aggregate; no agent-facing artifact read. */
export interface AgenticExports {
  admit(actor: Actor, input: { readonly request: string; readonly effort?: ExportEffort }): RunRecord;
  intent(runId: string): ExportIntent | null;
  finalize(claim: Claim, promptId: string): ExportReport;
  report(actor: Actor, runId: string): ExportReport | null;
}
