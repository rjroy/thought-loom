import type { Database } from "bun:sqlite";
import { createLogger, type Logger } from "../logging";
import type { RunSources } from "../domain/run";
import { SqliteMarkdownImports } from "../storage/markdown-import";
import { MarkdownImportWorker, importBusy, importTurn } from "./import-worker";

export interface LocalImportDependencies extends RunSources {
  readonly db: Database;
  readonly startTimer: (poll: () => void) => () => void;
  readonly worker?: MarkdownImportWorker;
}
const filesPerPoll = 4;
const waitersPerPoll = 50;

/** Bounded fair scheduling and waiter settlement. Without an injected configured worker, all processing is local. */
export class LocalMarkdownImportDriver {
  private readonly imports: SqliteMarkdownImports;
  private readonly logger: Logger;
  private readonly worker: MarkdownImportWorker;
  private readonly flights = new Map<string,Promise<void>>();
  private after = 0;
  private through: number | null = null;
  private paused = false;
  private cancelTimer: (() => void) | undefined;
  private flight: Promise<void> | undefined;
  private stopping: Promise<void> | undefined;
  constructor(dependencies: LocalImportDependencies) {
    this.imports=new SqliteMarkdownImports(dependencies.db,dependencies);
    this.logger=dependencies.logger ?? createLogger();
    this.worker=dependencies.worker ?? new MarkdownImportWorker(dependencies);
    this.startTimer=dependencies.startTimer;
  }
  private readonly startTimer: LocalImportDependencies["startTimer"];
  start(): void {
    if (this.paused || this.cancelTimer) return;
    this.cancelTimer=this.startTimer(() => {
      void this.poll().catch(error => {
        if (importBusy(error)) this.logger.warning("[import driver] local scan busy");
        else this.logger.error("[import driver] local scan failed");
      });
    });
  }
  poll(): Promise<void> {
    if (this.paused) return Promise.resolve();
    if (this.flight) return this.flight;
    const flight=Promise.resolve().then(() => this.scan()).finally(() => { this.flight=undefined; });
    this.flight=flight;
    return flight;
  }
  private async scan(): Promise<void> {
    if (this.paused) return;
    this.logger.verbose("[import driver] local poll attempt");
    this.imports.settleLocalCancellations(filesPerPoll);
    this.imports.resolveWaiters(waitersPerPoll);
    const available=filesPerPoll-this.flights.size;
    if (available===0) return;
    const page=this.worker.candidates(this.after,this.through,available);
    this.through=page.through;
    for (const work of page.items) {
      await importTurn();
      if (this.paused) return;
      this.after=work.position;
      if (this.flights.has(work.runId)) continue;
      const task=Promise.resolve().then(() => this.worker.tick(work)).catch(() => {
        this.logger.error("[import driver] file processing deferred",{runId:work.runId});
      }).finally(() => { this.flights.delete(work.runId); });
      this.flights.set(work.runId,task);
    }
    if (page.items.length<available || this.after>=page.through) { this.after=0; this.through=null; }
    if (this.paused) return;
    this.imports.resolveWaiters(waitersPerPoll);
    this.imports.settleLocalCancellations(filesPerPoll);
    this.logger.verbose("[import driver] local poll succeeded",{files:page.items.length});
  }
  /** Stop local callbacks before draining; never turn daemon shutdown into user Stop. */
  async drain(): Promise<readonly PromiseSettledResult<void>[]> {
    if (!this.paused) throw new Error("Local import drain requires pause");
    const scan = await Promise.allSettled(this.flight ? [this.flight] : []);
    const files = await Promise.allSettled([...this.flights.values()]);
    return [...scan,...files];
  }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.paused=true;
    this.worker.pause();
    this.stopping=(async () => {
      let failed=false;
      try { this.cancelTimer?.(); } catch { failed=true; }
      const results=await this.drain();
      if (results.some(result => result.status==="rejected")) failed=true;
      if (failed) throw new Error("Local import shutdown failed");
    })();
    return this.stopping;
  }
}
