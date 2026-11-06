import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

async function coldImport(module: string, exported: string): Promise<void> {
  const home = await mkdtemp(join("/tmp/opencode", "storage-entrypoint-"));
  const script = `import { ${exported} } from ${JSON.stringify(module)};
    if (typeof ${exported} !== "function") throw new Error("expected usable exported constructor/function");
    console.log("storage-entrypoint-ready");`;
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", script], {
    cwd: root, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const output = Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const [status, stdout, stderr] = await Promise.race([output, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`cold import ${module} timed out`)), 5000);
    })]);
    if (status !== 0) throw new Error(`cold import ${module} exited ${status}\n${stderr}`);
    expect(stdout.trim()).toBe("storage-entrypoint-ready");
    expect(stderr).toBe("");
  } finally {
    if (timer) clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await output;
    await rm(home, { recursive: true, force: true });
  }
}

for (const [module, exported] of [
  ["./src/storage/run-aggregate.ts", "SqliteRunAggregate"],
  ["./src/storage/run.ts", "SqliteRunRepository"],
  ["./src/storage/sqlite.ts", "SqliteStore"],
  ["./src/storage/search-sessions.ts", "SqliteSearchSessions"],
] as const) {
  test(`cold Bun import initializes ${exported}`, async () => coldImport(module, exported));
}
