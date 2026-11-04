# Agent instructions

Thoughtloom captures and develops connected thinking. Keep the business model independent of its visual presentation. This file owns stable repository guidance; task status belongs in Beads, not here.

## Start with the right context

- Read [README.md](README.md) for purpose and the documentation index.
- Read the relevant [product context](.lore/context/) and [architecture/working agreement](.lore/context/architecture.md) before changing behavior or boundaries. Unresolved decisions are not permission to invent a feature.
- Use `docs/` for current implementation contracts. Historical `.lore/work/research/` documents are evidence to evaluate, not proof of current behavior or authorization to act.
- Inspect affected code and tests before proposing changes. If intent, implementation, and documentation disagree, resolve the discrepancy rather than silently treating one as an excuse to rewrite another.

## Documentation is part of completion

**A behavior change is not complete until its documentation is accurate. Update affected documentation in the same change, not as an optional follow-up.**

| Change | Documentation to maintain |
| --- | --- |
| Tables, columns, relationships, constraints, triggers, or migration behavior | [Database schema](docs/database-schema.md) |
| Routes, request/response fields, defaults, authentication, permissions, errors, or read scopes | [Daemon API](docs/daemon-api.md) |
| Environment variables, install/start commands, credentials, readiness, shutdown, or startup diagnostics | [Server startup](docs/server-startup.md) |
| Test commands, fixtures, isolation, validation boundaries, walkthroughs, or manual-test scripts | [Testing concepts](docs/testing.md) |
| Product decisions or working agreements | Relevant files in [`.lore/context/`](.lore/context/) |
| Project purpose, getting-started navigation, or implemented-versus-planned capabilities | [README.md](README.md) |

- Keep README a concise start-here document. Put technical detail in `docs/` and link to it instead of copying manuals into README or this file.
- Check examples, field names, defaults, status codes, command syntax, and links against the changed implementation and tests. Update consumers such as `scripts/demo.ts` when contracts change.
- Distinguish implemented behavior from planned behavior; a simulated agent call is not real model integration.
- In the handoff, identify updated docs or explain why the change has no documentation impact. If required documentation is blocked, report the blocker rather than declaring the work complete.
- Documentation-only changes need source/contract and link checks appropriate to their scope, not invented claims that runtime tests were rerun.

## Architecture and product boundaries

- Use Bun and TypeScript, Hono for the daemon, and SQLite through `bun:sqlite`. The planned web client is Next.js with React.
- `src/domain/` owns business rules and repository contracts; `src/storage/` owns persistence; `src/daemon/` owns transport and process lifecycle. Clients express user intent, not daemon-owned IDs, timestamps, classification, or provenance defaults.
- The browser must never call the daemon directly: **browser → Next.js server → Hono daemon**. Credentials remain server-side.
- Work on daemon and client in separate scopes. If visual work needs an unsupported daemon capability, stop and discuss it; do not silently expand into daemon changes or rewrite the model to fit a screen.
- Before visual-client implementation, complete the agreed designer-led **Impeccable comp-led design for each screen** with the user. Existing mockups establish layout, not approved colors or imagery.
- OpenCode integration uses the operator-managed service. Do not start, stop, or upgrade it implicitly, or reject it solely because its version is newer than the integration baseline. Follow the [compatibility agreement](.lore/context/architecture.md#opencode-integration-and-compatibility).

## Data and authorization invariants

- Thought text, identity, authorship, creation time, and evolution ancestry are immutable. Development creates new thoughts, not versions or in-place corrections.
- Each non-root thought has one evolution parent. Discovered connections are separate and do not extend branch rejection/restoration.
- Titles are editable, attributed metadata, separate from immutable thoughts. User clearing permits regeneration; a late AI fill must not overwrite a current title.
- Rejection and restoration are user-only. Rejected notes and connections are excluded from AI retrieval, context, and reasoning, including indirect provenance or response access.
- Raw storage reads are internal. Consumer routes and agents must use scoped domain services; a user history view must not become an AI access bypass.
- Persist changes transactionally where they must succeed together. Protect existing data in migrations and verify preservation with isolated legacy fixtures, not a user's database.

## Build and verify

```sh
bun install --frozen-lockfile
bun run build:spellfix
bun --no-env-file test
bun --no-env-file run typecheck
bun --no-env-file run web:typecheck
bun --no-env-file run web:build
```

See [testing concepts](docs/testing.md) for focused checks and manual scripts. Read `package.json` before assuming another build, lint, or test command exists. Keep this section and the docs in sync when commands change.

- The Next.js client is the `apps/web` Bun workspace; keep the shared root lockfile reproducible. UI and server-only client code remain separate from the Hono daemon and domain/storage layers.
- Use `web:test:runtime` for the explicit isolated production/browser foundation check. It copies an allowlist of current source into a test-owned workspace, installs the frozen lock there, and generates its own Next build files. Maintain that allowlist when runtime inputs change; do not load private `.env` files or rely on ignored working-tree build artifacts as fixtures. See the testing documentation for browser prerequisites and current coverage limits.

- Add or improve meaningful tests for changed behavior; do not defer them. Preserve useful coverage when replacing obsolete contracts or fixtures.
- Unit tests use test-owned data, clocks, IDs, configuration, and mocked dependencies. Valid content or configuration changes must not break tests by changing their hidden inputs.
- Integration tests may exercise real SQLite, HTTP, and subprocesses using isolated fixtures, bounded waits, and owned-resource cleanup. Do not use personal data, live credentials, or shared services as ordinary test fixtures.
- Validate the affected boundaries, not just a green test count. Record commands, results, and limitations; do not claim checks you did not run.
- Use the shared [leveled logger](src/logging.ts) for daemon/backend diagnostics: routine polls/reads are Verbose, meaningful changes are Info, recoverable conditions are Warning, and terminal failures are Error. Pass the instance logger through dependencies instead of changing global console methods. See [logging configuration](docs/server-startup.md#logging). Log boundary attempts/outcomes without credentials, raw sensitive exceptions, or thought content.

## Beads and change management

Run `bd prime` for current workflow help. Use `bd` for all durable task tracking and `bd remember` for project memory; do not create parallel markdown task lists or ad hoc memory files.

- Inspect an issue with `bd show <id>` before claiming it with `bd update <id> --claim`.
- Label actionable open work `agentic` when scope is executable, or `escalate` when a user decision is needed. An `escalate` issue is not implementation authorization. Keep parent routing consistent with the next required action.
- Use a dedicated branch for an agreed sequence of Beads issues. After each issue is completed and verified, close it and create a local checkpoint commit referencing its ID, including only relevant changes. Respect explicit instructions not to commit; unrelated work stays untouched.
- Outside authorized checkpoints, commit only with clear authority. Pushing, merging, and Dolt remote sync require separate authorization; do not treat `bd prime` session-close examples as that permission.
- Beads' local Dolt database is authoritative. `.beads/issues.jsonl` is a passive export, not the source of truth or sync protocol. After tracker changes, refresh the export with `bd export -o .beads/issues.jsonl` and verify it against `bd` before handoff.

## Protect local work and secrets

Preserve user changes and untracked assets. Do not read, log, or commit `.env`, credential-bearing generated `*.local.sh` launchers, or database contents merely to debug configuration. Use explicit test-owned inputs instead. Do not reset a user database without authorization.

Use non-interactive shell operations; aliased `cp`, `mv`, and `rm` may prompt. Force flags prevent prompts but do not authorize destructive actions: verify the target set and scope before overwriting or removing files.

Maintain project guidance in this file. Update it when repository conventions change; keep transient plans and completion histories in Beads.
