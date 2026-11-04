import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { startDaemon, type RunningDaemon } from "../src/daemon/runtime";

const user = "test-user-token-0123456789-abcdef012345";
const ai = "test-agent-token-0123456789-abcdef01234";
async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([promise, Bun.sleep(3000).then(() => { throw new Error(`${label} timed out`); })]);
}
async function command(daemon: RunningDaemon, path: string, method: string, body: unknown) {
  const response = await fetch(new URL(path, daemon.url), { method, headers: { authorization: `Bearer ${user}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(1500) });
  return { status: response.status, data: await bounded(response.json(), "HTTP body") as unknown };
}

test("unconfigured daemon captures and clears titles over HTTP while durable weave jobs stay queued", async () => {
  const dir = await mkdtemp(join("/tmp/opencode", "supervisor-runtime-"));
  const path = join(dir, "owned.sqlite");
  let daemon: RunningDaemon | undefined;
  try {
    daemon = await bounded(startDaemon({ port: 0, dbPath: path, credentials: { user, ai } }, () => {}), "daemon start");
    const captured = await command(daemon, "/thoughts", "POST", { text: "offline capture", title: "temporary title" });
    expect(captured.status).toBe(201);
    if (typeof captured.data !== "object" || captured.data === null || !("id" in captured.data) || typeof captured.data.id !== "string") throw new Error("Expected created thought identity");
    const id = captured.data.id;
    const cleared = await command(daemon, `/thoughts/${encodeURIComponent(id)}/title`, "PUT", { title: null });
    expect(cleared.status).toBe(200);
    expect(cleared.data).toMatchObject({ id, title: null, titleAuthor: null });
    await bounded(daemon.stop(), "daemon stop");
    daemon = undefined;
    const db = new Database(path, { readonly: true });
    try {
      const jobs = db.query("SELECT status,weave_subject_id AS subjectId,weave_trigger_id AS triggerId FROM runs WHERE kind='weave' ORDER BY rowid").all() as { status: string; subjectId: string; triggerId: string }[];
      expect(jobs).toHaveLength(2);
      expect(jobs.map(job => ({ status: job.status, subjectId: job.subjectId }))).toEqual([{ status: "queued", subjectId: id }, { status: "queued", subjectId: id }]);
      expect(jobs[0]?.triggerId).not.toBe(jobs[1]?.triggerId);
      expect(db.query("SELECT COUNT(*) AS n FROM agent_bindings").get()).toEqual({ n: 0 });
    } finally { db.close(); }
  } finally {
    try { if (daemon) await bounded(daemon.stop(), "daemon cleanup"); }
    finally { await rm(dir, { recursive: true, force: true }); }
  }
}, 10000);
