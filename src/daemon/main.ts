import { ConfigError, parseConfig } from "./config";
import { startDaemon } from "./runtime";
import { ExecutionOwnerHeldError, executionOwnerHeldDiagnostic } from "../storage/execution-owner";

if (import.meta.main) {
  try {
    const config = parseConfig(process.env);
    const daemon = await startDaemon(config, event => {
      if ("operation" in event && event.operation === "start" && event.phase === "outcome" && event.success === true) {
        console.log(JSON.stringify(event));
      } else if (config.logLevel === "verbose") console.log(JSON.stringify(event));
    });
    let shuttingDown = false;
    const shutdown = () => {
      if (shuttingDown) return;
      shuttingDown = true;
      void daemon.stop().catch(() => {
        console.error(JSON.stringify({ operation: "stop", phase: "outcome", success: false }));
        process.exitCode = 1;
      });
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } catch (error) {
    console.error(JSON.stringify({ operation: "start", phase: "outcome", success: false,
      message: error instanceof ConfigError ? error.message : error instanceof ExecutionOwnerHeldError ? executionOwnerHeldDiagnostic : "Daemon startup failed" }));
    process.exitCode = 1;
  }
}
