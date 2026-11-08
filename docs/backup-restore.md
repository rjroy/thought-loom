# Portable backup and restore

[Start here](../README.md) · [Server startup](server-startup.md) · [Database schema](database-schema.md) · [Testing](testing.md#backup-and-recovery-validation)

## Status and scope

**Partially implemented contract for `thought-loom-5a0`, not a complete recovery feature.** Knowledge-database WAL startup, canonical encoders/compiled inventory, internal online capture and empty immutable `restore_fences` storage are implemented. Backup commands/configuration, scheduling, Git delivery, offline loading and enforcement of restored-work isolation remain planned. Current stopped-file copies have a separate [limited procedure](server-startup.md#paired-media-backup-and-restore). Implementation here is distinct from the independent runtime evidence still required below.

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
| `appSchema` | `"thoughtloom-logical-1"`, the explicitly supported application-table contract described below, including the restore-fence metadata table. This is not SQLite's `schema_version` or a service version. |
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

The implemented internal [`format.ts`](../src/backup/format.ts) encodes raw typed cells and manifest metadata, preserves BOM text with fatal UTF-8 decoding, rejects REAL/out-of-range integers and duplicate keys/rowids, and reconstructs closed objects in canonical order. The encoder alone validates metadata shapes, not actual file hashes, complete source membership or an untrusted restore payload. The capture service below supplies source/file validation and process budgets; the restore decoder/loader remains planned.

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
| Recovery-control metadata | `restore_fences` | Implemented additive storage; fresh/migrated installations start empty. Include all records. Existing fences must survive subsequent backup/restore. Execution enforcement and the recovery lifecycle below remain planned. |
| Derived persistent search | `thought_search_fts`, `response_search_fts`, their FTS5 shadow tables (`_data`, `_idx`, `_content`, `_docsize`, `_config`), and singular `search_revision` | Omit and rebuild from restored canonical data using application-owned definitions. `search_revision` is a spelling-cache epoch; plural `search_revisions` above is retained control state. |
| SQLite bookkeeping | `sqlite_sequence`; any SQLite-owned statistics such as `sqlite_stat1`/`sqlite_stat4` | Preserve only the named AUTOINCREMENT high-water values in the manifest. Statistics are rebuildable; do not ship arbitrary `sqlite_*` records. |
| Connection/process-local state | TEMP FTS/vocabulary/spellfix tables, token-signing keys, cursor/clock caches, native-flight maps, parser preparations, timers | Omit; never use an old cursor/token as new authority. Historical tokens embedded in retained intent TEXT remain inert receipt facts; signing keys are excluded. |
| Filesystem control/scratch | `<db>.execution-owner.sqlite` and its companions, knowledge-DB companions, media `staging`/`prepared`, unreferenced objects, backup locks/workspaces | Exclude. Never restore the actual exclusive lease. Recreate only empty managed scratch directories with the target's private modes. |

Source anchors: [core migration](../src/storage/sqlite.ts), [run](../src/storage/run-schema.ts), [receipt](../src/storage/run-receipt-schema.ts), [export](../src/storage/agentic-export-schema.ts), [import](../src/storage/import-schema.ts), [media](../src/storage/media-schema.ts), [search](../src/storage/search-schema.ts), [cleanup](../src/storage/search-cleanup-schema.ts), and [owner registry](../src/storage/execution-owner-schema.ts). Import/search/media migrations widen the bootstrap definitions; `run-schema.ts` alone is not today's complete schema. [Media paths](../src/storage/media-file-paths.ts) and [publication/cleanup](../src/storage/media-files.ts) own the file boundary.

The implemented [`schema.ts`](../src/backup/schema.ts) checks a compiled inventory of 41 payload tables plus the excluded spelling epoch. It compares actual declared types/nullability, ordered primary/composite foreign keys and their actions, unique-key columns/collations/partial predicates, rowid-table shape and AUTOINCREMENT usage. It allows only the exact derived virtual/shadow and SQLite bookkeeping names above, not a broad FTS-name prefix. Read-only metadata inspection accepts Bun number or bigint PRAGMA results and returns frozen table shapes; capture must invoke it within its coherent source transaction. Extra non-unique performance indexes are harmless to the payload. This is not byte-for-byte validation of historical defaults, CHECK expressions, FK deferral clauses or trigger SQL, nor validation of record contents/relationships; normal application migrations and the later capture/restore invariant checks retain those responsibilities. Unsupported extra user tables are refused, even if ordinary migration correctly preserves them.

### Compatibility and evolution

The implemented encoders/inventory target only `thoughtloom-logical-1`; the offline decoder/loader remains planned. Normal application migration adds the empty recovery-control table without changing existing data; pre-feature databases first take that migration on daemon startup. Capture must not migrate a source database. The eventual loader must refuse unknown format versions, app-schema IDs, table sets, column sets, scalar tags or unsupported historical shapes before target publication. A newer application version is not rejected just for being newer when it still explicitly supports this contract.

Future schema changes must update the inventory, typed codec and preservation tests in the same change. Add an explicit tested adapter or a new app-schema ID; never guess missing fields or silently discard unknown history. Change the outer format version when encoding/layout semantics change. Native session/protocol versions are historical data, not a request to attach to a provider. Run ordinary supported migrations on restored data only under the offline loader/startup safety gate; never execute DDL from a manifest.

## Coherent online capture

### Internal invocation and limits

[`captureBackup(options)`](../src/backup/capture.ts) is an explicit internal Bun API, not a daemon route, startup job or installed command. Required absolute paths are `databasePath`, `mediaDirectory` and `outputDirectory`; optional fields are `signal`, an instance `logger`, and `limits`. The output parent must already exist, be owned by the current UID with mode `0700`, and be outside a Git checkout and separate from the managed media tree. Caller-owned entries in that parent are not staged or cleaned. Paths must be canonical without symlink components; existing source/storage permissions and the supported Linux local-filesystem boundary still apply. Capture acquires **no execution-owner lease**, registers no owner and initializes no media store.

The result is `{snapshotDirectory,manifestSha256}`. The selected directory is `<outputDirectory>/snapshot-<manifestSha256>` and contains the payload contents shown above, with no enclosing duplicate `snapshot/` level. Future Git delivery copies those contents under its own `snapshot/` prefix. There is no automatic retry, Git operation or background schedule in this API. Callers own cancellation/shutdown: abort the supplied signal and await settlement before discarding resources.

| Technical limit | Default / enforcement |
| --- | --- |
| `limits.sourceReadMs` | `10000`; the parent kills and joins the owned child if startup, the pinned-snapshot handshake, validation or raw SQL collection exceeds this deadline. |
| `limits.totalMs` | `120000`; parent cancellation covers capture and pre-publication verification. The child also has a rounded-up whole-second CPU limit through `/usr/bin/prlimit`; core dumps are disabled. |
| `limits.maxRssBytes` | `536870912` (512 MiB); parent samples the child's Linux `/proc/<pid>/status` RSS every 25 ms and kills/joins it after observing an excess. |
| Control I/O | At most 8192 combined stdout/stderr bytes; only closed phase/count/digest messages are interpreted, and stderr is discarded without logging. Private request metadata is capped at 16 KiB. |

Limits are positive safe integers; the source deadline cannot exceed the total deadline, which must fit a JavaScript timer. These are per-attempt technical budgets, not permanent record/file-count limits or a truncation policy. RSS monitoring is **sampled**, not a hard allocation ceiling or an OOM-proof sandbox; transient peaks can exceed it, and parent scheduling can delay observation. No `RLIMIT_AS` is used: JavaScriptCore reserves substantial virtual address space. No default upload-size setting restricts retained-original backup. The child is launched with exact `bun --no-env-file` arguments, a private working directory and only fixed PATH/LANG values, never inherited credentials, private environment files or native-service configuration. Abort, timeout, control failure and resource refusal join the process, pipes and active RSS sample before attempt cleanup.

### SQL boundary

Daemon startup enables and verifies knowledge-database **WAL mode** under the execution-owner lease before normal migration/workers. The private execution-owner sidecar remains in `DELETE` mode with its existing lifetime exclusive transaction. Capture refuses a rollback-mode source with `wal-required`; open/migrate it through normal WAL-capable daemon startup before trying again. Capture never silently changes a running database's journal mode.

The fixed [`capture worker`](../src/backup/capture-worker.ts) uses one separate read-only Bun connection (`create:false`, `safeIntegers:true`, query-only and trusted-schema-off, with no shared-cache/read-uncommitted mode). Its one-second SQLite busy wait is still bounded by the parent's source deadline. It refuses a source with the restore-in-progress marker described below and checks canonical path/device/inode identity around operations instead of adopting a replacement. [`readSource`](../src/backup/capture-source.ts) begins one read transaction, establishes its snapshot with an actual schema read, validates the supported inventory and collects all allowlisted raw typed rows, meaningful rowids, sequence values and media identity from **that same transaction**. TEXT is selected as bytes with a separate storage-class projection; integers never pass through JavaScript numbers. It materializes raw values privately, then commits/rolls back and closes the connection **before** encoding, file hashing/copying or Git. There is no main-daemon full-data scan and no unrelated per-table transaction sequence.

Before publication, checks cover SQLite integrity/FKs, row counts/storage classes, source-list/issued/association order, required thought/response/document seals, forest ancestry, polymorphic run/search dependency references, import byte coverage/membership/locators, retained-document/pending-input SHA-256, media-root associations and search turn/discovery ownership. Later title edits are valid; validation does not replay initial admission or require imported thoughts to remain untitled. Historical nullable/unknown journal facts stay unchanged rather than being reconstructed as native proof. The capture validator is not an interpretation of arbitrary old model envelopes or a native terminal-evidence verifier.

The parent logs Info `source snapshot established` while the actual WAL snapshot is pinned and before authorizing its raw-row scan; `source snapshot released` follows connection close, with table/row counts. These are real bounded control events, not readiness inferred from sleep. Capture logs attempt/outcome, safe failure categories and manifest digests, not payloads, paths or raw errors. WAL permits concurrent commits; a long reader can still retain WAL pages and delay checkpoints. Owned concurrency/latency evidence must verify the configured budgets. Capture changes no business rows, generations, identities or cancellation facts.

[SQLite isolation](https://www.sqlite.org/isolation.html) establishes the read-transaction contract. [Bun SQLite](https://bun.sh/docs/runtime/sqlite) documents read-only connections and exact integers. [SQLite VACUUM](https://www.sqlite.org/lang_vacuum.html) documents `VACUUM INTO` as a consistent live snapshot and explicitly **not** a source write operation, but also warns that VACUUM may change implicit rowids. It is not the chosen capture mechanism. Neither an unguarded live DB/WAL copy nor a copy of the execution-owner sidecar establishes a logical snapshot. A different snapshot primitive needs explicit rowid/concurrency proof before substituting it.

### Original-file boundary

Capture uses the **snapshotted** `media_sources` list/fingerprints, not a later live listing. It checks the actual private marker against that identity and copies only referenced `objects/<source-id>` through directory-handle-anchored/no-follow operations. Source size, SHA-256, ownership/mode/link count and identity/timestamps must remain valid; destination bytes are read back and checked after sync. Copy/hash loops use a 64 KiB buffer. Marker stability is rechecked across the copy. No `MediaFiles` initialization, source mutation, extraction, format revalidation, hard-link pin or scratch/orphan scan occurs. A null SQL identity requires no sources and an absent/empty selected media directory; unrelated existing store contents are not adopted.

The current implementation has an important provable invariant: source rows and their fingerprints/store identity cannot be deleted or updated; objects are synced and published **before** their synchronous SQL admission, under the same gate used by orphan cleanup. Cleanup tests current references and never removes referenced objects, including rejected/failed sources. Therefore a committed source in this snapshot remains referenced in the current database for this schema; no full-export cleanup pause or hard-link pin is needed. Do not hard-link originals into the backup: the live store refuses unexpected multiple links.

This argument depends on actual source immutability, not the general claim that a current unreferenced object was never referenced by a snapshot. If a future feature permits source deletion, it must add snapshot-lifetime pinning or coordinated descriptor retention under the cleanup gate **before** removing that invariant. Missing/corrupt/replaced originals or an identity conflict fail the whole attempt; do not omit the source or publish a database-only success. A bounded retry starts a fresh coherent attempt. External tampering is not repaired automatically.

### Local publication

Each attempt exclusively creates `.capture-<UUID>` under the explicit output parent, with private request metadata and a separate `snapshot` child (`0700` directories, `0600` files). Only compiled table files and selected originals are written; all written files are verified and synced, and the manifest is written last. The parent accepts a joined successful child with a matching manifest digest before publication.

Publication uses one narrow built-in `bun:ffi` call to Linux `libc.so.6` `renameat2(...,RENAME_NOREPLACE)` with held directory FDs. It atomically moves the complete snapshot on the same filesystem without replacing an existing empty directory, file or symlink. This requires that native symbol/kernel/filesystem operation; unsupported publication fails closed, with no plain-rename or overwrite fallback. A failed rename may reuse an existing destination **only after streaming full-tree path/type/mode/link/count/hash equality against the validated staging tree**. Otherwise the existing entry is untouched and capture fails. Concurrent equal snapshots can therefore converge on one immutable directory without clobbering caller-owned entries.

Before the commit point, failure/cancellation removes only this attempt's provably owned scratch and leaves earlier snapshots/unrelated entries untouched. Directory FDs and process work are joined/closed. The no-replace rename is the commit point: a later abort does not delete a completed snapshot. A post-commit sync/cleanup failure can report failure while retaining that complete directory for inspection; it never rolls back by deleting a good snapshot. Last-good data is never replaced, repaired or pruned automatically. Crash-orphan scratch is not scavenged by this API. Local payloads contain no control/request files, locks, credentials or diagnostics. This is local capture publication, not an atomic transaction spanning a live SQL database and files, and not Git delivery.

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

The additive [`restore_fences` table](../src/storage/restore-fences-schema.ts) is implemented; **the execution guards and recovery transitions in the rest of this section are not**. Its primary key is `(entity_kind,entity_id)`, followed by `snapshot_sha256`, `restored_at` and `original_state_json`; all columns are non-null TEXT. Kinds are `run`, `import-batch`, `import-file` and `composer`. SQL requires nonempty identity/time, a lowercase 64-character hex digest and JSON-object original state; update/delete/replacement guards protect records. Migration creates no fence records. The planned loader supplies the selected manifest digest and UTC restoration timestamp, and stores exact original mutable fields that recovery changes, using the scalar encoding above inside canonical `original_state_json`: keys are qualified column names such as `runs.status`, `runs.generation`, `search_turns.open_slot`, `markdown_import_files.outcome`, `markdown_import_files.reason_code` and `search_composer_contexts.state`. The search slot before-value belongs to its run's fence. Use `{}` when no fields changed. Rows have no liveness/release flag and no FK that loses the fence when search content is purged. There is no unfence/reactivate command in this scope. Existing fences must be retained verbatim on a later restore; add fences only for newly encountered identities.

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

The internal capture implementation still requires its independent concurrency/resource/failure evidence; a separate owned primitive probe is not capture proof. Git delivery/scheduling, offline loading and no-replay recovery remain unimplemented. Follow-on work must update these planned labels, exact commands/configuration and focused evidence as the corresponding capabilities become real.
