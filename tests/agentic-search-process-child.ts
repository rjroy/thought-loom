import { startDaemon } from "../src/daemon/runtime";

const path = process.argv[2];
if (!path) throw new Error("owned database path required");
const credentials = { user: "owned-user-012345678901234567890123456789", ai: "owned-agent-01234567890123456789012345678" };
const daemon = await startDaemon({ dbPath: path, port: 0, credentials }, () => {}, {
  startTimer: () => () => {}, logSink: () => {},
  resolveAgentService: async () => { throw new Error("unexpected owned resolver"); },
  createPublicClient: () => { throw new Error("unexpected owned client"); },
});
try {
  console.log(JSON.stringify({ type: "ready", url: daemon.url }));
  await new Response(Bun.stdin.stream()).text();
} finally { await daemon.stop(); }
