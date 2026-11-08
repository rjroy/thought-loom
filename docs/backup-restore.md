# Portable backup and restore

[Start here](../README.md) · [Server startup](server-startup.md) · [Database schema](database-schema.md) · [Testing](testing.md#backup-and-recovery-validation)

## Status and scope

**Implementation contract for `thought-loom-5a0`, not an available backup feature.** The commands, configuration, WAL capture setup and restore fences below are planned. This document establishes the contract before capture, Git delivery and restore are implemented. Current stopped-file copies have a separate [limited procedure](server-startup.md#paired-media-backup-and-restore).

This is disaster recovery: versioned JSON plus byte-exact retained image/PDF originals, preserving identities and relationships, including rejected material. Capture must work while the daemon serves requests. Restore is a standalone, offline operation into an empty installation, not an HTTP route, editable-file interface, import/merge operation or native-service backup. A dedicated ordinary Git repository is the destination; GitHub is expected, a private repository is strongly recommended. Repository/account creation and remote administration remain operator work.

## Privacy and trust

- Backups are **readable, not encrypted**. They contain rejected thoughts, replies, conversations, original Markdown bytes, image/PDF files, filenames, provenance, request keys and private prepared prompts. Git history can retain content subsequently deleted from the application. Local deletion is not backup or provider erasure.
- Historical bindings retain endpoint, model, permissions, workspace paths and native IDs; execution-owner records retain historical path/device/inode identity. These are durable facts, not a copy of host configuration or permission to use that endpoint. Prepared prompts can contain old absolute media paths. Do not redact or rewrite them and call the result lossless.
- Exclude `.env`, bearer/provider credentials, private launchers, agent configuration, host Git/SSH credentials, logs, source checkouts and OpenCode-owned sessions/databases/files. Host-managed Git authentication stays outside the payload. Content can itself contain a user-entered secret; exclusion of configuration is not content secret-scanning.
- SHA-256 detects corruption and inconsistent files, **not a malicious replacement of both data and hashes**. The operator selects a trusted repository/revision independently. Restore never executes snapshot SQL, code, hooks, filters, links or embedded instructions.

## Version 1 payload

One Git revision contains one complete `snapshot/` tree. Previous revisions are its history; do not accumulate timestamp-named copies within that tree.

```text
snapshot/
  manifest.json
  tables/<table-name>.json
  media/store.json                 # absent only when SQL media_store is empty
  media/objects/<source-id>        # one original per media_sources row
```

No SQLite database, WAL, journal, SHM or execution-owner sidecar belongs in this tree. No filesystem staging, prepared media scratch, unreferenced object or empty-directory placeholder belongs in it. Identical original bytes belonging to distinct source IDs remain distinct object entries. Original filenames are display metadata, never storage paths.

### Manifest

`manifest.json` has exactly these keys:

| Key | Value |
| --- | --- |
| `format` | `"thoughtloom-backup"`. |
| `version` | JSON integer `1`, the envelope/encoding version. |
| `appSchema` | `"thoughtloom-logical-1"`, the explicitly supported application-table contract described below, including the planned restore-fence table. This is not SQLite's `schema_version` or a service version. |
| `mediaStoreId` | Exact SQL `media_store.store_id`, or null when that table is empty. |
| `tables` | Entries sorted by table name: exact `{name,path,rowCount,byteLength,sha256}` for every included table, even an empty one. |
| `sequences` | Entries sorted by name: exact `{name,value}` for `sqlite_sequence` high-water values of `import_documents`, `markdown_imports` and `search_sessions`. Omit an entry only if SQLite has no entry for that table. `value` uses the integer cell encoding below. |
| `mediaMarker` | Null, or exact `{path,byteLength,sha256}` for `media/store.json`. |
| `originals` | Entries sorted by source ID: exact `{sourceId,path,byteLength,sha256}` for every snapshotted media source. |

Counts and byte lengths are canonical nonnegative decimal **strings**, without signs or leading zeroes except `"0"`. Hashes are 64 lowercase hexadecimal SHA-256 characters over actual file bytes. Table paths are exactly `tables/<name>.json`; object paths exactly `media/objects/<sourceId>`. Manifest object entries must agree with SQL source IDs, lengths and binary digests. The marker is canonical `{"version":1,"storeId":"<exact-id>"}` plus LF, reconstructed from the validated identity rather than copied with arbitrary marker formatting. Null identity requires no sources, marker or objects.

The SHA-256 of the canonical manifest bytes identifies the snapshot; it is not stored recursively in itself. Capture times, attempt IDs, host paths, wall-clock schedule state and Git delivery results are **not** payload fields. Log them separately. Unchanged logical data, identities, relevant ordering and sequence values produce identical bytes and no new Git commit.

### Table files and exact scalar encoding

Each table file has exactly `{columns,rows}`. `columns` is the supported column-name list sorted in ASCII order, not source DDL order. Each row is exactly `{rowid,values}`; `values` matches that list. `rowid` is null except for the ordering-sensitive tables identified below, where it uses the integer encoding. No missing fields, omitted nulls or extra columns are allowed.

| SQLite storage class | JSON cell |
| --- | --- |
| NULL | `null` |
| TEXT | A JSON string, with its exact Unicode content, including leading U+FEFF, whitespace, line endings and embedded JSON-as-text. Never parse/reformat stored JSON text as part of backup. |
| INTEGER | `{"$integer":"-123"}`; canonical signed decimal, no `+`, leading zeroes or `-0`, within signed 64-bit range. This also encodes booleans stored as integers. |
| BLOB | `{"$blob":"AAE="}`; standard padded RFC 4648 base64, verified by decode/re-encode equality. A digest BLOB stays binary; it is not a hex string in a table cell. |

There are no supported REAL columns. Reject an unexpected storage class or non-round-trippable TEXT rather than coercing, rounding or replacing it. Read INTEGER values with Bun's `safeIntegers: true`; do not pass them through JavaScript numbers. Read/validate exact TEXT bytes through a BLOB projection where needed, and restore TEXT using UTF-8 bytes with `CAST(? AS TEXT)`; ordinary Bun string binding can consume a leading U+FEFF. Validate SQLite constraints and application-required safe-integer ranges without truncation.

Canonical JSON uses UTF-8 without BOM, compact `JSON.stringify` string escaping, object keys in ASCII order at every structural level, and one final LF. Stored TEXT is a scalar, not a structural object. Sort rows by their declared primary key in key order (INTEGER numerically, TEXT by UTF-8 byte order, not locale); this means `sequence` for `import_documents`, `markdown_imports` and `search_sessions`. Ordering-sensitive tables instead sort by numeric preserved rowid. Do not depend on unspecified SELECT order.

Preserve implicit rowids for `runs`, `run_operation_receipts`, `response_thoughts`, `run_context`, `markdown_import_files`, `import_namespaces` and `search_native_cleanup`: worker queue order, legacy receipt order, response/context order and import/cleanup scans use them. Preserve explicit `sequence`, `position` and ordinal columns everywhere. Other implicit rowids, FTS document IDs, physical page layout and obsolete cursor signatures are not recovery identities. Preserve the listed rowids before any operation that can renumber them; UUID sorting is not a substitute for queue or association order.

### Application schema inventory

This inventory is grounded in the migration functions and current readers, not a live/user database. Every current persistent application table is classified here. Capture and restore use a **compiled allowlist of tables, columns, keys and storage types** for `appSchema`, checked against the actual source schema. They do not dynamically export unknown tables or accept SQL definitions from the payload. Unrecognized tables/columns or incompatible definitions fail closed rather than disappearing silently. SQLite-owned derived objects are classified separately below.

| Classification | Tables | Treatment |
| --- | --- | --- |
| Canonical knowledge and metadata | `thoughts`, `thought_titles`, `thought_sources`, `thought_source_seals`, `connections`, `connection_sources`, `responses`, `response_thoughts`, `response_seals`, `rejected_thoughts`, `rejected_connections` | Include all columns/rows, exact text, attribution, timestamps, ancestry, ordered provenance, associations/seals and rejection markers. No AI scope filtering. |
| Durable execution history | `runs`, `run_steps`, `agent_bindings`, `run_context`, `run_operation_receipts`, `run_issued_thoughts`, `run_replies`, `execution_owners` | Include immutable IDs/inputs, envelopes, results, drafts, confirmed receipts, binding/owner attribution and actual cancellation evidence. Registry records are history, not held leases. |
| Export history | `export_intents`, `export_reports` | Include original requests/effort and completed reports/attribution, without making reports AI-readable knowledge. |
| Retained Markdown sources | `import_namespaces`, `import_documents`, `import_locations`, `import_document_parts`, `import_document_seals` | Include exact BLOB original bytes/digests, locators, parser/segmentation facts and complete membership maps/seals, including zero-thought documents. |
| Durable import admission and pending input | `markdown_imports`, `markdown_import_files`, `markdown_import_payloads` | Include batches, receipts, waiters and any admitted pending bytes. SQL payloads are operational staging, **not a rebuildable cache**: dropping them loses accepted input. They restore as inert private history, not resumed imports or new canonical documents. |
| Retained media metadata | `media_store`, `media_sources` | Include exact store identity, source/request identity, fingerprint, filename, clarification and root association, plus the referenced original files. There is no `media_files` table. |
| Search history and durable visibility/control | `search_sessions`, `search_turns`, `search_messages`, `search_discoveries`, `search_content_dependencies`, `search_composer_contexts`, `search_composer_dependencies`, `search_revisions`, `search_native_cleanup` | Include conversations, removed occurrences, tombstones, dependency ledgers, epochs and cancellation-only history, even after a run has been purged. Do not resurrect purged prose or native work. |
| Planned recovery control | `restore_fences` | Include once introduced for this contract; fresh source installations have an empty table. Existing fences survive subsequent backup/restore. Its bounded definition and lifecycle are below. Not implemented today. |
| Derived persistent search | `thought_search_fts`, `response_search_fts`, their FTS5 shadow tables (`_data`, `_idx`, `_content`, `_docsize`, `_config`), and singular `search_revision` | Omit and rebuild from restored canonical data using application-owned definitions. `search_revision` is a spelling-cache epoch; plural `search_revisions` above is retained control state. |
| SQLite bookkeeping | `sqlite_sequence`; any SQLite-owned statistics such as `sqlite_stat1`/`sqlite_stat4` | Preserve only the named AUTOINCREMENT high-water values in the manifest. Statistics are rebuildable; do not ship arbitrary `sqlite_*` records. |
| Connection/process-local state | TEMP FTS/vocabulary/spellfix tables, token-signing keys, cursor/clock caches, native-flight maps, parser preparations, timers | Omit; never use an old cursor/token as new authority. Historical tokens embedded in retained intent TEXT remain inert receipt facts; signing keys are excluded. |
| Filesystem control/scratch | `<db>.execution-owner.sqlite` and its companions, knowledge-DB companions, media `staging`/`prepared`, unreferenced objects, backup locks/workspaces | Exclude. Never restore the actual exclusive lease. Recreate only empty managed scratch directories with the target's private modes. |

Source anchors: [core migration](../src/storage/sqlite.ts), [run](../src/storage/run-schema.ts), [receipt](../src/storage/run-receipt-schema.ts), [export](../src/storage/agentic-export-schema.ts), [import](../src/storage/import-schema.ts), [media](../src/storage/media-schema.ts), [search](../src/storage/search-schema.ts), [cleanup](../src/storage/search-cleanup-schema.ts), and [owner registry](../src/storage/execution-owner-schema.ts). Import/search/media migrations widen the bootstrap definitions; `run-schema.ts` alone is not today's complete schema. [Media paths](../src/storage/media-file-paths.ts) and [publication/cleanup](../src/storage/media-files.ts) own the file boundary.

### Compatibility and evolution

Version 1 initially supports only `thoughtloom-logical-1` through its explicit codec/loader. The implementation must introduce the empty recovery-control table alongside that schema contract; pre-feature databases first take the normal application migration on daemon startup. Capture does not migrate a source database. Unknown format versions, app-schema IDs, table sets, column sets, scalar tags or unsupported historical shapes are refused before target publication. A newer application version is not rejected just for being newer when it still explicitly supports this contract.

Future schema changes must update the inventory, typed codec and preservation tests in the same change. Add an explicit tested adapter or a new app-schema ID; never guess missing fields or silently discard unknown history. Change the outer format version when encoding/layout semantics change. Native session/protocol versions are historical data, not a request to attach to a provider. Run ordinary supported migrations on restored data only under the offline loader/startup safety gate; never execute DDL from a manifest.

## Coherent online capture

### SQL boundary

The planned knowledge database uses **WAL mode**, enabled and verified under the daemon's execution-owner lease before normal migration/workers. The private execution-owner sidecar remains in `DELETE` mode with its existing lifetime exclusive transaction. Current startup does not yet enable knowledge-DB WAL. A standalone online capture must refuse a rollback-mode source with a safe upgrade/restart diagnostic; it must not silently change a running database's journal mode.

Use one separate read-only Bun connection (`create:false`, `safeIntegers:true`, no shared-cache/read-uncommitted mode) in an owned background process. Refuse a source with the restore-in-progress marker described below; verify canonical database identity around capture rather than adopting a replaced path. Begin one read transaction, establish its snapshot with an actual read, validate the supported schema and collect all allowlisted raw typed rows, required rowids, sequence values and media identity from **that same transaction**. Materialize those raw values in testable, resource-bounded private memory; then end the transaction/close the source connection **before** JSON encoding, file copying, hashing or Git. Keep the daemon's connection/event loop out of this scan. Never interleave unrelated per-table transactions.

The source-read phase has an externally enforced finite timeout and memory budget; exceeding either fails capture and joins the owned process, releasing its connection. Select and document the concrete technical limits with the capture implementation and its feasibility evidence. This is not a content-count quota or permission to publish a partial backup. WAL allows concurrent commits; a long reader can still retain WAL pages and delay checkpoints. Bound its lifetime and test ordinary request/write latency, not merely snapshot correctness. Do not change business rows, execution generations, source identities or cancellation state during capture.

[SQLite isolation](https://www.sqlite.org/isolation.html) establishes the read-transaction contract. [Bun SQLite](https://bun.sh/docs/runtime/sqlite) documents read-only connections and exact integers. [SQLite VACUUM](https://www.sqlite.org/lang_vacuum.html) documents `VACUUM INTO` as a consistent live snapshot and explicitly **not** a source write operation, but also warns that VACUUM may change implicit rowids. It is not the chosen capture mechanism. Neither an unguarded live DB/WAL copy nor a copy of the execution-owner sidecar establishes a logical snapshot. A different snapshot primitive needs explicit rowid/concurrency proof before substituting it.

### Original-file boundary

Use the **snapshotted** `media_sources` list and fingerprints, not a later live listing. Verify the actual store marker matches the snapshot identity; copy only each referenced `objects/<source-id>` through the anchored/no-follow private-file boundary. Verify size, SHA-256 and file identity/stability around copying. Hash against the snapshot digest, not a digest freshly read from the live DB. Capture is not constrained by a subsequently lowered upload/read-size setting: original bytes that were validly retained must still be backed up.

The current implementation has an important provable invariant: source rows and their fingerprints/store identity cannot be deleted or updated; objects are synced and published **before** their synchronous SQL admission, under the same gate used by orphan cleanup. Cleanup tests current references and never removes referenced objects, including rejected/failed sources. Therefore a committed source in this snapshot remains referenced in the current database for this schema; no full-export cleanup pause or hard-link pin is needed. Do not hard-link originals into the backup: the live store refuses unexpected multiple links.

This argument depends on actual source immutability, not the general claim that a current unreferenced object was never referenced by a snapshot. If a future feature permits source deletion, it must add snapshot-lifetime pinning or coordinated descriptor retention under the cleanup gate **before** removing that invariant. Missing/corrupt/replaced originals or an identity conflict fail the whole attempt; do not omit the source or publish a database-only success. A bounded retry starts a fresh coherent attempt. External tampering is not repaired automatically.

### Local publication

Stage privately outside the Git checkout (`0700` directories, `0600` files). Validate counts, key uniqueness, foreign and polymorphic references, seals/maps, digests and complete file membership. Recheck marker/file identity at the boundary. Sync owned files/directories, then publish one complete immutable local snapshot with an atomic same-filesystem publication step. Git only sees completed snapshots. Failure/cancellation leaves the last good snapshot untouched; clean only this attempt's owned staging. Local snapshots do not contain delivery locks, credentials or diagnostic logs.

## Planned Git configuration and scheduling

`THOUGHTLOOM_BACKUP_CONFIG` is planned server/CLI-only JSON. Absence disables all backup scheduling and Git/filesystem side effects. Require explicit values; do not infer a destination or silently enable a default schedule.

```json
{
  "repositoryUrl": "git@github.com:OWNER/thoughtloom-backups.git",
  "checkout": "/absolute/private/thoughtloom-backup-checkout",
  "branch": "backups",
  "intervalSeconds": 86400
}
```

All four fields are required. `intervalSeconds:null` means manual-only; a positive safe integer enables that interval. Daily is an example, not an enabled default. `checkout` is a dedicated absolute private path, separate from the application, database and media directories. Validate branch names and restrict transports to ordinary supported SSH/HTTPS Git URLs (owned local remotes for tests). Reject passwords, HTTP userinfo, tokens, query strings, fragments and unsafe helper transports; the conventional SSH username `git` is not a credential. Do not print the raw URL or config on failure.

Use the operator's SSH agent or host credential helper with noninteractive authentication. No token variable, browser credential, `.env` reader or credential in a snapshot/command example is required. Large original files can exceed a host's ordinary Git object/push limits: report delivery refusal and retain the local snapshot; do not silently drop files, introduce LFS or claim remote protection. A private Git repository is not an independent offline/encrypted backup.

The planned manual entry point, from the project root, is:

```sh
# PLANNED: scripts/backup.ts does not exist yet.
# Supply THOUGHTLOOM_DB_PATH, optional THOUGHTLOOM_MEDIA_DIR and
# THOUGHTLOOM_BACKUP_CONFIG explicitly in the launching environment.
bun --no-env-file scripts/backup.ts
```

It shares capture/delivery orchestration with the scheduler, needs no daemon HTTP endpoint or native agent credentials, and does not acquire the daemon's exclusive execution lease to read the source. It verifies the supported source database/media identity without adopting another store.

- Serialize all triggers, including separate manual processes, with one OS-released per-checkout operation lock. Coalesce scheduled wakes instead of growing an unbounded queue. This destination lock is not a source execution lease.
- Create/clone only a new dedicated checkout, or reuse one with matching tool-owned identity, remote and branch. Refuse unrelated, unexpectedly dirty, linked or conflicting checkouts and unexpected tracked payloads. After interruption, resume only a recorded tool-owned update whose HEAD and affected file fingerprints still match its saved before/after state; unknown edits require operator attention. Keep that bounded recovery record outside the payload. Do not initialize or clean an arbitrary existing repository. Disable executable repository hooks/filters/submodules for these operations; snapshots are plain Git files, not LFS pointers.
- Stage only the complete owned `snapshot/` allowlist, including deliberate replacement of its prior tree. Never `git add .` over an application/source directory or checkout leftovers. Commit only when payload bytes change, with content-free metadata. Remote success may still require pushing an earlier pending commit when capture is unchanged.
- Use exact subprocess argv, no shell interpolation, disabled prompts, bounded process/network waits and joined cancellation. Do not echo raw Git stderr, credential-helper output, URLs, paths or content as diagnostics.
- A configured interval starts after daemon readiness with one coalesced attempt, then follows that interval without replaying every missed tick. Each attempt retries retained pending delivery and can capture newer local data; a remote conflict stops delivery, not ordinary application use. Manual-only configuration starts no timer/retry loop. Shutdown seals new triggers and joins/terminates owned work before releasing resources; a push is not assumed delivered after a timeout.
- Retain completed local snapshots/commits on push failure. Retry idempotently on the next configured tick or manual invocation; verify the branch result after uncertain acknowledgements. Do not reset local commits, auto-merge external edits, force-push, rewrite history, delete remote branches or prune history automatically. Divergence is an operator-visible blocker, not permission to overwrite the remote.

Report **local snapshot**, **local Git commit** and **remote branch confirmation** separately. Manual exit is nonzero unless configured delivery is confirmed, even when local recovery data was saved. Info logs report completed changes/delivery; Warning reports recoverable/offline delivery and conflicts; Error reports terminal capture/configuration failure; Verbose handles polls/no-op detail. Log attempt/outcome and safe counts/digests, never private payloads or raw exceptions. Last-good local/remote status and retry bookkeeping stay outside the snapshot. No automatic destructive retention policy is enabled.

## Offline restore and inert historical work

The planned standalone entry point consumes an **already selected** snapshot directory. It does not fetch, check out a remote revision, run repository scripts, connect to OpenCode or start the daemon.

```sh
# PLANNED: scripts/restore.ts does not exist yet.
bun --no-env-file scripts/restore.ts \
  --snapshot /absolute/trusted-selected-checkout/snapshot \
  --target /absolute/empty/recovered-thoughtloom
```

The target is a new/empty private installation directory containing `thoughtloom.sqlite` and `thoughtloom.sqlite.media`; the normal default media-path rule then works. Arbitrary split destinations are not needed for version 1. Refuse a nonempty target, existing populated database, existing media store, unsafe paths or an active target execution owner. There is no `--force`, merge, overwrite or in-place repair mode. Stop the target daemon explicitly; the command never stops it or the operator service. Configure fresh role credentials, agent settings and backup destination separately after recovery.

### Validation and publication

1. Validate manifest/version/schema, canonical JSON/closed shapes, scalar encodings, unique identities, complete table/file membership, sequence high-water values and all lengths/hashes before touching application data. Validate actual references, including polymorphic exposure/dependency references, ordered maps/seals and source fingerprints; preserve supported legacy null/unknown facts rather than manufacturing evidence. Reject missing/extra/duplicate files, unsafe IDs/paths, absolute or traversal paths, NULs, symlinks and special/hard-linked payload files. Never open a path from a filename, import locator, binding or old prompt. Enforce bounded parsing/resources with safe errors, not payload excerpts.
2. Build and verify the load in private staging using only compiled application DDL/column mappings and parameter binding. Normal creation/admission APIs are inappropriate: they mint identities, schedule work and enforce initial-only conditions against later title metadata. Use an offline-only trusted loader, explicit transaction/rollback and deferred FKs for cycles. Install/verify the application's full guards after the load; disable no checks on a live application connection. No arbitrary schema/trigger text is accepted from the backup. Rebuild the two FTS projections (including media clarification, not filenames/binary text), spelling epoch and statistics only; preserve plural search epochs and recorded sequence high-water values. Validate FK/integrity checks and domain invariants before publication.
3. Reserve/check the empty target and acquire its actual `ExecutionOwnerLease` on the final database path. Recheck emptiness under that ownership; an already-running contender must win or lose the same lease, not an unrelated sentinel lock. Do not replace the leased DB inode or sidecar. Before target writes, durably create a private `.restore-in-progress` marker in the target directory. The planned daemon must refuse startup under its lease **before migration, workers or cleanup** while this marker exists. The marker is an incomplete-installation gate, not the permanent historical-work fence.
4. Under that lease, copy verified originals into the matching private media layout and load the final database transactionally on its fixed inode. Restore the original SQL store identity and canonical marker; create empty `staging` and `prepared` directories. Do not restore old device/inode ownership as current ownership. Apply the historical fences below within the SQL restoration transaction; verify final counts, relationships and bytes against the selected snapshot plus the explicitly enumerated recovery transitions.
5. Commit, close/check the target database, sync files/directories, and remove/sync the in-progress marker **last**. Only then report success and release ownership. This is fail-closed logical publication across SQL and files, not a fictitious atomic rename of two resources. Failure rolls back entered SQL, leaves existing installations untouched and never removes the last good backup. An interrupted target retains the marker and is refused at startup; ambiguous artifacts remain for deliberate inspection. Cleanup may remove only artifacts proven owned by this failed attempt, never an occupied destination or live sidecar. Do not advise clearing the marker to force readiness.

### Small durable guard, not a second execution engine

Introduce one additive internal table, **planned `restore_fences`**, with primary key `(entity_kind,entity_id)`, `snapshot_sha256`, `restored_at` and `original_state_json`; all columns are non-null TEXT. Kinds are `run`, `import-batch`, `import-file` and `composer`. `snapshot_sha256` is the selected manifest digest; `restored_at` is the restore command's UTC timestamp. Store exact original mutable fields that recovery changes, using the scalar encoding above inside canonical `original_state_json`: keys are qualified column names such as `runs.status`, `runs.generation`, `search_turns.open_slot`, `markdown_import_files.outcome`, `markdown_import_files.reason_code` and `search_composer_contexts.state`. The search slot before-value belongs to its run's fence. Use `{}` when no fields changed. Rows are immutable, have no liveness/release flag and no FK that loses the fence when search content is purged. There is no unfence/reactivate command in this scope. Existing fences are retained verbatim on a later restore; add fences only for newly encountered identities.

Fence **every restored run ID**, including terminal runs and IDs present only in `search_native_cleanup`; every restored import batch/file; and every restored composer. This is a finite historical identity set. It does not disable new work globally or infer a cutoff from reusable rowids, timestamps, PIDs or remote availability.

Only these local recovery transitions are allowed; retain their before-values in the fence record:

| Snapshotted state | Restored local treatment |
| --- | --- |
| Run `queued`, `submitting`, `running` or `uncertain` | Set local status to `interrupted` and increment generation once, checked without overflow. **Do not change cancellation state or any `run_steps` field.** Search's slot closes consistently with the interrupted run; retain any existing outcome reason, and leave an absent reason null rather than inventing user Stop. |
| Terminal run (`completed`, `failed`, `interrupted`) | Preserve status/generation and cancellation state. A completed native step without local finalization stays historical; never finalize it during restore/startup. |
| Pending import holder or waiter (`outcome` null) | Set local file outcome/reason to `interrupted`/`interrupted`, retaining its IDs, run/waiter links, digest and any SQL payload. This releases pending-holder reservations and prevents waiters from acquiring new runs. It is recovery interruption, not proof the user pressed Stop. Do not create a document, choose a new partition or delete accepted bytes. |
| Terminal import receipt; open/sealed batch | Preserve terminal facts and existing sealing time/null. All restored batches are closed to **new** file admissions by their fence; exact request-key replay remains historical. Do not invent a sealing timestamp. New imports use a new batch/key. |
| Active composer | Set state to `invalidated`, preserving revision and complete dependency ledger. Other composer states remain unchanged. Old tokens cannot authorize a new turn. |
| Cleanup row, binding, step, receipt, draft, response or confirmed output | Preserve exact recorded facts. Do not rewrite paths, native IDs, inputs, permission bindings, envelopes/results, ownership manifests or terminal/drain evidence. Do not turn a draft into a canonical reply. |

The run fence is checked in existing trusted storage/worker boundaries, **not only in the supervisor's candidate query**. It denies claim/recovery, preparation/binding, service resolution, native submission/observation/cancellation/Stop side effects, cached capability replay, knowledge writes, import local finalization and automatic cancellation settlement for restored identities. Configless import/waiter scans and purged-cleanup scans must honor it too. A Stop of fenced history is a local idempotent control read, never a call to the old service. Retained cancellation `pending` stays pending; `none` is not upgraded to a never-submitted certificate, and an old `settled` value is not newly certified. The offline restore command itself makes **zero** native calls.

Live subject/queue exclusion considers only unfenced work. Keep historical/latest-run and by-key inspection available; do not drop old runs from user receipts just to filter scheduling. A fence separates installations, **not a claim that old remote work has ended**. New explicit user actions may admit fresh identities/bindings using newly configured current paths and normal rejection/permission checks; same-key replay must never allocate a replacement. No startup reweaving, title regeneration, import completion, native cleanup or response publication is authorized merely by restoring. Confirmed existing interpretations still prevent another initial media summary; deliberate Reinterpret/Evolve retains its ordinary distinction.

Normal saved-search reads, fresh composers/turns and deliberate local Delete remain available. Deleting a restored search session may purge its local content through the existing retention boundary while retaining the no-prose fences; it must not seal a fabricated new cancellation certificate or schedule old native cleanup. New unfenced runs retain ordinary Stop/recovery/cleanup semantics. Migration and backup must preserve fences, and startup must fail closed if their schema/required guards are unavailable. Running an older release that ignores these controls is unsupported.

**External effects are not rolled back.** The original installation or OpenCode may still have pending work; portable restore neither stops nor certifies it. Keep the original installation stopped and reconcile its external work separately before deliberately requesting new overlapping work. Unknown remote completion can remain unknown indefinitely without preventing unrelated new work in the recovered installation. This policy preserves history without reviving it; it is not native-session continuation at a new path.

## Required evidence before shipping

This document's source/official-document checks are design evidence, **not runtime proof**. The separate [validation boundary](testing.md#backup-and-recovery-validation) must establish:

- Compiled inventory versus a freshly migrated owned schema, FTS-shadow exclusions, exact INTEGER/BLOB/TEXT/BOM round trips, sequence high-water values and the listed rowid-dependent order.
- WAL read-snapshot coherence with concurrent HTTP/SQL mutations and file-first admission; bounded source-reader lifetime, memory and ordinary-write latency; fail-closed rollback-mode refusal. No live operator database or journal-mode experiment.
- Current immutable-source/cleanup reasoning exercised at held publication/copy/cleanup boundaries, including missing/corrupt files and a lowered current upload limit. Future source deletion cannot inherit this proof.
- Offline trusted loading of guarded cyclic/sealed records with later title edits, full rollback, marker/lease ordering, competing startup, interruption at each publication boundary and no overwrite of a nonempty target.
- Configured **and configless** normal startup, direct worker/Stop/cached-result paths, import holders/waiters and purged cleanup with native tripwires: no old service resolution, create, submit, observe or cancel calls; unchanged native/cancellation facts; fresh independent work still succeeds.
- Owned local/bare Git remotes: no-op commits, scheduled/manual overlap, pending delivery/restart, offline and uncertain pushes, divergence, unsafe paths/credentials/hooks and last-good preservation. No automatic destructive history operation.

No production/test implementation or runtime verification is supplied by this documentation-only phase. Follow-on work must update these planned labels, exact commands/configuration and focused evidence as the corresponding capabilities become real.
