import { startDaemon, type RunningDaemon } from "../src/daemon/runtime";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { bounded, requestJson } from "./api";
import type { HttpFetch } from "./api";

export interface DemoDependencies {
  readonly tempRoot: string;
  readonly start: typeof startDaemon;
  readonly fetch: HttpFetch;
  readonly stdout: (message: string) => void;
  readonly stderr: (message: string) => void;
  readonly timeoutMs: number;
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Unexpected response");
  return Object.fromEntries(Object.entries(value));
}

/** Owns a temporary daemon and its data; all domain operations use HTTP. */
export async function runDemo(deps: DemoDependencies): Promise<number> {
  let directory: string | undefined;
  let daemon: RunningDaemon | undefined;
  let failed = false;
  try {
    directory = await mkdtemp(join(deps.tempRoot, "thoughtloom-demo-"));
    const credentials = { user: randomBytes(32).toString("hex"), ai: randomBytes(32).toString("hex") };
    daemon = await deps.start({ dbPath: join(directory, "demo.sqlite"), port: 0, credentials }, () => {});
    const base = new URL(daemon.url);
    const request = async (role: "user" | "ai", method: string, path: string, expected: number, body?: unknown): Promise<unknown> => {
      const headers: Record<string, string> = { authorization: `Bearer ${credentials[role]}` };
      if (body !== undefined) headers["content-type"] = "application/json";
      const response = await requestJson(deps.fetch, new URL(path, base), {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      }, deps.timeoutMs);
      if (response.status !== expected) throw new Error("Unexpected HTTP status");
      return response.value;
    };
    const create = async (id: string, parentId: string | null, sourceIds: string[], role: "user" | "ai", text: string) => {
      const value = object(await request(role, "POST", "/thoughts", 201, {
        id, parentId, sourceIds, text, title: null, kind: "developing-idea", createdAt: new Date().toISOString(), origin: "demo",
      }));
      if (value.id !== id || value.parentId !== parentId || value.author !== role) throw new Error("Unexpected created thought");
    };
    await create("original", null, [], "user", "A captured original idea");
    deps.stdout("Original captured.");
    await create("contribution", "original", ["original"], "user", "A user contribution");
    deps.stdout("User contribution added.");
    await create("development", "contribution", ["contribution"], "ai", "A simulated AI development");
    deps.stdout("Simulated AI development added.");
    await create("continuation", "development", ["development"], "user", "A later user continuation");
    await create("sibling", "original", [], "user", "A sibling thought");
    deps.stdout("Later continuation and sibling added.");
    const link = object(await request("user", "POST", "/connections", 201, {
      id: "connection", fromId: "development", toId: "sibling", category: "related", explanation: "A separate conceptual connection", sourceIds: [],
    }));
    if (link.id !== "connection") throw new Error("Unexpected connection");
    deps.stdout("Separate connection created.");
    await request("user", "POST", "/connections/connection/reject", 204);
    await request("user", "POST", "/thoughts/original/reject", 204);
    await request("ai", "GET", "/thoughts/original", 404);
    const child = object(await request("ai", "GET", "/thoughts/contribution", 200));
    if (child.id !== "contribution" || child.parentId !== null || !Array.isArray(child.sourceIds) || child.sourceIds.includes("original")) throw new Error("Child redaction failed");
    deps.stdout("Single reject hides the original; its active child remains usable with redacted provenance.");
    const history = await request("user", "GET", "/thoughts?scope=history", 200);
    if (!Array.isArray(history) || !history.some(item => object(item).id === "original")) throw new Error("History inspection failed");
    const preview = object(await request("user", "GET", "/thoughts/original/branch/preview", 200));
    if (preview.rootId !== "original" || !Array.isArray(preview.branchIds) || !preview.branchIds.includes("development") || !Array.isArray(preview.affectedIds) || !preview.affectedIds.includes("development")) throw new Error("Unexpected branch preview");
    deps.stdout("Branch preview received.");
    await request("user", "POST", "/thoughts/original/branch/reject", 204, preview);
    await request("ai", "GET", "/thoughts/development", 404);
    deps.stdout("Branch reject confirmed.");
    await request("user", "POST", "/thoughts/development/branch/restore", 204);
    const restored = object(await request("ai", "GET", "/thoughts/development", 200));
    if (restored.id !== "development") throw new Error("Subtree restore failed");
    await request("ai", "GET", "/thoughts/original", 404);
    await request("ai", "GET", "/connections/connection", 404);
    const connectionHistory = object(await request("user", "GET", "/connections/connection?scope=history", 200));
    if (connectionHistory.id !== "connection") throw new Error("Connection history failed");
    deps.stdout("Partial restore completed; the original and independently rejected connection remain hidden.");
  } catch {
    failed = true;
    deps.stderr("Demo failed; scenario or daemon request error.");
  } finally {
    if (daemon) {
      try { await bounded(daemon.stop(), deps.timeoutMs); }
      catch { failed = true; deps.stderr("Demo cleanup failed: daemon stop."); }
    }
    if (directory) {
      try { await rm(directory, { recursive: true, force: true }); }
      catch { failed = true; deps.stderr("Demo cleanup failed: temporary directory."); }
    }
  }
  return failed ? 1 : 0;
}

if (import.meta.main) {
  process.exitCode = await runDemo({ tempRoot: tmpdir(), start: startDaemon, fetch,
    stdout: message => console.log(message), stderr: message => console.error(message), timeoutMs: 5000 });
}
