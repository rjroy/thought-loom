import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { initialWorkerPrompt, capabilityResultPrompt } from "../../src/agent/worker-prompts";
import type { CapabilityRequest } from "../../src/domain/capability";
import type { DailyReviewPolicy } from "../../src/domain/daily-review";
import { RejectionService } from "../../src/domain/rejection";
import type { Claim, RunRecord } from "../../src/domain/run";
import { TitleService } from "../../src/domain/title";
import { createLogger } from "../../src/logging";
import { SqliteCapabilityDispatcher } from "../../src/storage/capability";
import { SqliteDailyReviews } from "../../src/storage/daily-review";
import { SqliteRejectionRepository } from "../../src/storage/rejection";
import { SqliteRunOperations } from "../../src/storage/run-operations";
import { SqliteRunProtocolRepository } from "../../src/storage/run-protocol";
import { SqliteRunWorkerState } from "../../src/storage/run-worker";
import { SqliteRunRepository } from "../../src/storage/run";
import { migrate, SqliteStore } from "../../src/storage/sqlite";
import { SqliteTitleRepository } from "../../src/storage/title";

export const reviewComplete = {version:1,kind:"review-complete",titleCheck:"complete",connectionCheck:"complete"} as const;
export const reviewPolicy = {rotationDays:4,maxPerDay:3} satisfies DailyReviewPolicy;
export function dailyReviewSetup(db: Database, policy = reviewPolicy) {
  let sequence = 0;
  const clock = {now:"2031-01-01T12:00:00.000Z"};
  const sources = {id:() => `daily-owned-${++sequence}`,now:() => clock.now,logger:createLogger("error",() => {})};
  const store = new SqliteStore(db), runs = new SqliteRunRepository(db,sources), ops = new SqliteRunOperations(db,sources);
  const steps = new SqliteRunProtocolRepository(db,sources.logger), state = new SqliteRunWorkerState(db,sources);
  const capabilities = new SqliteCapabilityDispatcher(db,sources);
  const reviews = new SqliteDailyReviews(db,sources,policy);
  const rejection = new RejectionService(new SqliteRejectionRepository(db,sources.logger));
  const titles = new TitleService(new SqliteTitleRepository(db,sources));
  function seed(id: string, createdAt = "2030-01-01T00:00:00.000Z") {
    store.saveThought({id,text:`Owned thinking ${id}`,title:null,titleAuthor:null,author:"user",kind:"captured-original",origin:"fixture",createdAt,parentId:null,sourceIds:[]});
  }
  function run(id: string): RunRecord {
    const value = runs.get(id); if (!value) throw new Error("Expected owned review run"); return value;
  }
  function admit(now = clock.now, configured = true) { clock.now = now; return reviews.admitDueBatch(now,configured); }
  function prepare(runId: string): Claim {
    const claim = runs.claim(runId); state.prepareInitial(claim,initialWorkerPrompt); return claim;
  }
  function invoke(claim: Claim, request: CapabilityRequest) {
    const current = run(claim.runId);
    steps.completeStep(claim,current.promptId,{version:1,kind:"request",request});
    const result = capabilities.dispatch(claim,current.promptId,request);
    steps.advance(claim,current.promptId,result,{promptId:sources.id(),input:capabilityResultPrompt(request,result,"weave",undefined,[],"daily-review")});
    return result;
  }
  function complete(claim: Claim) {
    const current = run(claim.runId);
    steps.completeStep(claim,current.promptId,reviewComplete); state.finish(claim,current.promptId);
  }
  return {db,sources,clock,store,runs,ops,steps,state,capabilities,reviews,rejection,titles,seed,run,admit,prepare,invoke,complete};
}
export type DailyReviewFixture = ReturnType<typeof dailyReviewSetup> & {readonly dir:string;readonly path:string;readonly media:string};
export async function dailyReviewFixture(action: (fixture: DailyReviewFixture) => Promise<void> | void, policy = reviewPolicy): Promise<void> {
  const dir = mkdtempSync("/tmp/opencode/daily-review-"), path = join(dir,"owned.sqlite"), media = `${path}.media`;
  const db = new Database(path);
  try {
    chmodSync(path,0o600); mkdirSync(media,{mode:0o700}); db.exec("PRAGMA journal_mode=WAL"); migrate(db,createLogger("error",() => {}));
    await action({...dailyReviewSetup(db,policy),dir,path,media});
  } finally { db.close(); rmSync(dir,{recursive:true,force:true}); }
}
