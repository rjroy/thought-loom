import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { createApp } from "./app";
import { findSource } from "./storage";

const databasePath = process.env.THOUGHTLOOM_DATABASE_PATH;
const port = Number(process.env.THOUGHTLOOM_DAEMON_PORT ?? "3001");
if (!databasePath || !isAbsolute(databasePath)) {
  throw new Error("THOUGHTLOOM_DATABASE_PATH must name an absolute SQLite path");
}
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error("THOUGHTLOOM_DAEMON_PORT must be between 1024 and 65535");
}

console.info("daemon.database opening", { databasePath });
try {
  await mkdir(dirname(databasePath), { recursive: true });
  // Existing storage API initializes/verifies migrations and closes its connection.
  findSource(databasePath, "startup-readiness-check");
  console.info("daemon.database ready");
} catch {
  console.error("daemon.database failed", { category: "storage_unavailable" });
  process.exit(1);
}

console.info("daemon.server starting", { port });
const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch: createApp({ databasePath }).fetch,
});
console.info("daemon.server listening", { url: `http://127.0.0.1:${server.port}`, worker: "not_implemented" });

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  console.info("daemon.server stopping");
  // Storage operations already close each connection; allow active requests to settle.
  await server.stop(false);
  console.info("daemon.server stopped");
  process.exit(0);
}
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
