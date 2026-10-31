import { parseArgs } from "node:util";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";
import { ABANDONMENT_ACKNOWLEDGEMENT, WeavingAbandonmentError, WeavingAbandonmentService, type AbandonUncertainInput } from "../apps/daemon/src/weaving-abandonment";

// Local operator command only. No environment-derived target, service discovery,
// native client, prompt submission, or network transport belongs in this CLI.
if (import.meta.main) {
  try {
    const { values } = parseArgs({ args: Bun.argv.slice(2), strict: true, allowPositionals: false, options: {
      database: { type: "string" }, "expected-job-id": { type: "string" }, "expected-run-id": { type: "string" },
      "expected-session-id": { type: "string" }, "expected-prompt-id": { type: "string" }, "expected-status": { type: "string" },
      "idempotency-key": { type: "string" }, "risk-acknowledgement": { type: "string" }, apply: { type: "boolean", default: false },
    } });
    const path = values.database, key = values["idempotency-key"];
    if (!path || !isAbsolute(path) || normalize(path) !== path || !key || !values["expected-job-id"] || !values["expected-run-id"] ||
        !values["expected-session-id"] || !values["expected-prompt-id"] || values["expected-status"] !== "uncertain" ||
        (values.apply && values["risk-acknowledgement"] !== ABANDONMENT_ACKNOWLEDGEMENT)) throw new WeavingAbandonmentError("invalid_input");
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || await realpath(path) !== path || (process.getuid && stat.uid !== process.getuid())) throw new WeavingAbandonmentError("invalid_input");
    const input: AbandonUncertainInput = { expectedJobId: values["expected-job-id"], expectedRunId: values["expected-run-id"],
      expectedSessionId: values["expected-session-id"], expectedPromptId: values["expected-prompt-id"], expectedStatus: "uncertain",
      acknowledgement: ABANDONMENT_ACKNOWLEDGEMENT };
    const service = new WeavingAbandonmentService({ databasePath: path,
      log: (state, details) => console.error(`weaving.abandonment ${state}`, details) });
    const result = values.apply ? service.abandon(input, key) : service.preview(input, key);
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error("Abandonment command refused", { category: error instanceof WeavingAbandonmentError ? error.code : "invalid_input" });
    process.exitCode = 1;
  }
}
