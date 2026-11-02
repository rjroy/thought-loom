# Opt-in Thoughtloom plugin witness

## Indexed-search candidate and historical fixture evidence

The current candidate marker is `thoughtloom-indexed-search-v2`. Its six-source
and bundle pins in `plugin-provenance.ts` are offline review inputs, not proof
of executing bytes. No native witness has been run for this search bundle. The
previous `thoughtloom-fuzzy-retrieval-v1` candidate and its offline pin checks
describe earlier bytes, not execution or validation of this indexed bundle.

The historical `thoughtloom-generated-titles-v1` isolated source title fixture
passed for its then-final bundle: `/tmp/opencode/title-native-witness-rerun.log`
records OpenCode 2.2.2, verified RPC, frozen command/grant, a completed native
title tool, AI revision, preserved USER override and original, zero semantic
changes and follow-up jobs, revoked grant, four fake-provider requests and
completed cleanup. Its test-specific permission ceiling does not prove the
production setup permits title calls.

The historical title-bundle watcher fixture also passed: `/tmp/opencode/finalbundle-watch-witness.log`
records A→B at the same PID/location, changed setup ID, fresh client/new nonce,
11 expected actions, zero provider requests and completed cleanup. The malformed
swap established only no B observed, not a witnessed failed setup. Neither test
proves native exact-item title invocation or authorizes live rollout. The accepted
64-artifact manifest SHA-256 is `4aafd83fe75f2386e91aa26c8d0c75a77b7b2b80639af9e02d8e5d3f1d0888a9`.
Neither historical receipt is evidence of the current search bundle. The
historical baseline fixture is not a substitute for these results.

Offline reproduction: from the isolated copy, `bun --no-env-file run
tests/native/plugin-provenance-report.ts`. Source closure is `plugin.ts`,
`capabilities.ts`, `contracts/src/tools.ts`, `native-capabilities.ts`,
`inspection.ts` and `search.ts`; candidate bundle A is
`d3a2042f7452926d7f41e3ccd772267969748eb7f4f5ced303fb4b52eaf93c4b`,
test-marker B is
`3da5c7a7b9aff8c23918be374afefcaca21c9d8bbfa53f1c07e34e17d5821c84`.
The embedded marker is a reviewed identifier, not an executing-byte hash.

### Source-title fixture — historical isolated execution

The following is the isolated command used for the historical title-bundle witness,
not permission to rerun the current bundle or change a shared native service:

```sh
THOUGHTLOOM_PLUGIN_WITNESS=1 THOUGHTLOOM_TITLE_WITNESS=1 \
OPENCODE_TEST_BINARY=/home/rjroy/.local/share/mise/installs/npm-opencode-cli/2.2.2/node_modules/.mise/@opencode+cli@2.2.2/node_modules/@opencode/cli/bin/opencode.exe \
bun --no-env-file run tests/native/title-witness.ts
```

This adds one explicit title-only launch profile: native uses a fresh private
home/config/database and the pinned binary/bundle, with project discovery and
file watching disabled. An exact test-owned config-content agent ceiling adds
only `record_title_v1` to the baseline; the offline-provisioned project file and
legacy profiles stay unchanged. This fixture-specific ceiling is not proof that
an operator's native setup permits title calls. The fake provider uses only
loopback, a fixed synthetic source and bounded scripted read/title/final flow.
The guard rejects the app ports and checks generated files before owned launch.
The fixture requires a fresh matching RPC nonce/build/PID/location, a new frozen
title-capable command/grant, one successful native title invocation, an AI title
revision, preserved user override and original, zero semantic changes and no
follow-up job. Cleanup signals only the owned process and retains the private
root if uncertain. The 75-second lifetime and request bounds apply; no external
provider or personal data is involved. Source-only evidence does **not** prove
exact-item titles, legacy-command denial, A→B activation of this bundle, live
rollout, hostile-process isolation or production permission configuration.

