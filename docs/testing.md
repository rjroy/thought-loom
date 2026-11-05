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

The focused `bun --no-env-file test tests/markdown-import-parser.test.ts` checks the pure Markdown import parser's UTF-8 byte coverage, opaque frontmatter, complete blocks and dependency-safe grouping, strict selection envelope, and structural fallback. It makes no import, daemon, or provider calls. Internal import workers use the parser; there is no exposed import route yet.

### Web foundation checks

```sh
bun --no-env-file run web:test
bun --no-env-file run web:typecheck
bun --no-env-file run web:build
bun --no-env-file run web:test:runtime
bun --no-env-file run web:test:integration
```

`web:test` runs the controlled `tests/web-*.test.ts` unit checks, also included in the ordinary Bun suite. The production runtime harness is a separate opt-in: it builds and starts an owned loopback Next.js server, then uses the installed Playwright package and `/usr/bin/chromium`. It checks trusted Host/mutation Origin handling, generated browser assets and output for test-owned credential sentinels, and the shared shell's navigation, focus, local font, and overflow at desktop/narrow widths. It does not contact the operator daemon or a model provider, and does not install a browser automatically.

The runtime harness copies an explicit allowlist of current working-tree application/configuration files into an owned temporary workspace, installs the frozen root lock there with lifecycle scripts disabled, and builds and starts there with test-owned configuration. Dependencies resolve inside that workspace, not through links to the working tree. Generated `next-env.d.ts` and `.next` files are created by the fixture build, not copied or required from an earlier working-tree build. It excludes personal `.env` files and databases; do not remove personal configuration to run the checks. Update the source allowlist when adding runtime inputs so the fixture continues to represent the application. Bun's environment-file flag does not disable Next.js's independent application environment loading.

Header navigation checks locate the contextual Back control inside the banner, verify its destination-specific accessible name, hover/keyboard-focus tooltip, target and focus treatment, and reject duplicate content-area return links. Idea returns to the previous viewed thought when available, otherwise validated Explore results with query and scroll intact. Evolve/Export retain their contextual destinations and mounted workspace state; root Explore/Capture do not inherit a stale arrow. Parent-title navigation and Export's internal Back to setup remain separate content actions. Both browser source-copy allowlists include the shared contextual-back component.

Browser checks cover the shared foundation, Capture, Explore, Idea, Evolve and Export. The owned fake daemon exercises actual server-side authentication, forbidden-origin rejection before upstream writes, canonical capture receipts, pending double-click suppression, definite denial and deliberate retry, uncertain outcomes without automatic repost, explicit duplicate intent, retained snapshots, and clear-after-success. Controlled `web-capture` unit tests separately cover malformed receipts, failed transport, forbidden caller metadata, optional titles and snapshot copying. Owned HTTP transport tests exercise timeout, redirect denial and redaction. Screenshots alone establish neither API behavior nor complete accessibility compliance.

The Explore companion uses controlled search results and inspection failures, not live project records. It verifies fresh-browser-context bookmarks and reloads, URL-backed facets/UTC dates/sort/scope, canonical thought/reply identity and daemon counts/context, text expansion, known/unknown rejection labels, errors/retry, stale-response suppression, and mobile Filters Escape/focus return. Return-scroll coverage requires a positive position and reports expected/restored values rather than silently skipping a short fixture. Direct bookmarked searches do not depend on a previously mounted provider. Unit `web-explore` tests cover strict query/DTO validation, date helpers with a fixed clock, safe links, bounded/deduplicated thought inspection, client abort forwarding and query-log privacy.

After stopping the owned production server, the harness starts an owned Next.js development server and sends distinct query sentinels through the search API and a bookmarked Explore page. Successful HTTP/upstream controls establish that the requests were exercised; drained development stdout and stderr must contain neither sentinel. This covers framework incoming-request logs as well as the application's separate transport logging tests.

