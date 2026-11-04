# Testing concepts

[Start here](../README.md) · [Server startup](server-startup.md) · [Daemon API](daemon-api.md)

Testing serves two purposes: protect business rules as the interface changes, and let a person explore daemon behavior without needing the visual client. Automated tests and manual scripts complement each other; neither replaces the other.

## Run the checks

From the project root:

```sh
bun install --frozen-lockfile
bun run build:spellfix
bun test
bun run typecheck
```

To prevent Bun from loading a project `.env` during checks:

```sh
bun --no-env-file test
bun --no-env-file run typecheck
```

Ordinary tests supply their own configuration and data rather than relying on your running daemon. They do not require a browser, model provider, or OpenCode service. Native acceptance is a separate explicit opt-in described below.

Search integration tests also need the [native extension build prerequisites](server-startup.md#native-spelling-extension). Run `bun run build:spellfix` before tests that use the default project artifact, including `search-contract` and `search-scopes`; that ignored artifact is absent on a fresh checkout and is not built automatically by the test command. Separate native pipeline tests compile the pinned vendored source into owned temporary outputs, verify its hash, load it through Bun SQLite, and check tamper and missing-artifact failures. Those temporary builds do not populate the default artifact. No system extension is assumed.

## Test boundaries

| Boundary | What the tests establish | Files |
| --- | --- | --- |
| Domain | Validation, immutable content, single-parent traversal, semantic creation, title authority, shared-response visibility, run identities and recovery using controlled inputs and repository/dispatcher doubles. | `domain`, `creation`, `rejection-domain`, `titles-domain`, `shared-responses-domain`, `runs-domain` |
| SQLite | Foreign keys, immutable-record triggers, source/response seals, atomic admission and receipts, rejection persistence, migrations and reopen behavior. | `sqlite`, `rejection-sqlite`, `titles-sqlite`, `shared-responses-sqlite`, `runs-sqlite` |
| Indexed search | FTS5 backfill and transactional title/reply maintenance, scoped retrieval and vocabulary, interrupted replies, rejection/restoration, unchanged-cache reuse and native extension build/load failures. | `search-index`, `search-scopes`, `search-efficiency`, `search-native` |
| Simple export | Evolution-only breadth/depth traversal, count semantics, traversal through rejected intermediates, addendum exclusion, Markdown attribution, read-only behavior and user-only HTTP authorization. | `simple-export` |
| Agent protocol kernel | Strict whole-envelope parsing, ordered prompt migration and exact input, per-step completion, atomic advancement/replay, reopen and durable cancellation settlement. | `run-protocol-domain`, `run-protocol-sqlite` |
| Typed agent operations | Step-owned receipts, title-fill no-op replay, interpretation/connection writes, effect rollback, export write denial, weave intent and no-findings/failure outcomes. | `run-operations` |
| Agent configuration and adapter | Optional/malformed configuration, Basic discovery headers and Bearer transport, immutable session binding, paginated history correlation, uncertain admission, quarantine and cancellation using controlled facades and owned HTTP fixtures. | `agent-config`, `opencode-adapter` |
| Scoped capabilities | Narrow AI search/read projections, exposure tracking versus full-read witnesses, connection/source prerequisites, malformed authority, replay and Stop/rejection fences, witness/final-cache rollback, populated predecessor migration and export write denial. | `capabilities`, `capability-migration` |
| Worker core | Controlled native execution of ordered steps, scoped initial context, capability/reply processing, no-findings weaving, absent configuration, uncertain admission, local pause, Stop/rejection and malformed output. | `worker` |
| Weave scheduling | Capture/title-clear/Evolve-follow-up admission, paired domain/job rollback, trigger deduplication and no recursive scheduling from weaver writes. | `scheduling` |
| Supervisor | Eligible-run scans, overlapping-poll coalescing, independent progress, pause-before-drain shutdown and queued capture/title-clear jobs through unconfigured HTTP runtime. | `supervisor`, `supervisor-runtime` |
| Configured daemon | Owned HTTP Weave/Evolve/status/Stop flow, unavailable service and role/credential boundaries; file-backed restart, cached-result recovery, held SDK shutdown and endpoint credential isolation. | `agent-runtime`, `runtime-recovery` |
| Agentic export | Strict report envelopes, immutable request/effort, full-read citations and attribution, rejection/Stop fences, atomic artifact finalization and independent knowledge-write denial; runtime admission/download, read-only index snapshots, configured variants and bound restart. | `agentic-export`, `agent-runtime` |
| Hono request API | Authentication, role restrictions, strict request bodies, response/status contracts, scoped data and sanitized logging without a network listener. | `api` |
| Native daemon | Real HTTP plus SQLite, startup validation, persistence across restart, concurrent captures, port conflicts, bounded failure cases and process signals. | `daemon` |
| Scripts | Request validation and diagnostics with injected fetch, plus a real isolated walkthrough and cleanup on success/failure. | `scripts` |

Names in the last column refer to `tests/<name>.test.ts`. Some files contain integration checks as well as small unit cases; choose the boundary needed for the change, not just the filename.

For example, title changes can be checked with:

```sh
bun test tests/titles-domain.test.ts tests/titles-sqlite.test.ts
```

### Controlled inputs, not production assumptions

- Unit tests own their records, IDs, clocks, configuration, and mocked dependencies. Valid changes to application data or configuration should not break those tests.
- SQLite integration tests use in-memory databases or unique temporary directories. They verify actual persistence and constraints, not a mock database's approximation.
- Migration tests build frozen, populated legacy schemas, including inline-title and separate-title databases with single-owner responses. They check preservation of thoughts, provenance, rejection state, titles and response associations, then migration idempotence and reopening. They do not inspect or reset a user's database.
- HTTP and process tests own their listeners, credentials and subprocesses. They use ephemeral ports where appropriate, bound waits, and clean resources in `finally` paths.
- Failure tests assert the intended diagnostic or state, not merely that some exception happened. An import error or missing table must not count as proof that an authorization or immutability check works.

## Business behavior protected

The suite covers these distinctions:

- Thought content and evolution ancestry remain immutable; editable title metadata is separate.
- Creation IDs, timestamps, authorship, kind and origin come from daemon business commands, not capture clients.
- A user title edit does not change the note's author. Clearing permits another supplied AI fill, and a late fill cannot overwrite a current title.
- Rejecting one thought preserves active descendants. Branch rejection/restoration walks evolution descendants, not discovered connections.
- Branch rejection requires the exact current preview; stale confirmations must not partially change state.
- A separately rejected connection stays rejected when its endpoint ideas are restored.
- User history/show-rejected access does not give AI callers access to rejected notes, sources, connections or response content.
- A reply is stored once with ordered, sealed associations. Normal user reads filter rejected associations; AI cannot read a shared reply if any associated thought is rejected. Explicit user inspection retains all associations.
- An interrupted addendum can still navigate to its latest eligible saved development without changing the reply's interrupted state or inventing a completed fallback.
- Run admission retains the exact Evolve contribution, and an Evolve operation cannot choose another visible parent. Knowledge, operation receipts and issued-order membership commit or roll back together.
- Lost acknowledgements recover the existing external identity. Native completion is durable evidence for finalization, not proof that the local output has already committed. Replayed operations do not create another development.
- Stop, stale ownership and rejected context fence later work. Submission authorization is checked as well as later writes, and a late successful acknowledgement cannot revive a stopped run. Drafts do not override the durable order of saved developments.

Deterministic agent tests supply controlled model proposals and replies. They establish conditional title filling, scoped capabilities, saved developments and run behavior, not semantic model quality or live-provider availability. Other command/API tests still simulate AI-authored calls directly.

Run-kernel tests use a controlled `NativeDispatcher`, not the real OpenCode client. They establish domain/storage recovery and fencing, not native service compatibility. Claim generation is not an expiry-based lease or a model effort quota.

Adapter tests also exercise the maintained public SDK against owned loopback HTTP fixtures. They do not discover the operator's service or read its registration credentials. Fake server identity versions test the absence of an exact-version gate, not compatibility with every future release. Native processes and real provider calls are not part of ordinary tests.

The worker core has a manual polling seam for controlled tests. It reuses durable steps, bindings, capability results and canonical replies. A tick is an execution boundary, not a model effort quota. Local pause is distinct from user Stop: it fences callbacks without undoing saved work or initiating cancellation. `agent-runtime` exercises configured scheduling, Evolve/status/Stop HTTP routes, role restrictions and unavailable-service behavior through an owned daemon with injected service/client dependencies.

Search tests exercise actual FTS5 and spellfix1 using test-owned records. Retained interrupted fallback replies remain searchable through their associated input without becoming completed developments. Efficiency checks observe graph-snapshot and vocabulary-rebuild boundaries rather than asserting machine-dependent timing. `search-contract` covers filter combinations and option counts, creation-date sorting, response metadata, modest query correction, and strict authenticated HTTP search. These checks do not establish browser behavior or final relevance tuning.

## Opt-in native OpenCode acceptance

The default suite never starts native OpenCode. Its pure `tests/opencode/isolation.test.ts` guard checks are separate from the explicitly invoked fixture:

```sh
OPENCODE_NATIVE_TEST=1 \
OPENCODE_TEST_BINARY=/absolute/verified-install/node_modules/.mise/@opencode+cli@2.2.5/node_modules/@opencode/cli/bin/opencode.exe \
bun --no-env-file run test:opencode
```

The path is a placeholder for an existing verified direct executable, not an installation command. The current fixture targets Linux x86-64 and OpenCode 2.2.5 with its matching installed platform package. This fixture baseline is not a production version gate: Thoughtloom must not reject a newer service solely for its version.

The fixture rejects wrappers and package runners, verifies installed binary/package metadata and matching artifacts, requires definite absence of `/etc/opencode`, and fails closed on unsafe prerequisites. Do not delete or rename personal/system configuration to force it to run. It constructs fresh fixture-only HOME/XDG/config/database/workspace paths under `/tmp/opencode`, disables project configuration discovery and unrelated integrations, and launches only its owned direct native process. It never starts or stops the operator's service. All provider traffic goes to its local fake provider; no paid model is used.

Acceptance exercises the actual daemon, maintained SDK and native service: weaving/title-fill and no-findings completion, scoped Evolve read/development/final reply, Stop retaining confirmed work, and restart after a proxy drops an already-admitted prompt acknowledgement. It also checks public prefix/typo search, count-limited Simple export, Agentic search/full-read/cited report download, and a forbidden export write attempt with unchanged knowledge. Build spellfix with `bun run build:spellfix` first; the fixture does not install or build missing prerequisites automatically.

The fixture records application/native/provider receipts and checks owned listeners, process group and observed descendants during cleanup. SIGINT/SIGTERM and normal completion share idempotent cleanup with bounded actions; failures are recorded without skipping later cleanup actions. Pure lifecycle tests exercise interruption using owned Bun subprocesses, not OpenCode. SIGKILL cannot be caught, and cleanup cannot guarantee absence of unknown detached descendants. Forced large history-page boundaries and universal model variants are not exercised by this fixture; separate controlled pagination and effort-mapping tests cover those contracts.

This validates the owned setup, not personal-service configuration, arbitrary plugins, future releases or model quality. Native deny rules are defense in depth, not a universal sandbox. Omitting either explicit selector fails the dedicated command actionably rather than silently falling back to a shared service or installing packages.

## Isolated walkthrough

```sh
bun run build:spellfix
bun run demo
```

The walkthrough owns a temporary SQLite database, generated credentials, and a daemon on an ephemeral loopback port. All thought and connection operations go through HTTP; the script does not populate the database behind the daemon's back.

It demonstrates:

1. Capture, a user contribution, a simulated AI development, and branching continuations.
2. A separate conceptual connection.
3. Single-note rejection with an active descendant still usable by AI, with rejected provenance redacted.
4. Branch preview and confirmed rejection.
5. Restoration of a later subtree without restoring the rejected root or independently rejected connection.
6. Authorship/kind-filtered search with option counts, spellfix typo retrieval, and rejected-material visibility.
7. Simple Markdown export, with before/after thought and connection history checks confirming read-only behavior.

It checks returned records as well as statuses, reports milestones, and removes its listener and temporary data on success or failure. It never attaches to the daemon configured in your shell. Exit status `0` means the scenario succeeded; nonzero means a scenario, request, or cleanup failure.

## Manual testing against a running daemon

Use the helper after following [server startup](server-startup.md):

```sh
bun run api --role user GET /thoughts
bun run api --role user POST /thoughts '{"text":"An idea to explore"}'
```

Unlike `demo`, this helper uses `THOUGHTLOOM_DAEMON_URL` and your selected role's credential. **It can modify persistent data. Use a disposable database for experiments.** It neither starts nor resets that daemon.

The helper prints the HTTP status and readable JSON, or the Markdown body for a successful `text/markdown` response. Configured tokens are redacted from output. Invalid JSON responses still fail when JSON is expected. HTTP, transport, timeout and input failures return nonzero; redirects are not followed, and requests/body reads have a five-second timeout. See [manual request examples](daemon-api.md#manual-requests) for title editing, evolution, inspection and rejection, and the search/export sections for those commands.

## What a green run does not prove

A passing suite is not a deployment test, validation against your personal data, browser UX review, performance guarantee, or proof of real OpenCode/model behavior. It establishes the controlled business, SQL, HTTP and process contracts exercised by the tests. Keep future service and visual validation separate from those claims.
