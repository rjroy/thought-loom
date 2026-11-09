// Isolated process exercises the real default Git runner, not an injected replacement.
import { access } from "node:fs/promises";
import { runBackupGit } from "../src/backup/git-process";

const [directory, helper, marker] = process.argv.slice(2);
if (!directory || !helper || !marker) throw new Error("Owned abort fixture inputs required");
const controller = new AbortController();
const result = runBackupGit({ cwd: directory, args: ["-c", `alias.ownedwait=!${helper}`, "ownedwait"], signal: controller.signal })
  .then(() => null, (error: unknown) => error);
try {
  const deadline = Date.now() + 5000;
  for (;;) {
    try { await access(`${marker}.shell`); await access(`${marker}.sleep`); break; }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      if (Date.now() >= deadline) throw new Error("Owned helper did not start");
      await Bun.sleep(10);
    }
  }
} finally { controller.abort(); }
const failure = await result;
console.log(JSON.stringify({ code: failure && typeof failure === "object" && "code" in failure ? failure.code : null }));