**Historical capture-only witness passed on 2026-10-31** after security review and independent
execution; results and limits are recorded in the [research note](../../.lore/work/research/opencode-2.2.2-owned-tools.md#2026-10-31--isolated-application-witness).
This does not certify personal policies, operator-service compatibility, dialogue
execution or later code changes. Ordinary `bun test` does not discover
`plugin-witness.ts`. This is one first-party-plugin fixture, not a rerun of the
three baseline profiles or an operator-service check. It changes no production
configuration. Any rerun remains explicit opt-in and subject to security review.

**Phase-4 capture+dialogue witness passed on 2026-10-31** after fresh review.
An independent tester ran the exact command below **once**, with the then-reviewed
source/bundle pins: exit **0**. This is separate from the historical
capture-only result; the existing baseline's three profiles were not rerun.

Receipt: **2.2.2**, plugin **active**, capture job and dialogue **completed**,
**2 owned sessions**, **4 native calls** (`read_source`, `record_interpretation`,
`record_idea`), **2 domain receipts**, **6 daemon replay refusals**, **8 fake-provider
requests** (**4 capture + 4 dialogue**), cleanup **completed**. Native context
matched history; originals/turn context, canonical reply and the developing
idea's two-source evidence/derivation were retained; grants were revoked.
The refusals were daemon replays, not extra native prompts. No paid-model or
personal/operator-service calls occurred. Post-run inspection found no owned
process or fixture directory; ephemeral ports were not reported or independently
port-checked. This is **not** live Stop or operator-policy certification. See the
[dated research result](../../.lore/work/research/opencode-2.2.2-owned-tools.md#2026-10-31--refreshed-capture-and-dialogue-witness).

## Pure checks (safe without native opt-in)

From the repository root, using the already installed runtime:

```sh
/home/rjroy/.local/share/mise/installs/bun/1.4.3/bin/bun --no-env-file test apps/daemon/tests/native-plugin-isolation.test.ts apps/daemon/tests/native-fixture-provider.test.ts
/home/rjroy/.local/share/mise/installs/bun/1.4.3/bin/bun --no-env-file node_modules/typescript/bin/tsc --noEmit -p tsconfig.native-tests.json
```

Package scripts: `test:native:guards` (isolation/bundle checks), `typecheck:native-tests`.
The provider tests exercise only the pure fixed-flow state machine: no server,
native process or provider/model call. The real-source bundle check uses
`Bun.build` in memory, not an installer or native loader. An offline-generator
test writes only a fresh private temporary fixture and removes it afterward;
it checks that production setup and the exact guarded documents agree.

## Watcher capability fixture — historical isolated execution

The historical title-bundle watcher pass above used the separate profile below. Any future
execution requires applicable safety review and authorization; isolated fixture
approval is not live-rollout authorization:

```sh
THOUGHTLOOM_PLUGIN_WITNESS=1 THOUGHTLOOM_PLUGIN_WATCH_WITNESS=1 \
OPENCODE_TEST_BINARY=/home/rjroy/.local/share/mise/installs/npm-opencode-cli/2.2.2/node_modules/.mise/@opencode+cli@2.2.2/node_modules/@opencode/cli/bin/opencode.exe \
bun --no-env-file run tests/native/plugin-watch-witness.ts
```

This separate profile keeps the exact guarded binary, private fixture root,
sanitized environment, fixed location and single local package, but enables file
watching. It sends no prompts: both loopback fixture services reject requests,
and provider requests must remain zero. It observes executing-build A, tries a
malformed same-entry replacement (no B must be observed), atomically swaps the
same entry to test-only B, and requires B from the same PID/location plus a new
nonce through a fresh client. B differs only in an embedded fixture marker and is
pinned separately; neither marker is an executing-byte hash. The malformed check
does not prove that the watcher observed that failed replacement. This watcher
alone does not invoke the title tool. Failure means STOP, not a
reload, new location or retry against shared services. Cleanup signals only the
owned child group and retains the private root if cleanup is uncertain.

The candidate source and in-memory bundle digests can be reproduced without
native execution using `bun --no-env-file run tests/native/plugin-provenance-report.ts`.
The report writes no pins; a reviewer must inspect source and update pins explicitly.

## Baseline native execution — independent tester only, after review

The opt-in script is `test:native:plugin`. Its equivalent exact entrypoint is:

```sh
THOUGHTLOOM_PLUGIN_WITNESS=1 \
OPENCODE_TEST_BINARY=/home/rjroy/.local/share/mise/installs/npm-opencode-cli/2.2.2/node_modules/.mise/@opencode+cli@2.2.2/node_modules/@opencode/cli/bin/opencode.exe \
/home/rjroy/.local/share/mise/installs/bun/1.4.3/bin/bun --no-env-file run tests/native/plugin-witness.ts
```

Do not run a PATH-selected OpenCode wrapper, `--version`, installer, native SDK
host, service `ensure`/`stop`, or another service/profile as a fallback. A guard or
witness failure is a failure, not permission to relax isolation or retry a prompt.

## Review surface and narrow baseline adaptation

* `plugin-isolation.ts` defines exact baseline and separately opted-in watcher environment profiles.
  `node-io.ts` supplies metadata/hash checks. `owned-native.ts` is the only spawn
  site, reached through `guardedLaunch` after all guards.
* `plugin-provenance.ts` pins the plugin, capability module, and their four contract
  inputs. `plugin-bundle.ts` checks canonical
  source paths/hashes and reproduces the pinned in-memory bundle. The harness
  never learns a hash from current files and then approves it automatically.
* Require Linux x64, Bun 1.4.3, canonical repository cwd and the exact existing
  canonical ELF/package pair at 2.2.2. Both binary files must be executable; sibling
  inode or digest must match. Expected SHA256 is
  `4452778e23fbda075eb2f83c2574b1d7452af8e347c52b8d9e016838b9c530d9`.
  This is an operator-supplied installation digest, not a publisher signature.
* Create only a new private `/tmp/opencode/thoughtloom-plugin-witness-*` root.
  Fresh HOME, XDG roots, native DB, configuration directory, Git config and temp
  directory are contained there. No host environment spread, provider credentials,
  proxies or extra native flags. `/etc/opencode` must be definitely absent; only
  metadata is inspected, never its contents or modifications.
* The old profile forbids plugins. This new profile allows **exactly one** local
  package generated by production `provisionNativeSetup`, with an exact package
  entrypoint and independently pinned source/bundle bytes. No URL, npm dependency,
  arbitrary path, external source re-export, extra file, SDK plugin or second
  local plugin is allowed. Hash changes require another source/bundle review;
  the harness does not update its allowlist automatically.
* Keep `OPENCODE_CONFIG_PROJECT_DISABLE=1`. Supply the exact generated plugin and
  agent through supported `OPENCODE_CONFIG_CONTENT`; the generated location's
  `.opencode/opencode.json` is checked but **not discovered** by native. No ancestor,
  repository-root or real global configuration is enabled or edited.
* Native `plugin.list` includes compiled-in plugins. These remain part of the
  pinned binary; registry validation allows those and only our exact active local
  package. It does not pretend the first-party package is the entire native
  registry. Active status alone is not success.
* Disable model catalog fetch, free providers, updates, baseline file watching, sharing,
  snapshots, warming and automatic compaction. The only enabled chat model must
  be the test-owned loopback provider. Default-deny permissions allow only exact
  actions. The agent ceiling is exactly `read_source`, `record_interpretation`
  and `record_idea`. Each newly owned session receives a default-deny narrower
  policy: capture allows only `read_source`/`record_interpretation`; dialogue
  allows only `read_source`/`record_idea`. No wildcard action allow, shell, file,
  delegation, MCP, browser or network tool grants. Native session readback and
  each actual provider catalog must match its exact two-action policy.

## What the real run must witness

The fixture binds two ephemeral loopback servers: the real Hono application over
a fresh SQLite database and a bounded deterministic fake provider (no outbound
fetch/proxy/model). It launches only its own detached native process group with
`serve --hostname 127.0.0.1 --port 0`. Exact readiness, PID/version, native temp
containment and the enabled fixture model are checked before submission. A private
test-owned registration is then used by the **production default maintained-client
connector**, not a scripted client port.

The production worker submits exactly once for capture, then exactly once for
one retained dialogue turn. These use **two distinct owned native sessions**,
run/job IDs and prompt IDs; neither adopts a TUI or mutable current-turn context.
The fake provider keeps the existing **nine-request capture cap** and adds at
most **five dialogue requests**: **14 total**, each at most 1 MiB. Each flow has
exactly three domain steps (six total); no-tool auxiliary replies consume the
same phase/total budgets and never call a real provider.

Capture still requests `read_source`, verifies the controlled original, records
one interpretation and verifies its result before returning a canonical final.
Only after capture settles does the fixture create a dialogue through the real
Hono routes, pinned to that actual interpretation/version, and save one user
turn. The provider verifies that the native dialogue prompt contains the original,
exact current input and pinned context/IDs; it reads the retained turn, records
one developing idea with both source IDs and the pinned interpretation derivation,
verifies the result and returns a canonical final. Any wrong/extra advertised
tool, missing result, unexpected phase, extra domain step or exceeded cap fails.

Accepted HTTP envelopes are matched to ordinary native assistant history:
session, configured agent, engine-owned assistant message ID and native call ID
must agree. Assistant message ID must differ from the single admitted prompt ID.
The worker's production event-handshake/history reconciliation must reach canonical
completion for each particular prompt. The fixture verifies original bytes
unchanged; one AI interpretation plus one actual `developing-idea`; **two**
native-context-derived domain receipts; and one attempted command, one recorded
change and revoked grant **per run**. The dialogue grant contains exactly the
original and retained user-turn source IDs. SQLite and the public dialogue view
must retain the canonical assistant text; the outcome's native assistant ID must
match ordinary history. Idea evidence and derivation must point to that original,
dialogue, turn, retained turn source and exact selected interpretation/version.

Separately, authenticated HTTP **replay-policy checks**, not additional native
prompts, require refusal of unknown-session and settled/revoked-session envelopes;
a wrong transport credential must return 401. Repeat these three checks for the
dialogue idea endpoint: **six daemon replay refusals**, not six additional native
tool calls. Expected successful output counts are two sessions, four native tool
calls, two domain receipts, six refusals, and the bounded actual provider counts.
These negatives do not prove native permission denial or hostile-plugin isolation.

## Cleanup, output and limits

Work has a 75-second abort deadline; native requests and stream consumers also
have production timeouts. Pending worker operations are tracked, aborted and
awaited before database cleanup. SIGINT/SIGTERM request the same cleanup. Only the
owned child process group is signalled: TERM, bounded grace, then KILL if needed;
group absence and leader reaping are checked. Both fixture servers force-close
their own connections. Cleanup steps are bounded. If process/consumer/path cleanup
is uncertain, fail and retain the private fixture root rather than erase files a
survivor could use or broaden the kill. No process-name, port-based or shared-service
kill is permitted. SIGKILL/host failure cannot guarantee cleanup.

Native output is bounded in memory and never echoed. Production logs are suppressed
within the executable entrypoint. The final JSON contains only fixed categories,
states, counts, tool names and version; no prompt, original, interpretation, user turn, idea,
credentials, native output, exception object or stack is printed. Private runtime
files are deleted on successful cleanup; on uncertainty they remain mode-protected.

This is application trust, **not an OS/network sandbox**. It trusts the pinned
native binary, reviewed first-party bundle and same-account operator. A hostile
same-account process/plugin could read credentials or change files between checks.
The transport credential authenticates forwarding, not cryptographic native
identity. Native model permissions do not constrain arbitrary plugin code. This
fixture does not certify personal plugins, shared-service setup, real provider
behavior, all domain tools, Stop, failures/stream gaps, or UI status.

## Source provenance

### Phase-4 bundle refresh (executed 2026-10-31)

| Artifact | SHA256 |
| --- | --- |
| `packages/agent-tools/src/plugin.ts` | `4e5f62a7806cf9a1a49f3edaa1a9f2b6c846d641ef910d0b9e699d2dffc04153` |
| `packages/contracts/src/tools.ts` | `ad18dc44175e900d98d07a89f44481141aab08c946d3a95999c45ff2cf638fef` |
| Bun 1.4.3 bundle | `eb68510bdc3d1989683a8b6c5ae3caab47c6785a626c3c63f6a79517ab71f04c` |

The pure commands above reproduce the bundle with entrypoint
`packages/agent-tools/src/plugin.ts`, `target: "bun"`, `format: "esm"`,
`packages: "bundle"`, no output directory. Any changed sources, fixture or pins
require review before another opt-in run. The earlier capture-only bundle hash
`b2e9e9de7545f79ab565710c7c248537bc9e98e2ac29482b65544f79f343b2e6`
is historical and now explicitly refused, not an alternate allowlist entry.

### Reused baseline (not rerun)

Reused committed memory-loop checkpoint:
`0b2343c94f4313ed6e86440031e15ee8cc7d459c`, at
`/home/rjroy/Projects/writing/memory-loop/.slim/worktrees/think-implementation`:

* `tests/opencode/isolation.ts`, blob `ed95fc4630d8ed6a651c068e67cff9fc464221ef`:
  fresh environment, containment, absent system config, isolated direct launch.
* `tests/opencode/readiness.ts`, blob `0c4a4023558362b3f5ee754ac50d8547c1804ef2`:
  exact complete readiness line and excluded app ports.
* Committed inline preflight in `backend/opencode-capabilities.test.ts`, blob
  `73766ba70163e2f9c944a3943f264735232ddbda`: package/ELF/canonical/sibling checks,
  fixture provider framing and explicit fixture discovery. Its `--version` spawn
  is intentionally omitted. The later **untracked** extracted binary helper is
  not checkpoint authority. The current operator-supplied binary digest is new
  input, not a claim about that old checkpoint's installation.

New source-only plugin adaptation uses exact public OpenCode revision
`098aa7fd6e02b03d6fc410f0b052038c7d4c5e81`:

* [Discovery, lines 59–80](https://github.com/anomalyco/opencode/blob/098aa7fd6e02b03d6fc410f0b052038c7d4c5e81/packages/core/src/config/discovery.ts#L59-L80): project:false skips the ancestor walk.
* [Config, lines 255–267](https://github.com/anomalyco/opencode/blob/098aa7fd6e02b03d6fc410f0b052038c7d4c5e81/packages/core/src/config.ts#L255-L267): config content independently becomes a document.
* [Plugin config, lines 134–155](https://github.com/anomalyco/opencode/blob/098aa7fd6e02b03d6fc410f0b052038c7d4c5e81/packages/core/src/config/plugin/source.ts#L134-L155): explicit absolute package directories; configured file targets are rejected.
* [Local provenance, lines 160–170](https://github.com/anomalyco/opencode/blob/098aa7fd6e02b03d6fc410f0b052038c7d4c5e81/packages/core/src/plugin/module.ts#L160-L170): local registry source.path is the configured target.
* [Supervisor, lines 147–174](https://github.com/anomalyco/opencode/blob/098aa7fd6e02b03d6fc410f0b052038c7d4c5e81/packages/core/src/plugin/supervisor.ts#L147-L174) and [internal plugins](https://github.com/anomalyco/opencode/blob/098aa7fd6e02b03d6fc410f0b052038c7d4c5e81/packages/core/src/plugin/internal.ts): compiled-in plugins are distinct from configured local code.
* [Warming, lines 16–27](https://github.com/anomalyco/opencode/blob/098aa7fd6e02b03d6fc410f0b052038c7d4c5e81/packages/core/src/plugin/warming.ts#L16-L27): false disables transient warming requests.

Native Tool.Context, permission.assert, activation and ownership evidence remain
in `.lore/work/research/opencode-2.2.2-owned-tools.md`; the existing integration
report remains the reused baseline. Installed 2.2.2 client/schema types verify
the actual SDK and registry shapes used here. Source support and pure guards alone
do not prove execution; the dated result above supplies isolated fixture proof,
not validation of the operator's production setup or personal policies.