The Idea companion uses a controlled graph and mutation receipts for fresh bookmarks, associated replies, title-only edits/clears, immediate-parent navigation, direct context and on-demand rationale, restore-control eligibility, branch restoration without connection commands, and uncertain writes without replay. Direct context includes children, provenance and discovered connections; overlapping relationships share a thought row without losing labels or connection-specific actions. Tests exclude recursive grandchildren and the old History/Sources disclosures. A held stale-preview scenario verifies that `409` applies nothing, old confirmation becomes unavailable, and the newly returned preview requires another explicit user confirmation with unchanged data. Held writes cannot retarget a newly focused idea. Disclosure checks verify stable enabled-trigger focus after uncertainty, scoped Tab/Escape behavior and outside-click dismissal without stealing title-input focus. Technical `web-idea` tests independently exercise scoped canonical reads, direct-parent rather than ancestor traversal, deduplicated bounded reference reads, unavailable versus failed references, safe links, exact command forwarding (including individual connection restoration), preview snapshots and sanitized outcomes.

The Evolve companion scripts admissions, known-run status, Stop, recorded developments and associated replies at desktop and narrow widths. It distinguishes mounted draft/run return from fresh reload and explicit earlier-Idea entry, continuation selection from browsing, complete from interrupted fallback, saved output from terminal failure, and unconfirmed admission/Stop from confirmed outcomes. Request counts use viewport/operation baselines while preserving the full daemon audit. Reload has a positive selected-thought fetch control in the new document, rejects new-document admission/Stop/run fetches, and independently rejects writes arriving at the fake daemon; a late read initiated by the old document is not evidence of reload recovery. These controlled cases do not establish live provider performance or persistent workspace recovery.

Composer checks require Send beside the labeled contribution textarea on desktop and narrow screens, with a comfortable target, readable input width, no horizontal overflow and logical keyboard order. The redundant empty-contribution helper is absent, while empty/whitespace disabling, pending and unknown-admission guards, retained drafts and meaningful warnings remain covered. This is the explicit user-approved layout deviation from the original mockups, not a change to admission semantics.

