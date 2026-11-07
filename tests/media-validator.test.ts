import { describe, expect, test } from "bun:test";
import { access, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogger, type LogRecord } from "../src/logging";
import { createMediaValidator, type MediaValidatorLaunchRequest, type MediaValidatorOptions } from "../src/storage/media-validator";
import { independentPng, rasterLimits } from "./fixtures/media-rasters";
import { classicPdf, pdfLimits } from "./fixtures/media-pdfs";

const child = join(import.meta.dir,"fixtures/media-validator-child.ts");
const secret = "private-sentinel-token";
const fixtureLimits = {dataBytes:1024*1024*1024,cpuSeconds:2,wallMs:4000,outputBytes:8192} as const;

function options(records: LogRecord[], overrides: Partial<MediaValidatorOptions> = {}): MediaValidatorOptions {
  return {
    raster:rasterLimits, pdf:pdfLimits, process:fixtureLimits,
    logger:createLogger("verbose",record => records.push(record)),
    ambientEnvironment:{PATH:"/usr/bin:/bin",MEDIA_VALIDATOR_TEST_SECRET:secret},
    ...overrides,
  };
}

async function withStage<T>(bytes: Uint8Array, action: (fd: number, dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp("/tmp/opencode/media-validator-test-");
  const path = join(dir,"stage");
  try {
    await writeFile(path,bytes);
    const file = await open(path,"r");
    try { return await action(file.fd,dir); } finally { await file.close(); }
  } finally { await rm(dir,{recursive:true,force:true}); }
}

function fixtureLauncher(mode: string, report: string, requests: MediaValidatorLaunchRequest[]): NonNullable<MediaValidatorOptions["launch"]> {
  return request => {
    requests.push(request);
    const bunFlag = request.cmd.indexOf("--no-env-file");
    if (bunFlag < 0) throw new Error("Supervisor did not disable Bun env-file loading");
    // Keep the supervisor's real prlimit and Bun arguments; substitute only the owned test entry.
    return Bun.spawn({cmd:[...request.cmd.slice(0,bunFlag+1),child,mode,report],
      env:{...request.env},stdin:"pipe",stdout:"pipe",stderr:"pipe"});
  };
}

const input = (fd: number, byteLength: number, signal = new AbortController().signal) => ({fd,byteLength,signal});
async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now()+2000;
  while (Date.now() < deadline) {
    try { await access(path); return; } catch { await Bun.sleep(10); }
  }
  throw new Error("Owned child did not report readiness");
}

