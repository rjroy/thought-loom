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

### Additional agent instructions

```sh
bun --no-env-file test tests/agent-instructions-api.test.ts
bun --no-env-file test tests/agent-instructions-worker.test.ts tests/media-path-worker.test.ts tests/capability-migration.test.ts
bun --no-env-file test tests/backup-schema.test.ts tests/backup-format.test.ts tests/restore-decode.test.ts tests/restore-target.test.ts
```

The settings API tests use owned daemon/SQLite fixtures for global defaults,
atomic revision-checked saves, authorization, exact text, restart, request limits
and private logging. Controlled native clients exercise role-specific guidance,
initial-preparation capture, synchronization failure, lost acknowledgements,
capability exchanges and the next turn of an existing Search conversation.
Import segmentation remains a positive exclusion control. These tests do not
call an operator service or establish provider compliance with textual guidance.

Migration fixtures preserve populated guidance, including leading BOM, and
legacy absence through schema rebuilds. Versioned backup checks cover logical-2
settings/guidance and logical-1 restoration to explicit empty defaults. These
commands describe test boundaries, not a claim that all checks passed on the
current revision.

The Settings browser checks use:

```sh
bun --no-env-file test tests/web-settings-boundary.test.ts tests/web-settings-request.test.ts
THOUGHTLOOM_TEST_SETTINGS_CASE=all bun --no-env-file run web:test:runtime
```

The built-Next fixture and owned browser exercise the fixed server-side route,
bookmarkable Settings page, global save/reload, exact text and clearing, UTF-8
field limits, accessible feedback, conflicts, and edits made while a save is
pending. Its controlled daemon fixture is not a real SQLite round trip or a
provider integration. Both browser harness source-copy allowlists include the
Settings runtime inputs; the shared-record harness also includes the new daemon
settings modules.

Both source-copy allowlists include the approved `backgrounds/settings-notebook.png`
and `backgrounds/browse-cat.png` runtime PNGs, not their authoring packages. The
focused Settings/Browse browser checks compare served bytes with the approved
production sources and verify decorative semantics, disabled dragging/pointer
events, desktop placement and narrow-screen omission. Browse also checks that
the cat is absent from its map; Settings verifies that the notebook fits beyond
the unchanged introduction rather than covering its copy. These are controlled
browser checks, not physical-device, screen-reader or runtime visual acceptance.

Request-helper tests use owned response streams to verify best-effort,
nonblocking cancellation of discarded error bodies. Cancellation failure does
not replace the request classification, and successful JSON responses are
consumed normally. Browser navigation retains its existing network-idle waits.

The focused chronological Browse API checks use `bun --no-env-file test tests/browse-api.test.ts`. Their owned in-memory SQLite fixture exercises HTTP pagination, equal-time ordering, query and cursor binding, invalid input, visibility and media/source projections, live continuation and avoidance of the rejection snapshot. This is not a large-library performance measurement or a browser test.

The direct-neighborhood HTTP fixture uses `bun --no-env-file test tests/neighborhood-api.test.ts`. It covers directed edge roles, duplicate provenance occurrences, page endpoint resolution and high-degree walks, rejection and AI evidence redaction, malformed requests and cursor binding without a rejection snapshot. It does not measure SQL scan/sort work or exercise a browser.

The client Browse checks use `bun --no-env-file test tests/web-browse.test.ts`. Test-owned query/DTO fixtures and injected page readers cover filter/bookmark encoding, the fixed Next server boundary, inspection flags, safe request failures, continuation serialization, duplicate suppression and stale scope-change completion. The client reuses the existing thought validator; full conversational responses are not catalog rows. These checks do not render React or establish layout/scroll behavior.

The local-map client checks use `bun --no-env-file test tests/web-browse-map.test.ts`. Controlled neighborhood readers and supplied layout geometry cover safe root/return URLs, the fixed server/browser boundary, scoped thought/connection projection, role and source-occurrence identity, explicit per-node continuation, selection without reads or camera movement, accumulation, unavailable nodes, read/restart recovery and stale root/scope/invalidation completions. Layout checks preserve existing positions and fit supplied bounds; they do not pin the visual design's production spacing or establish large-graph performance.

`THOUGHTLOOM_TEST_BROWSE=1 bun --no-env-file run web:test:runtime` selects the isolated built-Next Browse browser check at desktop and narrow sizes. Its owned daemon fixture exercises list navigation/pagination, rapid sort/authorship/inspection changes and history, bookmarks/reload, empty selection without a daemon read, reset, empty states and browser credential isolation. Its map journey covers actual written relationship roles, inspection without fetching, Linked list keyboard selection, explicit paginated expansion, camera controls, mounted Idea return versus reload, rejected-scope reset, unavailable/disconnected roots and non-root Idea entry. The shared-record `web:test:integration` walkthrough visits/reloads Browse, inspects and expands the real owned daemon/SQLite neighborhood, opens Idea and returns to the map/list without modifying library knowledge. These descriptions name test boundaries, not a report that this revision passed. They do not establish all read-recovery interleavings, physical-device behavior or accessibility certification.

Both browser source-copy allowlists include Browse's list/map pages and fixed API routes, query/DTO/request/controller/server modules, incremental map layout, mounted-memory provider, views and CSS modules. No design comp or private data is a runtime fixture. List bookmarks contain filters, not cursors: reload starts a fresh live walk. Loaded pages and reading position are document-local memory for in-app return; they are not persisted across reloads. A map bookmark contains its starting thought/scope and safe list return, not an expanded graph or inspected selection; reload reads one starting neighborhood. Tests use neither an operator service nor a provider for these reads.

### Continuous integration

The [GitHub Actions workflow](../.github/workflows/ci.yml) runs on pull requests and pushes to `master`. On GitHub-hosted Ubuntu 24.04 it uses Bun 1.4.3 and frozen dependencies, builds spellfix, runs the root tests and typecheck, builds and typechecks the web app, and runs both full browser foundation and shared-record integration suites. Commands use `--no-env-file`; the fixtures use owned data and deterministic fake agents, not repository secrets, an operator service, or a model provider. Native acceptance remains separate.

The job creates `/tmp/opencode` and checks for the image's preinstalled `/usr/bin/chromium`, the path required by the browser harnesses. The runner image and its Chromium version can change; the workflow does not install or pin the browser. It also relies on the hosted image's compiler and SQLite development headers for spellfix, and network access for dependency installs. Browser bootstraps install the frozen lock in their own source copies; the integration bootstrap builds its own spellfix. A workflow run must pass on GitHub before hosted compatibility is established.

### Backup and recovery validation

