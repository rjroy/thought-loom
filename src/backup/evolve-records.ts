import type { Database } from "bun:sqlite";
import { evolveKey, exactEvolvePassageStart, evolveReplyText, evolveTurnText, evolveValue, ideasSaveRequest } from "../domain/evolve-sessions";
import { parseEnvelope, protocolJson } from "../domain/run-protocol";
import { record } from "../domain/validation";
import { check as checkCapture } from "./capture-files";
import type { RawRow } from "./format";
import type { CapturedTable, SqlSnapshot } from "./records";
import type { BackupAppSchema } from "./schema";

export function validateEvolveRecords(db: Database, noRows: (db: Database, sql: string) => void): void {
  noRows(db,`SELECT 1 FROM evolve_sessions e WHERE e.continuation_id!=e.anchor_id AND NOT EXISTS(
    SELECT 1 FROM evolve_saves s JOIN evolve_turns t ON t.id=s.turn_id WHERE t.session_id=e.id AND s.thought_id=e.continuation_id) LIMIT 1`);
  noRows(db,`SELECT 1 FROM evolve_turns t JOIN evolve_sessions e ON e.id=t.session_id LEFT JOIN runs r ON r.id=t.run_id
    WHERE (t.parent_id!=e.anchor_id AND NOT EXISTS(SELECT 1 FROM evolve_saves s JOIN evolve_turns earlier ON earlier.id=s.turn_id
         WHERE earlier.session_id=e.id AND earlier.rowid<t.rowid AND s.thought_id=t.parent_id))
    OR (r.id IS NOT NULL AND (r.kind!='evolve' OR r.input_thought_id IS NOT NULL OR r.created_at!=t.admitted_at
      OR t.open_slot IS NOT (r.status IN ('queued','submitting','running','uncertain'))
      OR (t.reply IS NOT NULL) IS NOT (r.status='completed')
      OR EXISTS(SELECT 1 FROM run_replies a WHERE a.run_id=r.id)
      OR EXISTS(SELECT 1 FROM run_operation_receipts a WHERE a.run_id=r.id)
      OR NOT EXISTS(SELECT 1 FROM run_context c WHERE c.run_id=r.id AND c.kind='thought' AND c.ref_id=e.anchor_id)
      OR NOT EXISTS(SELECT 1 FROM run_context c WHERE c.run_id=r.id AND c.kind='thought' AND c.ref_id=t.parent_id)))
    LIMIT 1`);
  noRows(db,`SELECT 1 FROM evolve_turn_history h JOIN evolve_turns t ON t.id=h.turn_id JOIN evolve_turns p ON p.id=h.prior_turn_id
    LEFT JOIN runs r ON r.id=p.run_id WHERE t.session_id!=p.session_id OR t.rowid<=p.rowid OR r.status IS NOT 'completed' LIMIT 1`);
  noRows(db,`SELECT 1 FROM evolve_saves s GROUP BY s.turn_id HAVING min(s.position)!=0 OR max(s.position)!=count(*)-1 LIMIT 1`);
  noRows(db,`SELECT 1 FROM evolve_saves s WHERE EXISTS(SELECT 1 FROM thought_sources src WHERE src.thought_id=s.thought_id)
    OR EXISTS(SELECT 1 FROM runs r WHERE r.input_thought_id=s.thought_id)
    OR EXISTS(SELECT 1 FROM run_issued_thoughts i WHERE i.thought_id=s.thought_id) LIMIT 1`);
  noRows(db,`SELECT 1 FROM evolve_saves s WHERE s.source_turn_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM evolve_turn_history h WHERE h.turn_id=s.turn_id AND h.prior_turn_id=s.source_turn_id) LIMIT 1`);
}

