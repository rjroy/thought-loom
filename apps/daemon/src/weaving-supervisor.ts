import type { WeavingWorker } from "./weaving";
import { setTimeout as delay } from "node:timers/promises";
import type { WeavingWorkerState } from "@thoughtloom/contracts";

export type SupervisorState = WeavingWorkerState;

export class WeavingSupervisor {
  private readonly controller = new AbortController();
  private task: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private state: SupervisorState = "starting";
  private readonly wait: (signal: AbortSignal) => Promise<void>;

  constructor(private readonly options: {
    worker: Pick<WeavingWorker, "startNext" | "recover"> & Partial<Pick<WeavingWorker, "close">>;
    wait?: (signal: AbortSignal) => Promise<void>; pollMs?: number;
  }) {
    const pollMs = options.pollMs ?? 1_000;
    if (!Number.isSafeInteger(pollMs) || pollMs < 10 || pollMs > 60_000) throw new Error("Invalid supervisor polling interval");
    this.wait = options.wait ?? (async (signal) => { await delay(pollMs, undefined, { signal }); });
  }
  get status(): SupervisorState { return this.state; }

  async start(): Promise<void> {
    if (this.controller.signal.aborted) throw new Error("Supervisor is closed");
    if (!this.task) this.task = this.loop();
  }
  private async loop(): Promise<void> {
    const signal = this.controller.signal;
    try {
      while (!signal.aborted) {
        this.state = "working";
        try {
          await this.options.worker.recover();
          if (signal.aborted) break;
          const result = await this.options.worker.startNext();
          this.state = result.kind === "unavailable" ? "unavailable" : "waiting";
          console.info("weaving.supervisor tick", { outcome: result.kind });
        } catch {
          this.state = "failed";
          console.error("weaving.supervisor tick failed", { category: "worker_unavailable" });
        }
        if (signal.aborted) break;
        try { await this.wait(signal); }
        catch { if (!signal.aborted) { this.state = "failed"; break; } }
      }
    } finally { this.state = "stopped"; }
  }
  close(): Promise<void> {
    return this.closing ??= (async () => {
      this.controller.abort();
      try { await this.options.worker.close?.(); } finally { await this.task; this.state = "stopped"; }
    })();
  }
}
