import type { Database } from "bun:sqlite";
import { ideasSaveRequest, type EvolveSave } from "../domain/evolve-sessions";
import { RunConflictError, RunFenceError, RunForbiddenError, type Claim, type RunRecord, type RunSources } from "../domain/run";
import { protocolJson, type RunStep } from "../domain/run-protocol";
import { SqliteAgentInstructions } from "./agent-instructions";
import { evolveInitialContext, evolveThoughtEligible } from "./evolve-context";
import { evolveOwner, evolveTurnForRun, evolveUtf8, type EvolveTurnRow } from "./evolve-records";
import { saveEvolveIdea } from "./evolve-save";
import { SqliteRunAggregate } from "./run-aggregate";

export class SqliteEvolveExecution extends SqliteRunAggregate {
  constructor(db: Database, private readonly sources: RunSources) { super(db,sources.logger); }
  private turn(run: RunRecord): EvolveTurnRow {
    const turn = run.kind === "evolve" && run.inputThoughtId === null ? evolveTurnForRun(this.db,run.id) : null;
    if (!turn) throw new RunForbiddenError("Ideas-only turn authority required");
    return turn;
  }
  prepare(claim: Claim, render: (context: ReturnType<typeof evolveInitialContext>) => string): void {
    this.guardedExecution("prepare ideas context",claim,run => {
      const turn = this.turn(run), step = this.currentStep(run.id);
      if (step.input !== null) return;
      if (step.position !== 0 || step.state !== "prepared" || run.status !== "queued") throw new RunFenceError();
      const owner = evolveOwner(this.db,turn.session_id);
      if (!owner) throw new RunConflictError("Ideas-only conversation owner unavailable");
      const context = evolveInitialContext(this.db,owner,turn,ref => this.track(run.id,ref));
      const guidance = new SqliteAgentInstructions(this.db,this.logger).get().evolve;
      this.db.run("UPDATE run_steps SET input=CAST(? AS TEXT),guidance=CAST(? AS TEXT) WHERE run_id=? AND prompt_id=?",
        [evolveUtf8(render(context)),evolveUtf8(guidance),run.id,step.promptId]);
    });
  }
  process(claim: Claim, promptId: string, successor: (result: EvolveSave) => string): { completed: boolean; saves: number } {
    return this.guardedExecution("apply ideas result",claim,run => {
      const turn = this.turn(run), step = this.currentStep(run.id);
      if (step.promptId !== promptId || step.state !== "completed" || step.input === null || turn.reply !== null) throw new RunFenceError();
      if (step.envelope?.kind === "ideas-reply") return this.publish(run,turn,step,step.envelope);
      if (step.envelope?.kind !== "request" || step.envelope.request.capability !== "saveIdea") throw new RunForbiddenError("Ideas-only save or final reply required");
      const input = ideasSaveRequest(step.envelope.request.arguments);
      this.requireParent(turn,input.speaker,input.parentId);
      const result = saveEvolveIdea(this.db,this.sources,turn,input,input.source,{selectedBy:"ai",runId:run.id,promptId,index:0});
      const nextId = this.sources.promptId?.() ?? `msg_${this.sources.id()}`;
      this.db.run("UPDATE run_steps SET state='processed',result_json=? WHERE run_id=? AND prompt_id=?",
        [protocolJson({receipt:result}),run.id,promptId]);
      this.db.run(`INSERT INTO run_steps(run_id,position,prompt_id,input,state,native_state) VALUES (?,?,?,?,'prepared','unknown')`,
        [run.id,step.position+1,nextId,successor(result)]);
      this.db.run("UPDATE runs SET status='queued' WHERE id=?",[run.id]);
      return {completed:false,saves:1};
    });
  }
  private requireParent(turn: EvolveTurnRow, speaker: EvolveSave["speaker"], id: string): void {
    if (id !== turn.parent_id && !(speaker === "ai" && this.db.query(`SELECT 1 FROM evolve_saves
      WHERE turn_id=? AND thought_id=CAST(? AS TEXT) AND speaker='user' AND selected_by='ai'`).get(turn.id,evolveUtf8(id)))) {
      throw new RunConflictError("Ideas-only save parent is outside the turn");
    }
    if (!evolveThoughtEligible(this.db,id)) throw new RunFenceError("Ideas-only save parent unavailable");
  }
  private publish(run: RunRecord, turn: EvolveTurnRow, step: RunStep, envelope: Extract<NonNullable<RunStep["envelope"]>,{kind:"ideas-reply"}>) {
    const confirmed: EvolveSave[] = [];
    for (const [index,selection] of envelope.selections.entries()) {
      const earlier = selection.parentSelection === undefined ? undefined : confirmed[selection.parentSelection];
      if (selection.parentSelection !== undefined && earlier?.speaker !== "user") throw new RunConflictError("AI development must target an earlier user selection");
      const parentId = earlier?.thoughtId ?? turn.parent_id;
      this.requireParent(turn,selection.speaker,parentId);
      const {speaker,text,source,sourceTurnId} = selection;
      confirmed.push(saveEvolveIdea(this.db,this.sources,turn,{speaker,text,parentId,
        ...(sourceTurnId === undefined ? {} : {sourceTurnId})},source,
        {selectedBy:"ai",runId:run.id,promptId:step.promptId,index},envelope.reply));
    }
    this.db.run("UPDATE evolve_turns SET reply=CAST(? AS TEXT) WHERE id=?",[evolveUtf8(envelope.reply),turn.id]);
    this.db.run("UPDATE runs SET status='completed',generation=generation+1,cancellation_state='none' WHERE id=?",[run.id]);
    return {completed:true,saves:confirmed.length};
  }
}
