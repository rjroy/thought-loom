import { createLogger } from "../logging";
import type { Database } from "bun:sqlite";
import { evolvePassageStart, type EvolvePassage, type EvolveSave } from "../domain/evolve-sessions";
import { RunConflictError } from "../domain/run";
import type { RunSources } from "../domain/run";
import { createThought } from "../domain/thought";
import { connectionDiscoveryIntent } from "../domain/weave-scheduling";
import { evolveSaveDto, evolveSaveSql, evolveUtf8, type EvolveSaveRow, type EvolveTurnRow } from "./evolve-records";
import { SqliteKnowledgeWriter } from "./knowledge-write";
import { admitWeave } from "./weave-admission";
import { evolvePriorMessage } from "./evolve-context";

type SelectionOrigin = { selectedBy: "user"; key: string } | { selectedBy: "ai"; runId: string; promptId: string; index: number };

/** Source validation and knowledge insertion are called only inside the owning immediate transaction. */
export function saveEvolveIdea(db: Database, sources: RunSources, turn: EvolveTurnRow, input: EvolvePassage & Pick<EvolveSave,"sourceTurnId">,
  source: EvolveSave["source"], origin: SelectionOrigin, finalizedReply = turn.reply): EvolveSave {
  if (!db.inTransaction) throw new RunConflictError("Evolve save requires its owning transaction");
  const prior = input.sourceTurnId;
  if (prior !== undefined && (source !== "passage" || origin.selectedBy !== "ai")) {
    throw new RunConflictError("Prior passage provenance requires an automatic passage selection");
  }
  const automatic = origin.selectedBy === "ai", conservativeUser = automatic && input.speaker === "user";
  const speaker = input.speaker;
  const message = prior !== undefined ? evolvePriorMessage(db,turn,prior,speaker) : speaker === "user" ? turn.text : finalizedReply;
  const start = source === "passage" ? evolvePassageStart(message,input.text,prior !== undefined || conservativeUser,conservativeUser) : null;
  const text = message !== null && start !== null ? message.slice(start,start + input.text.length) : input.text;
  const sourceTurnId = prior === undefined ? null : evolveUtf8(prior);
  if (automatic) {
    const existing = db.query<EvolveSaveRow,[string,string,string,Uint8Array,Uint8Array | null,Uint8Array]>(`${evolveSaveSql}
      WHERE s.turn_id=? AND s.selected_by='ai' AND s.speaker=? AND s.source=? AND t.parent_id=CAST(? AS TEXT)
       AND s.source_turn_id IS CAST(? AS TEXT) AND t.text=CAST(? AS TEXT)`).get(turn.id,speaker,source,evolveUtf8(input.parentId),sourceTurnId,evolveUtf8(text));
    if (existing) return evolveSaveDto(existing);
  }
  const thoughtId = sources.id();
  const thought = createThought({id:thoughtId,text,parentId:input.parentId,title:null,titleAuthor:null,createdAt:sources.now(),
    sourceIds:[],author:speaker,kind:speaker === "user" ? "user-contribution" : "developing-idea",
    origin:speaker === "user" ? "contribution" : "development"});
  const logger = sources.logger ?? createLogger();
  new SqliteKnowledgeWriter(db,logger,automatic ? undefined : sources).saveThought(thought);
  db.run(`INSERT INTO evolve_saves(thought_id,turn_id,position,speaker,selected_by,source,passage_start,request_key,prompt_id,selection_index,source_turn_id)
    SELECT ?,CAST(? AS TEXT),COALESCE(MAX(position)+1,0),?,?,?,?,?,?,?,CAST(? AS TEXT) FROM evolve_saves WHERE turn_id=CAST(? AS TEXT)`,
    [thoughtId,evolveUtf8(turn.id),speaker,origin.selectedBy,source,start,automatic ? null : origin.key,
      automatic ? origin.promptId : null,automatic ? origin.index : null,sourceTurnId,evolveUtf8(turn.id)]);
  if (automatic) {
    admitWeave(db,sources,connectionDiscoveryIntent(thoughtId,origin.runId));
    db.run("UPDATE evolve_sessions SET continuation_id=? WHERE id=CAST(? AS TEXT)",[thoughtId,evolveUtf8(turn.session_id)]);
  }
  return {thoughtId,speaker,text,parentId:input.parentId,selectedBy:origin.selectedBy,source,start,...(prior === undefined ? {} : {sourceTurnId:prior})};
}
