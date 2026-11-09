import { writeFileSync } from "node:fs";
import type { BackupConfig } from "../src/backup/config";
import { BackupCheckoutLease } from "../src/backup/git";

const [rawConfig, marker] = process.argv.slice(2);
if (!rawConfig || !marker) throw new Error("Owned lease fixture inputs required");
const lease = await BackupCheckoutLease.acquire(JSON.parse(rawConfig) as BackupConfig);
try {
  writeFileSync(marker, "held", { mode: 0o600 });
  await new Promise<void>(resolve => { process.stdin.once("end", resolve); process.stdin.resume(); });
} finally { await lease.release(); }
