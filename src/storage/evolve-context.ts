import type { Database } from "bun:sqlite";
import type { EvolveSession, EvolveSpeaker } from "../domain/evolve-sessions";
import type { ContextRef } from "../domain/run";
import { RunConflictError } from "../domain/run";
import { protocolJson } from "../domain/run-protocol";
import { searchEligibilitySql } from "./search-eligibility";
import { readSearchThoughtPreview } from "./search-workspace-content";
import { evolveUtf8, type EvolveTurnRow } from "./evolve-records";

const historyTurns = 6;
const historyBytes = 32 * 1024;
export function evolveThoughtEligible(db: Database, id: string): boolean {
  return db.query(`SELECT 1 WHERE ${searchEligibilitySql("'thought'","CAST(?1 AS TEXT)")}`).get(evolveUtf8(id)) !== null;
}

/** A rejected save is evidence against both the save's destination and the message it copied. */
export function evolveContextEligible(db: Database, turnId: string): boolean {
  return !db.query(`WITH RECURSIVE lineage(id) AS (
    SELECT CAST(? AS TEXT) UNION SELECT h.prior_turn_id FROM evolve_turn_history h JOIN lineage l ON l.id=h.turn_id
  )
  SELECT 1 FROM lineage l JOIN evolve_turns t ON t.id=l.id WHERE
    EXISTS(SELECT 1 FROM run_context ctx WHERE ctx.run_id=t.run_id AND NOT ${searchEligibilitySql("ctx.kind","ctx.ref_id")})
    OR EXISTS(SELECT 1 FROM evolve_saves s JOIN rejected_thoughts r ON r.thought_id=s.thought_id
      WHERE s.turn_id=t.id)
    OR EXISTS(SELECT 1 FROM evolve_saves s JOIN rejected_thoughts r ON r.thought_id=s.thought_id
      WHERE s.source_turn_id=t.id)
  LIMIT 1`).get(evolveUtf8(turnId));
}

/** Capture invalidation while the rejection is committed, even if the user restores before the worker's next tick. */
export function affectedEvolveRuns(db: Database, kind: ContextRef["kind"], id: Uint8Array): { id: string }[] {
  return db.query<{id:string},[string,Uint8Array]>(`WITH RECURSIVE affected(turn_id) AS (
    SELECT t.id FROM run_context c JOIN evolve_turns t ON t.run_id=c.run_id WHERE c.kind=?1 AND c.ref_id=CAST(?2 AS TEXT)
    UNION SELECT s.turn_id FROM evolve_saves s WHERE ?1='thought' AND s.thought_id=CAST(?2 AS TEXT)
    UNION SELECT s.source_turn_id FROM evolve_saves s WHERE ?1='thought' AND s.thought_id=CAST(?2 AS TEXT) AND s.source_turn_id IS NOT NULL
    UNION SELECT h.turn_id FROM evolve_turn_history h JOIN affected a ON h.prior_turn_id=a.turn_id
  ) SELECT r.id FROM affected a JOIN evolve_turns t ON t.id=a.turn_id JOIN runs r ON r.id=t.run_id
  WHERE t.open_slot=1 AND NOT EXISTS(SELECT 1 FROM restore_fences f WHERE f.entity_kind='run' AND f.entity_id=r.id)`).all(kind,id);
}

interface Dialogue { id: string; user: string; ai: string }

/** Authorize a directly supplied prior message, not just another turn in the session or a transitive dependency. */
export function evolvePriorMessage(db: Database, turn: EvolveTurnRow, id: string, speaker: EvolveSpeaker): string {
  const unavailable = () => new RunConflictError("Evolve passage source is not in eligible prepared history");
  if (turn.run_id === null || id === turn.id || !db.query(`SELECT 1 FROM evolve_turn_history h
    WHERE h.turn_id=CAST(? AS TEXT) AND h.prior_turn_id=CAST(? AS TEXT)`).get(evolveUtf8(turn.id),evolveUtf8(id)) ||
    !evolveContextEligible(db,id)) throw unavailable();
  const row = db.query<Dialogue,[string,Uint8Array,Uint8Array,Uint8Array]>(`SELECT p.id,p.text AS user,p.reply AS ai
    FROM evolve_turns p JOIN runs r ON r.id=p.run_id JOIN run_steps s ON s.run_id=? AND s.position=0
    JOIN json_each(s.input,'$.context.history') sent
    WHERE p.id=CAST(? AS TEXT) AND p.session_id=CAST(? AS TEXT) AND r.status='completed' AND p.reply IS NOT NULL
      AND p.rowid<(SELECT rowid FROM evolve_turns WHERE id=CAST(?4 AS TEXT))
      AND json_extract(s.input,'$.kind')='ideas-job' AND json_extract(s.input,'$.context.turnId')=CAST(?4 AS TEXT)
      AND json_extract(sent.value,'$.id')=p.id AND json_extract(sent.value,'$.user')=p.text
      AND json_extract(sent.value,'$.ai')=p.reply`).get(turn.run_id,evolveUtf8(id),evolveUtf8(turn.session_id),evolveUtf8(turn.id));
  if (!row) throw unavailable();
  return row[speaker];
}

export function evolveInitialContext(db: Database, owner: EvolveSession, turn: EvolveTurnRow, track: (ref: ContextRef) => void) {
  const candidates = db.query<Dialogue,[string,string,number]>(`SELECT prior.id,prior.text AS user,prior.reply AS ai
    FROM evolve_turns prior JOIN runs r ON r.id=prior.run_id
    WHERE prior.session_id=? AND prior.rowid<(SELECT rowid FROM evolve_turns WHERE id=?) AND r.status='completed' AND prior.reply IS NOT NULL
    ORDER BY prior.rowid DESC LIMIT ?`).all(owner.id,turn.id,historyTurns);
  const history: Dialogue[] = [];
  let bytes = 0;
  for (const prior of candidates) {
    bytes += evolveUtf8(protocolJson(prior)).length;
    // Drop older context after any gap; never stitch around a dependency we could not provide.
    if (bytes > historyBytes || !evolveContextEligible(db,prior.id)) break;
    db.run("INSERT INTO evolve_turn_history(turn_id,prior_turn_id) VALUES (?,?)",[turn.id,prior.id]);
    history.unshift(prior);
  }
  const focus = [...new Set([owner.anchorThoughtId,turn.parent_id])].map(id => {
    if (!evolveThoughtEligible(db,id)) throw new RunConflictError("Evolve focus is unavailable");
    const {value,dependencies} = readSearchThoughtPreview(db,id);
    for (const ref of dependencies) track(ref);
    // Bounded text, no arbitrary library/response fetch or original path.
    const { thought } = value;
    return {id:thought.id,author:thought.author,title:thought.title?.slice(0,512) ?? null,text:thought.text?.slice(0,4096) ?? null};
  });
  return {turnId:turn.id,parentId:turn.parent_id,text:turn.text,focus,history};
}
