import { startDaemon } from "../src/daemon/runtime";

const dbPath = process.argv[2];
if (!dbPath) throw new Error("owned database path required");
try {
  const daemon = await startDaemon({ dbPath, port: 0, credentials: { user: "user-0123456789-0123456789-abcdef", ai: "agent-0123456789-0123456789-abcdef" } }, () => {}, { logSink: () => {} });
  console.log(JSON.stringify({ type: "ready", url: daemon.url }));
  await new Promise<void>(resolve => { process.stdin.once("end", resolve); process.stdin.resume(); });
  await daemon.stop();
  console.log(JSON.stringify({ type: "stopped" }));
} catch (error) {
  const held = error instanceof Error && error.message === "Daemon startup failed: execution owner already held";
  console.log(JSON.stringify(held ? { type: "rejected", reason: "execution-owner-held" } : { type: "startup-error" }));
  process.exitCode = 1;
}