describe("owned media validator supervisor", () => {
  test("accepts a fully decoded independent PNG through the bounded child", async () => {
    const bytes = independentPng(), records: LogRecord[] = [];
    await withStage(bytes,async fd => {
      const validator = createMediaValidator(options(records));
      try {
        await expect(validator.validate(input(fd,bytes.length))).resolves.toEqual({mimeType:"image/png"});
        // Validation borrows the descriptor and does not advance or close it.
        const fileBytes = Buffer.alloc(bytes.length);
        const {readSync} = await import("node:fs");
        expect(readSync(fd,fileBytes,0,fileBytes.length,0)).toBe(bytes.length);
        expect(new Uint8Array(fileBytes)).toEqual(new Uint8Array(bytes));
      } finally { await validator.close(); }
    });
  });

  test("accepts an independent classic PDF through the real child", async () => {
    const bytes = classicPdf(), records: LogRecord[] = [];
    await withStage(bytes,async fd => {
      const validator = createMediaValidator(options(records));
      try { await expect(validator.validate(input(fd,bytes.length))).resolves.toEqual({mimeType:"application/pdf"}); }
      finally { await validator.close(); }
    });
  });

  test("feeds exact staged bytes, applies inherited limits, and excludes ambient secrets", async () => {
    const bytes = independentPng(), records: LogRecord[] = [], requests: MediaValidatorLaunchRequest[] = [];
    await withStage(bytes,async (fd,dir) => {
      const report = join(dir,"report.json");
      const validator = createMediaValidator(options(records,{launch:fixtureLauncher("ok",report,requests)}));
      try {
        await expect(validator.validate(input(fd,bytes.length))).resolves.toEqual({mimeType:"image/png"});
        const observed: {input: string; limits: string; secret: string | null} = JSON.parse(await readFile(report,"utf8"));
        expect(observed.input).toBe(Buffer.from(bytes).toString("base64"));
        expect(observed.secret).toBeNull();
        expect(observed.limits).toMatch(/Max data size\s+1073741824\s+1073741824\s+bytes/);
        expect(observed.limits).toMatch(/Max cpu time\s+2\s+2\s+seconds/);
        expect(observed.limits).toMatch(/Max core file size\s+0\s+0\s+bytes/);
        expect(requests).toHaveLength(1);
        expect(requests[0]?.cmd[0]).toBe("/usr/bin/prlimit");
        expect(JSON.stringify(requests[0]?.env)).not.toContain(secret);
      } finally { await validator.close(); }
    });
  });

  test("refuses a mismatched announced byte count without accepting a prefix", async () => {
    const bytes = independentPng(), records: LogRecord[] = [];
    await withStage(bytes,async fd => {
      const validator = createMediaValidator(options(records));
      try {
        await expect(validator.validate(input(fd,bytes.length-1))).rejects.toThrow();
        await expect(validator.validate(input(fd,bytes.length+1))).rejects.toThrow();
      } finally { await validator.close(); }
    });
  });

  for (const mode of ["unknown","bad-mime","extra","truncated","nonzero","flood","crash","early-hang","cpu"] as const) {
    test(`rejects ${mode} worker outcome without exposing worker content`, async () => {
      const bytes = independentPng(), records: LogRecord[] = [], requests: MediaValidatorLaunchRequest[] = [];
      await withStage(bytes,async (fd,dir) => {
        const validator = createMediaValidator(options(records,{
          process:{...fixtureLimits,cpuSeconds:1,wallMs:mode === "cpu" ? 5000 : 1000,outputBytes:256},
          launch:fixtureLauncher(mode,join(dir,"report"),requests),
        }));
        try {
          let failure: unknown;
          try { await validator.validate(input(fd,bytes.length)); } catch (error) { failure = error; }
          expect(failure).toBeDefined();
          const exposed = `${String(failure)} ${JSON.stringify(records)}`;
          expect(exposed).not.toContain("private-sentinel");
          expect(exposed).not.toContain(dir);
          expect(exposed).not.toContain(secret);
          expect(requests).toHaveLength(1);
        } finally { await validator.close(); }
      });
    }, 10000);
  }

  test("a pre-aborted request and a closed validator cannot start a child", async () => {
    const bytes = independentPng(), records: LogRecord[] = [], requests: MediaValidatorLaunchRequest[] = [];
    await withStage(bytes,async (fd,dir) => {
      const validator = createMediaValidator(options(records,{launch:fixtureLauncher("ok",join(dir,"report"),requests)}));
      const controller = new AbortController(); controller.abort();
      try {
        await expect(validator.validate(input(fd,bytes.length,controller.signal))).rejects.toThrow();
        await validator.close();
        await validator.close();
        await expect(validator.validate(input(fd,bytes.length))).rejects.toThrow();
        expect(requests).toHaveLength(0);
      } finally { await validator.close(); }
    });
  });

  test("queued cancellation never starts a second child and close cancels and joins the held lane", async () => {
    const bytes = independentPng(), records: LogRecord[] = [], requests: MediaValidatorLaunchRequest[] = [];
    await withStage(bytes,async (fd,dir) => {
      const report = join(dir,"ready"), validator = createMediaValidator(options(records,{
        process:{...fixtureLimits,wallMs:10000},launch:fixtureLauncher("hold",report,requests),
      }));
      const active = validator.validate(input(fd,bytes.length)).then(() => "success",() => "rejected");
      try {
        await waitForFile(report);
        const controller = new AbortController();
        const queued = validator.validate(input(fd,bytes.length,controller.signal)).then(() => "success",() => "rejected");
        controller.abort();
        expect(await queued).toBe("rejected");
        expect(requests).toHaveLength(1);
        await validator.close();
        expect(await active).toBe("rejected");
        await expect(validator.validate(input(fd,bytes.length))).rejects.toThrow();
        expect(requests).toHaveLength(1);
      } finally { await validator.close(); }
    });
  },15000);
});
