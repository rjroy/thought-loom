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
    const create = async (role: "user" | "ai", parentId: string | null, text: string, sourceIds?: string[]): Promise<string> => {
      const path = parentId === null ? "/thoughts" : `/thoughts/${encodeURIComponent(parentId)}/${role === "ai" ? "developments" : "contributions"}`;
      const value = object(await request(role, "POST", path, 201, { text, ...(sourceIds ? { sourceIds } : {}) }));
      if (typeof value.id !== "string" || !value.id || value.parentId !== parentId || value.author !== role || value.text !== text) throw new Error("Unexpected created thought");
      return value.id;
    };
    const original = await create("user", null, "A captured original idea");
    deps.stdout("Original captured.");
    const contribution = await create("user", original, "A user contribution");
    deps.stdout("User contribution added.");
    const development = await create("ai", contribution, "A simulated AI development", [original, contribution]);
    deps.stdout("Simulated AI development added.");
    await create("user", development, "A later user continuation");
    const sibling = await create("user", original, "A sibling thought");
    deps.stdout("Later continuation and sibling added.");
    const link = object(await request("user", "POST", "/connections", 201, {
      fromId: development, toId: sibling, category: "related", explanation: "A separate conceptual connection", sourceIds: [],
    }));
    if (typeof link.id !== "string" || !link.id || link.fromId !== development || link.toId !== sibling) throw new Error("Unexpected connection");
    const linkId = encodeURIComponent(link.id);
    const rootPath = `/thoughts/${encodeURIComponent(original)}`;
    const contributionPath = `/thoughts/${encodeURIComponent(contribution)}`;
    const developmentPath = `/thoughts/${encodeURIComponent(development)}`;
    deps.stdout("Separate connection created.");
    await request("user", "POST", `/connections/${linkId}/reject`, 204);
    await request("user", "POST", `${rootPath}/reject`, 204);
    await request("ai", "GET", rootPath, 404);
    const child = object(await request("ai", "GET", contributionPath, 200));
    if (child.id !== contribution || child.parentId !== null || !Array.isArray(child.sourceIds) || child.sourceIds.includes(original)) throw new Error("Child redaction failed");
    deps.stdout("Single reject hides the original; its active child remains usable with redacted provenance.");
    const history = await request("user", "GET", "/thoughts?scope=history", 200);
    if (!Array.isArray(history) || !history.some(item => object(item).id === original)) throw new Error("History inspection failed");
    const preview = object(await request("user", "GET", `${rootPath}/branch/preview`, 200));
    if (preview.rootId !== original || !Array.isArray(preview.branchIds) || !preview.branchIds.includes(development) || !Array.isArray(preview.affectedIds) || !preview.affectedIds.includes(development)) throw new Error("Unexpected branch preview");
    deps.stdout("Branch preview received.");
    await request("user", "POST", `${rootPath}/branch/reject`, 204, preview);
    await request("ai", "GET", developmentPath, 404);
    deps.stdout("Branch reject confirmed.");
    await request("user", "POST", `${developmentPath}/branch/restore`, 204);
    const restored = object(await request("ai", "GET", developmentPath, 200));
    if (restored.id !== development) throw new Error("Subtree restore failed");
    await request("ai", "GET", rootPath, 404);
    await request("ai", "GET", `/connections/${linkId}`, 404);
    const connectionHistory = object(await request("user", "GET", `/connections/${linkId}?scope=history`, 200));
    if (connectionHistory.id !== link.id) throw new Error("Connection history failed");
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