Search integration tests also need the [native extension build prerequisites](server-startup.md#native-spelling-extension). Run `bun run build:spellfix` before tests that use the default project artifact, including `search-contract` and `search-scopes`; that ignored artifact is absent on a fresh checkout and is not built automatically by the test command. Separate native pipeline tests compile the pinned vendored source into owned temporary outputs, verify its hash, load it through Bun SQLite, and check tamper and missing-artifact failures. Those temporary builds do not populate the default artifact. No system extension is assumed.

The Export companion exercises independent methods, contextual normal-scope roots, exact UTF-8/line-ending bytes in downloads without another export request, frozen Agentic admissions, known-run Check/Stop, and successful artifact-read gating rather than status-only readiness. It checks unavailable roots without disabling Agentic, uncertain admission without replay, safe previews and producer-appended source links resolved only in normal scope. Hidden-root navigation retains a bounded network-idle check with request diagnostics. Unit cancellation spies verify that abandoned browser response bodies are released even on unexpected status/content type, without changing outcome classification if cleanup fails. This protects navigation from unfinished no-store error responses.

`web-export-markdown` runs the actual shared renderer through ReactDOMServer, with positive formatting/text controls and hostile HTML/link/image inputs. It does not substitute a fake renderer for safety evidence. Bun test registration stays in the root wrapper; the app-local helper has no Bun test-runner dependency. Source parser tests separately cover the producer's code-delimited JSON-ID appendix grammar and reject arbitrary body links as source identity. These checks do not prove live provider report quality.

The Idea metadata check requires About to share the existing desktop action row while allowing narrow wrapping. It exercises the disclosure's expanded state, keyboard activation and retained focus, then checks the existing metadata inside that disclosure rather than matching repeated source IDs elsewhere on the page. Opening About must not alter the selected thought or add a metadata-fetch operation. Resting-state checks require Edit title, Full reply, About and More actions to remain native buttons with underlined text using the existing link-color token, distinct from focal thought text.

### Shared-record browser acceptance

`web:test:integration` is a separate opt-in, not part of the ordinary test suite. Its built-in-only bootstrap copies an explicit set of current source/configuration inputs into an owned workspace, installs the frozen lock, builds the checksum-verified spellfix extension there, and starts the inner fixture with dependencies resolved inside that copy. It does not reuse private environment files, personal databases, generated launchers or ignored working-tree build artifacts.

Unlike the per-screen fake-daemon runtime, this walkthrough connects the browser and production Next server to a real owned Hono daemon backed by temporary SQLite and injected deterministic fake-agent callbacks. Desktop and narrow paths follow the same Capture-created identity through Explore, Idea, Evolve and both exports, including the actual persisted AI interpretation, its parent/provenance, title changes, rejection/restoration and mounted known-run return. Non-export work settles by explicit state predicates before knowledge-table snapshots, and the intended Evolve follow-up weave must publicly complete rather than merely reach any terminal status. Fake interpretations cite their own job's fully read subject. Run/report bookkeeping may change without implying a knowledge mutation. Held fake responses are released before daemon drain, and cleanup attempts all owned resources even if an earlier release fails.

This proves controlled shared-record continuity, not real provider behavior, cross-reload workspace persistence, physical-device usability or screen-reader certification. Keep the detailed per-screen tests for recovery, focus, safe Markdown and request boundaries rather than duplicating every edge case in this walkthrough. Neither browser command starts or changes the operator OpenCode service.

## Test boundaries

| Boundary | What the tests establish | Files |
| --- | --- | --- |
| Domain | Validation, immutable content, single-parent traversal, semantic creation, title authority, shared-response visibility, run identities and recovery using controlled inputs and repository/dispatcher doubles. | `domain`, `creation`, `rejection-domain`, `titles-domain`, `shared-responses-domain`, `runs-domain` |
| SQLite | Foreign keys, immutable-record triggers, source/response seals, atomic admission and receipts, rejection persistence, migrations and reopen behavior. | `sqlite`, `rejection-sqlite`, `titles-sqlite`, `shared-responses-sqlite`, `runs-sqlite` |
| Indexed search | FTS5 backfill and transactional title/reply maintenance, scoped retrieval and vocabulary, interrupted replies, rejection/restoration, unchanged-cache reuse and native extension build/load failures. | `search-index`, `search-scopes`, `search-efficiency`, `search-native` |
| Search context | Connected thought text relevance independent of result facets/sort, stable ties, immediate-predecessor fallback, response-hit destinations, corrected queries, and exclusion/redaction of rejected surrounding material. Uses isolated SQLite and controlled search fixtures. | `search-contract` |
| Simple export | Evolution-only breadth/depth traversal, count semantics, traversal through rejected intermediates, addendum exclusion, Markdown attribution, read-only behavior and user-only HTTP authorization. | `simple-export` |
| Agent protocol kernel | Strict whole-envelope parsing, ordered prompt migration and exact input, per-step completion, atomic advancement/replay, reopen and durable cancellation settlement. | `run-protocol-domain`, `run-protocol-sqlite` |
| Typed agent operations | Step-owned receipts, title-fill no-op replay, interpretation/connection writes, effect rollback, export write denial, weave intent and no-findings/failure outcomes. | `run-operations` |
| Agent configuration and adapter | Optional/malformed configuration, Basic discovery headers and Bearer transport, immutable session binding, paginated history correlation, uncertain admission, quarantine and cancellation using controlled facades and owned HTTP fixtures. | `agent-config`, `opencode-adapter` |
| Scoped capabilities | Narrow AI search/read projections, exposure tracking versus full-read witnesses, connection/source prerequisites, malformed authority, replay and Stop/rejection fences, witness/final-cache rollback, populated predecessor migration and export write denial. | `capabilities`, `capability-migration` |
| Worker core | Controlled native execution of ordered steps, scoped initial context, capability/reply processing, no-findings weaving, absent configuration, uncertain admission, local pause, Stop/rejection and malformed output. | `worker` |
| Weave scheduling | Capture/title-clear/Evolve-follow-up admission, paired domain/job rollback, trigger deduplication and no recursive scheduling from weaver writes. | `scheduling` |
| Supervisor | Eligible-run scans, overlapping-poll coalescing, independent progress, pause-before-drain shutdown and queued capture/title-clear jobs through unconfigured HTTP runtime. | `supervisor`, `supervisor-runtime` |
| Logging | Level thresholds and configuration, independent daemon sinks, quiet Info polling versus Verbose diagnostics, visible capture events, privacy, warning/recovery episodes and unconditional readiness. | `logging`, `daemon` |
| Configured daemon | Owned HTTP Weave/Evolve/status/Stop flow, unavailable service and role/credential boundaries; file-backed restart, cached-result recovery, held SDK shutdown and endpoint credential isolation. | `agent-runtime`, `runtime-recovery` |
| Agentic export | Strict report envelopes, immutable request/effort, full-read citations and attribution, rejection/Stop fences, atomic artifact finalization and independent knowledge-write denial; runtime admission/download, read-only index snapshots, configured variants and bound restart. | `agentic-export`, `agent-runtime` |
| Hono request API | Authentication, role restrictions, strict request bodies, response/status contracts, scoped relationship discovery, explicit rejection metadata for user inspection, and sanitized logging without a network listener. | `api` |
| Web server boundary | Test-owned origin configuration, trusted Host and mutation Origin, server-side bearer transport, path restrictions, no-store requests, redirect denial, timeouts, and sanitized errors/logging. Owned redirect fixtures never contact the operator daemon. | `web-boundary` |
| Web Capture command | Fixed-purpose payload forwarding, canonical receipts, known rejection versus uncertain admission, safe errors, optional title and immutable submitted snapshots. Browser interactions use the separate production runtime harness above. | `web-capture` |
| Web Explore read | Fixed search parameter mapping, canonical result/context/count preservation, safe links, UTC date helpers, bounded inspection and unknown status, abort forwarding, and sanitized query/error handling. | `web-explore` |
| Web Idea read/command | Scoped records and response association, on-demand known-link history/sources, strict title and rejection/restoration commands, immutable branch previews, conflict/uncertainty outcomes, and frozen command targets/payloads. | `web-idea` |
| Web Evolve operations/reads | Canonical text-only admission, known-run observation and Stop, immutable submitted snapshots, ordered output/reply resolution, normal-scoped thought reads and associated-response gating. | `web-evolve`, `web-evolve-read` |
| Web Export operations/preview | Independent Simple/Agentic commands, export run identity, artifact-read gating, exact bytes, abandoned response cleanup, producer appendix parsing and normal source resolution; actual Markdown SSR safety and formatting. | `web-export`, `web-export-sources`, `web-export-markdown` |
| Native daemon | Real HTTP plus SQLite, startup validation, persistence across restart, concurrent captures, port conflicts, bounded failure cases and process signals. | `daemon` |
| Scripts | Request validation and diagnostics with injected fetch, plus a real isolated walkthrough and cleanup on success/failure. | `scripts` |

Names in the last column refer to `tests/<name>.test.ts`. Some files contain integration checks as well as small unit cases; choose the boundary needed for the change, not just the filename.

The import-attribution/storage-foundation slice can be checked without a parser, browser, provider or operator service:

```sh
bun --no-env-file test tests/domain.test.ts tests/search-contract.test.ts tests/sqlite.test.ts tests/capability-migration.test.ts tests/markdown-import-foundation.test.ts
bun --no-env-file run typecheck
```

Build spellfix first for `search-contract` as described above. These checks cover exact imported thought text and later title attribution, unchanged user/AI combinations, source/imported-original filter/count shapes, fresh import membership/seal FK declarations, and populated predecessor preservation/reopen. The dedicated foundation fixtures also exercise direct-SQL seal and mapping guards, deferred-commit failure and rollback, reservation interleaving across two connections, bounded write-lock contention, rejection-safe inspection, and finalization rollback at 11 injected points including the last weave admission. Migration fixtures inject failures during staging and after destructive rebuild work has begun. These establish controlled transaction behavior, not simultaneous independent-worker execution or a large-database performance benchmark. The storage fixtures use test-owned parser manifests/ranges; the separate parser tests exercise the implemented Markdown preparation and selection functions. Neither suite establishes import-native terminal correlation or HTTP upload behavior.

The separate no-agent daemon integration check is:

```sh
bun --no-env-file test tests/markdown-import-runtime.test.ts tests/markdown-import-foundation.test.ts tests/opencode-adapter.test.ts tests/import-authority.test.ts tests/supervisor-runtime.test.ts
```

`markdown-import-runtime` admits controlled source bytes through internal storage and starts an owned Hono/SQLite daemon. Unconfigured cases cover structural finalization, duplicate waiters, bounded local progress, metadata-only inputs, restart from a saved partition, pause, Stop and corrupt staging. The configured case injects an in-memory native facade and checks one restricted owned prompt, standard variant, validated AI grouping, exact private preparation, source preservation and atomic weave admission. It uses no HTTP import admission, provider or operator service. `opencode-adapter` separately tests import-only terminal classification, full history, exact output and fencing; `import-authority` exercises persisted SQLite observation authority and its negative cases. These tests do not yet establish the full configured fallback/restart/race/cancellation matrix or large-vault scheduler performance. Source-copy harnesses that start the real daemon must include `src/agent/import-driver.ts`, `src/agent/import-worker.ts`, `src/storage/import-authority.ts`, `src/storage/markdown-import.ts` and the parser facade/implementation/contract; the shared-record bootstrap explicitly enumerates these inputs. The fake-daemon browser foundation does not import the Hono runtime and needs no such expansion.

Exact-text fixtures must compare submitted wording, stored BLOB bytes and returned thought/search/projection text, including a segment beginning with U+FEFF after a leading separator. Equality between pre/post-migration database reads alone can hide a character lost during an earlier write. Thought writers bind UTF-8 bytes and cast to TEXT to avoid Bun's consumption of a leading U+FEFF in a string parameter.

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

Deterministic agent tests supply controlled model proposals and replies. They check the rendered weave discovery instructions and establish conditional title filling, scoped capabilities, full-read evidence, saved developments and run behavior, not that a model will discover connections, semantic model quality or live-provider availability. Other command/API tests still simulate AI-authored calls directly.

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

## Rough local agent setup

```sh
bash scripts/setup-test.sh
# In one terminal:
scripts/daemon.local.sh
# In another:
scripts/web.local.sh
# Open http://127.0.0.1:3000/capture
# Optional agent smoke test in a third terminal:
scripts/demo.local.sh
```

Setup builds spellfix and runs checks, then writes private matching daemon, web and demo launchers without resetting `.data/thoughtloom.sqlite`. The web launcher runs the Next.js development server with the matching user token and daemon URL, plus `THOUGHTLOOM_WEB_ORIGIN=http://127.0.0.1:3000`; it does not embed the AI token, database path or agent configuration. Setup itself starts no services or browser. It preserves an explicit `THOUGHTLOOM_AGENT_CONFIG`; otherwise it selects `openai/gpt-6.1-sol` with `quick: low`, `standard: medium`, and `thorough: high`. The generated daemon discovers the operator-managed OpenCode service lazily when agent work needs it; that service must provide the selected model and variants. Supply explicit configuration to choose a different model or variants. Validation checks exclude agent configuration and do not use the live model.

**Starting the generated daemon can process existing queued weaving; captures and Evolve actions in the site, or running the generated demo, can also trigger real model work and incur charges.** The smoke client waits up to 45 seconds per run, then prints an inspection hint without stopping the daemon-owned work. Rerunning setup generates new daemon credentials, so restart both the test daemon and web client with their matching new launchers. Setup does not start or change the OpenCode service.

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
