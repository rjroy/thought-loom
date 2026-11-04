#!/usr/bin/env bash
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."
ROOT="$PWD"

export THOUGHTLOOM_USER_TOKEN="$(bun --no-env-file -e 'console.log(crypto.randomUUID())')"
export THOUGHTLOOM_AI_TOKEN="$(bun --no-env-file -e 'console.log(crypto.randomUUID())')"
export THOUGHTLOOM_DB_PATH="$ROOT/.data/thoughtloom.sqlite"
export THOUGHTLOOM_PORT=3001
export THOUGHTLOOM_DAEMON_URL="http://127.0.0.1:$THOUGHTLOOM_PORT"

bun install --frozen-lockfile
bun --no-env-file run build:spellfix
env -u THOUGHTLOOM_AGENT_CONFIG bun --no-env-file test
env -u THOUGHTLOOM_AGENT_CONFIG bun --no-env-file run typecheck

if [[ ! ${THOUGHTLOOM_AGENT_CONFIG+x} ]]; then
  # Discover only the existing operator-managed service and its selected default.
  if ! THOUGHTLOOM_AGENT_CONFIG="$(bun --no-env-file -e '
    import { Service } from "@opencode/client/service";
    import { OpenCode } from "@opencode/client";
    try {
      const endpoint = await Service.discover();
      if (!endpoint) throw new Error();
      const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });
      const selected = (await client.model.default({ location: { directory: process.cwd() } }, { signal: AbortSignal.timeout(10000) })).data;
      if (!selected || !selected.providerID || !selected.id) throw new Error();
      const variant = "variant" in selected && typeof selected.variant === "string" && selected.variant.trim() ? selected.variant : null;
      console.log(JSON.stringify({ service: { discover: true }, directory: process.cwd(),
        model: { providerID: selected.providerID, id: selected.id },
        effort: { quick: variant, standard: variant, thorough: variant } }));
    } catch {
      console.error("Cannot select the running OpenCode service default model; start/configure the operator service or set THOUGHTLOOM_AGENT_CONFIG explicitly.");
      process.exitCode = 1;
    }
  ')"; then
    exit 1
  fi
fi
export THOUGHTLOOM_AGENT_CONFIG

# Write private launchers without exposing values in setup output or shell syntax.
daemon_tmp="$(mktemp "$SCRIPT_DIR/.daemon.XXXXXXXX")"
demo_tmp=""
trap 'rm -f -- "$daemon_tmp" "$demo_tmp"' EXIT
demo_tmp="$(mktemp "$SCRIPT_DIR/.demo.XXXXXXXX")"
launcher_header() {
  printf '#!/usr/bin/env bash\nset -euo pipefail\n'
  printf 'cd -- %q\n' "$ROOT"
  local name
  for name in THOUGHTLOOM_USER_TOKEN THOUGHTLOOM_AI_TOKEN THOUGHTLOOM_DB_PATH THOUGHTLOOM_PORT THOUGHTLOOM_DAEMON_URL THOUGHTLOOM_AGENT_CONFIG; do
    printf 'export %s=%q\n' "$name" "${!name}"
  done
}
launcher_header > "$daemon_tmp"
printf 'exec bun --no-env-file run daemon\n' >> "$daemon_tmp"
launcher_header > "$demo_tmp"
cat >> "$demo_tmp" <<'LAUNCHER'
printf '%s\n' 'WARNING: this smoke test uses the configured real agent/model and may incur provider charges.'
bun --no-env-file - <<'SMOKE'
const base = process.env.THOUGHTLOOM_DAEMON_URL;
const token = process.env.THOUGHTLOOM_USER_TOKEN;
async function call(path, method = "GET", body) {
  const response = await fetch(new URL(path, base), {
    method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Daemon request failed (HTTP ${response.status})`);
  return response.headers.get("content-type")?.startsWith("text/markdown") ? text : JSON.parse(text);
}
async function wait(run) {
  const until = Date.now() + 45000;
  while (Date.now() < until) {
    const state = await call(`/runs/${encodeURIComponent(run.id)}`);
    if (state.status === "completed") return state;
    if (state.status === "failed" || state.status === "interrupted") {
      console.error(`Run ${state.id} ${state.status}; inspect with GET /runs/${encodeURIComponent(state.id)}.`);
      throw new Error("Run did not complete");
    }
    await Bun.sleep(1000);
  }
  console.log(`Run ${run.id} is still running; inspect with GET /runs/${encodeURIComponent(run.id)}.`);
  return null;
}
try {
  const thought = await call("/thoughts", "POST", { text: "Small observations can become useful connections between ideas." });
  console.log("Captured thought:", thought);
  const evolution = await call(`/thoughts/${encodeURIComponent(thought.id)}/evolve`, "POST", { text: "What might follow from this idea?" });
  console.log("Evolve admitted:", evolution);
  const evolved = await wait(evolution.run);
  if (evolved) {
    console.log("Evolve result:", evolved);
    for (const id of evolved.confirmedThoughtIds) console.log("Development:", await call(`/thoughts/${encodeURIComponent(id)}`));
    if (evolved.responseId) console.log("Retained response:", await call(`/responses/${encodeURIComponent(evolved.responseId)}`));
  }
  const report = await call("/exports/agentic", "POST", { request: "What thinking has been captured about connections between ideas?" });
  console.log("Agentic export admitted:", report);
  if (await wait(report.run)) console.log(await call(`/exports/agentic/${encodeURIComponent(report.run.id)}`));
} catch {
  console.error("Smoke failed. Check the daemon and configured agent; existing work was not stopped.");
  process.exitCode = 1;
}
SMOKE
LAUNCHER
chmod 700 "$daemon_tmp" "$demo_tmp"
mv -f -- "$daemon_tmp" "$SCRIPT_DIR/daemon.local.sh"
mv -f -- "$demo_tmp" "$SCRIPT_DIR/demo.local.sh"
printf '%s\n' 'Setup complete. Start scripts/daemon.local.sh, then run scripts/demo.local.sh in another terminal.'
