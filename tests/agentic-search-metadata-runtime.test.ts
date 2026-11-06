import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { startDaemon } from "../src/daemon/runtime";

test("configless owned daemon serves metadata through its real loopback listener", async () => {
  const dir = await mkdtemp(join("/tmp/opencode", "search-metadata-runtime-"));
  const user = "owned-user-012345678901234567890123456789";
  const ai = "owned-agent-01234567890123456789012345678";
  let nativeCalls = 0;
  try {
    const daemon = await startDaemon({ dbPath: join(dir, "owned.sqlite"), port: 0, credentials: { user, ai } }, () => {}, {
      resolveAgentService: async () => { nativeCalls++; throw new Error("unexpected resolver"); },
      createPublicClient: () => { nativeCalls++; throw new Error("unexpected client"); },
    });
    try {
      const request = (path: string, method = "GET", body?: string, headers: Record<string, string> = {}) => fetch(new URL(path, daemon.url), {
        method, headers: { authorization: `Bearer ${user}`, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
        body, signal: AbortSignal.timeout(3000),
      });
      const created = await request("/search-sessions", "POST", "{}", { "idempotency-key": "runtime-key" });
      expect(created.status).toBe(201);
      const { session } = await created.json() as { session: { id: string; revision: number } };
      expect((await request("/search-sessions")).status).toBe(200);
      expect((await request(`/search-sessions/${session.id}`)).status).toBe(200);
      const renamed = await request(`/search-sessions/${session.id}`, "PATCH", '{"title":"Runtime title"}', { "if-match": String(session.revision) });
      expect(renamed.status).toBe(200);
      expect((await request(`/search-sessions/${session.id}`, "DELETE")).status).toBe(204);
      expect((await request(`/search-sessions/${session.id}`)).status).toBe(404);
      expect(nativeCalls).toBe(0);
    } finally { await daemon.stop(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
