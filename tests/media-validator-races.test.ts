import { describe, expect, test } from "bun:test";
import { readSync } from "node:fs";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogger, type LogRecord } from "../src/logging";
import { createMediaValidator, type MediaValidatorLaunchRequest, type MediaValidatorOptions } from "../src/storage/media-validator";

const worker = join(import.meta.dir,"fixtures/media-validator-race-child.ts");
const byteLength = 128 * 1024;
const content = () => new Uint8Array(byteLength).fill(0x31);
const signalInput = (fd: number, signal: AbortSignal) => ({fd,byteLength,signal});

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>(done => { resolve = done; });
  return {promise,resolve};
}
async function bounded<T>(promise: Promise<T>, ms = 3000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise,new Promise<never>((_,reject) => {
      timer = setTimeout(() => reject(new Error("Owned test operation timed out")),ms);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
async function remainsPending(promise: Promise<unknown>): Promise<boolean> {
  return Promise.race([promise.then(() => false,() => false),Bun.sleep(100).then(() => true)]);
}
function options(records: LogRecord[], launch: NonNullable<MediaValidatorOptions["launch"]>): MediaValidatorOptions {
  return {
    raster:{maxBytes:byteLength,maxDimension:8,maxTotalPixels:64,maxFrames:4},
    pdf:{maxBytes:byteLength,maxPages:4,maxObjects:1024,maxDepth:64},
    process:{dataBytes:1024*1024*1024,cpuSeconds:2,wallMs:6000,outputBytes:8192},
    logger:createLogger("verbose",record => records.push(record)),launch,
  };
}
async function withStage(action: (fd: number, path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp("/tmp/opencode/media-validator-races-"), path = join(dir,"stage");
  try {
    await writeFile(path,content());
    const file = await open(path,"r");
    try { await action(file.fd,path); } finally { await file.close(); }
  } finally { await rm(dir,{recursive:true,force:true}); }
}
function spawnFixture(request: MediaValidatorLaunchRequest, mode: string) {
  const index = request.cmd.indexOf("--no-env-file");
  if (index < 0 || request.cmd[0] !== "/usr/bin/prlimit") throw new Error("Missing bounded child launcher");
  return Bun.spawn({cmd:[...request.cmd.slice(0,index+1),worker,mode],env:{...request.env},
    stdin:"pipe",stdout:"pipe",stderr:"pipe"});
}
type Child = ReturnType<typeof spawnFixture>;

/** Gate only this child's first stdin flush; never patch Bun or file handles globally. */
function holdFirstFlush(child: Child, entered: ReturnType<typeof deferred>, release: ReturnType<typeof deferred>): Child {
  let first = true;
  const stdin = new Proxy(child.stdin,{get(target,key) {
    if (key === "flush") return () => {
      if (!first) return target.flush();
      first = false;
      const result = target.flush();
      entered.resolve();
      return (async () => { try { return await result; } finally { await release.promise; } })();
    };
    const value = Reflect.get(target,key,target);
    return typeof value === "function" ? value.bind(target) : value;
  }});
  return new Proxy(child,{get(target,key) {
    if (key === "stdin") return stdin;
    const value = Reflect.get(target,key,target);
    return typeof value === "function" ? value.bind(target) : value;
  }});
}

/** Delay collection after native EOF, not the child or its exit. */
function holdEof(child: Child, channel: "stdout" | "stderr", entered: ReturnType<typeof deferred>, release: ReturnType<typeof deferred>): Child {
  const reader = child[channel].getReader();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const result = await reader.read();
      if (!result.done) { controller.enqueue(result.value); return; }
      entered.resolve();
      await release.promise;
      reader.releaseLock();
      controller.close();
    },
    async cancel() { await reader.cancel(); reader.releaseLock(); },
  });
  return new Proxy(child,{get(target,key) {
    if (key === channel) return stream;
    const value = Reflect.get(target,key,target);
    return typeof value === "function" ? value.bind(target) : value;
  }});
}

function borrowedStillOpen(fd: number): void {
  expect(readSync(fd,Buffer.alloc(1),0,1,0)).toBe(1);
}

describe("media validator owned-lane races", () => {
  test("refuses a same-size staged mutation after the first chunk has entered the feed", async () => {
    await withStage(async (fd,path) => {
      const entered = deferred(), release = deferred(), records: LogRecord[] = [], controller = new AbortController();
      const validator = createMediaValidator(options(records,request => holdFirstFlush(spawnFixture(request,"read"),entered,release)));
      const result = validator.validate(signalInput(fd,controller.signal)).then(() => "accepted",() => "rejected");
      try {
        await bounded(entered.promise);
        const writer = await open(path,"r+");
        try { await writer.write(Uint8Array.of(0x42),0,1,byteLength-1); await writer.sync(); } finally { await writer.close(); }
        release.resolve();
        expect(await bounded(result)).toBe("rejected");
        const witness = Buffer.alloc(1);
        expect(readSync(fd,witness,0,1,byteLength-1)).toBe(1);
        expect(witness[0]).toBe(0x42);
        borrowedStillOpen(fd);
      } finally { release.resolve(); controller.abort(); await bounded(validator.close()); await bounded(result); }
    });
  },10000);

  test("abort during pumping kills the child but does not finish until the entered pump joins", async () => {
    await withStage(async fd => {
      const entered = deferred(), release = deferred(), records: LogRecord[] = [], controller = new AbortController();
      let exited: Promise<number> | undefined;
      const validator = createMediaValidator(options(records,request => {
        const child = spawnFixture(request,"read"); exited = child.exited;
        return holdFirstFlush(child,entered,release);
      }));
      const result = validator.validate(signalInput(fd,controller.signal)).then(() => "accepted",() => "rejected");
      try {
        await bounded(entered.promise);
        controller.abort();
        if (!exited) throw new Error("Child did not start");
        await bounded(exited);
        expect(await remainsPending(result)).toBe(true);
        release.resolve();
        expect(await bounded(result)).toBe("rejected");
        borrowedStillOpen(fd);
      } finally { release.resolve(); controller.abort(); await bounded(validator.close()); await bounded(result); }
    });
  },10000);

  test("normalizes early child exit and broken stdin, joins the pump, and permits the next validation", async () => {
    await withStage(async (fd,path) => {
      const entered = deferred(), release = deferred(), records: LogRecord[] = [], controller = new AbortController();
      let launches = 0, exited: Promise<number> | undefined;
      const validator = createMediaValidator(options(records,request => {
        launches++;
        const child = spawnFixture(request,launches === 1 ? "early-exit" : "read");
        if (launches !== 1) return child;
        exited = child.exited;
        return holdFirstFlush(child,entered,release);
      }));
      const result = validator.validate(signalInput(fd,controller.signal)).then(() => "accepted",error => String(error));
      try {
        await bounded(entered.promise);
        if (!exited) throw new Error("Child did not start");
        expect(await bounded(exited)).not.toBe(0);
        expect(await remainsPending(result)).toBe(true);
        release.resolve();
        const message = await bounded(result);
        expect(message).not.toBe("accepted");
        expect(`${message} ${JSON.stringify(records)}`).not.toContain("private-sentinel");
        expect(`${message} ${JSON.stringify(records)}`).not.toContain(path);
        await expect(bounded(validator.validate(signalInput(fd,controller.signal)))).resolves.toEqual({mimeType:"image/png"});
        expect(launches).toBe(2);
        borrowedStillOpen(fd);
      } finally { release.resolve(); controller.abort(); await bounded(validator.close()); await bounded(result); }
    });
  },10000);

  for (const channel of ["stdout","stderr"] as const) {
    test(`holds the lane until delayed ${channel} EOF collection completes after child exit`, async () => {
      await withStage(async fd => {
        const entered = deferred(), release = deferred(), records: LogRecord[] = [], controller = new AbortController();
        let launches = 0, exited: Promise<number> | undefined;
        const validator = createMediaValidator(options(records,request => {
          launches++;
          const child = spawnFixture(request,"read");
          if (launches !== 1) return child;
          exited = child.exited;
          return holdEof(child,channel,entered,release);
        }));
        const first = validator.validate(signalInput(fd,controller.signal));
        // Attach rejection handlers immediately even if an earlier assertion fails.
        const settledFirst = first.then(() => {},() => {});
        let settledSecond: Promise<void> = Promise.resolve();
        try {
          await bounded(entered.promise);
          if (!exited) throw new Error("Child did not start");
          expect(await bounded(exited)).toBe(0);
          const second = validator.validate(signalInput(fd,controller.signal));
          settledSecond = second.then(() => {},() => {});
          expect(await remainsPending(first)).toBe(true);
          expect(await remainsPending(second)).toBe(true);
          expect(launches).toBe(1);
          release.resolve();
          await expect(bounded(first)).resolves.toEqual({mimeType:"image/png"});
          await expect(bounded(second)).resolves.toEqual({mimeType:"image/png"});
          expect(launches).toBe(2);
          borrowedStillOpen(fd);
        } finally {
          release.resolve(); controller.abort(); await bounded(validator.close());
          await bounded(Promise.all([settledFirst,settledSecond]));
        }
      });
    },10000);
  }
});
