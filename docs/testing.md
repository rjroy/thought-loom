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

Tests supply their own configuration and data rather than relying on your running daemon. They do not require a browser, model provider, or OpenCode service.

Search integration tests also need the [native extension build prerequisites](server-startup.md#native-spelling-extension). Run `bun run build:spellfix` before tests that use the default project artifact, including `search-contract` and `search-scopes`; that ignored artifact is absent on a fresh checkout and is not built automatically by the test command. Separate native pipeline tests compile the pinned vendored source into owned temporary outputs, verify its hash, load it through Bun SQLite, and check tamper and missing-artifact failures. Those temporary builds do not populate the default artifact. No system extension is assumed.

## Test boundaries

| Boundary | What the tests establish | Files |
| --- | --- | --- |
| Domain | Validation, immutable content, single-parent traversal, semantic creation, title authority, shared-response visibility, run identities and recovery using controlled inputs and repository/dispatcher doubles. | `domain`, `creation`, `rejection-domain`, `titles-domain`, `shared-responses-domain`, `runs-domain` |
| SQLite | Foreign keys, immutable-record triggers, source/response seals, atomic admission and receipts, rejection persistence, migrations and reopen behavior. | `sqlite`, `rejection-sqlite`, `titles-sqlite`, `shared-responses-sqlite`, `runs-sqlite` |
| Indexed search | FTS5 backfill and transactional title/reply maintenance, scoped retrieval and vocabulary, interrupted replies, rejection/restoration, unchanged-cache reuse and native extension build/load failures. | `search-index`, `search-scopes`, `search-efficiency`, `search-native` |
| Simple export | Evolution-only breadth/depth traversal, count semantics, traversal through rejected intermediates, addendum exclusion, Markdown attribution, read-only behavior and user-only HTTP authorization. | `simple-export` |
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

Actual weaver title generation is not covered because the weaver is not implemented. AI-authored developments and title fills in these tests are simulated calls to the existing command/API boundaries.

Run tests use a controlled `NativeDispatcher`, not the real OpenCode client. They establish domain/storage recovery and fencing, not worker scheduling or native service compatibility. Claim generation is not an expiry-based lease or a model effort quota.

Search tests exercise actual FTS5 and spellfix1 using test-owned records. Retained interrupted fallback replies remain searchable through their associated input without becoming completed developments. Efficiency checks observe graph-snapshot and vocabulary-rebuild boundaries rather than asserting machine-dependent timing. `search-contract` covers filter combinations and option counts, creation-date sorting, response metadata, modest query correction, and strict authenticated HTTP search. These checks do not establish browser behavior or final relevance tuning.

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