interface Records {
  text(row: RawRow, column: string): string;
  integer(row: RawRow, column: string): bigint;
  table(snapshot: SqlSnapshot, name: string): CapturedTable;
}
function check(value: unknown, code: "inconsistent-source"): asserts value { checkCapture(Boolean(value),code); }
const key = (...values: (string | null | undefined)[]) => JSON.stringify(values);
function instant(value: string): boolean {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

/** Verify provenance and canonical output as data. No recovered receipt authorizes execution. */
export function validateEvolveBytes(snapshot: SqlSnapshot, schema: BackupAppSchema | undefined, {text,integer,table}: Records): void {
  const sessionTable = snapshot.tables.find(t => t.shape.name === "evolve_sessions");
  const turnTable = snapshot.tables.find(t => t.shape.name === "evolve_turns");
  if (!sessionTable && !turnTable) return;
  check(sessionTable && turnTable,"inconsistent-source");
  const modern = turnTable.shape.columns.includes("run_id");
  check(schema === undefined || modern === (schema === "thoughtloom-logical-11"),"inconsistent-source");
  const optional = (row:RawRow,column:string) => row.values[column]?.storage === "text" ? text(row,column) : null;
  const sessions = new Map(sessionTable.rows.map(row => [text(row,"id"),row]));
  const turns = new Map(turnTable.rows.map(row => [text(row,"id"),row]));
  const runs = new Map<string,RawRow>(), steps = new Map<string,RawRow[]>(), byPrompt = new Map<string,RawRow>();
  const saves = new Map<string,RawRow>(), savesByTurn = new Map<string,RawRow[]>();
  const thoughts = new Map<string,RawRow>(), history = new Map<string,Set<string>>();
  if (modern) {
    for (const row of table(snapshot,"runs").rows) runs.set(text(row,"id"),row);
    for (const row of table(snapshot,"run_steps").rows) {
      const id = text(row,"run_id"), list = steps.get(id) ?? [];
      list.push(row); steps.set(id,list); byPrompt.set(text(row,"prompt_id"),row);
    }
    for (const row of table(snapshot,"thoughts").rows) thoughts.set(text(row,"id"),row);
    for (const row of table(snapshot,"evolve_saves").rows) {
      const id = text(row,"turn_id"), list = savesByTurn.get(id) ?? [];
      list.push(row); savesByTurn.set(id,list); saves.set(text(row,"thought_id"),row);
    }
    for (const row of table(snapshot,"evolve_turn_history").rows) {
      const id = text(row,"turn_id"), prior = text(row,"prior_turn_id"), set = history.get(id) ?? new Set();
      check(turns.has(id) && turns.has(prior) && !set.has(prior),"inconsistent-source");
      set.add(prior); history.set(id,set);
    }
  }
  const belongs = (id:string,session:string,before?:RawRow) => {
    const receipt = saves.get(id), origin = receipt ? turns.get(text(receipt,"turn_id")) : undefined;
    return origin && text(origin,"session_id") === session && (!before || (origin.rowid !== null && before.rowid !== null && origin.rowid < before.rowid));
  };
  try {
    for (const [id,row] of sessions) {
      const anchor = evolveValue(text(row,"anchor_id"),"anchor"), continuation = evolveValue(text(row,"continuation_id"),"continuation");
      evolveValue(id,"session id");
      check((anchor === continuation || belongs(continuation,id)) && instant(text(row,"created_at")),"inconsistent-source");
    }
    for (const [id,row] of turns) {
      const session = evolveValue(text(row,"session_id"),"session id"), owner = sessions.get(session),
        parent = evolveValue(text(row,"parent_id"),"parent"), content = evolveTurnText(text(row,"text"));
      evolveValue(id,"turn id"); evolveKey(text(row,"request_key"));
      check(owner && (parent === text(owner,"anchor_id") || belongs(parent,session,row)) && text(row,"status") === "pending" &&
        instant(text(row,"admitted_at")),"inconsistent-source");
      const runId = optional(row,"run_id"), run = runId === null ? undefined : runs.get(runId), reply = optional(row,"reply");
      const journal = runId === null ? [] : (steps.get(runId) ?? []).toSorted((a,b) => Number(integer(a,"position") - integer(b,"position")));
      const last = journal.at(-1), first = journal[0];
      if (runId === null) check(integer(row,"open_slot") === 1n && reply === null && !history.has(id),"inconsistent-source");
      else {
        check(run && first && last && text(run,"kind") === "evolve" && !optional(run,"input_thought_id") &&
          text(run,"created_at") === text(row,"admitted_at"),"inconsistent-source");
        const status = text(run,"status");
        check((reply !== null) === (status === "completed") &&
          integer(row,"open_slot") === (["queued","running","uncertain","submitting"].includes(status) ? 1n : 0n),"inconsistent-source");
        const initialBytes = optional(first,"input");
        check(initialBytes !== null || !history.has(id),"inconsistent-source");
        if (initialBytes !== null) {
          const job = record(JSON.parse(initialBytes)), context = record(job.context);
          check(job.kind === "ideas-job" && context.turnId === id && context.parentId === parent && context.text === content &&
            Array.isArray(context.history) && context.history.length === (history.get(id)?.size ?? 0),"inconsistent-source");
          const seen = new Set<string>(); let previous: RawRow | undefined;
          for (const item of context.history) {
            const data = record(item), prior = typeof data.id === "string" ? turns.get(data.id) : undefined;
            check(prior && typeof data.id === "string" && history.get(id)?.has(data.id) && !seen.has(data.id) &&
              text(prior,"session_id") === session && prior.rowid !== null && row.rowid !== null && prior.rowid < row.rowid &&
              (!previous || previous.rowid !== null && previous.rowid < prior.rowid) &&
              data.user === text(prior,"text") && data.ai === optional(prior,"reply") && typeof data.ai === "string","inconsistent-source");
            seen.add(data.id); previous = prior;
          }
        }
      }
      const actual = new Map<string,{thoughtId:string;speaker:string;encoded:string;stepPosition:bigint}>();
      for (const [position,receipt] of (savesByTurn.get(id) ?? []).toSorted((a,b) => Number(integer(a,"position")-integer(b,"position"))).entries()) {
        const thoughtId = text(receipt,"thought_id"), thought = thoughts.get(thoughtId), speaker = text(receipt,"speaker"),
          selected = text(receipt,"selected_by"), source = text(receipt,"source"), request = optional(receipt,"request_key"),
          promptId = optional(receipt,"prompt_id"), sourceTurnId = optional(receipt,"source_turn_id");
        check(thought && integer(receipt,"position") === BigInt(position) && ["user","ai"].includes(speaker) &&
          text(thought,"author") === speaker && text(thought,"kind") === (speaker === "user" ? "user-contribution" : "developing-idea") &&
          text(thought,"origin") === (speaker === "user" ? "contribution" : "development"),"inconsistent-source");
        const passage = evolveReplyText(text(thought,"text")), parentId = text(thought,"parent_id");
        let message = speaker === "user" ? content : reply;
        if (sourceTurnId !== null) {
          const origin = turns.get(evolveValue(sourceTurnId,"sourceTurnId"));
          check(origin && history.get(id)?.has(sourceTurnId) && selected === "ai" && source === "passage","inconsistent-source");
          message = speaker === "user" ? text(origin,"text") : optional(origin,"reply");
        }
        let start: number | null = null;
        if (source === "passage") {
          // Verify immutable provenance, not today's automatic attribution policy.
          const uniqueOccurrence = sourceTurnId !== null || (selected === "ai" && speaker === "user");
          start = exactEvolvePassageStart(message,passage,uniqueOccurrence);
          check(integer(receipt,"passage_start") === BigInt(start),"inconsistent-source");
        } else check(source === "synthesis" && speaker === "ai" && selected === "ai" && receipt.values.passage_start.storage === "null","inconsistent-source");
        if (selected === "user") {
          check(request !== null && promptId === null && receipt.values.selection_index.storage === "null" && source === "passage" && parentId === parent,"inconsistent-source");
          evolveKey(request);
          continue;
        }
        const step = promptId === null ? undefined : byPrompt.get(promptId);
        check(selected === "ai" && request === null && step && runId !== null && text(step,"run_id") === runId,"inconsistent-source");
        const index = Number(integer(receipt,"selection_index")), envelope = parseEnvelope(text(step,"envelope_json"));
        const signature = key(speaker,source,parentId,passage,sourceTurnId);
        const encoded = protocolJson({receipt:{thoughtId,speaker,selectedBy:selected,source,start,text:passage,parentId,
          ...(sourceTurnId === null ? {} : {sourceTurnId})}});
        check(!actual.has(signature),"inconsistent-source");
        if (envelope.kind === "request") {
          check(envelope.request.capability === "saveIdea" && index === 0 && text(step,"state") === "processed","inconsistent-source");
          const requested = ideasSaveRequest(envelope.request.arguments);
          check(signature === key(requested.speaker,requested.source,requested.parentId,requested.text,requested.sourceTurnId) &&
            protocolJson(JSON.parse(text(step,"result_json"))) === encoded,"inconsistent-source");
        } else {
          check(envelope.kind === "ideas-reply" && step === last && reply === envelope.reply,"inconsistent-source");
          const selection = envelope.selections[index];
          check(selection && selection.speaker === speaker && selection.source === source && selection.text === passage &&
            (selection.sourceTurnId ?? null) === sourceTurnId,"inconsistent-source");
        }
        check(parentId === parent || speaker === "ai" && [...actual.values()].some(value => value.speaker === "user" && value.thoughtId === parentId),"inconsistent-source");
        actual.set(signature,{thoughtId,speaker,encoded,stepPosition:integer(step,"position")});
      }
      if (reply !== null) {
        evolveReplyText(reply);
        check(last,"inconsistent-source");
        const envelope = parseEnvelope(text(last,"envelope_json"));
        check(envelope.kind === "ideas-reply" && envelope.reply === reply && text(last,"state") === "completed","inconsistent-source");
        const confirmed: {thoughtId:string;speaker:string}[] = [];
        for (const choice of envelope.selections) {
          const earlier = choice.parentSelection === undefined ? undefined : confirmed[choice.parentSelection];
          check(choice.parentSelection === undefined || earlier?.speaker === "user","inconsistent-source");
          const receipt = actual.get(key(choice.speaker,choice.source,earlier?.thoughtId ?? parent,choice.text,choice.sourceTurnId));
          check(receipt,"inconsistent-source"); confirmed.push(receipt);
        }
      }
      // Reused incremental selections may reference a receipt from an earlier prompt rather than a duplicate save.
      for (const step of journal.filter(step => text(step,"state") === "processed")) {
        const envelope = parseEnvelope(text(step,"envelope_json"));
        check(envelope.kind === "request" && envelope.request.capability === "saveIdea","inconsistent-source");
        const input = ideasSaveRequest(envelope.request.arguments), result = JSON.parse(text(step,"result_json"));
        const held = actual.get(key(input.speaker,input.source,input.parentId,input.text,input.sourceTurnId));
        check(held && held.stepPosition <= integer(step,"position") && protocolJson(result) === held.encoded,"inconsistent-source");
      }
    }
    for (const id of savesByTurn.keys()) check(turns.has(id),"inconsistent-source");
  } catch { check(false,"inconsistent-source"); }
}
