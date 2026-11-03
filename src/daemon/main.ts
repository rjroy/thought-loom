import { parseConfig } from "./config";
import { startDaemon } from "./runtime";

if (import.meta.main) {
  try {
    const daemon = await startDaemon(parseConfig(process.env), event => console.log(JSON.stringify(event)));
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
  } catch {
    console.error(JSON.stringify({ operation: "start", phase: "outcome", success: false }));
    process.exitCode = 1;
  }
}