The [portable backup/recovery contract](backup-restore.md) has online capture/Git delivery, whole-attempt source/workspace ownership, manual backup, configured daemon scheduling, WAL startup, canonical codecs/compiled inventory, immutable fences/authority guards, private staging/recovery and offline destination restore with a standalone command. The [selected-revision walkthrough](#selected-revision-recovery-walkthrough) composes these boundaries; the focused suites below retain their distinct coverage and limits.

`bun --no-env-file test tests/restore-startup.test.ts` covers startup refusal for regular, dangling-symlink and directory marker entries under the actual execution lease, before WAL/migration or producers, with owned data and lease-contention checks. This describes the test boundary, not a claim of a passing run or of implemented offline restore or complete historical-work isolation.

`bun --no-env-file test tests/restore-run-fences.test.ts` uses migrated owned SQLite, explicit fence records and native/resolver tripwires. Its core cases cover queued/already-claimed authority, preparation/binding and idempotent generic Stop with unchanged journals; cached read/write receipts, new capability and legacy-write refusal; configured direct-tick discovery refusal; terminal pending cancellation without native construction or settlement; and export-specific local Stop/deletion without calling the old provider, including a stale post-deletion tick. Unfenced positive controls retain claim, binding, write, discovery and cancellation behavior. These describe the focused test boundary, not a report that this revision passed. This suite does not establish the separate entity/coordination boundaries below or a complete restored-startup walkthrough.

The export history/lifecycle storage slice uses `bun --no-env-file test tests/agentic-export.test.ts tests/restore-run-fences.test.ts`. Test-owned SQLite fixtures check user-only bounded metadata history, complete local report/execution deletion, knowledge/unrelated-run preservation, active/pending refusals, settlement, restored local acknowledgement with unchanged historical execution/cancellation/fence before Delete, rollback and reopen. No live agent or credentials are fixtures. HTTP history/deletion and browser behavior are separate slices. Logical-3 disposition preservation, logical-1/logical-2 defaulting and a full backup→restore→discard round trip require their separate backup coverage; the direct-fence fixtures do not substitute for it.

The same suite includes rowless fence lookup and refusal after owned schema/immutable-trigger changes. Its leading-BOM alias controls exercise claim/Stop preservation, valid cached reads/write receipts and pending writes, plus configured discovery with canonical unfenced positive controls. The guard checks actual binding-byte consistency rather than a runtime-version gate; broader Unicode-ID execution support and every literal-ID/cleanup combination are not established by these cases. Coverage descriptions are not a claim of a passing rerun.

```sh
bun --no-env-file test tests/restore-import-fences.test.ts tests/restore-coordination.test.ts tests/restore-search-fences.test.ts
```

These suites use migrated owned databases and explicit fences, not a loader or operator service. Import cases exercise historical keyed replay versus new batch admission/sealing, prepared/private input and choice/claim/failure/finalization refusal, retained payloads and a configless fenced-waiter scan, with fresh local publication controls. Coordination cases retain old keyed histories while testing fresh Reinterpret/title-clear dispatch, unsettled/unverified old weave exclusion, rejected-subject denial and supervisor capacity filtering. Search cases use a held/registered owned execution lease, genuine normal worker submissions and a deterministic native client for composer-token refusal, qualified rowless cleanup authority, cached cleanup identity refusal, scanner exclusion and mixed historical/fresh local Delete. These are the intended focused validation boundaries, not a report of a passing rerun.

Further controls are still needed for Evolve/media admission across historical fences, already-admitted search-key replay after composer fencing, terminal-certificate/late-ACK payload refusal, held import/native boundaries, generic entity-kind aliases and broader mixed-state combinations. The separate loader/recovery and walkthrough suites below cover recovery transitions, slot/reservation release, destination publication/rollback and configured/configless startup. No full inert-recovery guarantee follows from inserting fence rows in a running fixture alone.

```sh
bun --no-env-file test tests/restore-decode.test.ts tests/restore-staging.test.ts
```

The decoder cases use test-owned raw cells for signed-int64 extrema, BLOBs, nullable fields, BOM/CRLF text and canonical row/key ordering; they reject malformed storage tags, null primary keys, invalid UTF-8/base64, duplicate identities and incomplete/noncanonical manifests. Staging uses an owned current-schema daemon/SQLite/capture fixture, not the frozen migration predecessor with its extra unsupported table. It compares all 42 raw table projections, retained rowids/sequences/media bytes, existing fences and original run facts, checks derived search/SQL integrity and reinstated immutable guards, and checks closed-DB disposal. Recomputed-hash missing-parent/seal cases must fail as invalid records; missing/extra/symlinked payloads, digest/JSON-budget mismatches and pre-abort must preserve caller entries. Unknown disposal content must remain untouched. These describe the suites, not a claim that this working-tree revision passed.

RC-01 staging cases recompute canonical bytes and hashes with oversized `eligibility`, `retrieval`, `catalog`, retained-document sequence and preserved import-file rowid values; these must fail as `invalid-records` without changing caller entries or the source snapshot. A positive control retains the inclusive safe maximum for catalog/document sequence and full-int64 ordinary-run generation/manifest high-water values. The other designated application revision/cursor fields use the same shared range check but are not individually exercised by these cases; capture-side range refusal is not separately established by this staging suite. No passing rerun is claimed here.

Staging caps manifest/per-table/aggregate JSON inputs and streams originals; it is not a hard process RSS/deadline boundary and does not preempt synchronous parsing/SQL. Held-copy mutation/abort, replacement/inode races, descriptor-close faults, mid-load storage faults, broader cyclic/sealed legacy combinations and crash/power-loss behavior still need dedicated controls. A successful stage deliberately retains its startup marker and applies no recovery transitions/new fences. No final-target publication or inert recovered-installation guarantee follows from these tests.

```sh
bun --no-env-file test tests/restore-recovery.test.ts
```

The recovery suite composes genuine owned capture/staging with retained ordinary/search runs, a qualified rowless cleanup journal, pending import holder/waiter payloads, composers and a prior fence. It checks missing identity fences and exact qualified before-value JSON; active-run interruption/generation changes and slot release without a false Stop reason; retained terminal maxima, payloads, dependencies/native journals and source/marker bytes; repeat/different-timestamp behavior; ordinary generation overflow; rollback at the safe `recovery validated` log boundary; disposal and forged/disposed/unknown-artifact refusal. These are source-read coverage descriptions, not a report of a passing rerun.

Search-generation overflow, concurrent recover/dispose joins, unusual identity-byte cases, close/commit/storage faults, broader preserved-field combinations and adversarial path replacement are not individually established by this suite. Recovery shares the staged input bounds and cooperative-cancellation limits, not a new process RSS/deadline boundary. Destination publication, configured/configless startup and the synthetic measurement have separate evidence below; this suite alone does not establish a complete recovered installation.

```sh
bun --no-env-file test tests/restore-target.test.ts tests/restore-command.test.ts
```

The target suite uses a genuine owned capture with BOM text, retained Markdown/media, sequence high-water values and historical runs. Its reference is a separately staged/recovered copy. It compares the final 42-table/sequence state and originals, FTS/integrity/guards, an existing-empty and an absent target, the unchanged source snapshot and the fixed target DB inode. At synchronous target ownership/marker/commit/validation logs, it inspects the actual inode/marker; the durable-marker boundary also starts an owned competing process against the real execution lease and confirms the main DB still has no schema. Refusal cases cover occupied/symlink targets, invalid input, pre-abort and a genuinely held zero-byte placeholder lease. Aborts after the durable marker and after DB commit must retain the marker, release ownership and block daemon startup before resolver/client creation. These are source-read test boundaries, not a report of a passing rerun.

Command cases isolate parsing/exit behavior with a typed restore-operation dependency, controlled clock, signal and supplied environment. They reject unknown/duplicate/missing/relative/NUL/hash-invalid arguments before service entry, ignore unrelated role/agent/backup settings, check failure/cancellation joins and safe logs, and import the real module in an owned no-env-file child without installing signal handlers or reading its dotenv. They do not themselves perform a full command-driven installation or OS-signal walkthrough.

Mid-write I/O/close faults, marker-unlink/directory-sync uncertainty, stronger path/inode races, target permission assertions and real CLI signal cleanup still need their own controls. Configured/configless restored startup with fresh work is covered by the walkthrough below. The read-only zero-placeholder contention classifier never authorizes adoption of an unheld nonempty directory. Shared loader changes require rerunning the decoder/staging/recovery regressions. Standalone source copies must include `restore-staging.ts`, `restore-recovery.ts`, `restore-load.ts`, `restore-target.ts` and `scripts/restore.ts`; these introduce no new daemon/browser runtime imports. No hard RSS, capacity or power-loss guarantee follows from these suites.

`bun --no-env-file test tests/backup-config.test.ts` covers optional, closed configuration, lexical checkout isolation and sanitized invalid settings with test-owned inputs. It does not establish physical path safety or Git delivery. This describes the validation boundary, not a claim that the check was rerun.

`bun --no-env-file test tests/daemon-wal-startup.test.ts` exercises WAL before migration, preservation of existing data, lease contention and a read snapshot concurrent with a daemon write using owned databases. This is not proof of a backup implementation, bounded capture or recovery.

```sh
bun --no-env-file test tests/backup-format.test.ts tests/backup-schema.test.ts tests/media-source-migration.test.ts
```

The format/schema suites use test-owned raw bytes/integers and migrated in-memory databases for canonical encoding and compiled inventory boundaries. The media migration suite additionally uses its independently frozen populated predecessor to check additive empty fence storage, immutability and preservation through repeat migration/reopen. Migration may preserve an unrelated custom table while backup inventory validation deliberately refuses it as unsupported. These commands describe the focused validation boundary, not a claim that this working-tree revision has passed. The encoder validates metadata shapes, not actual source/file membership or hashes; the separate entity guards do not create fences or implement a loader.

Daemon source-copy allowlists must include `storage/restore-fences-schema.ts`, `storage/restore-fences.ts`, `storage/search-projections.ts`, `domain/export-history.ts`, `storage/export-lifecycle-sql.ts` and the actual backup runtime closure: scheduler/whole-attempt/capture/Git/workspace codecs now also import `backup/records.ts`, `backup/snapshot.ts` and `backup/decode.ts`. Include the fixed `capture-worker.ts` subprocess entry and its reader inputs for configured capture. The integration bootstrap includes these dependencies even when automatic backup is disabled; the standalone `restore-staging.ts` API is not a daemon runtime import. The separate browser foundation harness needs no backup inputs unless its own import closure changes. No private environment or ignored build output is a fixture.

```sh
bun --no-env-file test tests/backup-capture.test.ts
```

The nine-case capture suite owns a real loopback daemon/WAL SQLite database, private original files and an output parent with caller-owned entries. It checks complete deterministic payload/count/hash/original bytes, last-good preservation on missing/corrupt files and marker conflict, pre-abort refusal, rollback-mode/restore-marker/unknown-schema refusal and transactional thought-group coherence during real writes. It does not use an operator service/provider and does not establish standalone restore or a recovered-installation no-replay walkthrough. Commands describe the test boundary, not a report that checks were rerun for a docs-only change.

Controlled cases hold the owned child after `source snapshot established`, while its real read transaction is pinned. Later SQL changes and an HTTP media admission remain outside that snapshot while their committed source state is preserved. Held-child source/total deadline and in-flight abort cases check rejection, child exit/join and untouched caller-owned output; an undersized RSS budget checks sampled-watchdog refusal without publication. Concurrent identical captures check verified destination reuse; corrupted manifests, extra files and a destination manifest symlink check conflict refusal without replacement. Missing source seals and dangling run-context references check invariant refusal without changing the source or last-good snapshot. Controlled logs are checked for fixture-content and credential leakage.

Held cleanup-gate races, adversarial source path/inode replacement during capture and large-library capacity remain unproved. These cases do not establish a hard RSS ceiling, daemon-impact/performance bounds or crash/power-loss recovery. For further controlled checks, `CaptureOptions.logger` exposes the owned PID at snapshot establishment before one-shot scan authorization, and `source snapshot released` follows connection close. `limits` accepts explicit owned technical budgets; the production streaming-file helper's lifetime guard permits owned filesystem mutation at a verified read boundary without global filesystem mocks. No timing-only assertion, empty refusal fixture or standalone rename primitive probe is complete capture evidence.

```sh
bun --no-env-file test tests/backup-capture-monitor.test.ts
```

The monitor suite uses controlled status readers and real owned workers. It covers open/read `ENOENT`/`ESRCH` as no sample, short-read assembly, empty/truncated/bad-token and live permission/I/O refusals, descriptor closure, delayed exit observation after a vanished read, pending-read joins, rejection of an incomplete killed worker, retained RSS-limit failure and sanitized diagnostics. Complete nonterminal missing-RSS frames are delivered both after actual exit0 with observation held, and before actual exit while the owned worker is SIGSTOP-held. The latter uses an owned reconciliation-timer dependency: registration witnesses entry, then tests resume the real worker, trigger expiry while it stays live, or abort. They compare successful completion digests with the actual manifest, check closed readers/timer disposal, and deliver stale expiry callbacks before/after settlement without racing a production timer. A genuinely bad RSS token must never enter reconciliation. These are source-read coverage descriptions, not a report of a passing rerun.

The status reader caps each sample at 8192 bytes and 8192 read calls, accepts a numeric `VmRSS` line without waiting for unrelated trailing fields, and fails closed when its budget is exhausted without a usable result. Missing RSS with valid `Z`/`X` state means no sample. A complete eligible nonterminal missing-RSS EOF record remains a reader refusal, but its owning supervisor can reconcile it against actual child exit within a fixed 100 ms window; expiry is fatal, not a fabricated zero-RSS sample or an unbounded exit wait. See the [capture limit/eligibility contract](backup-restore.md#internal-invocation-and-limits). Actual exit0 and complete protocol remain mandatory, and already latched memory/abort/deadline failures remain failures. The internal `openStatus`, `observeExit` and `startReconciliationTimer` seams control owned reader/lifecycle/timer boundaries only, not public `CaptureOptions` or a configurable grace period. Error-level diagnostics contain static stage/category and optional parse-reason values, never raw errors, proc contents or paths.

The actual retained `/proc` descriptor case is conditional on the host reporting `ESRCH`; controlled cases do not depend on winning a kernel timing race. A native observation or controlled missing-RSS reproduction establishes a possible lifecycle shape, not the exact cause of a historical CI failure, its startup-versus-exit phase, or a concurrent-load explanation. Budget/invalid-read-count, additional record-shape/identity cases, close-fault combinations, actual-default-timer expiry under load and wider scheduling/resource behavior still need dedicated controls. None of these tests establishes a hard RSS ceiling or guarantees every missing-memory condition will reconcile successfully.

```sh
env -i PATH="$PATH" bun --no-env-file test tests/backup-git-delivery.test.ts
```

The Git suite uses actual capture output and owned private checkouts/local bare repositories. Its 13 baseline cases cover snapshot-only/no-op/changed commits; offline fresh-process retry and divergence without rewriting history; unrelated/symlinked/dirty checkout and unexpected/symbolic/non-ancestor ref refusal; bounded held-lease delivery composition, cross-process exclusion and OS-released ownership; completed add/commit with lost acknowledgement and fresh-process recovery; unknown pending HEAD/index/file refusal; uncertain push confirmation; valid remote adoption versus unrelated payload refusal; owned host hook/filter/signing traps; and default-runner abort with Git exit and no running owned group helpers. [`backup-git-child.ts`](../tests/backup-git-child.ts) supplies explicit retry/default-runner processes. Most cases inject real Git with a validated `https://backup.invalid/owned/fixture.git` URL rewritten to the owned bare repository; default-delivery cases configure only an owned HOME/local mapping. No real backup account, host credentials, network, operator service or provider is a fixture.

Two additional default-runner cases exercise inherited child umasks `0077` and `0002`, including initial/changed delivery, offline retention, fresh-process retry and metadata permissions. The production runner uses a fixed `/bin/sh` setup to set child-only `umask 077`, then `exec`s Git with separate argv; neither caller umask changes nor user-value interpolation into shell code is required. This describes fixture coverage, not a claim that checks were rerun for later changes.

A forced 60-second Git deadline, output-overflow refusal, broader mid-write crash/power-loss recovery and adversarial payload/path/inode races remain unproved. `DeliveryDependencies.runGit` receives actual argv/cwd/signal, and verbose command attempt/finished logs expose only the safe operation name for owned holds/failures. Replacement-runner fixtures own their subprocess cleanup and do not prove the default runner's environment or descendant lifecycle; the separate default-runner cases cover only their stated boundaries. The Git held-lease case checks delivery composition; the attempt/scheduler/runtime suites below cover their separate boundaries. No manual trigger or offline recovery behavior is established by this suite.

```sh
env -i PATH="$PATH" bun --no-env-file test tests/backup-attempt.test.ts tests/backup-scheduler.test.ts tests/backup-runtime.test.ts
env -i PATH="$PATH" bun --no-env-file test tests/backup-command.test.ts
```

The whole-attempt case holds the actual checkout lease before starting the service, checks that neither capture nor Git enters while blocked, then exercises genuine capture/local Git, offline retention and unchanged pending retry. It uses owned source/media/output and a local bare redirect, with content/credential log controls. Scheduler cases use a test-owned bigint monotonic clock and held attempt to cover null intervals, one initial attempt, coalesced ticks, abort/join/sealed stop, recoverable failure and long/max-safe seconds without 32-bit timer clamping. Runtime cases use an owned backup clock/attempt seam: absent/null configuration must ignore it, while a positive interval begins after readiness and holds actual daemon execution ownership until aborted work joins. These descriptions are validation boundaries, not a report that the current revision has passed.

The command suite covers absent configuration and dotenv isolation, default media selection, owned local-bare delivery, offline retention/retry, pre-abort and sanitized logs. It does not prove OS-signal cleanup or restore behavior. These are test boundaries, not a claim of a passing run.

Additional attempt controls refuse replaced capture roots/ownership records, an unowned incomplete workspace and a source symlink without deleting caller data; a separate process cannot capture or call Git while the first attempt holds its pinned source snapshot. Scheduler controls explicitly reinvoke cancelled callbacks/restart after stop and inject clock/cancellation faults without reviving work. An owned runtime/local-bare composition performs real scheduled capture/Git delivery, then holds a real capture child during shutdown and verifies child termination before execution ownership can be reacquired. Mid-write workspace-initialization faults, broader held path/inode races and arbitrary process-crash recovery remain unproved. No capacity, daemon-latency, OS-signal cleanup or standalone restore guarantee follows from these focused fixtures.

Document validation must compare table/column and media-lifecycle claims against current migrations/readers, check local links and distinguish official SQLite semantics from owned runtime proof. In particular, `VACUUM INTO` is not a source write operation but may renumber implicit rowids; a current DB reference check protects a historical snapshot only while source rows remain immutable and undeletable.

Further capture/delivery and restore changes must maintain focused tests alongside their code, then document exact commands here. Validation goals are [listed in the contract](backup-restore.md#required-evidence-before-shipping): exact scalar/order/history preservation, coherent WAL capture during writes/media publication, cleanup/file faults, owned local Git failures/divergence and standalone restore validation/rollback/publication. Use freshly migrated or frozen legacy owned SQLite fixtures, private files and fake native ports, never personal data, credentials, an operator service or a provider.

#### Selected-revision recovery walkthrough

```sh
bun --no-env-file test tests/backup-recovery-walkthrough.test.ts
```

This test owns a loopback Hono daemon, SQLite/media, deterministic native clients and a local bare Git repository. It holds the actual capture child at its snapshot boundary while an HTTP write commits, and permits another write during a held local Git delivery process. It checks failed delivery, retry and last-good revision preservation, extracts the selected confirmed revision, and invokes the actual `scripts/restore.ts` command in a no-env-file child. Restored records are compared with that revision, not later source mutations.

Both configless and configured restored-daemon startup exercise real scans without reviving historical runs, pending imports or rowless cleanup. Checks retain historical execution facts and payloads, exact originals, user history, relationship/search reads and rejection's AI exclusion. Fresh independent work completes through the configured fake agent. Application-owned historical bindings and prepared inputs remain backup data; operator service files and credentials are not fixtures or copied service state.

The expanded walkthrough passed with 119 assertions; the root suite passed 1,572 tests across 136 files, the backup/restore subset passed 88 tests, and root typecheck passed. Web typecheck, production build, foundation runtime and shared-record integration also passed; those unchanged-runtime results were reused after the test-only configless addition. These are local isolated results, not a hosted GitHub Actions run. The existing CI root-test command discovers this walkthrough automatically.

The local transport maps a validated `.invalid` HTTPS URL to an owned bare repository. A held Git process is not proof of concurrent live network transfer or hosted Git authentication. Real provider behavior, main-process CLI signal handling, arbitrary I/O/power-loss faults and production capacity remain outside this walkthrough.

One separate synthetic run on Bun 1.4.3 captured 2,500 notes containing 20,142,500 text bytes in 199 ms and restored them in 2,396 ms. Three HTTP-admitted PNG originals totaled only 213 bytes. It verified 2,503 restored thoughts, three media sources, three runs/fences, exact originals and an absent final marker. Parent-process peak RSS was 438,736 KiB, excluding children. This single owned run is neither a process-tree memory bound nor evidence of large-media capacity, concurrent-load behavior or production latency; JSON input limits are not hard RSS limits.

### Media-source domain and persistence checks

```sh
bun --no-env-file test tests/domain.test.ts tests/simple-export.test.ts tests/agentic-export.test.ts
bun --no-env-file test tests/media-source-migration.test.ts tests/media-source-projections.test.ts tests/search-capability-media-result.test.ts
bun --no-env-file test tests/media-source-migration.test.ts tests/capability-migration.test.ts tests/agentic-search-migration.test.ts tests/markdown-import-foundation.test.ts
```

Controlled domain values cover the null-text `media-original` source, separately attributed exact user clarification, filename display fallback and honest export descriptors. Existing textual kinds must still reject null or blank text.

The focused three-file persistence group uses the real migration and in-memory or uniquely owned `/tmp/opencode` SQLite databases, explicit IDs/clocks/digests and controlled clarification with BOM, whitespace, CRLF and non-ASCII text. Metadata bytes are sentinel inputs, not image/PDF decoding fixtures. It checks the initially empty store identity, explicit idempotent initialization, source-first atomic writer rollback, immutable associations, null-text/source-authorship guards, hydrated raw/scoped/search/context/capability/saved-search/export projections, rejection exclusion and clarification/title-only FTS/vocabulary. Projection/vocabulary checks need the [native spelling extension](server-startup.md#native-spelling-extension) built as described above. Retained-result decoder controls cover valid media projections and malformed/extra descriptor fields.

`media-source-migration` uses [`fixtures/pre-media-schema.sql`](../tests/fixtures/pre-media-schema.sql), a frozen selected predecessor schema populated with Markdown document/seal membership, exact bytes, rowids, source seals, execution/search history and an additional incoming FK/index/trigger. It compares preservation through repeat migration and file reopen, checks FK integrity, and injects a failure immediately after real destructive closure DDL to check complete schema/data rollback and clean retry. The broader migration command retains older predecessor and Markdown-preservation checks rather than replacing them with empty-database setup.

Successful-upgrade comparisons retain historical step bytes and original index/trigger definitions. [`sqlite-foreign-keys`](../tests/fixtures/sqlite-foreign-keys.ts) normalizes only SQLite's FK-group ordinals: composite grouping, component sequence, referenced columns and all action/match semantics remain compared. Destructive-failure rollback compares the complete schema, every row column and raw FK ordinals; the frozen SQL fixture is not regenerated through current migration. A separate owned development-schema fixture checks file-run cleanup: core records survive, affected active runs become interrupted with pending cancellation, and a fault after real DDL restores both schema and data before a successful retry/reopen. No personal database is used.

These persistence tests do not establish file access, format validation, HTTP media import or model behavior. The separate worker/file/validator groups below cover their own boundaries. The current Next.js decoders remain text-only; existing web checks protect text/Markdown behavior, not media rendering. Commands and coverage descriptions are not a claim that a particular working-tree revision has passed verification.

### Normal worker diagnostics

`bun --no-env-file test tests/worker.test.ts --test-name-pattern 'default-level worker diagnostics'` exercises controlled initial-preparation and invalid-envelope failures using owned SQLite fixtures and an injected native client. It checks default-level run/generation correlation, stage and category, and redaction of private fixture text. It does not reproduce or establish the cause of the original Evolve failure, or exercise a live service or provider.

### Shared-file media worker checks

```sh
bun --no-env-file test tests/media-path-worker.test.ts
bun --no-env-file test tests/media-path-worker.test.ts --test-name-pattern '^normal Weaver reopens a retained source by its shared absolute file path$'
```

[`media-path-worker`](../tests/media-path-worker.test.ts) uses a real retained test-owned PNG, the private file service and SQLite, plus the normal `RunWorker`/`OpenCodeAdapter` with a scripted decoded native client. Its injected resolver accepts only the daemon-owned source ID and returns the verified actual absolute original path. Neither the operator service nor a model provider is a fixture.

The checks cover normal Weaver `readThought` continuation, initial media summary instructions and canonical searchable interpretation/Full reply, Evolve ancestor and independently read supporting-source paths, rejection→restoration during a held path read, restricted Search/Export/Markdown segmentation, and title-clear without file reopening or another interpretation. A failed-source case exercises ordinary worker cancellation followed by deliberate retry using the same retained original, including pending-cancellation denial, idempotence and duplicate-interpretation prevention. Ordinary Thought records and capability results must not contain filesystem paths. The held-read control checks committed context, immediate generation fencing and no late continuation/publication while retaining the file.

These tests establish managed path delivery through normal text prompts and application persistence, not actual OpenCode filesystem-tool execution or model understanding. The fixture's injected validator checks owned bytes, not image/PDF format validation. The daemon and OpenCode must share filesystem access. The separate [HTTP workflow suite](#media-import-http-workflow-checks) covers daemon wiring and actual validation; neither suite provides a browser media flow.

### Media admission and lifecycle checks

```sh
bun --no-env-file test tests/media-admission.test.ts tests/media-weave-purpose.test.ts
bun --no-env-file test tests/media-path-worker.test.ts tests/media-admission.test.ts tests/media-source-migration.test.ts tests/media-source-projections.test.ts tests/media-weave-purpose.test.ts tests/media-files.test.ts tests/media-files-faults.test.ts
```

[`media-admission`](../tests/media-admission.test.ts) checks the [internal source-plus-normal-weave command](database-schema.md#source-admission-and-lifecycle) with two connections to owned SQLite and controlled metadata. Source/root/title/seal and initial run/step commit together. A real SQL fault after initial-step insertion must leave both connections unchanged before clean retry. Controls cover exact replay with newly allocated daemon identities, payload conflicts, independent equal-byte imports, metadata-only source non-adoption, user-only admission/retry, repeat migration/reopen and deliberate retry only after failed/interrupted work has settled cancellation. An existing interpretation prevents another initial summary.

[`media-weave-purpose`](../tests/media-weave-purpose.test.ts) checks conditional title fill/completion, prohibited title-only reads/writes, receipt/cache and legacy-write bypasses, and late user-title protection. Prepared successors with forbidden title-only history are refused before native submission without rewriting retained input; a valid title-fill successor remains replayable. Normal Evolve contribution/development behavior remains available. Ordinary Stop, recovery, cancellation and knowledge-operation coverage stays in `worker`, `run-protocol-sqlite` and `run-operations`; no separate media execution lifecycle is used.

### Media import HTTP workflow checks

```sh
bun --no-env-file test tests/media-import-api.test.ts
bun --no-env-file test tests/media-import-api.test.ts --test-name-pattern '^owned media upload retains its original and queues normal weaving without agent configuration$'
bun --no-env-file test tests/media-import-api.test.ts tests/media-path-worker.test.ts tests/media-admission.test.ts tests/markdown-import-api.test.ts tests/worker.test.ts tests/opencode-adapter.test.ts
```

The nine cases in [`media-import-api`](../tests/media-import-api.test.ts) use an actual loopback Hono daemon, owned file-backed SQLite/private media directories, synthetic valid PNG/PDF bytes and the real bounded validator child. [`fixtures/media-import-api.ts`](../tests/fixtures/media-import-api.ts) supplies explicit test credentials/configuration, a 4096-byte file limit, a controlled polling callback and a deterministic decoded native client. It never attaches to the operator service or a provider. SQL inspection uses read-only connections, not fabricated execution records.

Coverage includes authenticated upload/configless queuing; auth/role denial while the entire body is withheld; closed multipart fields, size/type and corrupt-pixel refusal without admission; same-key replay/conflicts/by-key recovery and independent equal-byte imports; exact download headers/bytes and normal/history rejection scopes; configured normal-worker PNG/PDF path delivery, clarification/default instructions and canonical child/Full reply; HTTP failed-source retry after actual normal cancellation; orderly restart/paired copies/marker-mismatch refusal with clean startup retry; and held normal native work joined during shutdown before agentless reopen without resend. Public receipts/Thoughts contain no filesystem paths, and controlled diagnostic checks exclude private input.

The suite covers the current [backend contract](daemon-api.md#retained-media-import-and-source-inspection), not actual OpenCode filesystem/MCP tools, model understanding, provider compatibility, a browser media workflow, arbitrary OS-crash/power-loss recovery or every backup utility. Restore checks use stopped owned data and agentless inspection, not moved-path native-session recovery. Broader file faults, format/resource/race and ordinary lifecycle controls remain in their focused suites below; the HTTP suite does not duplicate all of them. Coverage descriptions are not a claim that checks were rerun for a docs-only change.

### Manual media import walkthrough

Use an **owned test daemon** with a fresh temporary database/media directory, test-only credentials and no agent configuration. Start it with explicit test settings and `bun --no-env-file src/daemon/main.ts`, with `THOUGHTLOOM_AGENT_CONFIG` absent from that process environment; do not use a persistent launcher or personal library. Set `DAEMON` to its actual loopback readiness URL and `USER_TOKEN` to its test user credential. Without agents this walkthrough makes no model call; positive interpretation/failure/retry uses the deterministic HTTP suite above.

From the repository root, create a test-owned PNG using the existing independent fixture:

```sh
WORK="$(mktemp -d /tmp/opencode/thoughtloom-media-manual.XXXXXXXX)"
MEDIA_TEST_FILE="$WORK/owned.png" bun --no-env-file -e 'import { independentPng } from "./tests/fixtures/media-rasters.ts"; const file = process.env.MEDIA_TEST_FILE; if (!file) throw new Error("Missing owned output path"); await Bun.write(file, independentPng());'
curl -sS -D "$WORK/upload.headers" -o "$WORK/admission.json" \
  -H "Authorization: Bearer $USER_TOKEN" -H 'Idempotency-Key: owned-image-1' \
  --form-string 'metadata={"clarification":"Describe the two colored regions."}' \
  -F "file=@$WORK/owned.png;type=image/png;filename=owned.png" "$DAEMON/imports/media"
```

Check the response is `202`, then copy `thought.mediaSource.id`, `thought.id` and `run.id` from `admission.json` into `SOURCE_ID`, `THOUGHT_ID` and `RUN_ID`. They are distinct identities. Use that same upload key to recover its receipt, inspect the queued run and compare the exact original:

```sh
curl -sS -H "Authorization: Bearer $USER_TOKEN" "$DAEMON/imports/media/by-key/owned-image-1"
curl -sS -H "Authorization: Bearer $USER_TOKEN" "$DAEMON/runs/$RUN_ID"
curl -sS -H "Authorization: Bearer $USER_TOKEN" "$DAEMON/media-sources/$SOURCE_ID"
curl --fail -sS -D "$WORK/download.headers" -H "Authorization: Bearer $USER_TOKEN" \
  "$DAEMON/media-sources/$SOURCE_ID/raw" -o "$WORK/download.png"
cmp -- "$WORK/owned.png" "$WORK/download.png"
# Expected 409: the configless initial run is queued, not a safely failed interpretation.
curl -i -sS -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: owned-retry-1' -d '{}' "$DAEMON/media-sources/$SOURCE_ID/retry"
```

The download headers must include `image/png`, the safe download filename, `nosniff` and `no-store`. Repeat the identical upload command for `200` with the same identities, not another queued run. To exercise deliberate rejected-source inspection:

```sh
curl -i -sS -X POST -H "Authorization: Bearer $USER_TOKEN" "$DAEMON/thoughts/$THOUGHT_ID/reject"
# Expected 404 under normal scope; the retained original is not deleted.
curl -i -sS -H "Authorization: Bearer $USER_TOKEN" "$DAEMON/media-sources/$SOURCE_ID"
curl --fail -sS -H "Authorization: Bearer $USER_TOKEN" \
  "$DAEMON/media-sources/$SOURCE_ID/raw?scope=history" -o "$WORK/history.png"
cmp -- "$WORK/owned.png" "$WORK/history.png"
```

Do not edit SQL status or cancellation fields to manufacture a retry. Stop the owned daemon cleanly before removing only its known test database/media directory and the workspace created here. See [paired backup/restore](server-startup.md#paired-media-backup-and-restore); this walkthrough does not use or reset personal data.

### Private media-file service checks

```sh
bun --no-env-file test tests/media-files.test.ts tests/media-files-faults.test.ts
```

These tests use owned Linux directories and SQLite fixtures, explicit identities/clocks, and an injected validator that accepts sentinel bytes. They exercise private marker/identity initialization, publication without overwriting, fingerprint-verified reads and stable absolute `originalPath`, corruption/link refusal, cancellation, reference-aware cleanup, active staging, joined close and lifetime fencing. The service requires a synchronous trusted admission callback that owns its SQL transaction; filesystem work stays outside that transaction.

The fault suite supplies instance-local filesystem delegates for `sync`, `link` and `unlink`, performing real owned I/O and injecting failures or held completion at selected publication boundaries. It checks that failed publication does not falsely admit a source or destroy an existing original, that ambiguous SQL/link outcomes preserve referenced bytes, that unsafe layouts are refused, and that shutdown joins held I/O before releasing descriptors. No global filesystem mock is installed.

This is not evidence of image/PDF decoding, parser subprocess containment, arbitrary process-crash recovery, daemon media integration or power-loss durability. No original from a personal directory, operator service or provider is a fixture. The sentinel validator in these tests is not the separate bounded format validator.

### Bounded media validation checks

```sh
bun --no-env-file test tests/media-validation-rasters.test.ts tests/media-validation-pdf.test.ts
bun --no-env-file test tests/media-validator.test.ts tests/media-validator-races.test.ts
```

These isolated checks exercise the [internal validator](server-startup.md#internal-media-validation), not a daemon upload or a browser flow. They use synthetic, test-owned bytes and explicit test-owned budgets. Raster controls include independently framed PNG/GIF data, JPEG/WebP fixtures, corrupt and truncated pixels, later animation frames, APNG refusal, unsupported content and byte/dimension/pixel/frame boundaries. PDF controls use synthetic classic and library-written documents, public parser objects, page/object/depth limits, active or embedded content, encrypted inputs and a dangling trailer `Encrypt` reference. They do not use a personal file or a provider.

The Cantoo 2.11.1 classic writer encrypts streams but does not encrypt Info strings in the encryption fixture. The controlled encrypted documents therefore omit `Info` and contain a known page-content stream. Tests check the security dictionary and permissions, ciphertext, wrong-password refusal and exact plaintext recovery with the test-owned password. Unencrypted metadata coverage remains separate. Production validation supplies no password and rejects encryption, not a decryption feature.

Supervisor tests launch an owned Bun child through the real `prlimit` command with explicit test limits, check inherited DATA/CPU/core limits via `/proc/self/limits`, and exercise genuine PNG/PDF worker inputs. Controlled child substitutions cover strict result shape, bad MIME, extra output, crashes, nonzero exits, output flooding, CPU/wall termination, environment isolation, cancellation and borrowed descriptors. Instance-local gates exercise same-size file mutation during feeding, abort or early child exit while pumping, and delayed stdout/stderr EOF after child exit before the next lane may start. These checks do not establish containment for every native allocation, format or race, actual daemon integration, or real service/provider behavior. Commands describe coverage, not a claim that the current working tree has passed them.

### Runtime execution-owner checks

```sh
bun --no-env-file test tests/agent-execution-owner.test.ts
bun --no-env-file test tests/agent-execution-provenance.test.ts tests/agent-execution-owner.test.ts
bun --no-env-file test tests/agent-execution-owner.test.ts tests/daemon.test.ts tests/runtime-recovery.test.ts tests/agent-runtime.test.ts tests/supervisor.test.ts tests/supervisor-runtime.test.ts tests/worker.test.ts tests/opencode-adapter.test.ts tests/markdown-import-runtime.test.ts tests/markdown-import-worker-preparation.test.ts
```

`agent-execution-owner` owns temporary file databases and child Bun processes under `/tmp/opencode`, uses explicit credentials/cleared child environment and `--no-env-file`, and never uses an operator/provider fixture. It checks same-process exclusion while a separate knowledge-DB connection can write, actual relative/symlink cross-process contention with the exact safe conflict diagnostic, clean shutdown/SIGKILL release, and release after failed listener startup. The private SQLite sidecar remains until the fixture removes its entire stopped owned directory. These checks exercise real VFS locking, not an in-process ownership mock.

File-backed daemon checks require the [supported Linux/local path boundary](server-startup.md#database-execution-ownership). Direct isolated in-memory repository and injected-worker tests do not claim daemon/process exclusivity and need no sidecar. Runtime lifecycle checks must distinguish the knowledge database and private sidecar by actual connection identity/role, not the first `Database.exec` context or one aggregate `Database.close` count. Verify each resource closes exactly once, after held producers drain, without hiding either close from instrumentation.

Configured preflight registers inside the existing run-flight map; runtime shutdown seals/joins application handlers, then takes final run/cleanup-tail/shared-resolver and import-driver drains before closing the knowledge DB and lease. Native adapter lifetime fences do not widen native permissions or replace claim/context checks. Existing held-SDK and import lifecycle cases remain important; expand controlled coverage for held service resolution, direct non-supervisor ticks, listener error with admitted handlers, path/inode replacement, sidecar permissions/hard links and unsupported mounts/filesystems. Lease acquisition alone is not remote cancellation settlement or delayed-admission absence. Retained cleanup and explicit internal retention/purged cleanup have separate focused checks below; the default no-controller facet still refuses bound-session purge.

`agent-execution-provenance` uses real migration, file-backed runtime leases and the injected decoded native client. Its isolated legacy fixture and [frozen selected pre-provenance Search closure](../tests/fixtures/pre-execution-provenance.sql) check preserved rowids/bytes/index/trigger definitions, nullable binding FK/null old rows, reopen/repeated migration and invalid owner FK rejection. Injection immediately after actual registry-table creation checks complete schema/data rollback with FKs enabled. A real search turn checks setup attribution before `sessionCreate`, submission under the same registered runtime ID, immutability and actual completion. Expanded controls preserve populated pre-provenance submission strings, reject registration against copied/released lease boundaries, and keep isolated workers honestly unqualified. Config-less restart records fresh immutable owner IDs with the same canonical DB identity/protocol; bare acquisition adds no registry row. Fixture INSERTs must name columns; preservation comparisons must project historical columns and assert additive nullable attribution separately. No PID/heartbeat or legacy string infers an owner. These tests alone do not establish cleanup predecessor-drain/restart or held native races; the separate retained-cleanup cases cover their stated boundaries. Registry membership alone settles no remote work or bound Delete. Source-copy inputs include `storage/execution-owner-schema.ts` and the lease/path modules; maintain the actual runtime import closure.

The focused `bun --no-env-file test tests/markdown-import-parser.test.ts` checks the pure Markdown import parser's UTF-8 byte coverage, opaque frontmatter, complete blocks and dependency-safe grouping, strict selection envelope, and structural fallback. Test-owned wrappers around the real parser also check one AST pass across preparation and partitioning. Genuine preparations are deeply frozen and registered privately to their parser instance; partitioning rechecks source-byte fingerprints and coverage without reparsing. Cloned, forged, cross-instance, or byte-mismatched preparations are rejected. These tests make no import, daemon, or provider calls. Import workers use this parser.

For a manual HTTP walkthrough, start an **owned test daemon** with a temporary database, test-only credentials and no agent configuration, then set `DAEMON` to its loopback URL and `USER_TOKEN` to its test user token. Use a test-owned UTF-8 Markdown file, not a personal vault. The following uses curl without converting file bytes; copy the returned batch and file IDs into `BATCH` and `FILE`:

```sh
curl -sS -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -H 'Idempotency-Key: test-batch-1' -d '{}' "$DAEMON/imports/markdown"
curl -sS -H "Authorization: Bearer $USER_TOKEN" -H 'Idempotency-Key: test-file-1' -F 'metadata={"relativePath":"fixture.md"}' -F 'file=@fixture.md;type=text/markdown' "$DAEMON/imports/markdown/$BATCH/files"
curl -sS -H "Authorization: Bearer $USER_TOKEN" "$DAEMON/imports/markdown/$BATCH/files/$FILE"
curl -sS -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{}' "$DAEMON/imports/markdown/$BATCH/seal"
```

Poll until the file is terminal; an imported result supplies `documentId`. Inspect `/import-sources/DOCUMENT_ID/parts?scope=history` or download `/import-sources/DOCUMENT_ID/raw?scope=history` with the same test credential, replacing the placeholder with that ID. Compare the downloaded file bytes with the original fixture. Stop the owned daemon and remove its temporary database and fixture afterward. See the [API contract](daemon-api.md#markdown-import-and-source-inspection) for replay, errors and bounds; this walkthrough does not exercise a provider.

For an explicit Linux-only parser resource probe, run `bun --no-env-file scripts/markdown-import-perf.ts` in an isolated source copy with frozen dependencies. The first JSON line identifies the three parser source files, package manifest and lockfile by SHA-256 and reports the Bun version. An optional `--revision-label LABEL` records a caller-supplied label; it does not establish that a working tree is clean. Each deterministic generated input runs in a fresh subprocess; the parent samples `/proc` RSS, stops a probe above 512 MiB or 10 seconds, and reports byte length, input and output hashes, reconstruction, elapsed time and sampled peak RSS. These are sampled validation stops, not OS resource limits or product input limits; sampling may miss transient peaks. The parent kills its active owned child on SIGINT, SIGTERM or normal error cleanup (SIGKILL cannot be handled). `--extended` adds larger probes; use it only after the baseline is safe. This probe is not part of the ordinary test suite and needs no daemon, provider or personal input.

The harness is outside the root TypeScript include. Check it explicitly in the isolated copy with `bun --no-env-file node_modules/typescript/bin/tsc --ignoreConfig --noEmit --skipLibCheck --module preserve --moduleResolution bundler --target esnext --types bun scripts/markdown-import-perf.ts`.

### Agentic search foundation checks

The current [search-session schema and internal lifecycle](database-schema.md#agentic-search-storage-foundation) have focused SQLite checks:

```sh
bun --no-env-file test tests/agentic-search-migration.test.ts tests/capability-migration.test.ts
bun --no-env-file test tests/agentic-search-cleanup-journal.test.ts tests/agent-execution-provenance.test.ts
bun --no-env-file test tests/agentic-search-cleanup-runtime.test.ts tests/agentic-search-fences.test.ts
bun --no-env-file test tests/agentic-search-retention-runtime.test.ts tests/agentic-search-cleanup-runtime.test.ts
bun --no-env-file test tests/agentic-search-sessions.test.ts
bun --no-env-file test tests/agentic-search-api.test.ts tests/api.test.ts
bun --no-env-file test tests/agentic-search-workspace-api.test.ts tests/agentic-search-api.test.ts tests/agentic-search-workspace.test.ts
bun --no-env-file test tests/agentic-search-turn-api.test.ts tests/agentic-search-workspace-api.test.ts tests/agentic-search-api.test.ts
bun --no-env-file test tests/agentic-search-clock-api.test.ts tests/agentic-search-clock-http-runtime.test.ts tests/agentic-search-clock-runtime.test.ts tests/agentic-search-time.test.ts
bun --no-env-file test tests/agentic-search-turns.test.ts
bun --no-env-file test tests/agentic-search-publication.test.ts
bun --no-env-file test tests/agentic-search-rejection.test.ts tests/rejection-domain.test.ts tests/rejection-sqlite.test.ts
bun --no-env-file test tests/agentic-search-retrieval.test.ts
bun --no-env-file test tests/agentic-search-workspace.test.ts
bun --no-env-file test tests/agentic-search-time.test.ts
bun --no-env-file test tests/agentic-search-runtime.test.ts
bun --no-env-file test tests/agentic-search-capabilities.test.ts tests/agentic-search-runtime.test.ts
bun --no-env-file test tests/agentic-search-capabilities.test.ts tests/agentic-search-rich-capabilities.test.ts tests/agentic-search-runtime.test.ts
bun --no-env-file test tests/agentic-search-clock-runtime.test.ts tests/agentic-search-capabilities.test.ts tests/agentic-search-rich-capabilities.test.ts tests/agentic-search-runtime.test.ts
bun --no-env-file test tests/agentic-search-recovery.test.ts tests/agentic-search-fences.test.ts
bun --no-env-file test tests/agentic-search-unbound-stop.test.ts
bun --no-env-file test tests/agentic-search-retention-runtime.test.ts tests/agentic-search-retention-recovery.test.ts tests/agentic-search-cleanup-runtime.test.ts tests/agentic-search-cleanup-journal.test.ts tests/agent-execution-provenance.test.ts tests/agent-execution-owner.test.ts
bun --no-env-file test tests/agentic-search-configless-retention.test.ts tests/agentic-search-metadata-runtime.test.ts tests/agentic-search-turn-runtime.test.ts
bun --no-env-file test tests/agentic-search-retention-http-runtime.test.ts
bun --no-env-file test tests/storage-entrypoints.test.ts
```

These tests own their in-memory or unique `/tmp/opencode` SQLite fixtures, IDs, clocks and source records. Foundation cases call the real migration/storage/domain facet; the initial runtime case additionally drives the real worker/adapter through an injected decoded native-client fixture. None uses a personal database, operator service, model provider or browser. Migration's FTS5 tables use built-in SQLite support; the retrieval typo case builds and loads its own spellfix artifact rather than relying on the checkout's ignored build output.

- **Migration and preservation:** fresh/repeated migration, file reopen, foreign keys, legacy knowledge/native journals and populated import-era descendants, including source seals and pending payloads. Fault injection after the actual run-row copy checks rollback of destructive schema/data work. Unrelated trigger/index definitions must survive unchanged; the six intentional tombstoned-search delete exceptions are checked separately rather than mistaken for preservation failures. Legacy step snapshots project preexisting columns and explicitly check the added nullable `submit_owner` instead of treating that addition as data loss.
- **Cleanup journal foundation:** `agentic-search-cleanup-journal` uses real migration, actual admitted sessions/turns and a frozen preceding cleanup DDL. It checks nullable manifest/submission-owner columns, the session FK, legacy bytes/rowid/custom index/trigger preservation, repeat/reopen behavior, no fresh manifestless row, and rollback after actual manifest-column/table creation. Expanded cases exercise all-step snapshots/focus/hash/privacy, strict codec denials, missing historical input and already-fenced ownership requirements. Controlled old SQL settlement is historical fixture state, not native terminal evidence; these cases do not establish a real joined native flight. Keep structural fixtures aligned with the [concrete internal contract](database-schema.md#cleanup-journal-and-internal-snapshot), never weaken guards to fit old manifestless positives. Source-copy runtime inputs include `storage/search-cleanup-schema.ts`, `storage/search-cleanup-migration.ts`, `storage/search-cleanup-manifest.ts` and `storage/search-cleanup-snapshot.ts`.
- **Retained cleanup runtime:** `agentic-search-cleanup-runtime` owns a real file-backed lease/registry, actual configured worker/adapter and the decoded scripted client, not SQL-native-completion or a live service. Stop after lost ACK with empty history stays drained/pending and never resends; later matching complete history settles once without retaining private native output. Binding/location drift becomes conflict with no foreign cancellation/interrupt. Held fourth submission after real find/read/discovery is joined after Stop or reject-restore; confirmed discoveries/messages remain unchanged and late output is never published. Expanded cases cover owned inbox cancellation/interrupt followed by terminal reobservation, multipage evidence for every authorized prompt, malformed cursors and foreign binding controls, direct-worker cleanup drain, and qualified never-authorized setup. They do not prove actual daemon shutdown during cleanup or simultaneous external-writer races. Delete and orderly predecessor recovery have separate coverage below; no provider/operator fixture or new HTTP route is involved. Runtime source-copy closure additionally needs `agent/search-cleanup-contract.ts`, `agent/search-cleanup-history.ts`, `agent/search-cancellation.ts`, `storage/search-cleanup.ts` and `storage/search-cleanup-evidence.ts`.
- **Explicit retention runtime:** `agentic-search-retention-runtime` uses an actual file-backed lease/registry, configured worker/adapter and decoded client. A real four-prompt find/read/discovery/reply checks unchanged default refusal, AI denial, then explicit controller-backed purge of completed bound content, title-free tombstone/key non-resurrection, local table removal, library preservation and FKs. A held authorized submission checks that Delete returns before release; later matching ACK/terminal evidence updates only the sealed outbox, with empty history remaining drained/pending, no resend, no run recreation and no late prose retention. A distinctive SQL fault fires only after the cleanup snapshot exists, then verifies sanitized outer error/test-owned cause, whole-table rollback and no cancellation scheduling. These cases exercise the real proposed `searchRetention()`/optional second-facet-argument seam, not a SQL-only purge fixture. Add `storage/search-retention.ts` to source-copy runtime allowlists.
- **Configless HTTP retention:** `agentic-search-configless-retention` starts an actual configured daemon/file-backed lease and submits through the decoded client, then orderly drains and reopens the same file without agent configuration. Active and user-stopped bound turns can be locally deleted through HTTP while metadata/Check/Stop remain available and fresh-turn denial writes no run. It checks purged content/execution rows, unchanged library tables, title-free creation-key tombstones, exact non-content setup/submission identity, pending/unknown cleanup, and a second configless restart without resurrection. Injected resolver/client tripwires must remain untouched in configless mode. This is orderly replacement, not proof of OS-crash recovery, provider erasure or every held configured-handler/shutdown ordering. No new source-copy input is required for this ownership refinement; retain the existing worker/retention and HTTP receipt module closure.
- **Fixture independence:** `capability-migration` and the historical case in `agentic-search-migration` contain frozen predecessor DDL. The populated immediate-predecessor `preSearch` fixture is different: it reuses current bootstrap/import migrations while suppressing the search foundation during setup, then runs the migration under test on the real connection. It exercises the populated current closure, but is coupled to today's migration code and is **not** an independently frozen released import-era schema. Keep that distinction when evaluating preservation evidence.
- **Structural guards:** positive/negative raw-SQL controls exercise search-only turn ownership, composite same-session message/dependency ownership, retained-message update/replace denial, live/non-search purge denial, child-first tombstoned purge, composer anti-reset/coverage retention, occurrence membership after removal, completed-step receipt correlation and cleanup owner/prompt constraints. These are persistence checks, **not** proof that a dispatcher authorized the request, validated a complete turn intent, recorded full reads or safely published model output. Some structural fixtures intentionally use JSON-valid but domain-incomplete intent/envelopes.
- **Lifecycle:** the typed `SqliteStore.searchSessions({id,now})` facet checks empty-payload creation, strict keys/roles/metadata rejection, multiple sessions, revision-checked rename, create replay without activity, title-free tombstones and non-resurrection, bounded catalog keysets, limit/cursor binding and `list-changed` after mutations. Human history independently pages messages and discovery occurrences, rejects AI/foreign continuations and preserves explicit removed/rejected history. Local purge has retained-library row controls; without an explicit retention controller, bound or possibly submitted deletion must return `native-cleanup-required` before changing its snapshot.
- **Metadata HTTP:** `agentic-search-api` checks creation/replay, catalog pagination and invalidation, active-run and changing eligibility projections, rename, local deletion, library preservation, authorization, no-store and malformed requests through real Hono/domain/SQLite. Metadata reads do not reset composer coverage. `agentic-search-metadata-runtime` separately exercises an owned configless listener with zero resolver/client calls. No browser behavior is established. Source-copy runtime allowlists need `daemon/search-session-routes.ts`.
- **Workspace HTTP:** `agentic-search-workspace-api` uses the actual Hono/domain/SQLite path with test-admitted stopped turns. It checks composer lifecycle, normal offered-ledger coverage and rejection fences, separate user history, safe preview, cursor/scope guards and fixed-entry removal replay. Discovery publication is test-owned SQL state, not native-execution evidence. Add `daemon/search-http.ts` and `daemon/search-workspace-routes.ts` to source-copy runtime allowlists; no browser/provider is exercised.
- **Turn/control HTTP:** `agentic-search-turn-api` checks admission and control-only replay, configless no-write denial, scoped keys and deletion precedence, Check/Stop retention, strict inputs and ordinary run compatibility. `agentic-search-turn-runtime` disables timer polling and proves that committed admission wakes the actual supervisor into a controlled unavailable resolver without constructing an SDK client. These are not provider-availability guarantees. Source-copy runtime allowlists need `daemon/search-turn-routes.ts`.
- **Composer/turn persistence:** `agentic-search-turns` exercises blank composers, trusted same-session message offering, stale token rejection, whole offered-union inheritance, distinct caller/daemon clock anchors, atomic run/turn/message admission, composer consumption, control-only key replay and changed/new-key conflicts. Rejected shared-source coverage must not become offered prose or ledger entries; a rejected starting thought must not admit a turn. Unknown/caller-owned authority fields and AI actors are negative controls. The injected message-insert abort is conditional on both the real search run and owning turn already existing, so it identifies failure after those writes, not an import/setup failure.
- **Clock helpers:** `agentic-search-time` exercises frozen admission clock replay, pure model-boundary attachment selection and agent-interpreted UTC interval conversion, including offset/zone mismatch and DST controls. These helpers do not dispatch prompts, select an eligible turn from a session, receive browser clock headers or schedule updates. The caller supplies the trusted original anchor and injected wall/elapsed clock data; apparent client-minus-daemon offset includes unknown transit delay. A backwards daemon time before sample receipt produces an unknown age rather than an invented value.
- **Clock HTTP receipt:** `agentic-search-clock-api` checks paired/duplicate headers, owner/generation/stale-arrival isolation, new-turn separation, cache forget/clear, ordinary-run exemption and Delete success/rollback. Polls write no SQL clock rows. The actual daemon test checks fresh transport input separately from the immutable anchor; a composed real app/cache/worker test with injected elapsed time checks a due normal successor without a clock-only prompt or prepared-input rewrite. Browser forwarding, capacity eviction and full-runtime elapsed-time behavior remain separate evidence. Source-copy runtime allowlists need `daemon/search-clock-receipts.ts`.
- **Trusted publication:** `agentic-search-publication` uses actual session/turn admission, then test-owned SQL binding, claim, exposure and completed-step fixtures. It checks this-run thought full reads, stale/foreign ownership denial, uncited exposure rejection, immutable add receipts, `already-active` no-op activity, removal by fixed occurrence ID and fresh rediscovery at the tail. Both final reply dispositions inherit all exposures and release the active slot without changing the controlled knowledge tables. The dependency-insert fault requires the occurrence **and** confirmed step receipt to exist, then checks the sanitized cause, full table rollback and retry. These fixtures do not establish native observer/dispatcher correctness or a model's full read; they establish how publication uses recorded evidence.
- **Rejection-event integration:** `agentic-search-rejection` calls the real `RejectionService`/SQLite repository after real session admission and ledger-aware message offering. Trusted SQL fixtures supply retained exposures and bindings, not native execution. Direct thought/connection rejection, connection endpoints and another member of a shared response must fence only affected active runs/composers, including inherited message dependencies; unrelated work and controlled library rows remain unchanged. Actual rejection/restoration increments both dedicated revisions, denied AI calls/no-op repeats do not, and reject-then-restore before any poll cannot revive work. The distinctive abort trigger requires the rejected marker and an actual interrupted generation update to exist, then checks rollback of the marker, run/slot/outcome, composer and revisions before retry. Existing rejection-domain/SQLite tests retain branch confirmation, ancestry-only traversal, independent connection state, reopen and outer-transaction rollback controls.
- **Investigative retrieval:** `agentic-search-retrieval` checks the internal AI-normal facet's response identity, rejection of shared responses, date-only bounds, filters, transfer limits, multi-page ordering and ties, corpus change detection, revision rollback and ordinary Search compatibility. Its typo-correction case builds a test-owned spellfix artifact. Candidate snippets are not full reads; these checks do not establish dispatcher exposure recording, simultaneous pagination races or bounded database work merely from bounded result pages.
- **Normal workspace ledger:** `agentic-search-workspace` calls the real user-only session facet over owned migrated SQLite data. It checks chronological message pages, old-page coverage retention, exact-token admission after refresh, fixed high-water membership, collection/session/limit mismatch denial and separate-composer/AI controls. Control-only replay/by-key cannot supply old message prose; displaying that message under C2 requires a fresh registered read, and reject-then-restore permanently invalidates C2. Preview redacts rejected ancestry, registers visible thought/source identities and writes no full-read witness. Removed E1 stays out of normal discovery pages while E2 is current; a safe target with an unsafe rationale offers only its fresh summary, then restoration permits a newly registered rationale read. Deliberate history remains exact user-only output without a composer token.
- **Initial real worker turn:** `agentic-search-runtime` drives `ConfiguredRunWorker.tick` and `RunSupervisor.poll` with an injected service resolver and decoded `PublicClient`, not a fake SQL finalizer or a live service. An ordinary Weave positive control proves the fixture's submission/history correlation. Search clarification and follow-up each create a fresh deny-all native session, persist the completed assistant reply/disposition, release the active slot and preserve the controlled library/FTS tables. Initial input includes the retained client timestamp and daemon clock, includes eligible prior conversation on follow-up, excludes a rejected sentinel and does not redispatch completed runs. The supervisor must actually scan the admitted search run. This initial fixture establishes the thin reply flow, not full investigative capability dispatch, provider behavior or all protocol/security/race denials.
- **Core search capabilities:** `agentic-search-capabilities` drives the same real configured worker/adapter with the shared decoded scripted client in `agentic-search-capability-fixture`, not SQL-completed steps. The controlled corpus is first checked through the real investigative facet. The actual find → full read → discovery → search reply uses one native session and four unique message identities, verifies core manifest membership with no capabilities outside the approved nine, observes reference-only → full-read progression, and compares successors against durable step results. It checks occurrence/final reply/released slot, unchanged knowledge/FTS rows, cross-run witness noninheritance, snippet-only publication denial and actual ordinary knowledge-write denial. These lexical fixtures do not need spellfix and never call Service.discover or a provider.
- **Rich search capabilities:** `agentic-search-rich-capabilities` follows a completed core discovery with a new same-session user turn, then actually dispatches related connections, connection read, related responses, response read, private conversation, active discoveries, time conversion and a final reply through the configured worker. All nine manifest names, same-session native step identities, stored-result/successor equality, hidden connection/shared-response exclusion, other-session/rejected sentinels, retained conversation/rationale, paired-clock UTC conversion and unchanged library rows are checked. Additional controls verify foreign same-position anchor isolation, denied unsafe old intents, removed E1/fresh E2 listing with unsafe rationale/evidence omitted, connection provenance redaction, shared-response null visibility and record-kind-only full reads. Unknown scope/actor/session fields, an unavailable intent position and import-source access are denied after a valid first read, not simply because rich capabilities are unsupported. Paging boundaries, rich cached-result/rollback and held races remain separate coverage.
- **Clock runtime wiring:** `agentic-search-clock-runtime` injects daemon wall time and the actual optional `searchClock.monotonicNow` dependency into the real configured worker. It checks exactly one hour versus strictly more, observation-only waiting, scoped latest/stale/foreign observations, backwards clocks, lost acknowledgements, prepared-input reuse and cold reconstruction. A refreshed normal successor keeps the original request anchor and matches persisted input; no clock-only prompt is created. Replacement follows settled ticks and pause, not an OS crash. Browser clock forwarding and actual cache-capacity eviction remain separate coverage.
- **Recovery and user fences:** `agentic-search-recovery` exercises lost acknowledgements with partial, empty or unavailable native history, file-backed reopen without resubmission, and durable result recovery before successor preparation. Foreign or altered actual inputs and forbidden native tools are quarantined; compaction bookkeeping alone is not. `agentic-search-fences` holds native create, submit or observe across actual rejection or user Stop. Already-authorized admission may finish, but no subsequent local publication is permitted. Orderly worker replacement is not exclusive-owner or OS-crash proof; ownership has separate real-process tests.

Investigative continuations are opaque, process-local HMAC-authenticated values binding the complete query, page size, revision, high-water marks and last ordering key. Find-candidate cursors use a fixed-length keyed digest of the canonical query and filters rather than embedding query text; cursor contents must not be logged. A process restart invalidates them; start a fresh walk. A valid continuation whose corpus revision changed instead returns `retrieval-changed`. Tests establish valid continuation before changing its payload while retaining the old signature; altered claims must not silently truncate the walk. Duplicate-payload tampering is rejected by authentication, while a separate strict-parser test covers duplicate JSON fields. This does not exercise a validly signed duplicate payload or cross-process restart invalidation.

The internal investigative facet also offers bounded, AI-normal direct relationship references for connections, children, parent, sources and responses. Connection references include direction and category; no related thought/response text, automatic graph traversal or full-read witness is produced. Related continuations bind the starting thought, relation, page size, revision, high-water and last identity. Missing or rejected starting thoughts return `ValidationError`; an already-issued cursor invalidated by a corpus change returns `retrieval-changed`. The search dispatcher records the starting thought and every returned record/endpoint before model use.

The facet returns catalog `{items,nextCursor}`, not an array; history returns separate message/discovery page envelopes. HTTP adapters authenticate the internal typed catalog/history continuations; normal-workspace continuations already have separate signed opaque strings bound to collection/session/normal-scope/order/limit/position/high-water. They are not content authorization or composer tokens; a new composer can use a same-session position only through a fresh read that registers its actual output. Process restart requires a fresh page walk and refresh of the same persistent composer, never a smaller blank ledger for its old draft. Admission/replay/by-key responses contain no conversation prose. Exact replay precedes current configuration and token checks; fresh admission checks configuration transactionally before writes. Next/browser time forwarding remains client work.

Expanded workspace fixtures cover scoped provenance, imported-original preview without source-artifact access, connection/response dependencies, unavailable discovery targets, signed-cursor tampering and injected ledger-write rollback. These are storage/domain controls, not cross-process restart or browser cache tests. The source bounds page rows and fetches dependencies only for offered eligible owners; this is not a large-library performance measurement. Future client tests must discard C1-bound cached/delayed prose rather than simply changing its composer ID.

For distinctive SQL fault assertions, capture the sanitized outer `SearchStorageError` and inspect only the specific test-owned `Error.cause` marker, then compare the complete owned table snapshot and absent receipt. Do not weaken the check to any thrown exception, leak the original SQL error into the outer message, or log/serialize the cause. A retry after removing the injected trigger must still admit using the retained composer/key.

The existing internal rejection repository instead rethrows its SQL exception for its owned transaction-fault assertion; this does not authorize logging/serializing it or exposing it from HTTP. Its search invalidation is a repository-command transaction contract, not a raw-SQL marker trigger. Extended tests cover branch overlap, queued/unbound versus uncertain cancellation, terminal/non-search isolation and use of the identity-only mutation projection. They do not establish indexed large-library performance or native cancellation settlement.

Read foundation slices as controlled storage/domain evidence and the initial runtime test as a separate real-worker/decoded-client boundary, not complete agent-dispatcher, HTTP or UI acceptance. Expanded publication tests cover historical replay after rediscovery, ownership/binding denial, stopped/failed retention, rejection fencing and finalization rollback. Persisted SQL completion fixtures still do not establish native observation or asynchronous publication/rejection/Stop races. The historical receipt path may return only its immutable control fact under a still-active current claim and whole-run eligibility fence, never execute an old prompt or reconstruct membership.

Direct relationship tests exercise saved-record references, visibility, direction, signed continuation integrity and mutation invalidation; the two-connection cases are sequential, not simultaneous contention. Pure paired-clock/calendar tests do not establish SQL anchor selection; the rich runtime fixture separately reaches that adapter and its unavailable-selector denial. Expanded rich controls additionally cover foreign same-position anchors, unsafe selected intents, unsafe/removed discovery entries, provenance redaction and record-kind witness policies. Older-page coverage and uncited exposure closure still need broader runtime controls. Daemon clock receipt coverage is described above; Next/browser forwarding and every cache-eviction or concurrent lifecycle ordering remain separate work.

Retain broader cached result/processed-successor replay, direct trusted misuse, wrong-kind/unknown-authority, retrieval-change and rollback coverage. Successful chains are not proof of every negative/recovery boundary or simultaneous scheduling correctness. Cache guards inspect retained identity/dependency/eligibility metadata without re-reading prose or granting witnesses; removal must not deliver an old list occurrence. Search deliberately cannot use ordinary cleanup settlement: its cleanup tail requires qualified joined execution and positive terminal evidence. Expanded cleanup cases exercise owned inbox cancellation, interrupt followed by terminal reobservation, multipage evidence for two authorized prompts, and cursor/foreign/model/permission/endpoint refusal. Held cleanup drain is tested at the direct-worker boundary; a trusted-snapshot-seeded late-ACK case isolates the callback rather than natural producer timing.

Maintained retention runtime/recovery cases cover qualified predecessor replacement, copied/unqualified-owner isolation, unavailable credentials, later terminal settlement, held setup/cleanup, metadata-only late ACKs and controller authority guards. `agentic-search-unbound-stop` verifies local Delete of proven untouched user-stopped turns. The HTTP retention tests additionally hold actual configured submission and daemon cleanup/shutdown: local Delete returns early, but the lease remains exclusive until local drain. Configless HTTP deletion preserves unresolved non-content evidence without SDK calls. A three-run backlog is not exhaustive fairness or performance evidence, and orderly replacement is not OS-crash recovery of an in-flight request. Every snapshot-reuse or concurrency ordering remains beyond these focused checks. Composer discard and the [owned search walkthrough](#isolated-agentic-search-walkthrough) now have HTTP coverage; no provider-side erasure is promised.

### Web foundation checks

```sh
bun --no-env-file run web:test
bun --no-env-file run web:typecheck
bun --no-env-file run web:build
bun --no-env-file run web:test:runtime
bun --no-env-file run web:test:integration
```

`web:test` runs the controlled `tests/web-*.test.ts` unit checks, also included in the ordinary Bun suite. The production runtime harness is a separate opt-in: it builds and starts an owned loopback Next.js server, then uses the installed Playwright package and `/usr/bin/chromium`. It checks trusted Host/mutation Origin handling, generated browser assets and output for test-owned credential sentinels, and the shared shell's navigation, focus, local font, and overflow at desktop/narrow widths. It does not contact the operator daemon or a model provider, and does not install a browser automatically.

For the focused multi-origin proxy check, run `THOUGHTLOOM_TEST_GUARDS=1 bun --no-env-file run web:test:runtime`. The owned production build probes two configured loopback authorities through the same owned server, including same-origin mutations, cross-port denial and forwarded-host spoofing. It does not contact the second port, exercise API route guards or establish behavior of an external HTTPS proxy.

`bun --no-env-file test tests/web-import-boundary.test.ts` checks the Next import boundary with controlled upstream responses: exact multipart bytes and idempotency keys, bounded uploads, trusted mutations, server-only credentials, report identity and shape validation, and uncertain outcomes without automatic replay. An isolated child fixture invokes the actual Next route exports, including import-run classification before Stop. These checks establish forwarding and response handling, not Next router behavior, browser interaction, or real-daemon deduplication.

The import runtime companion exercises the Capture entry and retained draft, selection without upload, local Not sent files, exact upload bytes and keys, uncertain admission without automatic reupload, paginated report checks, mixed file outcomes, known-run Stop, report reopening and deliberate original inspection. Controlled client-helper tests separately cover request and response validation. Both source-copy harnesses include the import providers, components, styles and fixed server routes; keep their allowlists current when runtime inputs change.

`bun --no-env-file test tests/web-connection-command.test.ts tests/web-idea.test.ts tests/web-boundary.test.ts` checks the connection-create command, exact supported fields, server-owned identity/authorship, canonical receipts, known failures and uncertain submitted snapshots without automatic replay. Controlled Idea request tests also check best-effort cancellation of unread error bodies, unchanged outcomes when cancellation throws, rejects or remains pending, and consumption of accepted or malformed JSON. These checks do not establish a navigation or performance fix. The Idea runtime companion exercises the guided connection editor at desktop/narrow widths, including search/preview, direction, required rationale, optional source thoughts, Cancel confirmation, refresh/navigation reset, pending submission and uncertainty. The shared-record integration walkthrough creates a user connection through Next and verifies its canonical endpoints against the owned daemon. Candidate selection must distinguish thought identity, not assume matching text is unique.

The runtime harness copies an explicit allowlist of current working-tree application/configuration files into an owned temporary workspace, installs the frozen root lock there with lifecycle scripts disabled, and builds and starts there with test-owned configuration. Dependencies resolve inside that workspace, not through links to the working tree. Generated `next-env.d.ts` and `.next` files are created by the fixture build, not copied or required from an earlier working-tree build. It excludes personal `.env` files and databases; do not remove personal configuration to run the checks. Update the source allowlist when adding runtime inputs so the fixture continues to represent the application. Bun's environment-file flag does not disable Next.js's independent application environment loading.

For the focused root intro browser checks, run `THOUGHTLOOM_TEST_ROOT_SPLASH=1 bun --no-env-file run web:test:runtime`. These use the same owned build and desktop/phone Chromium contexts. They exercise root lifecycle, the completed-dissolve visibility boundary, actual history replacement, Skip/Escape cleanup, reduced motion, a no-JavaScript link, direct Explore/deep-link bypass and blank-search request absence. They also check served artwork bytes; they do not certify visual timing, screen readers or physical devices.

Header navigation checks locate the contextual Back control inside the banner, verify its destination-specific accessible name, hover/keyboard-focus tooltip, target and focus treatment, and reject duplicate content-area return links. Idea returns to the previous viewed thought when available, otherwise validated Explore results with query and scroll intact. Evolve retains its contextual destination and mounted workspace state; Simple export returns to its Idea, while the Exports subtree has catalog/detail destinations. Root Explore/Capture do not inherit a stale arrow. Parent-title navigation remains a separate content action. Both browser source-copy allowlists include the shared contextual-back component.

Browser checks cover the shared foundation, Capture, Explore, Idea, Evolve and Export. The owned fake daemon exercises actual server-side authentication, forbidden-origin rejection before upstream writes, canonical capture receipts, pending double-click suppression, definite denial and deliberate retry, uncertain outcomes without automatic repost, explicit duplicate intent, retained snapshots, and clear-after-success. Controlled `web-capture` unit tests separately cover malformed receipts, failed transport, forbidden caller metadata, optional titles and snapshot copying. Owned HTTP transport tests exercise timeout, redirect denial and redaction. Screenshots alone establish neither API behavior nor complete accessibility compliance.

The two approved decorative SVGs are explicit public inputs in both browser source-copy allowlists. Foundation HTTP checks compare served SVG bytes with the fixture's public files. Capture/Explore companions verify loaded 24px images, 8px heading gaps, unchanged accessible heading names, empty alternatives, hidden decorative semantics and no image focus stop. Capture keeps its sprout through saving/receipt states; Explore's lantern is absent during blank-query validation, loading, results, empty results, read errors and invalid bookmarks. These checks preserve the user-approved SVG shapes, including the sprout's separated leaf; they do not enforce the superseded connected-leaf design preference or claim screen-reader certification.

The nine separately approved content/relationship assets and shared `content-glyph.tsx`/CSS are also explicit inputs in both browser allowlists. Focused glyph checks use controlled material kinds, response roles and persisted relationships in Explore, Idea and Evolve. They compare actual served bytes with the approved production package, verify 20px leading record/material cues, 24px focal Idea and 16px relationship marks, and retain words/authorship/direction. A Full reply result must not also display the underlying material icon. The fake-daemon foundation supports one focused screen without running its full walkthrough: `THOUGHTLOOM_TEST_GLYPH_CASE=explore bun --no-env-file run web:test:runtime` (or `idea`/`evolve`). This still uses the documented owned source-copy/frozen-install/production-build bootstrap and both desktop/narrow widths; it is not permission to use an operator daemon. Keep the approved candidate package available to the outer test process for exact source-byte comparisons. The source PNG's 16px cue remains label-dependent; loading/screenshot checks are not proof of standalone recognition or screen-reader certification.

The separately authorized Explore clearing has a [production package](../.impeccable/candidates/explore-clearing/README.md) and a byte-identical promoted PNG in `apps/web/public/backgrounds/`. Its source-preserving color-matte recipe uses Python 3 and the exact installed ImageMagick build recorded in that package. Use an owned, empty candidate directory:

```sh
python3 -B -m unittest discover -s .impeccable/candidates/explore-clearing -p 'test_build.py' -v
python3 -B .impeccable/candidates/explore-clearing/build.py --output-dir /tmp/opencode/explore-clearing-build
python3 -B .impeccable/candidates/explore-clearing/verify.py --candidate-dir /tmp/opencode/explore-clearing-build
```

These explicit asset checks are separate from ordinary Bun tests. Unit tests own synthetic pixels and explicit matte settings; the verifier uses the actual packaged approved source to check pinned identity, deterministic rebuilds, candidate bytes, real alpha and embedded provenance. They use no daemon, provider or user data and do not promote files to `public/`. Static desktop/phone derivative evidence is not built-Next acceptance.

Both browser-harness allowlists include the promoted clearing PNG. The existing Explore browser companion compares actual served bytes to the production package, verifies loaded decorative/nonfocusable/noninteractive semantics, and checks its absence during validation, loading, results, no results, invalid bookmarks and errors. Layout probes cover 359/360px width and 699/700px height boundaries plus 600/800/1024px intermediate widths, including expanded narrow Filters, no control overlaps and no horizontal overflow. The production package is an outer-test reference, not browser-delivered source/provenance. These assertions do not establish physical-device, software-keyboard or screen-reader certification. Run them through the existing focused `THOUGHTLOOM_TEST_EXPLORE=1 bun --no-env-file run web:test:runtime` command; no operator service is involved.

The separately approved Capture canopy has a [lean production package](../.impeccable/candidates/capture-canopy/README.md), with an immutable source and a byte-identical promoted runtime PNG. Its existing soft alpha is retained by ordinary RGBA resampling, not the clearing's backdrop-removal recipe. Explicit mechanical checks are:

```sh
python3 -B -m unittest discover -s .impeccable/candidates/capture-canopy -p 'test_build.py' -v
python3 -B .impeccable/candidates/capture-canopy/build.py --verify --output-dir .impeccable/candidates/capture-canopy/production
```

Four pure helper tests and two clearly marked ImageMagick integration tests use only owned dimensions, metadata envelopes and RGBA pixels; none reads the approved artwork or production tuning as a unit fixture. Read-only package verification separately checks actual source identity and deterministic derivative bytes. Both runtime harnesses copy only the public canopy PNG, not authoring/provenance files, into their Next fixture.

The existing `capture.runtime.ts` companion verifies the loaded image and served bytes, empty alternatives/hidden semantics, no tab stop or dragging, pointer-event suppression and the 196 × 294px display size. It asserts stable document-relative placement across filled/blank/validation, held saving, saved, denied and uncertain outcomes without weakening its existing save-count, retained-draft and recovery checks. Layout probes cover 768/769px at default browser sizing (the actual 48rem full-width Capture breakpoint), 900/1024/1440px gutters and 125% root text at 900px: 87% form width, 1rem clearance, clipping, no control collisions or horizontal overflow. Narrow omission does not promise zero asset downloads. Import checks retain the existing entry/draft behavior and require no canopy on `/import`; an Explore route control also requires no Capture canopy. Run these through the full `bun --no-env-file run web:test:runtime` harness; there is no separate Capture-only switch. These are owned-fixture checks, not operator-service, physical-device, software-keyboard or screen-reader certification.

The Explore companion uses controlled search results and inspection failures, not live project records. It verifies fresh-browser-context bookmarks and reloads, URL-backed facets/UTC dates/sort/scope, canonical thought/reply identity and daemon counts/context, text expansion, known/unknown rejection labels, errors/retry, stale-response suppression, and mobile Filters Escape/focus return. Return-scroll coverage requires a positive position and reports expected/restored values rather than silently skipping a short fixture. Direct bookmarked searches do not depend on a previously mounted provider. Unit `web-explore` tests cover strict query/DTO validation, date helpers with a fixed clock, safe links, bounded/deduplicated thought inspection, client abort forwarding and query-log privacy.

After stopping the owned production server, the harness starts an owned Next.js development server and sends distinct query sentinels through the search API and a bookmarked Explore page. Successful HTTP/upstream controls establish that the requests were exercised; drained development stdout and stderr must contain neither sentinel. This covers framework incoming-request logs as well as the application's separate transport logging tests.

The Idea companion uses a controlled graph and mutation receipts for fresh bookmarks, associated replies, title-only edits/clears, immediate-parent navigation, direct context and on-demand rationale, restore-control eligibility, branch restoration without connection commands, and uncertain writes without replay. The fixture retains its lifetime request audit across state resets; connection-rejection counts use a per-walkthrough baseline, independently checked by `tests/web-idea-walkthrough-audit.test.ts`. Direct context includes children, provenance and discovered connections; overlapping relationships share a thought row without losing labels or connection-specific actions. Tests exclude recursive grandchildren and the old History/Sources disclosures. A held stale-preview scenario verifies that `409` applies nothing, old confirmation becomes unavailable, and the newly returned preview requires another explicit user confirmation with unchanged data. Held writes cannot retarget a newly focused idea. Disclosure checks verify stable enabled-trigger focus after uncertainty, scoped Tab/Escape behavior and outside-click dismissal without stealing title-input focus. Technical `web-idea` tests independently exercise scoped canonical reads, direct-parent rather than ancestor traversal, deduplicated bounded reference reads, unavailable versus failed references, safe links, exact command forwarding (including individual connection restoration), preview snapshots and sanitized outcomes.

The Evolve companion scripts admissions, known-run status, Stop, recorded developments and associated replies at desktop and narrow widths. It distinguishes mounted draft/run return from fresh reload and explicit earlier-Idea entry, continuation selection from browsing, complete from interrupted fallback, saved output from terminal failure, and unconfirmed admission/Stop from confirmed outcomes. Request counts use viewport/operation baselines while preserving the full daemon audit. Reload has a positive selected-thought fetch control in the new document, rejects new-document admission/Stop/run fetches, and independently rejects writes arriving at the fake daemon; a late read initiated by the old document is not evidence of reload recovery. These controlled cases do not establish live provider performance or persistent workspace recovery.

Composer checks require Send beside the labeled contribution textarea on desktop and narrow screens, with a comfortable target, readable input width, no horizontal overflow and logical keyboard order. The redundant empty-contribution helper is absent, while empty/whitespace disabling, pending and unknown-admission guards, retained drafts and meaningful warnings remain covered. This is the explicit user-approved layout deviation from the original mockups, not a change to admission semantics.

Search integration tests also need the [native extension build prerequisites](server-startup.md#native-spelling-extension). Run `bun run build:spellfix` before tests that use the default project artifact, including `search-contract` and `search-scopes`; that ignored artifact is absent on a fresh checkout and is not built automatically by the test command. Separate native pipeline tests compile the pinned vendored source into owned temporary outputs, verify its hash, load it through Bun SQLite, and check tamper and missing-artifact failures. Those temporary builds do not populate the default artifact. No system extension is assumed.

The Export companion exercises Explore's persistent export catalog, bounded continuation, separate request form, bookmark/reload recovery, exact report downloads, Stop/settlement-gated deletion and restored local-discard acknowledgment. Idea's contextual Export is checked as Simple-only, with a normal-scope root and exact UTF-8/line-ending download bytes without another export request. Unknown admission does not replay or invent a run identity. Previews retain safe Markdown and producer-appended source links resolved only in normal scope. Run this companion alone with `THOUGHTLOOM_TEST_EXPORT=1 bun --no-env-file run web:test:runtime`; mutation counts are scoped to each walkthrough, not accumulated across desktop and phone fixtures. Unit cancellation spies verify that abandoned browser response bodies are released even on unexpected status/content type, without changing outcome classification if cleanup fails. This protects navigation from unfinished no-store error responses.

`bun --no-env-file test tests/web-export.test.ts` checks the Next server boundary with controlled upstream responses, including history/metadata projection, malformed export fields, actual non-export response shapes, identity validation, pagination, local deletion and sanitized failures. Unknown extra fields are stripped from export metadata; generic run responses separately require the export discriminator. These checks establish forwarding and response handling, not browser behavior or real-daemon lifecycle safety. Both browser source-copy allowlists include the actual Exports page, controller, type and style dependencies.

`bun --no-env-file test tests/web-export-controller.test.ts` uses controlled deferred fetches to check stale deletion-recovery fencing and catalog re-entry across admission outcomes. The focused browser modes `THOUGHTLOOM_TEST_EXPORT_RACE=normal` and `THOUGHTLOOM_TEST_EXPORT_RACE=unknown-saved`, each with `bun --no-env-file run web:test:runtime`, hold submission while Cancel opens and finishes reading the catalog, then release a saved admission. They require the mounted catalog to reconcile without manual refresh, reload or a repeated POST, including when admission's response is uncertain. These actual view-lifecycle cases complement rather than replace the controller checks.

`web-export-markdown` runs the actual shared renderer through ReactDOMServer, with positive formatting/text controls and hostile HTML/link/image inputs. It does not substitute a fake renderer for safety evidence. Bun test registration stays in the root wrapper; the app-local helper has no Bun test-runner dependency. Source parser tests separately cover the producer's code-delimited JSON-ID appendix grammar and reject arbitrary body links as source identity. These checks do not prove live provider report quality.

The Idea metadata check requires About to share the existing desktop action row while allowing narrow wrapping. It exercises the disclosure's expanded state, keyboard activation and retained focus, then checks the existing metadata inside that disclosure rather than matching repeated source IDs elsewhere on the page. Opening About must not alter the selected thought or add a metadata-fetch operation. Resting-state checks require Edit title, Full reply, About and More actions to remain native buttons with underlined text using the existing link-color token, distinct from focal thought text.

For a focused Explore browser check, run `THOUGHTLOOM_TEST_EXPLORE=1 bun --no-env-file run web:test:runtime`. It includes imported-source authorship and material filters, their counts, query forwarding and bookmark restoration, using test-owned search results. This focused mode does not replace the complete runtime check.

### Media client boundary and browser checks

`tests/web-import-boundary.test.ts` covers fixed Next media upload, original-key receipt lookup, scoped source reads, retry, weave status/Stop and private download. It checks trust, bounded requests, strict receipts, sanitized errors and safe encoded keys. `tests/web-boundary.test.ts` covers the shared transport and both upload limits in Next's proxy configuration. `tests/web-media-client.test.ts` exercises actual multipart serialization through the client and Next boundary, including quoted versus literal-percent filenames and release of local file references only after confirmed receipts.

The foundation companion `apps/web/tests/media-import.runtime.ts` uses test-owned files and controlled same-origin responses at desktop and phone widths. It covers the single Capture chooser and draft return, explicit upload, frozen inputs/key, uncertain admission and deliberate same-key replay, source/interpretation separation, exact-byte download, latest source status, retry/Stop uncertainty and explicit rejected inspection. Controlled held reads reproduce restore, title-save/output, and ordinary-command/output refresh races; canonical content and source status must settle without manual recovery or extra writes.

The default `web:test:runtime` includes these cases. For focused investigation, use `THOUGHTLOOM_TEST_MEDIA_CASE=entry` with that command, or select `upload-recovery`, `source-status`, `source-gates`, `source-retry`, `source-rejected`, `source-restore`, `source-title-race`, or `source-command-race`. Prefer one default run for combined verification rather than repeatedly installing/building a fixture for each case. Both browser allowlists explicitly include the media client and route inputs. An outer fixture running the harness must also retain the tracked artwork references used by existing Capture, Explore and glyph byte-comparison checks; production public copies alone do not replace those test inputs.

These controlled browser checks do not establish provider understanding, actual OpenCode tool access, shared-record media continuity, physical-device behavior or screen-reader certification. Use the backend HTTP suite for owned media persistence/worker contracts; shared-record browser coverage is described separately below. No operator service or personal media is a fixture.

### Root splash checks

The user-approved root intro has a [source-preserving package](../.impeccable/candidates/root-splash/README.md). Its two public WebPs are byte-identical extractions from the immutable approved study; no image encoder, generator, heavy tracing or screenshot is used in the runtime. Explicit mechanical checks are:

```sh
python3 -B .impeccable/candidates/root-splash/build.py --verify
python3 -B -m unittest discover -s .impeccable/candidates/root-splash -p 'test_build.py' -v
```

The six helper tests own their payloads, XML and numeric ranges; actual artwork identity and retimed mask assembly are separately verified by the read-only package check. Both production-browser harness allowlists include only the two promoted WebPs and the four new root-splash component/CSS inputs, not the authoring/review package.

Run the focused actual-client boundary through:

```sh
THOUGHTLOOM_TEST_ROOT_SPLASH=1 bun --no-env-file run web:test:runtime
```

`root-splash.runtime.ts` exercises ordinary root completion, served artwork byte/hash identity, keyboard isolation, history replacement, explicit-root replay, Skip/Escape and stale-handler cleanup, direct-route bypass, reduced-motion/no-script entry and each artwork failure. No-script entry is checked under both default and reduced motion: Open Explore must be visible, reachable by Tab and usable with Enter. The JavaScript-enabled reduced-motion path separately requires immediate navigation without the intro delay. Its warm-provider regression preserves remembered filtered query/results/expansion and saved scroll without a repeated completed search or premature root URL change. A separate held-search case checks selection continuity and resumption after an in-flight search is abandoned. Ordinary Explore keeps its sticky header available while reading: real-user Capture navigation must begin with the link fully in view and must not move the saved reading position. Programmatic activation after scrolling can mask a broken sticky containing block and is not a substitute for that navigation contract. The focused mode uses the existing isolated production build/fake daemon and default desktop/narrow viewports; it is not a standalone HTML test, operator service, physical-device, software-keyboard or screen-reader certification.

For the separate cold destination-chunk handoff check, run `THOUGHTLOOM_TEST_ROOT_SPLASH_CHUNKS=1 bun --no-env-file run web:test:runtime`. This mode uses an owned Next development server and fresh desktop browser context, not the production build. It compiles both routes, derives destination-only ExploreView scripts from their generated manifests, and holds those scripts while allowing Flight responses and the normal intro dissolve. It checks that revealed Explore controls remain available without a loading fallback, then releases the scripts and checks usable `/explore` and no blank search. It does not establish production chunk behavior; the production root-splash mode above covers the built app without this controlled chunk delay. Neither mode uses an operator daemon or provider. These descriptions define coverage, not a claim that the commands passed on the current revision.

For ordinary playback, the browser regression samples computed visibility synchronously when a completed overlay animation is canceled, before React can remove the overlay. Any connected completion sample must remain invisible; eventual navigation alone cannot detect a transient reappearance. This check does not establish frame-by-frame visual timing.

The designer's exact-frame/actual-playback static study checks remain separate from actual runtime evidence. Runtime visual inspection covers the real opaque overlay, completed scene, dissolve, SSR route-aware hidden/inert shell and the actual Explore destination at 1440 × 900 and 390 × 844. Completed-art crops match the approved study with zero differing pixels. Selected captures predate the shell-containing-block correction and do not replace full sticky-navigation regression checks. A green command must be recorded after independent final execution; art/motion evidence alone does not establish full-suite green or preserved ordinary header behavior.

### Conversational search client checks

`bun --no-env-file test tests/web-agentic-search-controller.test.ts` uses injected client, key and clock sources to check workspace isolation, occurrence removal/rediscovery, loaded-page refresh and non-UTC/DST clock formatting. It does not contact a daemon or model. Keep fixtures independent of the current library and model configuration.

The owned production runtime harness includes fixed search-session/search-run BFF checks and desktop/narrow browser companions. These cover explicit New/Resume, bookmarks without automatic writes, conversation/discovery/preview, uncertain admission with same-key Check, known-run Stop, blocked-context recovery, unavailable placeholders, title/Copy link/History/Delete, and draft/reading-position return from Idea. BFF checks include strict normal/history separation, control-only identity validation, paired clock forwarding, colon-bearing recovery keys and exact previews larger than 1 MiB. Neither control receipts nor retained request snapshots are evidence of normal conversation content.

For a focused harness run, set `THOUGHTLOOM_TEST_AGENTIC_CASE` with `web:test:runtime`: `routes`, `workspace`, `turns`, `controls`, `recovery-key`, `large-preview`, `entry`, `saved`, `ui-core`, `ui-unknown`, `ui-context`, `ui-return`, `ui-actions`, `ui-unavailable`, `ui-idle-retry` or `ui-active-reading`. For example:

```sh
THOUGHTLOOM_TEST_AGENTIC_CASE=ui-core bun --no-env-file run web:test:runtime
```

These selected modes are focused checks, not replacements for the complete runtime command. Both source-copy allowlists must include the search provider, controller/request/location modules, components/styles and fixed route handlers. The generated comp PNGs are not runtime inputs. Controlled fixtures establish recovery and privacy boundaries, not retrieval quality, live OpenCode behavior or comprehensive accessibility certification.

### Shared-record browser acceptance

`web:test:integration` is a separate opt-in, not part of the ordinary test suite. Its built-in-only bootstrap copies an explicit set of current source/configuration inputs into an owned workspace, installs the frozen lock, builds the checksum-verified spellfix extension there, and starts the inner fixture with dependencies resolved inside that copy. It does not reuse private environment files, personal databases, generated launchers or ignored working-tree build artifacts.

The allowlist in [`integration.bootstrap.ts`](../apps/web/tests/integration.bootstrap.ts) follows the daemon's runtime imports and the media client workflow. It includes daemon `import-body.ts`/`media-routes.ts`, domain `media-import.ts`, and storage `media-import.ts`, `media-admission.ts`, `media-files.ts`, `media-file-paths.ts`, `media-validator.ts`, its child entry `media-validator-worker.ts`, `media-validation.ts` and `media-pdf-validation.ts`, alongside `run-fences.ts` and the media metadata/migration modules. The child entry is a file input even though launched by URL rather than a static import. Worker modules still receive a resolver function; the daemon owns construction. Keep the copied closure aligned with actual imports/child entries. Source inspection alone is not a harness rerun.

The inner fixture's native client implements session-scoped keyed instruction
storage. Before the browser walkthrough, deterministic checks verify empty
state, session isolation, replacement and removal. These checks establish the
fake client's contract, not live OpenCode behavior. Root typecheck includes
`integration/**/*.ts`; any outer validation copy must contain those inputs
before running typecheck, not add them only before the browser command.

Unlike the per-screen fake-daemon runtime, this walkthrough connects the browser and production Next server to a real owned Hono daemon backed by temporary SQLite and injected deterministic fake-agent callbacks. Desktop and narrow paths follow the same Capture-created identity through Explore, Idea, Evolve and both exports, including the actual persisted AI interpretation, its parent/provenance, title changes, rejection/restoration and mounted known-run return. Non-export work settles by explicit state predicates before knowledge-table snapshots, and the intended Evolve follow-up weave must publicly complete rather than merely reach any terminal status. Fake interpretations cite their own job's fully read subject. Run/report bookkeeping may change without implying a knowledge mutation. Held fake responses are released before daemon drain, and cleanup attempts all owned resources even if an earlier release fails.

A separate imported-record path selects and uploads test-owned Markdown in the browser through the Next import workspace, then opens its report, retained original and imported Idea against the real owned daemon. The fixture supplies strict fake-SDK segmentation using the submitted manifest. It checks exact source bytes, imported attribution, user-only original access and completed weaving, then follows that actual imported record through filtered Explore, Idea, Evolve, Simple export and an Agentic report with a source citation. Browser requests go through Next.js, never directly to the daemon. Both desktop and narrow viewports exercise this path.

The media path uploads an independently generated valid PNG through the same browser boundary, retains its actual source/run identities, and waits for a canonical fake-agent interpretation. It verifies exact clarification, unverified file authorship, filename fallback and original download bytes, then follows the persisted source through media-filtered Explore, Idea, Evolve, Ask preview, and both exports. Rejection checks distinguish normal exclusion, explicit user-history download and denied AI access. The fake agent exercises the recording contract; it does not establish image understanding or actual OpenCode filesystem access.

The conversational-search path uses the real owned Hono/SQLite runtime and a deterministic decoded fake agent to find/read/discover existing thoughts. Both viewports exercise explicit New/Resume, bookmarked reload without writes, recorded conversation, eligible discovery/preview, Idea return, fixed-occurrence removal and fresh rediscovery, user-only History, and local session Delete preserving library records and another session. It does not exercise Stop or rejection during that search journey; controlled per-screen and backend tests cover their separate boundaries.

This proves controlled shared-record continuity, not real provider behavior, cross-reload unsent-draft persistence, physical-device usability or screen-reader certification. Keep the detailed per-screen tests for recovery, focus, safe Markdown and request boundaries rather than duplicating every edge case in this walkthrough. Neither browser command starts or changes the operator OpenCode service.

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
| Agent configuration and adapter | Optional/malformed configuration, Basic discovery headers and Bearer transport, immutable session binding, paginated history correlation, settled permissive tool turns, uncertain admission, quarantine and cancellation using controlled facades and owned HTTP fixtures. | `agent-config`, `opencode-adapter` |
| Shared-file media execution | Real retained original with normal worker/native fake, scoped initial/readThought path context, canonical searchable interpretation and Full reply, Evolve supporting reads, held rejection/restoration fencing, restricted roles and title-only behavior. Atomic source/weave admission, replay, deliberate retry and file integrity use owned fixtures. No real filesystem-tool/model claim. | `media-path-worker`, `media-admission`, `media-weave-purpose`, `media-source-migration`, `media-source-projections`, `media-files`, `media-files-faults` |
| Media HTTP/runtime | Actual owned Hono/SQLite/private files and validator, user-only bounded upload, receipts/replay, scoped exact downloads, configless queuing, normal fake-agent interpretation/retry, held shutdown/reopen and paired restore/mismatch refusal. No provider, native filesystem-tool, browser or arbitrary-crash claim. | `media-import-api` |
| Scoped capabilities | Narrow AI search/read projections, exposure tracking versus full-read witnesses, connection/source prerequisites, malformed authority, replay and Stop/rejection fences, witness/final-cache rollback, populated predecessor migration and export write denial. | `capabilities`, `capability-migration` |
| Agentic search persistence | Separate session schema, actual run-kind CHECK upgrade and incoming-FK preservation/rollback, same-session ownership, retained-content/composer guards, occurrence uniqueness and narrow tombstoned purge/cleanup constraints. Raw SQL fixtures do not establish dispatcher/full-read authority. | `agentic-search-migration` |
| Agentic search lifecycle | User-only metadata/history facet with test-owned IDs/clocks, create replay, revision rename, bounded catalog/history continuations, tombstones, local-only purge and fail-closed bound/possible-dispatch deletion. No search-session HTTP or agent runtime is exercised. | `agentic-search-sessions` |
| Agentic search turn persistence | Trusted composer message coverage, signed revision claims, atomic run/turn/user-message and whole-union persistence, frozen clock intent, control-only exact replay, role/authority rejection and distinctive post-run/turn fault injection. No query investigation or native dispatch; rejection transactions have separate coverage. | `agentic-search-turns` |
| Agentic search publication | Claim/prompt/native-evidence and recorded full-read fences, whole-exposure dependencies, occurrence add/no-op/replay/removal/rediscovery, atomic final replies and dependency-fault rollback. Completed native evidence is SQL-owned fixture data, not a real native/dispatcher integration. | `agentic-search-publication` |
| Agentic search rejection | Real user-only rejection transaction, dedicated revision effects/no-ops, direct and implicit endpoint/response-member dependencies, scoped run/composer fencing, reject-restore non-revival and distinctive post-fence rollback. No native cancellation/drain or dispatcher race proof. | `agentic-search-rejection` |
| Agentic search normal workspace | Bounded message/discovery pages, monotonic current-composer coverage, signed position continuations, refresh/admission and recovery boundaries, current rationale eligibility, removed-occurrence filtering and AI-normal preview without full-read authority. No HTTP/client cache handling or native execution. | `agentic-search-workspace` |
| Agentic search core runtime capabilities | Real configured find/read/add/reply chain, approved manifest membership, one native session across ordered message IDs, durable results/witness progression, cross-run noninheritance, denied snippet-only publication and ordinary knowledge writes, unchanged controlled library tables. No live provider or broad replay/race proof. | `agentic-search-capabilities` |
| Agentic search rich runtime capabilities | All nine capabilities; actual rich reads, same-session clock conversion with foreign-position collision/unsafe-intent controls, removed/unsafe-rationale filtering, provenance redaction, record-kind witnesses and caller-authority denial. Rich paging, replay, rollback and held-race coverage remains separate work. | `agentic-search-rich-capabilities` |
| Agentic search clock runtime | Injected monotonic/wall sources check exact-hour versus due refresh, scoped observations, observation-only waiting, uncertain acknowledgement, retained prepared input and cold reconstruction. Original anchors and honest sample age/skew remain in exact SQL/native input; no clock-only prompt. Browser forwarding and actual capacity eviction remain separate coverage. | `agentic-search-clock-runtime` |
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
| Web Export operations/preview | Simple-only contextual export; separate Agentic history, metadata and deletion forwarding; export identity, artifact-read gating, exact bytes, malformed response rejection and public-field projection, abandoned response cleanup, producer appendix parsing and normal source resolution; actual Markdown SSR safety and formatting. | `web-export`, `web-export-sources`, `web-export-markdown` |
| Native daemon | Real HTTP plus SQLite, startup validation, persistence across restart, concurrent captures, port conflicts, bounded failure cases and process signals. | `daemon` |
| Scripts | Request validation and diagnostics with injected fetch, plus a real isolated walkthrough and cleanup on success/failure. | `scripts` |

Names in the last column refer to `tests/<name>.test.ts`. Some files contain integration checks as well as small unit cases; choose the boundary needed for the change, not just the filename.

The import-attribution/storage-foundation slice can be checked without a parser, browser, provider or operator service:

```sh
bun --no-env-file test tests/domain.test.ts tests/search-contract.test.ts tests/sqlite.test.ts tests/capability-migration.test.ts tests/markdown-import-foundation.test.ts
bun --no-env-file run typecheck
```

Build spellfix first for `search-contract` as described above. These checks cover exact imported thought text and later title attribution, unchanged user/AI combinations, source/imported-original filter/count shapes, fresh import membership/seal FK declarations, and populated predecessor preservation/reopen. The dedicated foundation fixtures also exercise direct-SQL seal and mapping guards, deferred-commit failure and rollback, reservation interleaving across two connections, bounded write-lock contention, rejection-safe inspection, and finalization rollback at 11 injected points including the last weave admission. Migration fixtures inject failures during staging and after destructive rebuild work has begun. These establish controlled transaction behavior, not simultaneous independent-worker execution or a large-database performance benchmark. The storage fixtures use test-owned parser manifests/ranges; the separate parser tests exercise the implemented Markdown preparation and selection functions. Neither suite establishes import-native terminal correlation or HTTP upload behavior.

For loose-file identity and HTTP admission specifically, run `bun --no-env-file test tests/markdown-import-foundation.test.ts tests/markdown-import-api.test.ts`. These owned SQLite and daemon fixtures cover same-name distinct bytes, library-wide duplicate skips without additional import runs, stable non-loose path protection, and repeated migration of legacy locator guards with retained documents and pending work. Build spellfix first; no provider, shared daemon or personal database is used.

The separate no-agent daemon integration check is:

```sh
bun --no-env-file test tests/markdown-import-runtime.test.ts tests/markdown-import-foundation.test.ts tests/opencode-adapter.test.ts tests/import-authority.test.ts tests/supervisor-runtime.test.ts
```

`markdown-import-runtime` admits controlled source bytes through internal storage and starts an owned Hono/SQLite daemon. Unconfigured cases cover structural finalization, duplicate waiters, bounded local progress, metadata-only inputs, restart from a saved partition, pause, Stop and corrupt staging. The configured case injects an in-memory native facade and checks one restricted owned prompt, standard variant, validated AI grouping, exact private preparation, source preservation and atomic weave admission. It uses no HTTP import admission, provider or operator service. `opencode-adapter` separately tests import-only terminal classification, full history, exact output and fencing; `import-authority` exercises persisted SQLite observation authority and its negative cases. These tests do not yet establish the full configured fallback/restart/race/cancellation matrix or large-vault scheduler performance. Source-copy harnesses that start the real daemon must include `src/agent/import-driver.ts`, `src/agent/import-worker.ts`, `src/storage/import-authority.ts`, `src/storage/markdown-import.ts` and the parser facade/implementation/contract; the shared-record bootstrap explicitly enumerates these inputs. The fake-daemon browser foundation does not import the Hono runtime and needs no such expansion.

Run `bun --no-env-file test tests/markdown-import-worker-preparation.test.ts` for deterministic worker parse-count checks. An injected paired `MarkdownParser` wraps the real AST parser, while real SQLite and an in-memory native facade exercise preparation, observation and partitioning. Valid/failed/invalid terminal paths and unchanged pre-dispatch retries keep one AST pass; restarting a submitted job or evicting its preparation causes no parse during pending observations and one restoration only at terminal selection. Durable-choice recovery uses zero AST/native calls, and Stop prevents cached source publication. The four-entry preparation cache is separate from fixed-size per-live-claim verification metadata; neither retains source buffers or AST/native graphs. These are exact call-count and authority tests, not flaky RSS thresholds or an exhaustive cache-invalidation/race proof. Repeat the explicit resource probe separately when assessing process memory.

Exact-text fixtures must compare submitted wording, stored BLOB bytes and returned thought/search/projection text, including a segment beginning with U+FEFF after a leading separator. Equality between pre/post-migration database reads alone can hide a character lost during an earlier write. Thought writers bind UTF-8 bytes and cast to TEXT to avoid Bun's consumption of a leading U+FEFF in a string parameter.

For example, title changes can be checked with:

```sh
bun test tests/titles-domain.test.ts tests/titles-sqlite.test.ts
```

### Controlled inputs, not production assumptions

- Unit tests own their records, IDs, clocks, configuration, and mocked dependencies. Valid changes to application data or configuration should not break those tests.
- SQLite integration tests use in-memory databases or unique temporary directories. They verify actual persistence and constraints, not a mock database's approximation.
- Migration tests include frozen, populated legacy schemas, including inline-title and separate-title databases with single-owner responses. They check preservation of thoughts, provenance, rejection state, titles and response associations, then migration idempotence and reopening. The reconstructed immediate-predecessor search fixture has the coupling limitation described above. These tests do not inspect or reset a user's database.
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

Deterministic agent tests supply controlled model proposals and replies. They check rendered Weaver and Evolve discovery instructions, conditional contribution title filling, scoped capabilities, full-read evidence, saved developments and run behavior. Evolve follow-up scheduling targets the latest development only, while a no-development reply remains attached to the contribution. These checks do not establish that a model will discover connections, semantic model quality or live-provider availability. Other command/API tests still simulate AI-authored calls directly.

Run-kernel tests use a controlled `NativeDispatcher`, not the real OpenCode client. They establish domain/storage recovery and fencing, not native service compatibility. Claim generation is not an expiry-based lease or a model effort quota.

Adapter tests also exercise the maintained public SDK against owned loopback HTTP fixtures. They do not discover the operator's service or read its registration credentials. Fake server identity versions test the absence of an exact-version gate, not compatibility with every future release. Native processes and real provider calls are not part of ordinary tests.

The worker core has a manual polling seam for controlled tests. It reuses durable steps, bindings, capability results and canonical replies. A tick is an execution boundary, not a model effort quota. Local pause is distinct from user Stop: it fences callbacks without undoing saved work or initiating cancellation. `agent-runtime` exercises configured scheduling, Evolve/status/Stop HTTP routes, role restrictions and unavailable-service behavior through an owned daemon with injected service/client dependencies.

`bun --no-env-file test tests/opencode-adapter.test.ts tests/worker.test.ts` exercises ordinary cancellation using controlled native history and test-owned SQLite. Regression cases distinguish positive terminal evidence from an empty inbox/inactive snapshot after an uncertain submission, incomplete or mismatched history, native outages, and foreign ownership. Real-adapter cases check all dispatched steps through paginated history, settled native-tool turns, and correlated failed/interrupted terminal boundaries without assistant prose; removing an earlier boundary must leave cleanup pending. A real-adapter worker case preserves an earlier dispatched step when the current step is a prepared successor, including worker restart; a separate control preserves local settlement before genuine initial submission. These checks do not establish live-service timing or prove safe replacement admission from a historical `settled` flag. Reinterpretation admission has separate checks below.

`bun --no-env-file test tests/reinterpretation-api.test.ts tests/worker.test.ts tests/supervisor.test.ts tests/restore-coordination.test.ts` checks historical recovery and the keyed reinterpretation boundary. Owned HTTP/SQLite fixtures cover user-authored roots and AI subjects, exact-key replay, rejection scopes, and supervisor → worker → adapter reconciliation for failed/interrupted settled-but-unverified weaves. Positive proof preserves historical status, generation, input and saved knowledge before permitting a fresh key; missing, foreign or active native evidence remains blocked. Worker tests retain all-step, prepared-successor, journal-fence and rollback controls; supervisor tests distinguish unverified candidates from proven and restore-fenced work. A historical `settled` flag alone is not evidence of safety. These fixtures do not use a provider or operator service and do not prove multiprocess contention or browser behavior.

`bun --no-env-file test tests/scheduling.test.ts tests/media-weave-purpose.test.ts tests/media-import-api.test.ts` separately covers serialized subject work and media initial recovery versus fresh reinterpretation, including the current run's own interpretation and retained limitation replies.

`tests/web-reinterpretation-controller.test.ts` checks tab-session identity storage, synchronous duplicate protection, receipt reconciliation and explicit same-key resend, stale reads, and uncertain Stop with controlled dependencies. The isolated production browser foundation also exercises the real Next admission/receipt boundary and Idea behavior at desktop and phone sizes. For a focused run, use `THOUGHTLOOM_TEST_REINTERPRET_CASE=all bun --no-env-file run web:test:runtime`; narrower values are `core`, `recovery`, `storage`, `guards`, `stop`, and `media`. Default `web:test:runtime` includes them all. Checks cover reload without automatic writes, storage failure without dispatch, preserving existing replies/context, new direct children without navigation, no automatic Stop replay, and one media status owner. The fake-daemon foundation establishes browser and proxy behavior, not model quality; shared-record integration exercises the owned real daemon separately.

`bun --no-env-file test tests/worker.test.ts tests/run-operations.test.ts tests/agent-runtime.test.ts` covers URL-aware Weaver instructions and retained completed outcomes. Controlled capability sequences create separately searchable sibling interpretations with inline links, retain successful work alongside reported inaccessible sources, and expose the outcome through existing Full reply routes. Rejection and Stop fence publication, and shared-response visibility still excludes rejected associations from AI reads. Prompt checks establish instruction presence, not model compliance; scripted outputs establish application persistence, not actual public or authenticated URL retrieval. No source snapshot or live MCP/provider fixture is used.

For role-based native tool permissions and history handling, run:

```sh
bun --no-env-file test tests/opencode-adapter.test.ts tests/import-authority.test.ts tests/agent-runtime.test.ts tests/agentic-search-runtime.test.ts
```

These controlled cases check Weaver/Evolve allow bindings, restricted-kind guards, saved deny policies, and SDK-shaped activity through the installed client and owned HTTP fixtures. A combined real-client, adapter, worker and migrated SQLite case checks one interpretation receipt and final reply despite auxiliary records. Tests separate final parent text from intermediate text, foreign user input, missing boundaries and restricted native-tool or standalone shell evidence. A queued compaction fixture checks observation, submission and cancellation remain pending without quarantine or mutation, then recover after drain. Ordinary cancellation still requires every dispatched step's terminal boundary. These fixtures do not execute shell, filesystem, MCP, delegation or provider work. The separate opt-in native fixture below does not currently force tool execution; do not treat its ordinary assistant replies as proof of that behavior.

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

Acceptance exercises the actual daemon, maintained SDK and native service: weaving/title-fill and no-findings completion, scoped Evolve read/development/final reply, Stop retaining confirmed work, and restart after a proxy drops an already-admitted prompt acknowledgement. It also checks public prefix/typo search, count-limited Simple export, Agentic export's library search/full-read/cited report download, and a forbidden export write attempt with unchanged knowledge. This does not exercise the new search-session foundation. Build spellfix with `bun run build:spellfix` first; the fixture does not install or build missing prerequisites automatically.

The fixture records application/native/provider receipts and checks owned listeners, process group and observed descendants during cleanup. SIGINT/SIGTERM and normal completion share idempotent cleanup with bounded actions; failures are recorded without skipping later cleanup actions. Pure lifecycle tests exercise interruption using owned Bun subprocesses, not OpenCode. SIGKILL cannot be caught, and cleanup cannot guarantee absence of unknown detached descendants. Forced large history-page boundaries and universal model variants are not exercised by this fixture; separate controlled pagination and effort-mapping tests cover those contracts.

This validates the owned setup, not personal-service configuration, arbitrary plugins, future releases or model quality. Restricted-role native deny rules are defense in depth, not a universal sandbox; Weaver/Evolve native execution is permissive. Omitting either explicit selector fails the dedicated command actionably rather than silently falling back to a shared service or installing packages.

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

### Isolated agentic-search walkthrough

```sh
bun --no-env-file run demo:search
```

This runs `agentic-search-http-walkthrough` and `agentic-search-process-resume` against test-owned databases, credentials and loopback daemons. **The agent is a deterministic decoded fake, not an OpenCode service or model provider.** It does not attach to your configured daemon or incur provider charges.

The HTTP scenario captures fixture thoughts, settles simulated weaving, recovers a deliberately lost admission response by key, and follows discovery and clarification across fresh native sessions. It checks removal and later rediscovery, rejection-safe context, and local deletion with pending cleanup while preserving the library and another saved session. Normal display uses composer-ledger reads rather than recovered control prose.

The second scenario starts a fresh Bun process on the same owned database. Exact replay with the original token still returns control IDs; refreshing the same composer preserves its offered union, while an old page cursor is rejected under the new process key. Both scenarios clean up on success or failure. They demonstrate controlled HTTP/process behavior, not native in-flight OS-crash recovery, provider compatibility, remote erasure or browser UX.

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
