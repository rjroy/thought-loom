import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { createApp } from "./app";
import { findSource } from "./storage";
import { readToolConnection } from "../../../packages/agent-tools/src/plugin";
import { readNativeSetupConfig } from "./native-setup";
import { NativeWeavingAdapter } from "./native-adapter";
import { WeavingWorker } from "./weaving";
import { WeavingSupervisor } from "./weaving-supervisor";

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
const nativeConfigFile = process.env.THOUGHTLOOM_NATIVE_CONFIG_FILE;
const selected = nativeConfigFile ? await readNativeSetupConfig(nativeConfigFile) : undefined;
const toolConnectionFile = process.env.THOUGHTLOOM_TOOL_CONNECTION_FILE ?? selected?.connectionFile;
const tools = toolConnectionFile ? await readToolConnection(toolConnectionFile) : undefined;
if (tools && new URL(tools.url).origin !== `http://127.0.0.1:${port}`) throw new Error("Tool connection must address this loopback daemon");
if (selected && (!tools || selected.location !== tools.location || selected.connectionFile !== toolConnectionFile)) throw new Error("Native and tool configuration must share the owned location and connection file");
const adapter = selected ? new NativeWeavingAdapter({ databasePath, registrationFile: selected.registrationFile,
  location: selected.location, agent: selected.agent, model: selected.model, operations: selected.operations, dialogueOperations: selected.dialogueOperations }) : null;
const worker = new WeavingWorker({ databasePath, adapter });
const supervisor = new WeavingSupervisor({ worker });
const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch: createApp({ databasePath, ...(tools ? { tools } : {}), weavingWorker: worker, weavingConfigured: selected !== undefined, weavingStatus: () => supervisor.status }).fetch,
});
await supervisor.start();
console.info("daemon.server listening", { url: `http://127.0.0.1:${server.port}`, worker: selected ? "configured" : "unavailable" });

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  console.info("daemon.server stopping");
  await supervisor.close();
  // Storage operations already close each connection; allow active requests to settle.
  await server.stop(false);
  console.info("daemon.server stopped");
  process.exit(0);
}
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
