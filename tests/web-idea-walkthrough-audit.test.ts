import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { connectionRejectCount, ideaDaemon } from "../apps/web/tests/idea.runtime";

test("Idea walkthrough counts only its own connection rejections without clearing the audit", async () => {
  const token = "owned-idea-test-token";
  const daemon = ideaDaemon(token);
  const server = createServer((request, response) => { void daemon.handler(request, response); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("owned fixture has no TCP address");
    const reject = async () => {
      const response = await fetch(`http://127.0.0.1:${address.port}/connections/idea-child-edge/reject`, {
        method: "POST", headers: { authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(204);
    };

    await reject(); // An earlier walkthrough against the same daemon.
    daemon.reset();
    const start = daemon.attempts.length;
    await reject();
    expect(daemon.attempts).toHaveLength(2);
    expect(connectionRejectCount(daemon, start)).toBe(1);
    await reject();
    expect(connectionRejectCount(daemon, start)).toBe(2); // Duplicate writes still fail a one-write assertion.
    expect(daemon.attempts).toHaveLength(3);
  } finally {
    server.close();
    await once(server, "close");
  }
});
