import { spawn } from "node:child_process";
import { copyFile, lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// This outer process imports only built-ins; all application imports happen in the owned copy.
const root = fileURLToPath(new URL("../../..", import.meta.url));
const sources = {
  src: ["logging.ts"],
  "src/daemon": ["runtime.ts", "app.ts", "markdown-import-routes.ts", "search-session-routes.ts", "search-http.ts", "search-clock-receipts.ts", "search-workspace-routes.ts", "search-turn-routes.ts", "config.ts", "config-error.ts", "agent-config.ts"],
  "src/domain": ["agent.ts", "agentic-export.ts", "agentic-search.ts", "agentic-search-workspace.ts", "search-session-guards.ts", "search-time.ts", "search-capability.ts", "search-capability-result.ts", "search-run-context.ts", "investigative-retrieval.ts", "search-publication.ts", "capability.ts", "connection.ts", "creation.ts", "markdown-import.ts", "markdown-import-contract.ts", "markdown-import-parser.ts", "rejection.ts", "response.ts", "run-context.ts", "run-protocol.ts", "run-operations.ts", "search.ts", "run.ts", "thought.ts", "simple-export.ts", "shared-response.ts", "weave-scheduling.ts", "validation.ts", "title.ts"],
  "src/agent": ["configured-worker.ts", "import-driver.ts", "import-worker.ts", "binding.ts", "history.ts", "errors.ts", "opencode-client.ts", "opencode-adapter.ts", "supervisor.ts", "service.ts", "worker-prompts.ts", "search-prompts.ts", "search-cancellation.ts", "search-cleanup-contract.ts", "search-cleanup-history.ts", "worker.ts"],
  "src/storage": ["execution-owner.ts", "execution-owner-path.ts", "execution-owner-schema.ts", "agent.ts", "agent-binding.ts", "weave-admission.ts", "title.ts", "sqlite.ts", "knowledge-write.ts", "shared-response.ts", "search.ts", "investigative-retrieval.ts", "search-migration.ts", "search-schema.ts", "search-sessions.ts", "search-history.ts", "search-purge.ts", "search-composer.ts", "search-context-token.ts", "search-eligibility.ts", "search-invalidation.ts", "search-turns.ts", "search-workspace.ts", "search-workspace-content.ts", "search-workspace-cursor.ts", "search-session-activity.ts", "search-publication.ts", "search-publication-guard.ts", "search-capability.ts", "search-capability-context.ts", "search-capability-result.ts", "search-initial-context.ts", "search-library-read.ts", "search-prompt-clock.ts", "search-cleanup-migration.ts", "search-cleanup-schema.ts", "search-cleanup.ts", "search-cleanup-evidence.ts", "search-cleanup-manifest.ts", "search-cleanup-snapshot.ts", "search-retention.ts", "search-run-authority.ts", "run.ts", "run-worker.ts", "run-schema.ts", "run-record.ts", "run-receipt-schema.ts", "run-protocol.ts", "run-operations.ts", "run-aggregate.ts", "rejection.ts", "rejection-state.ts", "capability.ts", "agentic-export.ts", "agentic-export-schema.ts", "import-authority.ts", "import-inspection.ts", "import-migration.ts", "import-schema.ts", "markdown-import.ts", "transaction.ts"],
  "apps/web/src": ["proxy.ts"],
  "apps/web/src/app": ["globals.css", "layout.tsx", "page.tsx", "capture/page.tsx", "import/page.tsx", "explore/page.tsx", "ideas/[id]/page.tsx", "evolve/page.tsx", "export/page.tsx", "api/capture/route.ts", "api/search/route.ts", "api/ideas/[id]/route.ts", "api/evolve/thoughts/[id]/route.ts", "api/evolve/thoughts/[id]/responses/[responseId]/route.ts", "api/evolve/runs/[id]/route.ts", "api/export/simple/route.ts", "api/export/agentic/route.ts", "api/export/agentic/[id]/route.ts", "api/export/runs/[id]/route.ts", "api/export/thoughts/[id]/route.ts", "api/imports/markdown/route.ts", "api/imports/markdown/[id]/route.ts", "api/imports/markdown/[id]/files/route.ts", "api/imports/markdown/[id]/files/[fileId]/route.ts", "api/imports/markdown/[id]/seal/route.ts", "api/imports/namespaces/route.ts", "api/imports/runs/[id]/route.ts", "api/imports/runs/[id]/stop/route.ts", "api/imports/sources/route.ts", "api/imports/sources/[id]/route.ts", "api/imports/sources/[id]/parts/route.ts", "api/imports/sources/[id]/raw/route.ts"],
  "apps/web/src/components": ["primary-navigation.tsx", "contextual-back.tsx", "capture-form.tsx", "capture-provider.tsx", "capture.module.css", "import-view.tsx", "import-provider.tsx", "import-inspection.tsx", "import.module.css", "explore-view.tsx", "explore-provider.tsx", "explore.module.css", "idea-view.tsx", "idea-navigation-provider.tsx", "idea.module.css", "evolve-view.tsx", "evolve-provider.tsx", "evolve.module.css", "export-view.tsx", "export-provider.tsx", "export.module.css", "export-markdown.ts"],
  "apps/web/src/features": ["capture/submission.ts", "import/types.ts", "import/request.ts", "explore/query.ts", "explore/results.ts", "explore/request.ts", "idea/location.ts", "idea/types.ts", "idea/validation.ts", "idea/request.ts", "evolve/location.ts", "evolve/types.ts", "evolve/validation.ts", "evolve/request.ts", "export/types.ts", "export/request.ts", "export/sources.ts"],
  "apps/web/src/server": ["capture.ts", "client.ts", "config.ts", "daemon.ts", "request-guard.ts", "search.ts", "idea.ts", "evolve.ts", "export.ts", "import.ts"],
} satisfies Record<string, readonly string[]>;
const files = ["package.json", "bun.lock", "tsconfig.json", "apps/web/package.json", "apps/web/tsconfig.json", "apps/web/next.config.ts", "apps/web/public/fonts/SourceSans3-VariableFont_wght.ttf", "apps/web/public/fonts/OFL.txt", "vendor/sqlite/spellfix.c", "scripts/build-spellfix.sh", "integration/inner.ts", ...Object.entries(sources).flatMap(([dir, names]) => names.map(name => `${dir}/${name}`))];

async function execute(cwd: string, args: string[], env: NodeJS.ProcessEnv, label: string, limit = 120_000): Promise<void> {
  const child = spawn(process.execPath, args, { cwd, env, stdio: ["ignore", "inherit", "inherit"], detached: true });
  const closed = new Promise<number | null>((resolveClose, reject) => { child.once("error", reject); child.once("close", resolveClose); });
  const signalGroup = (signal: NodeJS.Signals) => { if (child.pid !== undefined) { try { process.kill(-child.pid, signal); } catch { /* Already exited. */ } } };
  const timer = setTimeout(() => signalGroup("SIGTERM"), limit);
  const force = setTimeout(() => signalGroup("SIGKILL"), limit + 3000);
  try { const code = await closed; if (code !== 0) throw new Error(`${label} failed or timed out`); }
  finally { clearTimeout(timer); clearTimeout(force); }
}

const temp = await mkdtemp("/tmp/opencode/thoughtloom-integration-");
try {
  const workspace = resolve(temp, "workspace");
  for (const file of files) {
    const source = resolve(root, file);
    if (!(await lstat(source)).isFile()) throw new Error(`Integration input must be a regular file: ${file}`);
    const target = resolve(workspace, file);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
  }
  const home = resolve(temp, "home"), tmp = resolve(temp, "tmp");
  await mkdir(home); await mkdir(tmp);
  const env: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: process.env.PATH, HOME: home, TMPDIR: tmp, NEXT_TELEMETRY_DISABLED: "1" };
  await execute(workspace, ["--no-env-file", "install", "--frozen-lockfile", "--ignore-scripts", "--prefer-offline", "--cache-dir", resolve(homedir(), ".bun/install/cache"), "--backend=copyfile"], env, "Owned install");
  await execute(workspace, ["--no-env-file", "run", "build:spellfix"], env, "Owned spellfix build");
  await execute(workspace, ["--no-env-file", "integration/inner.ts"], env, "Owned integration", 300_000);
} finally { await rm(temp, { recursive: true, force: true }); }
