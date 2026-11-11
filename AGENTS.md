# Agent instructions

Thoughtloom captures and develops connected thinking. Keep the business model independent of its visual presentation. This file owns stable repository guidance; task status belongs in Beads, not here.

## Start with the right context

- Read [README.md](README.md) for purpose and the documentation index.
- Read the relevant [user guide](docs/user-guide.md) workflow before changing user-visible behavior. It documents the implemented client, not just product intent.
- Read the relevant [product context](.lore/context/) and [architecture/working agreement](.lore/context/architecture.md) before changing behavior or boundaries. Unresolved decisions are not permission to invent a feature.
- Use `docs/` for current implementation contracts. Historical `.lore/work/research/` documents are evidence to evaluate, not proof of current behavior or authorization to act.
- Inspect affected code and tests before proposing changes. If intent, implementation, and documentation disagree, resolve the discrepancy rather than silently treating one as an excuse to rewrite another.

## Documentation is part of completion

**A behavior change is not complete until its documentation is accurate. Update affected documentation in the same change, not as an optional follow-up.**

| Change | Documentation to maintain |
| --- | --- |
| User workflows, UI labels, limitations, recovery actions, or screens shown in the guide | [User guide](docs/user-guide.md); refresh affected screenshots using isolated synthetic data, never a private library. |
| Tables, columns, relationships, constraints, triggers, or migration behavior | [Database schema](docs/database-schema.md) |
| Routes, request/response fields, defaults, authentication, permissions, errors, or read scopes | [Daemon API](docs/daemon-api.md) |
| Environment variables, install/start commands, credentials, readiness, shutdown, or startup diagnostics | [Server startup](docs/server-startup.md) |
| Persistent services, access setup, upgrades, or deployment commands | [Production deployment](docs/production-deployment.md) |
| Backup format, capture/delivery, retained-original preservation, or offline recovery | [Backup and restore](docs/backup-restore.md) |
| Visual tokens, layout, interaction patterns, or responsive rules | [Client design system](apps/web/DESIGN.md) |
| Test commands, fixtures, isolation, validation boundaries, walkthroughs, or manual-test scripts | [Testing concepts](docs/testing.md) |
| Product decisions or working agreements | Relevant files in [`.lore/context/`](.lore/context/) |
| Project purpose, getting-started navigation, or implemented-versus-planned capabilities | [README.md](README.md) |

- Keep README human-focused: purpose, available capabilities and routes into user/operator/developer documentation. Keep this file AI-contributor-focused: stable boundaries, invariants, verification and change-management rules. Put workflow instructions and technical detail in their respective `docs/` references rather than duplicating them here.
- Check examples, field names, defaults, status codes, command syntax, and links against the changed implementation and tests. Update consumers such as `scripts/demo.ts` when contracts change.
- Distinguish implemented behavior from planned behavior; a simulated agent call is not real model integration.
- In the handoff, identify updated docs or explain why the change has no documentation impact. If required documentation is blocked, report the blocker rather than declaring the work complete.
- Documentation-only changes need source/contract and link checks appropriate to their scope, not invented claims that runtime tests were rerun.

## Architecture and product boundaries

- Use Bun and TypeScript, Hono for the daemon, and SQLite through `bun:sqlite`. The implemented web client is Next.js with React in `apps/web`.
- `src/domain/` owns business rules and repository contracts; `src/storage/` owns persistence; `src/daemon/` owns transport and process lifecycle. Clients express user intent, not daemon-owned IDs, timestamps, classification, or provenance defaults.
- The browser must never call the daemon directly: **browser → Next.js server → Hono daemon**. Credentials remain server-side.
- Work on daemon and client in separate scopes. If visual work needs an unsupported daemon capability, stop and discuss it; do not silently expand into daemon changes or rewrite the model to fit a screen.
- Preserve the agreed designer-led **Impeccable comp-led design for each screen** approval gate before visual implementation. The client already exists; use [its design system](apps/web/DESIGN.md) and approved screen references for current design context. Existing mockups alone do not approve colors or imagery.
- OpenCode integration uses the operator-managed service. Do not start, stop, or upgrade it implicitly, or reject it solely because its version is newer than the integration baseline. Follow the [compatibility agreement](.lore/context/architecture.md#opencode-integration-and-compatibility).
- Weaver and Evolve may use operator-configured native/MCP tools under the [agent tool-access policy](.lore/context/architecture.md#agent-tool-access-policy). Agentic Search, Agentic Export and import segmentation remain restricted to their application capabilities. Scoped application access is not a sandbox for permissive filesystem or shell tools; do not claim it is.

## Data and authorization invariants

- Thought text, identity, authorship, creation time, and evolution ancestry are immutable. Development creates new thoughts, not versions or in-place corrections.
- Each non-root thought has one evolution parent. Discovered connections are separate and do not extend branch rejection/restoration.
- Titles are editable, attributed metadata, separate from immutable thoughts. User clearing permits regeneration; a late AI fill must not overwrite a current title.
- Rejection and restoration are user-only. Application-mediated AI retrieval, context and reasoning must exclude rejected notes and connections, including indirect provenance or response access. This is an application invariant, not a sandbox guarantee for operator-provided native/MCP tools.
- Raw storage reads are internal. Consumer routes and agents must use scoped domain services; a user history view must not become an AI access bypass.
- Persist changes transactionally where they must succeed together. Protect existing data in migrations and verify preservation with isolated legacy fixtures, not a user's database.
- Preserve retained originals separately from interpretations. Media originals live outside SQLite and must remain paired with the correct store; follow the documented backup/restore contract rather than treating a database copy or Markdown export as a complete backup. Backups include private and rejected material; protect them accordingly.
- Preserve durable request/run identities during uncertainty. A failed read is not proof of failed execution, and a lost write acknowledgment does not authorize automatic replay. Stop and local retirement/discard do not prove remote cancellation or undo external tool effects.

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
- Before writing web code, read [the web workspace instructions](apps/web/AGENTS.md) and relevant installed Next.js documentation. Do not assume framework APIs from an older release.
- Use `web:test:runtime` for the explicit isolated production/browser foundation check. It copies an allowlist of current source into a test-owned workspace, installs the frozen lock there, and generates its own Next build files. Maintain that allowlist when runtime inputs change; do not load private `.env` files or rely on ignored working-tree build artifacts as fixtures. See the testing documentation for browser prerequisites and current coverage limits.
- Use `web:test:integration` for the separate shared-record browser walkthrough over an owned real Hono/SQLite daemon and deterministic fake agent. Its bootstrap installs and builds spellfix inside its source copy. Keep that allowlist current, settle background work before knowledge snapshots, and release held fake responses before daemon shutdown. Neither browser harness may use the operator service or a provider as a fixture.

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
- Beads' local Dolt database is authoritative. Do not generate `.beads/issues.jsonl` exports unless explicitly requested; use `bd` to inspect and verify tracker changes.
- Always include the complete current `.beads/interactions.jsonl` changes in authorized commits. This file is a normal side effect of using Beads; do not classify its entries as unrelated work or partially stage them by issue.

## Protect local work and secrets

Preserve user changes and untracked assets. Do not read, log, or commit `.env`, credential-bearing generated `*.local.sh` launchers, or database contents merely to debug configuration. Use explicit test-owned inputs instead. Do not reset a user database without authorization.

Use non-interactive shell operations; aliased `cp`, `mv`, and `rm` may prompt. Force flags prevent prompts but do not authorize destructive actions: verify the target set and scope before overwriting or removing files.

Maintain project guidance in this file. Update it when repository conventions change; keep transient plans and completion histories in Beads.
