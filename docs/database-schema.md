# Database schema

[Start here](../README.md) · [Daemon API](daemon-api.md) · [Server startup](server-startup.md) · [Backup contract](backup-restore.md)

Thoughtloom uses SQLite through Bun's built-in `bun:sqlite`. The authoritative migration starts in [`src/storage/sqlite.ts`](../src/storage/sqlite.ts); Markdown import definitions and its predecessor FK-closure rebuild live in [`import-schema.ts`](../src/storage/import-schema.ts) and [`import-migration.ts`](../src/storage/import-migration.ts). The [media metadata foundation](#media-source-storage-foundation) has its own thought/FK migration. The separate [agentic-search storage](#agentic-search-storage-foundation) supports user-only saved sessions and configured search execution through the [daemon API](daemon-api.md#agentic-search-sessions). Public Markdown import access is documented in the [daemon API](daemon-api.md#markdown-import-and-source-inspection).

## Model and relationships

- A thought is an immutable piece of recorded thinking. A non-root thought has one evolution parent; roots have no parent.
- Titles are separate mutable metadata, returned alongside thoughts in ordinary reads.
- Conceptual connections are separate from evolution ancestry. They never become extra evolution parents or extend the scope of a branch operation.
- Source associations record supporting provenance. Their position preserves the order of each source list.
- Rejection is presence in a separate state table, not deletion or modification of the recorded thought.

Database names use `snake_case`; the [API](daemon-api.md#response-records) uses `camelCase`.

## Backup and recovery boundary

Daemon startup enables and verifies WAL on the knowledge database under its execution-owner lease before migration. The separate lease sidecar remains in DELETE journal mode. WAL alone is not an online backup implementation.

The [portable format](backup-restore.md#application-schema-inventory) inventories all current durable tables, derived search data and transient exclusions. It includes rejected records, private SQL import payloads, complete native journals/cancellation evidence, historical owner attribution and original media files, not just ordinary scoped Thought projections. The actual execution-owner sidecar is never a recovery artifact.

The internal [compiled backup inventory](../src/backup/schema.ts) validates supported table/column/type/nullability, primary/foreign/unique-key and derived-object metadata without changing the source. Its effective typed column definitions also drive strict decoding; primary-key nulls never request new SQLite identities. It is not a complete SQL-constraint/trigger or record-integrity validator. The [explicit capture service](backup-restore.md#coherent-online-capture) separately performs shared integrity/reference/seal/map checks, copies raw rows from one owned-process WAL read transaction, then closes it before encoding and verifying original files. It never migrates/registers an owner or changes source rows. [Private restore staging](backup-restore.md#implemented-private-staging-not-an-installation) loads original-state records into a new marker-gated database, preserving rowids, sequences, existing fences and plural search epochs while rebuilding derived search data. The separate [staged recovery operation](backup-restore.md#implemented-staged-recovery-transitions) adds missing fences and applies only the enumerated local transitions in one transaction, without migration/native/owner effects. [Offline installation](backup-restore.md#standalone-offline-installation) uses the shared trusted loader on a new fixed-inode target under its actual execution lease and durable marker; it copies the already recovered records, not a second recovery. The installer never registers a new historical owner. A raw database copy has no newly generated fences and can resume retained jobs. No schema/format compatibility ID or online-backup guarantee should be inferred from SQLite's schema counter.

### `restore_fences`

[`restore-fences-schema.ts`](../src/storage/restore-fences-schema.ts) adds this table within the existing core migration transaction, with no data backfill, existing-table rebuild or native call.

| Column | Type | Constraint / meaning |
| --- | --- | --- |
| `entity_kind` | `TEXT` | `run`, `import-batch`, `import-file` or `composer`; first component of the primary key. |
| `entity_id` | `TEXT` | Nonempty historical identity; second primary-key component. |
| `snapshot_sha256` | `TEXT` | Exactly 64 lowercase hexadecimal characters; selected manifest digest. |
| `restored_at` | `TEXT` | Nonempty timestamp; staged recovery supplies canonical UTC syntax for new fences. |
| `original_state_json` | `TEXT` | Valid JSON object; new recovery fences retain exact before-values for explicitly changed local state, using qualified keys/scalar tags and final LF. Existing fences remain byte-exact. |

All columns are `NOT NULL`. There are no FKs: historical run/composer identities can outlive deliberate search-content deletion. Update and identity/rowid replacement are forbidden. Delete is forbidden except for the exact run fence of an export undergoing its authorized transactional local purge; no live retained run is unfenced by a command. Migration preserves populated records and upgrades only the exact supported predecessor delete guard to this narrow exception. Migration and the shared [authority helper](../src/storage/restore-fences.ts) verify the compiled table/guard definitions and fail closed when they are unavailable or incompatible; missing metadata is not permission to execute. Each entity-kind gate preserves exact fence identity and refuses inconsistent ordinary string binding rather than authorizing an alias.

Run claim/context/capability/preparation/binding/finalization and cancellation-settlement paths consult `entity_kind='run'` directly, including native-worker and cleanup-journal gates even when a run row has been purged. Import authority additionally checks the associated batch/file; private input, choice, publication, failure/Stop payload deletion and local/native cancellation settlement are denied for any fenced owner. Import scans exclude those owners before their limits. Batch/file keyed receipt replay remains historical, while fenced batches reject new file admission and sealing writes. Composer guards refuse new turn authority without fencing the saved session. Live weave coordination and supervisor scans ignore fenced work without removing history/latest/by-key records. Local search Delete preserves fences and existing historical cleanup evidence without fabricating a new certificate; fresh work retains ordinary cleanup rules. These authority checks and original-state staging generate no transitions/fence records. Explicit staged recovery adds missing fences, closes active search slots and interrupts pending import reservations while preserving accepted payloads and native/cancellation facts; final installation preserves that exact state. No schema change is involved. Complete restored-startup/fresh-work evidence remains separate from table/guard presence.

## Tables

Unless marked nullable, columns below are `NOT NULL`. Every listed foreign key references the identified parent row. Library tables do not cascade deletion; the owned search-metadata cascades are identified separately below.

### `thoughts`

| Column | Type | Constraint / meaning |
| --- | --- | --- |
| `id` | `TEXT` | Primary key; assigned by the daemon's creation command. |
| `text` | `TEXT`, nullable | Recorded wording for textual kinds; null exactly for `media-original`. Domain validation keeps textual wording nonempty. |
| `author` | `TEXT` | Check: `user`, `ai`, or `source` (Markdown/media original with unverified original authorship). |
| `kind` | `TEXT` | Check: `captured-original`, `user-contribution`, `ai-interpretation`, `developing-idea`, `imported-original`, or `media-original`. |
| `created_at` | `TEXT` | Daemon-generated UTC ISO timestamp. SQLite itself stores text rather than enforcing timestamp syntax. |
| `origin` | `TEXT` | Provenance label. Current HTTP creation commands use `capture`, `contribution`, or `development`; this column is not a SQL enum. |
| `parent_id` | `TEXT`, nullable | Foreign key to `thoughts.id`; a check forbids self-parenting. |
| `import_document_id` | `TEXT`, nullable | Internal FK to `import_document_seals.document_id`, `DEFERRABLE INITIALLY DEFERRED`; present exactly for imported originals. Not part of the ordinary Thought DTO. |

There is no title column in the current table. `BEFORE UPDATE` and `BEFORE DELETE` triggers abort mutations with an immutability error. Further development creates another thought rather than a revision of this row.

`author='source'` occurs exactly for `imported-original` or `media-original`. Markdown originals require `origin='markdown-import'` and a null evolution parent. The unique `(import_document_id,id)` key supports exact document/thought membership. Media originals require `origin='media-import'`, null text, a null parent and null import membership. Supporting-source inserts are forbidden for both original kinds; source membership is not `sourceIds`. Existing user/AI combinations for the other kinds remain valid. Ordinary `saveThought()` refuses both source kinds instead of inferring a title author from `source`; dedicated writers create their initial null titles. Later user/AI title edits and fills remain valid.

The media writer and [metadata tables](#media-source-storage-foundation) persist the null-text source variant. Backend scoped reads, search results/context, investigative retrieval, saved-search previews and exports handle its descriptor. Daemon startup wires validated private-file retention, [media HTTP admission/inspection/retry](daemon-api.md#retained-media-import-and-source-inspection) and managed original paths into the normal Weaver/Evolve worker on the required shared filesystem. The Next.js client presents descriptors and accesses user-only media operations through its server boundary. See the [media agreement](../.lore/context/media-import.md).

Thought writers bind UTF-8 bytes with `CAST(? AS TEXT)` rather than passing text directly as a Bun string parameter, which consumes an initial U+FEFF. This preserves recorded text even when a segment begins with U+FEFF somewhere other than the original file's initial BOM. Stored BLOB bytes and returned JavaScript text are separate validation boundaries. Migration preserves actual legacy stored bytes; it cannot infer characters already lost by an older write.

### `thought_titles`

| Column | Type | Constraint / meaning |
| --- | --- | --- |
| `thought_id` | `TEXT` | Primary key and foreign key to `thoughts.id`. |
| `title` | `TEXT`, nullable | Current display title. |
| `title_author` | `TEXT`, nullable | Check: `user` or `ai` when present. This is distinct from the thought's author. |

A check requires title and title author to be either both null or both non-null. The primary key permits at most one title record per thought; supported thought saves create the metadata row even when untitled.

Users may edit or clear the title without changing the base thought. Clearing sets both values to null and permits a future AI fill. The title service checks rejection state and current title within a transaction; AI may fill only an active, still-untitled thought. See [`domain/title.ts`](../src/domain/title.ts) and [`storage/title.ts`](../src/storage/title.ts).

### `thought_sources`

| Column | Type | Constraint / meaning |
| --- | --- | --- |
| `thought_id` | `TEXT` | Foreign key to the thought receiving provenance. |
| `position` | `INTEGER` | Source-list position. |
| `source_id` | `TEXT` | Foreign key to the supporting thought. |

Composite primary key: `(thought_id, position)`. Sources do not create extra evolution parents.

### `thought_source_seals`

| Column | Type | Constraint / meaning |
| --- | --- | --- |
| `thought_id` | `TEXT` | Primary key and foreign key to `thoughts.id`; marks its source set complete. |

`saveThought()` inserts a thought, its title, its source rows, and its seal in one transaction. After sealing, triggers reject new source rows. Updates and deletion of source rows or seals are also rejected. This protects recorded provenance without preventing initial assembly.

Media-source interpretations use the ordinary run-owned interpretation operation: the source is the evolution parent, and the AI child's text is independently searchable. A source receives one initial interpretation; subsequent development uses Evolve. See [source admission and lifecycle](#source-admission-and-lifecycle).

### `connections`

| Column | Type | Constraint / meaning |
| --- | --- | --- |
| `id` | `TEXT` | Primary key; assigned by the daemon. |
| `from_id` | `TEXT` | Foreign key to `thoughts.id`. |
| `to_id` | `TEXT` | Foreign key to `thoughts.id`. |
| `category` | `TEXT` | Check: `supports`, `contradicts`, `extends`, or `related`. |
| `proposed_by` | `TEXT` | Check: `user` or `ai`. |
| `explanation` | `TEXT` | Recorded rationale. |

The endpoints preserve direction where the category is directional. Unlike thoughts and responses, this table has no immutable-update/delete triggers; the current HTTP interface exposes creation and rejection/restoration, not arbitrary record edits.

### `connection_sources`

| Column | Type | Constraint / meaning |
| --- | --- | --- |
| `connection_id` | `TEXT` | Foreign key to `connections.id`. |
| `position` | `INTEGER` | Source-list position. |
| `source_id` | `TEXT` | Foreign key to a supporting thought. |

Composite primary key: `(connection_id, position)`. Thought-source sealing triggers do not apply to this table.

### `responses`

| Column | Type | Constraint / meaning |
| --- | --- | --- |
| `id` | `TEXT` | Primary key. |
| `text` | `TEXT` | Retained response text. |
| `role` | `TEXT` | Check: `addendum` or `fallback`. |
| `state` | `TEXT` | Check: `complete` or `interrupted`. |

An addendum can accompany several recorded developments without duplicating its text. A fallback retains the response when no separate development was recorded and has exactly one thought association. Update/delete triggers protect response text, identity, role and state.

The HTTP API reads these records rather than accepting client-created responses. Evolve execution and completed Weaver outcomes create them transactionally during local finalization. A Weaver outcome associates the original subject and any issued interpretations, so it remains accessible from the original capture even when no interpretation was warranted. Its shared associations retain the existing AI rejection policy. URL attribution is ordinary interpretation text; no fetched-source snapshots, external-source table or schema migration are added. Response states describe retained output; run/step state and cancellation settlement are tracked separately.

### `response_thoughts`

| Column | Type | Constraint / meaning |
| --- | --- | --- |
| `response_id` | `TEXT` | Foreign key to `responses.id`. |
| `thought_id` | `TEXT` | Foreign key to an associated thought. |
| `position` | `INTEGER` | Nonnegative issued-order position. |

Composite primary key: `(response_id, position)`. A unique constraint on `(response_id, thought_id)` prevents duplicate associations. The domain requires at least one associated thought, and exactly one for a fallback. Order records when developments were issued, not UUID order.

### `response_seals`

| Column | Type | Constraint / meaning |
| --- | --- | --- |
| `response_id` | `TEXT` | Primary key and foreign key to `responses.id`; marks its association list complete. |

Saving a response inserts its canonical row, ordered associations and seal in one immediate transaction. Seals prevent later association inserts; triggers also reject association updates/deletion and seal updates/deletion. Rejection changes visibility, not these immutable links. See [`storage/shared-response.ts`](../src/storage/shared-response.ts).

### Rejection state

| Table | Column | Constraint / meaning |
| --- | --- | --- |
| `rejected_thoughts` | `thought_id TEXT` | Primary key and foreign key to `thoughts.id`. Presence means rejected. |
| `rejected_connections` | `connection_id TEXT` | Primary key and foreign key to `connections.id`. Presence means explicitly rejected. |

Restoration removes the state marker, not the original record. Branch operations traverse `thoughts.parent_id`, never `connections`.

A connection with a rejected endpoint is unavailable in normal reads even without an explicit connection marker. Restoring endpoints can make it visible again, but a separately rejected connection stays rejected until separately restored.

The existing user-only `RejectionService` and SQLite repository also update [search eligibility and active-work fences](#rejection-event-transactions) in the marker's transaction. This is a repository-command contract, not an invalidation trigger for arbitrary raw SQL marker writes.

## Global additional agent instructions

`agent_instructions` stores an optional singleton record containing the four
additional instruction strings and a positive safe-integer revision. An absent
record represents four empty strings and revision `0`; migration does not create
a default row. The [user-only settings API](daemon-api.md#additional-agent-instructions)
replaces the four values atomically using the last-read revision. Accepted text,
including leading BOM and whitespace, is preserved through UTF-8 byte binding.

Settings are mutable metadata, not thought content or operator model/tool
configuration. Changing them never rewrites a previously prepared run.

## Durable execution tables

These tables are initialized by core migration through [`run-schema.ts`](../src/storage/run-schema.ts) and the additive [`execution-owner-schema.ts`](../src/storage/execution-owner-schema.ts). Configured workers and public Evolve/status/Stop routes use the same run aggregate. Migration itself makes no model calls; with agent configuration present, the daemon supervisor can process supported queued jobs retained from an earlier run. Search has an [initial configured runtime](#initial-configured-search-runtime), separate from SQL acceptance of its kind and not yet a complete investigation workflow.

### `runs`

| Column | Type | Constraint / meaning |
| --- | --- | --- |
| `id` | `TEXT` | Primary key; daemon-owned run identity. |
| `kind` | `TEXT` | SQL check and internal `RunKind`: `weave`, `evolve`, `export`, `import`, or `search`. `OrdinaryRunKind` remains explicitly `weave`, `evolve`, `export`; search execution does not inherit their capabilities or knowledge-write authority. |
| `status` | `TEXT` | Check: `queued`, `submitting`, `running`, `uncertain`, `completed`, `interrupted`, or `failed`. |
| `session_id` | `TEXT` | Unique, stable external session identity. |
| `prompt_id` | `TEXT` | Unique, immutable initial external prompt identity. Later prompt identities live in `run_steps`. |
| `created_at` | `TEXT` | Creation timestamp. |
| `generation` | `INTEGER` | Nonnegative claim generation used to fence stale owners. |
| `input_thought_id` | `TEXT`, nullable | Foreign key to the admitted user contribution; required exactly for new `evolve` runs and null for other kinds. |
| `weave_subject_id` | `TEXT`, nullable | Foreign key to the thought being woven; paired with the trigger identity and permitted only for weave runs. |
| `weave_trigger_id` | `TEXT`, nullable | Immutable trigger identity; legacy weave intent remains unknown rather than inferred. |
| `cancellation_state` | `TEXT` | `none` (default), `pending`, or `settled`; remote cancellation settlement is distinct from local interruption. |
| `weave_retired_at` | `TEXT`, nullable | Write-once user-acknowledged retirement time for one failed or interrupted interpretation weave. Null is the default for old and new runs; it is not native settlement evidence. |

Identity, kind, initial session/prompt identities, creation time and input identity are trigger-protected. Retirement cannot be cleared or rewritten, and a retired run's status cannot change. Deleting runs is blocked except for the [narrow tombstoned-search purge](#search-retention-and-purge-guards); other run kinds remain protected. Search input and weave-subject fields must be null. Status and generation otherwise remain mutable through guarded repository operations, not arbitrary model instructions. The internal `RunRecord.promptId` and `nativeState` project the current ordered step, rather than duplicating its native completion evidence in `runs`.

Evolve contribution creation and run admission commit together. The persisted input link identifies the exact contribution after restart and constrains where the run may add developments. A claim contains the run ID and generation. Claims currently have no time-based expiry; this is ownership fencing, not a model-runtime or effort quota.

### `run_steps`

| Column | Type | Constraint / meaning |
| --- | --- | --- |
| `run_id` | `TEXT` | Foreign key to `runs.id`. |
| `position` | `INTEGER` | Nonnegative step order; composite primary key with `run_id`. |
| `prompt_id` | `TEXT` | Globally unique, immutable daemon-owned prompt identity. |
| `input` | `TEXT`, nullable | Exact immutable input; null only until prepared or when legacy input is unknown. |
| `guidance` | `TEXT`, nullable | Additional-instruction snapshot for a prepared initial step. `NULL` covers unprepared initial steps, successors, segmentation and legacy absence; an empty string records a newly prepared initial step with no extra guidance. |
| `state` | `TEXT` | `prepared`, `submitting`, `uncertain`, `completed`, or `processed`. |
| `native_state` | `TEXT` | `unknown`, `running`, or `completed`, local to this step. |
| `envelope_json` | `TEXT`, nullable | Validated canonical request/completion envelope. |
| `result_json` | `TEXT`, nullable | Confirmed capability result, retained before advancement and reused for eligible replay. |
| `submit_owner` | `TEXT`, nullable | Search submission owner attribution. New deployed authorizations use the registered held lease's ID; older strings and nulls remain unchanged. No FK is added to this legacy-compatible column. |

Triggers enforce append order, immutable identities/input, durable completion, and immutable recorded envelopes/results. A run insert creates step zero. Preparation records its exact input once; migration never invents missing legacy input. A completed capability step can retain its confirmed result before advancement. Advancing atomically verifies or records that result and creates the successor's exact input and identity. Matching replay reuses that successor; a mismatch conflicts. Every successor begins with its own unknown native state.

Initial preparation captures the applicable global additional instructions in
the same guarded transaction. The snapshot is immutable after preparation and
is reused through capability exchanges, retries and recovery. Import
segmentation does not receive these settings. Schema rebuilds preserve existing
snapshots exactly and leave historical absence as `NULL`.

For an interrupted or failed weave or Evolve run, positive whole-journal native cancellation evidence can record submitted steps as `completed` with `native_state='completed'` in the same fenced transaction that settles cancellation. Here completion records that the native turn ended, including interruption; it does not manufacture a successful protocol envelope or result. Prompt identities/input and existing envelopes/results remain unchanged, processed steps and untouched prepared successors are preserved, and the run remains interrupted/failed. This durable evidence permits later reinterpretation, daily review of saved contributions/developments, or queued work after restart. A historical settlement flag without the corresponding evidence is still insufficient. Import and search retain their separate terminal-evidence contracts.

The owner guard permits a one-time `submit_owner` assignment only on an existing prepared search step becoming `submitting`, with non-null exact input, unknown native state, a live mapped session and an existing binding. Inserts cannot preassign it, and non-search steps cannot acquire it. The deployed search runtime validates its held lease and exact registry record, then assigns that lease's ID in the existing binding authorization transaction, together with step/run submission state immediately before dispatch. Existing non-null strings are never rewritten by migration or a restart claim. Direct isolated workers without a deployed lease retain unqualified process-random attribution; no registry proof is fabricated for them. Registry membership alone, a legacy string or null is not liveness, execution-flight drain proof or cancellation settlement.

Protocol input is one strict version-1 JSON request or completion envelope. Duplicate keys, extra fields, unsupported versions, model-supplied operation IDs and malformed/truncated output are rejected. Search adds its own `search-reply` envelope with `reply`, `disposition` (`awaiting-user` or `done`) and unique `sourceThoughtIds`; only a search run may complete with it. Search requests use the separate exact nine-capability union [listed below](#initial-configured-search-runtime); search cannot complete through ordinary `complete`/`report` paths. Non-search runs cannot use search-only requests or `search-reply`; the three shared record-read names retain their ordinary scoped contracts. Machine envelopes are not retained conversational replies. Async acknowledgements are bound to the original prompt and cannot change a successor step.

Import step zero has a separate private storage contract. Preparation saves a canonical version-1 `import-job` containing the unchanged decoded document, validated parser manifest, fixed segmentation instructions and an empty capabilities list. The manifest uses scalar-aligned UTF-8 byte ranges, ordered complete atoms and `b0` through `bN` cut IDs. The parser is responsible for Markdown/dependency safety; storage independently checks byte/range coverage and matches the chosen manifest against that exact prepared input.

A write-once `result_json` with `type:'import-partition'` is allowed only for its owning pending import file's initial step. It retains the validated partition, source fingerprint and private never-submitted/terminal evidence. Choosing increments the run generation and ends initial-source access; if a native binding exists, it also retains pending cancellation independently of file completion. A genuine terminal completion records completed native/step state; a failed terminal observation does not fabricate successful native completion. Only validated AI segmentation gets a `segmentation` envelope; structural choices may retain no envelope. Ordinary runs retain their previous result/envelope requirements. Generic protocol, binding, capability, knowledge-write and context paths reject import authority; the ordinary worker and supervisor deliberately do not dispatch import runs. The separate import worker handles restricted native execution and the same local finalizer used without an agent.

Stop fences local execution before remote cancellation settles. Pending settlement remains durable even after local interruption; marking cancellation settled never restores execution authority. For ordinary runs, a binding alone is not evidence of submission: an untouched initial step proven never submitted can settle locally without native cleanup. Submitted steps and ambiguous legacy history still require reconciliation. Search cannot use these ordinary settlement methods; its separate [retained cleanup tail](#retained-search-cancellation) requires joined execution and positive admission/terminal evidence. Configured workers process supported steps through the daemon-owned supervisor.

For a failed or interrupted weave or Evolve run whose historical cancellation flag is already `settled` but whose journal does not prove safety, the existing bounded supervisor scan schedules the same joined ordinary cleanup path. Direct worker ticks use that same selection/proof boundary. It excludes already-proven and restore-fenced history. The adapter must establish terminal boundaries for every potentially dispatched step and current empty inbox/inactive state; missing, foreign or active evidence cannot authorize settlement. The commit rechecks the complete journal, generation, binding and restore fence, then records terminal step bookkeeping without changing the run's terminal status or generation, saved input, protocol output, receipts or knowledge. This neither resubmits nor revives the old run or adopts a native reply. No schema change or separate recovery job is involved.

### `run_screening_passes` and `run_screening_pairs`

Optional local connection screening uses one durable pass per creation-owned text-subject weave (ordinary capture/Markdown or connection-only work), or independently admitted daily review, before its initial prompt is prepared. A historical creation owner does not suppress daily screening. These are private execution history, not connection evidence or a second native submission journal. Media originals/title-only and explicit reinterpretation runs do not enter this step; their newly generated text can have separate creation owners.

| Pass column | Type | Constraint / meaning |
| --- | --- | --- |
| `run_id` | `TEXT` | Primary key and FK to `runs.id`; stable across new claim generations. |
| `subject_id` | `TEXT` | Immutable FK to `thoughts.id`, matching the owning weave subject. |
| `policy_json` | `TEXT` | Immutable canonical JSON `{"version":"connection-screening-1","threshold":0.6,"judgeIdentity":"…"}`. Production judge identity is a SHA-256 over endpoint/model/timeout and the exact question policy, not credentials or a claim ID. |
| `candidate_count` | `INTEGER` | Immutable nonnegative size of the initial eligible other-text-thought membership. |
| `status` | `TEXT` | `collecting`, `complete` or sticky `fallback`. Completion is committed with the initial prompt. |
| `failure_code` | `TEXT`, nullable | Non-null exactly for fallback: `screening-unavailable`, `eligibility-changed` or `configuration-changed`. No raw exception or thought text. |

| Pair column | Type | Constraint / meaning |
| --- | --- | --- |
| `run_id` | `TEXT` | FK to the pass; composite primary key with `candidate_id`. |
| `candidate_id` | `TEXT` | Immutable FK to another text thought, never a media-original descriptor. |
| `position` | `INTEGER` | Immutable contiguous membership order; unique with `run_id`. |
| `judgment_json` | `TEXT`, nullable | Null until committed; then write-once canonical `{"score":0.75}` with one finite probability in `[0,1]`. JSON TEXT avoids adding REAL cells to the portable format. |

Membership is admitted atomically. Triggers protect identities, membership, completed judgments and terminal fallback, and require all judgments before completion. Application/backup validators additionally enforce canonical policy/score JSON and cross-row ownership/count/exposure/full-read invariants. Existing progress is not keyed to `runs.generation`: a restart resumes only null judgments under a fresh claim. An interrupted unfinished **read-only** pair judgment can be recomputed; this never permits replay of native submissions or writes with uncertain acknowledgement.

The worker checks claim, context, subject and candidate eligibility before each external call, commits ID exposure, performs network work outside SQLite, then fences ownership and eligibility again before saving the score. Screening exposure is not a Weaver full read. Rejecting a thought already exposed by a screening-owned run interrupts that active run in the rejection transaction, so restoring it cannot authorize a late judgment. Stop, stale claims, retirement and restore fences also deny late work.

A known failure persists fallback immediately, even while other calls drain; no judgment is retried within that run after fallback. A changed/missing judge configuration or policy before completion uses fallback instead of mixing judgments. Candidate membership drift also uses fallback, not a partial exhaustive claim. Initial prompt preparation atomically rechecks membership, selects nominees from saved scores, grants their scoped full-read witnesses, captures guidance and stores exact prompt bytes. Once prepared, no restart or configuration change regenerates/re-screens that prompt.

[`run-screening-schema.ts`](../src/storage/run-screening-schema.ts) installs these additive tables/guards after predecessor migrations in the core transaction. Legacy databases receive empty progress, not inferred scores. Logical-5 introduced these tables; current logical-6 captures retain them. Logical-1 through logical-4 restore with explicitly verified empty progress. Recovery preserves these rows verbatim while fencing their owning runs.

### Daily-review metadata and scheduling

[`daily-review-schema.ts`](../src/storage/daily-review-schema.ts) adds two tables without rebuilding or backfilling existing thoughts or runs. The internal [`SqliteDailyReviews`](../src/storage/daily-review.ts) command admits work; configured daemon startup wakes the daily driver at boot and on its shared technical timer. There is no daily-review HTTP admission endpoint or new Thought field.

| `daily_review_batches` column | Type | Meaning |
| --- | --- | --- |
| `review_date` | `TEXT` | UTC `YYYY-MM-DD` primary key; one sealed nonempty admission per date. |
| `admitted_at` | `TEXT` | Canonical UTC admission time. |
| `eligible_count` | `INTEGER` | Positive snapshot of all active textual thoughts, including busy ones; raw media descriptors are excluded. |
| `ceiling` | `INTEGER` | Positive maximum admissions calculated from the saved policy, at most the eligible count. |
| `admitted_count` | `INTEGER` | Positive actual batch size, no greater than the ceiling. |
| `policy_json` | `TEXT` | Immutable canonical `{rotationDays,maxPerDay}` policy snapshot. Initial defaults are 30 days and 20 admissions per day, not permanent schema constraints. |

| `daily_review_items` column | Type | Meaning |
| --- | --- | --- |
| `run_id` | `TEXT` | Primary key/FK to the existing weave run; deferred FK permits membership to authorize its run insert in the same transaction. |
| `review_date` | `TEXT` | FK to the batch; unique with both `thought_id` and `position`. |
| `thought_id` | `TEXT` | FK to the fixed textual subject. |
| `position` | `INTEGER` | Immutable contiguous admission order. |
| `completed_at` | `TEXT`, nullable | Write-once canonical UTC time, set only with successful two-check run completion. |

Batch, members and all queued runs commit together. Batch and membership identities cannot be changed/deleted; successful completion cannot be cleared or rewritten. Batch existence seals admission: failure never refills a slot. Empty, unconfigured and wholly blocked libraries create no batch. The command admits only the supplied current UTC date, not missed days, and refuses dates at or before its durable latest admitted date after a backwards clock change.

The ceiling is `min(maxPerDay, ceil(eligible_count / rotationDays))`, with zero work for an empty library. The cap takes precedence over the rotation target, so larger libraries can take longer than 30 days under the initial defaults. Busy subjects are removed before selecting that many candidates, but remain in the count. Selection is never-successfully-reviewed first, then oldest successful review. Equal/null success times use never-attempted/oldest attempt, creation time and binary ID as deterministic ties; a failed never-reviewed subject therefore does not repeatedly preempt untouched ones. `lastReviewedAt` is the maximum persisted successful member timestamp, separate from viewing metadata and immutable thought content. Old libraries default to no successful reviews, not inferred completion from ordinary weaving.

`daily-review:<date>` resolves to the restricted daily purpose only for text subjects. General weave admission cannot fabricate it; matching complete batch membership is required at execution. Application capabilities permit scoped search/reads, conditional title fill and connections involving that subject. Retained receipts/history and successor preparation retain the restriction. No thoughts, interpretations, developments, drafts or public Full replies are published. Weaver's permissive operator native-tool policy is unchanged, not sandboxed.

Only the strict `{"version":1,"kind":"review-complete","titleCheck":"complete","connectionCheck":"complete"}` terminal envelope may complete this purpose. Other purposes reject it; ordinary `complete` cannot finish daily review. Run completion and the member timestamp commit together, including no-change outcomes. Saved title/connection effects may survive later failure, but failed/incomplete/Stopped/rejected or uncertain reviews do not gain a timestamp. Local screening fallback is not review failure when Weaver subsequently completes both checks successfully.

Daily admission defers behind active/unsettled fixed-subject weaving and the Weaver/Evolve run that created its input/issued subject. Later ordinary/connection-only work waits behind a daily reservation. Existing interpretation versus creation-discovery concurrency otherwise remains unchanged. Terminal status or an unverified historical settlement bit is insufficient. Restore fences remove historical execution blockers without reviving their work. Daily runs are not interpretation status owners or retirement candidates and are independent of Evolve's creation-owner Stop cascade.

Logical-6 includes both tables and validates identities, policy/arithmetic, complete membership/order, permitted history and successful terminal envelopes. A non-completed review may retain its final completed-but-unprocessed request as private data before dispatch, across shutdown/restart, or after dispatch denied it, provided that prompt has no result or operation receipt and the review has no success time. Forbidden effect receipts, processed requests/predecessors and fabricated successful completion remain invalid. Logical-1 through logical-5 explicitly restore daily tables empty. Recovery preserves successful times and sealed dates, fences all historical runs and leaves incomplete reviews inert; it never reconstructs missing review work. The admission ceiling bounds subjects, not exhaustive screening's approximately `B(N-1)` pair judgments.

### Creation-owned connection discovery

No additional queue, table or column is used. An internal `weave` run with immutable `weave_trigger_id='connection-discovery:<creator-run-id>'` has purpose `connection-only`. Its existing subject/trigger identity is the durable replay key. The creator is retained in `runs`: its `input_thought_id` identifies an Evolve contribution, or its `run_issued_thoughts` membership identifies a generated development/interpretation. Admission and backup/restore validation check this origin relationship, exclude media-original descriptors, and refuse issued thoughts or public reply rows belonging to connection-only work.

Direct contribution/development commands have no creator run. Their scheduled knowledge writer atomically admits `connection-discovery-direct:<thought-id>` alongside the new thought. The suffix must match the fixed subject, which must be a non-root user-authored `user-contribution` with origin `contribution` and no sources, or an AI-authored `developing-idea` with origin `development`. It must not be any run's admitted input or issued thought. Fresh admission requires the writer's creation transaction; general admission can replay an existing owner but cannot backfill historical direct thoughts. These explicit direct identities remain distinct from run origins, including Evolve Stop's origin matching. No fake run, new table or backup version is introduced.

Evolve admission saves the contribution, original run and discovery owner together. Every typed or legacy generated development/interpretation saves its owner with the thought, receipt and issued membership; capability dispatch also commits the exact result in that transaction. This includes siblings, non-latest developments, media interpretations and new reinterpretation outputs. Replay reuses the recorded owner, never schedules another. Fresh discovery admission requires active, unfenced creation authority; stopped/restored historical creators cannot acquire new owners. Existing historical creations are not backfilled by migration or replay.

Ordinary captured/Markdown weaving retains its creation screening. A generated thought's dedicated owner owns its screening even if completed, stopped or using fallback: the ordinary latest-development Evolve follow-up keeps title/interpretation duties but does not repeat creation screening or nominations. Connection-only dispatch is independent of interpretation serialization; it is excluded from interpretation admission blockers and cannot be retired through interpretation retirement.

Connection-only authority permits scoped search/reads and warranted connections involving its fixed subject, not interpretation/development/title writes. The application checks purpose and endpoint scope before effects, cached receipt/result replay and completion. Its canonical final envelope stays in `run_steps`; no `responses`/`run_replies` publication or recursive interpretation job is created. Operator-managed native tools retain the existing Weaver policy; application scope is not a native-tool sandbox.

User Stop on Evolve also interrupts active discovery owners whose durable trigger names that Evolve run, in the same transaction. Generations and existing cancellation journals fence held calls and late results; completed effects are not undone. Origin identities survive reopening, receipt replay and backup. Restore preserves the trigger/origin facts and fences all historical runs without creating or resuming discovery. This semantic use of existing TEXT fields does not change the logical-5 inventory or frozen older inventories.

### `agent_bindings`

| Column | Type | Constraint / meaning |
| --- | --- | --- |
| `run_id` | `TEXT` | Primary key and foreign key to `runs.id`. |
| `session_id` | `TEXT` | Unique native session identity bound to the run. |
| `service_url`, `directory` | `TEXT` | Selected service and native location. |
| `model_json` | `TEXT` | Explicit provider/model/variant reference. |
| `permissions_json` | `TEXT` | Immutable native permission rules: existing deny policies or the singleton wildcard allow policy for Weaver/Evolve. Restricted run kinds cannot bind an allow policy. Existing bindings retain their saved policy on recovery. |
| `protocol_version` | `INTEGER` | Check: `1`. |
| `execution_owner_id` | `TEXT`, nullable | FK to `execution_owners.id`; immutable setup attribution for new deployed search bindings. Existing bindings and ordinary/import bindings remain null. |

Update triggers make bindings immutable; deletion has only the narrow tombstoned-search exception described below. No service credentials or authentication headers are stored. Binding is permitted only before the initial native submission; recovery cannot infer a new binding for an already-submitted unbound run. Internal run reads project the bound native session while preserving the initial allocated identity in `runs`.

Search setup attribution is persisted with the binding before the first native session-create RPC, even if no prompt is ever authorized. The trusted binding repository accepts an actual optional `ExecutionOwnerLease`, not a caller-selected owner string; it requires the held lease's matching registered identity/protocol on the same database connection. Reusing an existing binding never fills a legacy null or replaces its setup owner. Setup attribution and each step's later submission attribution are distinct: a restarted owner may observe an old binding and authorize a fresh prepared successor without rewriting earlier facts. The public/native `AgentBinding` DTO is unchanged and contains no owner selector.

### `execution_owners`

| Column | Type | Constraint / meaning |
| --- | --- | --- |
| `id` | `TEXT` | Nonempty primary key; opaque ID minted only by the actual acquired runtime lease. |
| `database_identity` | `TEXT` | Nonempty canonical identity JSON containing DB `path`, device `dev` and inode `ino` as strings. No credentials or conversation content. |
| `lease_protocol` | `TEXT` | Nonempty protocol identifier; current runtime emits `sqlite-sidecar-v1`. |

[`ExecutionOwnerLease.register(db)`](../src/storage/execution-owner.ts) records the capability's own ID/identity/protocol in a short immediate transaction after migration and before worker construction, even without agent configuration. Update/delete/replacement guards retain records unchanged, including after shutdown or later startup failure. Acquiring a bare lease alone does not register a row. `assertRegistered(db)` requires an active lease, the same canonical database file and an exact registry match for that lease; caller DTOs or arbitrary strings do not qualify execution.

Historical attribution qualifies for the lease protocol only when its registry identity and protocol match the current canonical DB identity/protocol; table existence or an ID lookup alone is insufficient. A copied/restored file with a different path/device/inode cannot automatically inherit predecessor evidence. Registry rows have no PID, heartbeat, liveness flag or claim that a predecessor's network request cannot arrive. Search cleanup uses the held lease plus matching setup/all-submission lineage to exclude predecessor future calls, after joining the current lane. That local proof still needs positive remote terminal evidence for every authorized prompt. The separate explicit retention controller can purge local content while this remote uncertainty remains pending.

Imports have explicit trusted storage methods, not a mode flag on ordinary binding: `bindImport` requires the active pending holder and its prepared private initial input; `assertImportPreparation` fences session setup and preflight to that never-submitted input, and `recordImportSubmission` records intent immediately before the exact bound prompt is sent. These storage methods make no network calls. `assertImportOwnership` is read-only and additionally requires persisted import kind, current generation, a pending owning file, no library context or knowledge receipts, the exact immutable prompt sequence and recorded submission intent. `recordImportObservation` retains only existing nonterminal native vocabulary; terminal facts enter storage atomically with the chosen partition. Shared source/input validation checks staging bytes against their receipt and the prepared document/manifest. Stop, settlement, a newer generation or a durable partition choice revokes dispatch/observation authority. A separate fenced cancellation gate permits only cleanup of completed, failed or interrupted imports with pending cancellation; it does not reopen source access.

`OpenCodeAdapter.observeImport` requires that repository guard before/after native reads. Production callers use distinct ordinary/import local fences (`AdapterFences`); local pause checks cannot replace persisted authority. The observer shares session/binding checks, paginated history reading and prompt/context/inbox correlation with ordinary observation, but not its terminal classifier or phase transitions. Owned failed/interrupted idle tails produce `terminal-failure`; complete error-free successful tails produce `terminal-completion` with exact output, including empty/whitespace/non-stop output for later segmentation validation. Unknown/incomplete history remains nonterminal. No canonical result is written by observation.

The private `ImportTerminalEvidence` carries `sessionId`, `promptId`, `inputSha256`, user/assistant/idle message IDs, typed idle outcome, nullable completion time/finish, assistant/idle error booleans, and UTF-8 output byte length/SHA-256. Before retaining either terminal result, storage checks the bound session and exact prepared prompt/hash; `userMessageId` must equal that persisted prompt ID, which is the native user-message identity used by submission and history correlation. Storage validates these known persisted identities, not independent proof of unpersisted provider facts; the observer establishes native terminal correlation. The witness contains no raw provider exceptions. These terminal states never enter the ordinary `NativePhase` callback; ordinary failure/error/empty-output semantics remain unchanged.

Adapter authorization checks ownership, context visibility and exact persisted prompt bytes in short transactions before crossing the native boundary. Submission is recorded before dispatch, so an ambiguous acknowledgement cannot justify resending after restart merely because native inbox/history reads are empty. Foreign or conflicting native input quarantines the run; missing decisive evidence remains uncertain. The immutable saved binding preserves creation intent and endpoint, while native ownership uses session and owner/run/protocol metadata rather than exact mutable model, directory or unrelated metadata. Complete parent history, ordered actual user inputs, final parent assistant and idle boundary establish output correlation; opaque auxiliary records alone are not a conflict. Live event delivery alone is not recovery evidence. Ordinary cancellation independently requires a terminal boundary for every potentially dispatched journal step, with no active or queued work, before transactional settlement.

### `run_context`

| Column | Type | Constraint / meaning |
| --- | --- | --- |
| `run_id` | `TEXT` | Foreign key to `runs.id`. |
| `kind` | `TEXT` | Check: `thought`, `connection`, or `response`. |
| `ref_id` | `TEXT` | Referenced identity; polymorphic, so not a declared foreign key. |
| `full_read` | `INTEGER` | Durable full-read distinction; defaults to false for legacy exposure rows and may only be upgraded. |

Composite primary key: `(run_id, kind, ref_id)`. The repository checks AI visibility before recording exposed context and revalidates it when authorizing submissions, reads, writes and cached-result delivery. A shared reply becomes ineligible if any associated thought is rejected. Full-read evidence is monotonic; a candidate snippet or a referenced ID alone does not prove that the model read the thought's full text.

The scoped capability dispatcher returns narrow search candidates and AI-scoped thought, connection or response reads. A media `readThought` returns its descriptor/clarification and records full-record context before the normal Weaver/Evolve worker resolves an eligible original path outside SQL. That private prompt context is not part of the capability result. The dispatcher records every exposed reference, but does not upgrade indirectly referenced IDs to full-read witnesses. Connections and supporting sources require the appropriate full reads before a write. Model requests cannot select user authority, run/operation identity, authorship or timestamps, and cannot reject/restore notes or access raw SQL/files through these application capabilities. Capability effects, exposure evidence, typed receipts, issued membership and the confirmed step result share the aggregate transaction. A Stop or rejected exposed reference fences replay as well as new work. Permissive native tools have their separate [trusted filesystem access](server-startup.md#retained-media-and-shared-filesystem).

### `run_operation_receipts`

| Column | Type | Constraint / meaning |
| --- | --- | --- |
| `run_id` | `TEXT` | Foreign key to `runs.id`. |
| `operation_id` | `TEXT` | Stable operation identity within the run; step-format receipts use the persisted prompt ID. |
| `operation_json` | `TEXT` | Recorded operation request. |
| `thought_id` | `TEXT`, nullable | Foreign key to a resulting development/interpretation; absent for title fills and connections. |
| `result_json` | `TEXT` | Recorded result returned for an eligible replay. |
| `format` | `TEXT` | `legacy` (default) or `step`. Legacy receipts require a resulting thought. |

Composite primary key: `(run_id, operation_id)`. A unique constraint covers `(run_id, operation_id, thought_id)` for the issued-membership foreign key. Update/delete triggers protect receipts. An insert trigger requires a step-format receipt to identify an existing prompt belonging to the run.

Typed step operations record developments, interpretations, categorized connections or conditional missing-title fills. Their effects and receipts commit atomically; only thought-producing operations also create issued membership. Evolve developments use the admitted contribution as parent; weave interpretations use the persisted weave subject. Authorship, IDs and timestamps are daemon-owned.

Weaver/Evolve connection capabilities deduplicate the same directed `(fromId,toId,category)` inside the guarded immediate transaction, after purpose, prompt, visibility and endpoint/supporting-source full-read checks. A visible existing match returns `{type:"connection",status:"already-present",connection}` with its original identity, explanation and attribution and AI-scoped provenance. Any explicitly rejected match suppresses equivalent creation, even alongside a visible match, returning only `{type:"connection",status:"not-created"}`. No rejected identity, content or provenance enters the result or context. With no match, `{type:"connection",status:"created",connection}` records a new AI relation. There is no global unique constraint: direct commands retain deliberate multiplicity, and reversed endpoints or different categories remain distinct.

Each outcome, its exposures and the dispatched step result commit with its immutable receipt. Replay returns that original outcome without looking for newer matches or enriching redacted provenance after restoration; exposed relation/source rejection still fences replay. Readers, successor confirmation and backup validation reject unknown/malformed outcomes, mismatched requests or fictitious backing records. Historical status-less `{type:"connection",connection}` created receipts remain readable without adding a status or rewriting bytes. The pre-existing TEXT JSON cells are extensible; no table, column or backup inventory changes are needed.

Reusing the operation identity with the same request reuses the result; a different request conflicts. Title-fill outcomes include a durable no-op when a title already exists. Replaying that no-op after a later user clear does not apply the old proposal. A stopped, failed, stale or rejected-context claim cannot use replay to bypass its fence. Export runs cannot dispatch any knowledge write. Legacy development receipts remain readable without inventing membership for non-thought results.

### `run_issued_thoughts`

| Column | Type | Constraint / meaning |
| --- | --- | --- |
| `run_id` | `TEXT` | Foreign key to `runs.id`. |
| `operation_id` | `TEXT` | Operation that issued the development or interpretation. |
| `thought_id` | `TEXT` | Foreign key to the issued thought. |
| `position` | `INTEGER` | Nonnegative issued-order position. |

Composite primary key: `(run_id, position)`. Unique constraints cover `(run_id, operation_id)` and `(run_id, thought_id)`. A composite foreign key links `(run_id, operation_id, thought_id)` to the matching receipt. Update/delete triggers protect the ledger.

This is the durable source of reply membership, not a potentially stale draft list. Replaying an operation does not append another result. Addendum finalization must use this order; an unrelated or reversed association list conflicts.

### `run_replies`

| Column | Type | Constraint / meaning |
| --- | --- | --- |
| `run_id` | `TEXT` | Primary key and foreign key to `runs.id`. |
| `draft_json` | `TEXT`, nullable | In-progress reply draft, not yet an immutable canonical response. |
| `response_id` | `TEXT`, nullable | Foreign key to the retained canonical response. |

There are no immutable-row triggers here because drafts and finalization bookkeeping change. Final canonical text and associations are protected by the response tables.

Stop retains confirmed developments and can persist an existing draft as an interrupted response using durable associations. It does not invent an association if none can be derived safely. Final response persistence and local completion commit together. Observed native completion instead produces a reconciliation handoff with action `finalize`; it does not claim the local response is already committed. Recovery returns `{run, claim, action}` using `finalize`, `resume`, or `observe`, without replacing the stored external identities.

A title-only or no-findings weave still retains its completed outcome as a response associated with the subject; it need not create an interpretation. Failure retains confirmed knowledge changes and eligible interrupted drafts, fences later callbacks, and keeps pending remote cancellation settlement available.

For media roots, title-clear purpose is derived from the persisted subject and trigger, not caller-supplied capabilities. It permits conditional title fill and completion only, with metadata-only context and no original path; it cannot read other thoughts or publish an interpretation or connection. Incompatible retained request history is denied before native submission, including already-prepared successors, without rewriting historical inputs. Ordinary initial source weaving instead uses the normal capabilities, interpretation operation and Full reply finalizer. Completion without a saved interpretation retains the limitation reply but marks source processing failed. Confirmed children remain saved if later work fails.

### Durable weave scheduling

When the scheduling port is enabled, capture, an explicit user title-clear on an eligible active note, and successful Evolve finalization admit a follow-up weave inside the triggering transaction. Capture uses `capture:<thought-id>`; each eligible title-clear has a daemon-generated invitation ID; Evolve uses `evolve:<run-id>` and selects its last issued development or contribution fallback. Clearing an already absent title on an eligible note is still a new regeneration invitation; clearing a rejected note's title is not. Worker finalization uses the same scheduling path as direct run finalization.

Admission reuses the first recorded subject/trigger match without resetting its status or results. A lookup index and insert trigger prevent future duplicates. Migration preserves legacy duplicate jobs and their histories rather than deleting or cancelling them. Network availability and agent configuration are outside these transactions. AI title fills, connection writes and interrupted replies do not schedule weaving. Run-created interpretations/developments admit only their dedicated connection-discovery owner; they do not recursively schedule interpretation-capable work.

Explicit user reinterpretation uses `reinterpret:<request-key>` with the same immutable subject/trigger identity and uniqueness guard. No receipt table is added. A key identifies one admitted request, not a semantic content duplicate or an alias for unrelated active work. User-only receipt recovery reads the existing run; historical `settled` flags alone do not prove replacement eligibility. A valid recorded never-submitted or completed journal can establish safety. Otherwise an explicit per-run retirement can remove that run alone as a blocker while retaining remote uncertainty. See the [command and recovery contract](daemon-api.md#reinterpret-post-thoughtsidreinterpret).

Automatic invitations remain durable even when the subject is busy; a title edit or Evolve publication is not rolled back merely to avoid simultaneous weaving. Existing run metadata selects a started interpretation incumbent across prepared successors and restart, otherwise the oldest queued invitation. Waiting runs remain queued without generation churn. Worker entry, claim and native-submission authorization enforce this order, while already-submitted work remains observable and cancellable. Unresolved or unverified historical work blocks fresh dispatch unless that exact run was explicitly retired; other blockers still apply. Genuine media-title-only work is capability-restricted and can coexist; text title-clear work can interpret and participates in serialization. No separate queue table or scheduler is added.

The immutable reinterpretation trigger also determines execution purpose. Initial media processing retains its prohibition on historical interpretation children; reinterpretation instead permits one new direct interpretation issued by the current run. Completion checks this run's issued output, not the existence of any historical child. A missing new media interpretation retains the complete limitation response but fails the run; ordinary text/URL no-findings replies can complete without a new thought.

The import writer admits one ordinary weave per imported thought with trigger `import:<document-id>:<ordinal>` in the same transaction as the canonical file. No model runs inside that transaction. Empty/metadata-only imports admit no thoughts or weaving.

### Agentic export artifacts

These subordinate tables reuse run identities and claims; they are not another execution journal:

| Table | Columns and constraints |
| --- | --- |
| `export_intents` | `run_id` primary key/FK to `runs`; nonempty `request`; `effort` is `quick`, `standard` (default), or `thorough`; `local_disposition` is `retained` (default), `local-stopped`, or transaction-only `deleting`. Insert requires an export run and `retained` disposition. |
| `export_reports` | `run_id` primary key/FK to `export_intents`; `prompt_id` identifies its completed report step; nonempty `markdown`; `sources_json` holds validated attribution. |

Insert/update guards prevent replacement or mutation of intent identity/request/effort and stored reports. Disposition transitions and deletion have narrow owner-checked exceptions below. Legacy export runs remain without an intent rather than receiving an invented request. Finalization validates the persisted version-1 report envelope, full-read source witnesses, current source eligibility and all exposed run context. Report insertion and local completion commit together; Stop, rejection or stale ownership fences publication.

The report preserves model Markdown and appends validated source thought IDs, title/fallback, immutable thought author and material kind. This validates citation structure and eligibility, not the truth of the model's connective conclusions. Historical artifacts are deliberately user-only: they are not thoughts, conversation responses, search-index entries or AI-readable context. Artifact and run-state writes do not grant knowledge-write authority. The existing worker/supervisor executes export runs; immutable intent selects the configured effort variant before binding, and user routes admit and download reports through scoped application services.

The internal user-only `AgenticExports.list/get/delete/stop` storage/domain facet supplies export history independently of agent configuration. History contains only `id`, persisted `status`, `createdAt`, `request`, `effort`, `restored` and `deletionState` (`stop-required`, `settling`, `ready`); intent-less legacy and non-export runs are excluded. Pages default to 50, maximum 200, ordered by immutable creation time then ID descending. Typed keyset continuations bind the limit and last tuple. Pages are live, not a cross-request membership snapshot: concurrent admissions/deletions can change membership, and refresh is needed for newer rows ahead of the current position. These are internal continuations, not authenticated HTTP cursors. No history/deletion HTTP routes or client workflow are added by this storage foundation.

Live active exports require ordinary explicit Stop; interrupted/failed exports remain undeletable until cancellation is settled. Completed exports with cancellation `none` or `settled` are ready. A restore-fenced, locally terminal export may instead acknowledge **local** Stop by changing only its intent disposition to `local-stopped`. The application-facing run Stop adapter uses this export-specific branch, preserving the historical status, generation, steps, binding, fence and cancellation evidence, without contacting the old agent. That acknowledged snapshot is ready for local deletion even if historical remote cancellation is unknown/pending. This is not native settlement; generic fenced Stop and all unrelated restored execution remain inert.

Delete rechecks eligibility in one immediate transaction, authorizes `deleting`, and removes the report, issued membership, operation receipts, reply bookkeeping/drafts, context, binding and all steps (including retained prompt/result/report copies), then the exact run fence. The final guarded run deletion consumes the remaining intent witness. Unexpected search/import ownership refuses deletion. Any failure rolls back the entire purge and preserves a preceding local Stop acknowledgement. Core migration installs the combined export/search delete guards after all schema foundations, retaining independent search ownership rules. Knowledge, referenced canonical responses, media, shared execution-owner registry rows and unrelated runs/fences are untouched. No deletion tombstone or content-bearing diagnostics are retained. Backup validation refuses a persisted `deleting` disposition. This is logical local deletion, not provider, downloaded-file, backup-history or SQLite free-page/WAL erasure.

## Markdown import storage foundation

These tables, internal adapters and the lossless Markdown parser exist. The [`import driver`](../src/agent/import-driver.ts) schedules a shared [`import worker`](../src/agent/import-worker.ts): local structural processing without agent configuration, or restricted initial segmentation with the configured standard model/variant. User-only HTTP routes use the command and inspection contracts without exposing raw storage. [`domain/markdown-import.ts`](../src/domain/markdown-import.ts) exposes the range/manifest, parser, admission, report and inspection contracts. [`storage/markdown-import.ts`](../src/storage/markdown-import.ts) owns admission, private input, durable partition choice and finalization; [`import-inspection.ts`](../src/storage/import-inspection.ts) owns deliberately scoped user inspection. Unconfigured scans claim only pending holders with a durable choice or an untouched initial queued/prepared/unknown step without an envelope or later steps. A binding does not exclude that never-submitted path when the exact prepared input is retained; bound rows with missing historical input remain excluded. Finalization retains the binding and truthful prepared/unknown journal, and proven never-submitted cancellation settles locally without a native client. Configured scans also observe existing submitted identities and settle terminal pending cancellation, including completed imports, without reopening execution authority. Neither path infers terminal failure from unknown native history. Terminal local cancellation can settle only when the existing import journal proves no submission.

| Table | Columns and constraints |
| --- | --- |
| `import_namespaces` | `id` PK, `kind`, `label`, `created_at`. Migration creates one stable `loose-markdown` namespace with a constant label; a partial unique index enforces that kind's singleton. |
| `import_documents` | `sequence INTEGER PRIMARY KEY AUTOINCREMENT`; unique `id`; `original_bytes BLOB`; 32-byte `sha256 BLOB`; `byte_length`; `encoding='utf-8'`; `original_namespace_id` FK; `original_path`; `created_at`; `parser_version`; `segmentation_method` (`ai`, `structural`, `not-needed`); nullable `segmentation_reason`, present exactly for structural fallback. Unique `(sha256,byte_length)`; byte length must match the BLOB. |
| `import_locations` | `(namespace_id,relative_path)` PK, namespace/document FKs; document lookup index. A successful novel non-loose import binds its original locator; loose imports do not. Existing loose locators remain preserved but do not establish identity. A duplicate skip does not add an alias. |
| `import_document_parts` | `(document_id,position)` PK; `kind` (`thought`, `separator`, `frontmatter`, `bom`); `[start_byte,end_byte)`; nullable unique `thought_id` and nullable `thought_ordinal`, present exactly for thought parts. Unique `(document_id,thought_ordinal)`; composite FK `(document_id,thought_id)` to `thoughts(import_document_id,id)`. |
| `import_document_seals` | `document_id` PK, immediate FK to the document. The document's own `id` has the reverse **deferred** FK to this seal, including when it has zero thoughts. |
| `markdown_imports` | Auto-increasing `sequence`, unique `id` and `request_key`, namespace FK, immutable `created_at`, nullable write-once `sealed_at`. |
| `markdown_import_files` | `id` PK; batch/namespace composite FK; ordered `position`; `request_key`; `relative_path`; digest/length; `created_at`; nullable unique import `run_id`; nullable `waiting_on_file_id`; nullable terminal `outcome`, `document_id`, `reason_code`. Unique batch-position and batch-request-key pairs. Document is required exactly for imported/skip outcomes; a reason is required exactly for failed/interrupted outcomes. |
| `markdown_import_payloads` | `file_id` PK/FK; immutable exact staged `bytes`, length-matched to its pending file. Deletion requires terminal settlement. This is private staging, not a retained source or retrieval artifact. |

Positions, ordinals, lengths and offsets use nonnegative safe integers; part ranges are nonempty. Documents, original locators, parts, seals and namespaces reject replacement/update/deletion. A sealed document refuses late parts and imported thoughts. Seal insertion checks the original locator for non-loose sources, complete contiguous ordered byte coverage, BOM/frontmatter placement, ordered thought ordinals, mapping in both directions, null initial title metadata, sealed empty supporting-source sets and exact equality between each thought's UTF-8 bytes and its original slice. A missing seal cannot commit, even for an empty or metadata-only document with no thought rows. Application validation additionally checks well-formed UTF-8, no NUL, scalar boundaries, whitespace-only separators and frontmatter framing; the lossless parser supplies the separate Markdown block/dependency checks.

Admission validates literal relative paths without opening them and compares actual bytes for matching fingerprints. Path writes and locator/reservation lookups bind UTF-8 bytes through `CAST(? AS TEXT)`, preserving a leading U+FEFF and keeping prefixed and unprefixed paths distinct. Non-loose known-locator changed bytes win over cross-document dedupe; loose paths are metadata and legacy loose locators are ignored for identity. Request-key replay compares immutable inputs; batch sealing does not block an already-admitted replay. A partial unique index reserves pending-holder `(sha256,byte_length)` pairs library-wide; insert/update triggers reserve `(namespace_id,relative_path)` only for non-loose holders. Migration replaces the old universal locator index and seal trigger transactionally without changing existing records. A waiter owns no run and points to a pending holder, never another waiter. Bounded local waiter rechecks rerun admission after holder settlement; this is not native dispatch or an automatic retry of a terminal file.

Finalization revalidates ownership, staged bytes, the durable manifest/partition and reservations. Document, imported thoughts and title/source metadata, complete parts, any non-loose original locator, document seal, weave admissions, file result, completed run and staged-byte deletion commit together. The shared immediate-transaction helper explicitly rolls back a failed deferred-FK commit before releasing the connection. Stop similarly fences a pending import, settles its file as interrupted and removes staging atomically; it never reverses a committed source or its independent weave jobs.

Source detail/raw/parts require a user `history` inspection scope even when all segments are active. Thought provenance requires a user and respects the target thought's current read scope. Reports/lists never include document bodies. Internal lists use bounded keyset pages (default 50, maximum 200) with route/parent/scope/limit-bound typed continuations and a fixed membership high-water mark; opaque authenticated HTTP cursor encoding remains a future route responsibility. Source metadata, filenames, raw bytes, staging and partition journals never enter thought/response search, ordinary AI context or export membership traversal. Rejection/restoration follows evolution, not document membership.

## Media-source storage foundation

[`media-schema.ts`](../src/storage/media-schema.ts) defines immutable source metadata. Original files live outside SQLite in private storage; there is no original-byte or extracted-text column. Daemon startup connects validation, private-file retention, user-only HTTP admission/inspection/retry and the normal worker's path resolver. Weaver/Evolve receives a managed absolute path and instructions for OpenCode's permitted tools. **The daemon and OpenCode must share filesystem access.** The browser workflow uses fixed Next.js server handlers rather than direct daemon access. See the [API](daemon-api.md#retained-media-import-and-source-inspection), [web workflow](server-startup.md#image-and-pdf-import-workflow), and [filesystem requirements](server-startup.md#retained-media-and-shared-filesystem).

### `media_store`

| Column | Type | Constraint / meaning |
| --- | --- | --- |
| `singleton` | `INTEGER` | Primary key, check `singleton=1`. |
| `store_id` | `TEXT` | Unique store identity; SQL check `length(trim(store_id))>0`. Not a directory path. |

Migration leaves this table empty. Internal `SqliteStore.mediaStoreId()` returns its ID or null. `initializeMediaStore(storeId)` persists a supplied nonempty ID, returns it on an exact repeat, and refuses replacement. Update/delete/replacement triggers protect the identity. Daemon startup supplies the retained ID or a new UUID to the private file service, which checks/creates its matching directory marker before initializing SQL identity. Opening an already initialized store never replaces that identity.

### `media_sources`

| Column | Type | Constraint / meaning |
| --- | --- | --- |
| `id` | `TEXT` | Nonempty primary key identifying the source. |
| `source_thought_id` | `TEXT` | Unique; three `DEFERRABLE INITIALLY DEFERRED` FKs to `thoughts.id`, `thought_titles.thought_id` and `thought_source_seals.thought_id`. |
| `request_key` | `TEXT` | Unique; 1–128 ASCII letters, digits, `.`, `_`, `:`, `-`. |
| `display_name` | `TEXT` | Nonempty display filename, not an opened path or search term. |
| `mime_type` | `TEXT` | Check: `image/png`, `image/jpeg`, `image/gif`, `image/webp`, `application/pdf`. |
| `byte_length` | `INTEGER` | SQLite integer; `0<byte_length<=9007199254740991`. |
| `sha256` | `BLOB` | Exactly 32 bytes; **not unique**. |
| `clarification` | `TEXT`, nullable | Exact user wording; nonblank when present. The SQL check excludes the ECMAScript trim whitespace set without modifying stored text. |
| `created_at` | `TEXT` | Nonempty; must equal the new root's creation time. |

All source columns reject update, deletion and identity/request-key replacement. Source insertion requires an initialized store and a target thought that does not yet exist. A thought-insert trigger requires the source-first association exactly for media roots and matches creation time; thought checks enforce source authorship, null text and root/origin fields. Deferred FKs prevent committing a source without its root, title row and empty supporting-source seal. Supporting-source inserts are forbidden even before sealing. Clarification authorship is derived as `user` when present, otherwise null; file authorship is always `unverified` in the descriptor.

Internal `SqliteStore.saveMediaSource({thought,requestKey,sha256})` in [`media-source.ts`](../src/storage/media-source.ts) validates the domain media variant, an initially absent title and a 32-byte supplied digest. One immediate transaction inserts source metadata **before** the root, then its null title metadata and empty source seal. It requires prior explicit store initialization, copies the supplied digest, and admits no run. Equal digests may belong to distinct sources. This metadata seam neither verifies actual file bytes nor implements an HTTP idempotency/retry contract. UTF-8 byte binding preserves exact clarification, including a leading U+FEFF.

Full Thought projections include the scoped `mediaSource` descriptor described in the [API](daemon-api.md#response-records). Search and investigative snippets use clarification only; saved-search discovery/history summaries use the filename only as a title fallback. Existing rejection/provenance rules apply to these projections. A thought full read proves descriptor/clarification exposure, not a binary read. Search and Agentic Export gain no file-open or native-tool capability; Markdown whole-document artifacts remain user-only.

### Normal media weaving and scoped file paths

The existing [`RunWorker`](../src/agent/worker.ts) accepts an optional trusted `mediaPath(sourceId): Promise<string>` dependency. It selects source IDs only from scoped eligible media Thoughts in initial Weaver/Evolve context or a confirmed `readThought` result. Context/full-read references commit first; asynchronous path resolution then runs outside SQL. Current claim, local lifetime and context checks run around that boundary and before saving the next prompt. The resolver receives a source ID, not a caller-selected path. Returned paths must be absolute.

The exact text prompt contains the ordinary Thought descriptor and separate private `originals:[{thoughtId,path}]` context. Initial source weaving follows the exact user clarification or asks for a summary when absent. OpenCode uses its normal native tools to read the original for the configured model. No path is added to public Thought projections or canonical capability results. Search and Agentic Export retain descriptor-only reads and denied native tools; import segmentation receives only its own Markdown input. Existing deny-bound Weaver/Evolve sessions are not silently upgraded to permissive tools.

### Source admission and lifecycle

After file publication, [`SqliteMediaAdmissions.admit("user",input)`](../src/storage/media-admission.ts) commits source metadata, root/title/source seal, an ordinary weave and its initial step together. It returns `{thought,run,replayed}`. The initial trigger is `media-import:<source-id>`. Request-key replay compares immutable filename, MIME, byte length, digest and exact clarification, then returns the original source/run identities without rescheduling. Independently allocated IDs/times and later title edits do not change that payload comparison. A metadata-only source without an initial admission is not adopted by replay.

The daemon's [`SqliteMediaImports`](../src/storage/media-import.ts) coordinates this command with real file publication and scoped user reads. Its bounded upload lane checks retained request keys before publishing, and compares uploaded byte length/SHA-256 plus exact name/clarification for replay. Fresh records use the validator's detected MIME. `byKey` resolves `media_sources.request_key` to that source's initial `media-import:<source-id>` run; `retryAdmission` resolves the source-specific `media-retry:<source-id>:<key>` intent and reports whether it already exists inside the admission transaction. Public replies use the existing ordinary run projection, not internal native identities. There are no additional tables or schema changes for these routes/lookups.

Normal run operations save one initial searchable AI interpretation child and the outcome's Full reply. Title-clear on a media root schedules only title regeneration, without reopening the file or creating another interpretation. The internal user-only `retry(actor,sourceId,requestKey)` reuses the original through ordinary weave admission with a `media-retry:<source-id>:<request-key>` trigger. A fresh admission requires no existing interpretation child; if a previous non-title source run exists, it must be failed/interrupted with settled cancellation. Active or unresolved work is not duplicated. Matching intent replay returns its existing run. Once any initial interpretation exists, further work uses Evolve, even if that child is later rejected.

Media-source rejection uses the existing user rejection transaction and scoped eligibility rules. It immediately interrupts affected active Weaver/Evolve runs, increments their generations and marks cancellation pending, including runs exposed through supporting context. The confirmed `readThought` context is already durable while a first supporting-file path read is held, so rejection followed by restoration cannot revive that callback. Stop/failure/rejection retains source metadata, original files and confirmed knowledge; restoration does not resume the terminal run or schedule replacement work. Application fences cannot withdraw a path already sent to trusted native tools. See the [worker](testing.md#shared-file-media-worker-checks) and [admission/lifecycle checks](testing.md#media-admission-and-lifecycle-checks).

### Internal private-file service

[`media-files.ts`](../src/storage/media-files.ts) receives an explicit private directory, store identity, instance logger, lifetime fence and validator. Its `store.json` marker records `{version:1,storeId}` and must match SQLite. The owned layout has `objects`, `staging` and private scratch `prepared` subdirectories; filenames supplied with thoughts never select storage paths. Linux directory handles anchor operations through `/proc/self/fd`, with same-UID ownership, `0700` directory/`0600` file modes, no-follow and hard-link checks in [`media-file-paths.ts`](../src/storage/media-file-paths.ts).

Publication bounds and hashes the actual stream, validates staged bytes, syncs the file and publishes without replacing an existing object. Only then does it call the trusted synchronous SQL admission callback, outside a SQL transaction; that callback owns its short transaction. The service checks the resulting immutable source fingerprint. There is no atomic transaction spanning SQLite and the filesystem: failures can leave unreferenced files, while an ambiguous callback failure must preserve a committed original. No filesystem I/O belongs inside the callback's SQL transaction.

`readOriginal(sourceId)` verifies the stored reference and actual original fingerprint before returning bytes. `originalPath(sourceId)` performs the same verification and returns the stable real absolute object path, not a process-local descriptor path. Path-only verification hashes the file without retaining its full contents in memory. Cleanup is bounded and reference-aware, never removes referenced originals merely because they are rejected or failed, and excludes active publication. Unknown scratch files and unexpected multi-link leftovers are conservatively retained. The daemon performs bounded cleanup at startup and after admission, with a 24-hour orphan grace and 64-entry batches. Closing joins entered work before releasing owned handles; it does not close the caller's database. Scoped HTTP reads and normal worker claims supply consumer authorization separately. See the [owned filesystem checks](testing.md#private-media-file-service-checks) and [paired backup/restore procedure](server-startup.md#paired-media-backup-and-restore).

## Agentic search storage foundation

Implemented code is split between [`search-schema.ts`](../src/storage/search-schema.ts), [`search-migration.ts`](../src/storage/search-migration.ts), the domain contracts/service in [`domain/agentic-search.ts`](../src/domain/agentic-search.ts), and [`search-sessions.ts`](../src/storage/search-sessions.ts). Schema, structural guards, metadata/history lifecycle, composers, ledger-aware normal pages and previews, atomic turn admission, discovery/reply publication, occurrence removal and transactional rejection invalidation are implemented. The internal investigative facet provides bounded lexical/date-only retrieval and direct relationship references. The configured worker supports nine logical search capabilities, strict search replies, SQL conversation/paired-clock context and due clock refresh. Runtime exclusivity, qualified attribution, joined cleanup, explicit retention and purged-outbox scanning protect local deletion. The daemon exposes [session, workspace and turn/control routes](daemon-api.md#agentic-search-sessions) and accepts optional paired clock headers. The implemented Next.js client provides Ask your library and Saved searches through fixed server-side forwarding routes; see the [web workflow](server-startup.md#conversational-search). [Testing concepts](testing.md#agentic-search-foundation-checks) describe the controlled evidence and its limits. Ordinary Search and Agentic export keep their existing contracts.

### Search-owned tables

Session identity is separate from the native `runs.session_id`. Search text, titles and selections are not thoughts, responses or conceptual connections and do not enter library FTS or spelling vocabulary.

| Table | Fields and constraints |
| --- | --- |
| `search_sessions` | `sequence INTEGER PRIMARY KEY AUTOINCREMENT`; unique `id` and `create_request_key`; nullable `title`; `created_at`, `last_activity_at`; nonnegative `revision` default `0`; nullable `deleted_at`. Live rows require a nonempty title; deleted rows require a null title. The partial `search_sessions_activity` index orders live rows by activity and sequence descending. |
| `search_turns` | `run_id` primary key/FK to `runs.id`, `ON DELETE CASCADE`; `session_id` FK to `search_sessions.id`; ordered nonnegative `position`; `request_key`, `admitted_at`; `effort` (`quick`, `standard`, `thorough`); `context_mode` (`continue`, `restart`); JSON-valid `intent_json`; `open_slot` (`0` or `1`, default `1`); nullable `outcome_reason`. Unique session-position, session-request-key and session-run pairs. Partial `search_turns_one_active` permits one open slot per session. |
| `search_messages` | `id` primary key; `session_id`, `run_id`, ordered `position`; `role` (`user` or `assistant`); nonempty `text`; `created_at`; nullable `disposition`; JSON-valid `evidence_json`. Composite `(session_id,run_id)` FK to `search_turns(session_id,run_id)`, cascading deletion. Unique session-position, run-role and session-ID pairs. User disposition must be null; assistant disposition is `awaiting-user` or `done`. |
| `search_discoveries` | `id` primary key; `session_id`; `thought_id` FK to `thoughts.id`; ordered `position`; nonempty `why`; JSON-valid `evidence_json`; `added_run_id`, `added_prompt_id` (FK to `run_steps.prompt_id`), `added_at`; nullable `removed_at`. Composite `(session_id,added_run_id)` FK to `search_turns(session_id,run_id)` cascades deletion. Unique added-prompt, session-position and session-ID pairs. |
| `search_content_dependencies` | `sequence INTEGER PRIMARY KEY`; `session_id` FK to `search_sessions.id`; nullable `message_id` and `discovery_id`, exactly one present; `ref_kind` (`thought`, `connection`, `response`) and `ref_id`. Composite session/owner FKs to `search_messages(session_id,id)` and `search_discoveries(session_id,id)` cascade deletion. Partial unique indexes deduplicate each owner's source references; `search_dependency_reverse` indexes kind/reference/session. The polymorphic source reference is not a cross-table FK. |
| `search_composer_contexts` | `id` primary key; `session_id` FK to `search_sessions.id`; nonnegative `revision` default `0`; `state` (`active`, `consumed`, `invalidated`, `discarded`); `created_at`. Session lookup index. New rows must be active revision-zero contexts in live sessions. |
| `search_composer_dependencies` | `composer_id` FK with cascading deletion; source `ref_kind` and `ref_id`; composite primary key over all three. Reverse kind/reference/composer index. These are source identities, not copied prose. |
| `search_revisions` | Singleton `id=1`; nonnegative `eligibility`, `retrieval`, `catalog`, initially zero. Guards prevent deletion, replacement and decreasing counters. Lifecycle commands maintain `catalog`; each actual thought/connection rejection or restoration through the rejection repository increments both `eligibility` and `retrieval` transactionally. Triggers also advance `retrieval` for thought creation, source association insertion, title insertion/deletion or changed metadata, response creation and response association insertion, and connection insertion/deletion or changed identity, endpoints or category. These epochs are not business counts and are distinct from the existing spelling `search_revision`. |
| `search_native_cleanup` | `run_id` primary key **without a run FK**, allowing evidence to outlive a purged run; `session_id` FK to `search_sessions.id`; JSON-valid `binding_json`; non-null `last_prompt_id`; nullable `submit_owner`; `drain_state` (`waiting`, `drained`, `unknown-after-restart`); `admission_state` (`never-submitted`, `uncertain`, `admitted`, `terminal`); nullable 32-byte BLOB `prompt_sha256`; nullable JSON-valid `evidence_json`; `state` (`pending`, `settled`, `ownership-conflict`); nullable JSON-valid `prompt_manifest_json`, null only for preserved legacy rows. |

`search_discoveries_one_unremoved` is a **partial** unique index on `(session_id,thought_id) WHERE removed_at IS NULL`; `search_discoveries_visible` indexes live occurrence order. Removed occurrences remain immutable history. A different completed add step may therefore insert a new ID, rationale and tail position for the same thought; it never clears an earlier occurrence's removal. The internal publication and fixed-ID removal methods below implement that transaction boundary; the search-only `addDiscovery` dispatcher uses this same publication path.

Supporting source lookups use `run_context(kind,ref_id,run_id)`, `response_thoughts(thought_id,response_id)` and indexes beginning with each connection endpoint. Migration checks existing full indexes before adding equivalent coverage.

### Search retention and purge guards

Turn insertion requires a live session and a `search` run with no thought/weave input; its slot must match the run's active/terminal status. Terminal status releases the slot, and a terminal search run cannot reopen. Identity, intent, message text/role/evidence, occurrence rationale/order and source dependencies are immutable while retained. Replace paths are guarded as well as updates/deletes. Occurrence removal is write-once; composer coverage cannot shrink while active, and consumed/invalidated/discarded contexts cannot reset to active. Consumed/discarded dependency cleanup is allowed without resetting their context identity.

A discovery insert must match its own run's completed `addDiscovery` request and confirmed `discovery-add`/`added` receipt, including entry ID, target, rationale and evidence JSON. This SQL correlation is **not** dispatcher authorization, exact domain-intent validation, current eligibility or full-read proof. Raw SQL checks JSON syntax; the separate domain admission command validates the versioned turn intent. Search inserts into library reply bookkeeping, knowledge-operation receipts and issued-thought membership are denied; import/export ownership guards remain in force.

Six existing delete guards have deliberate search-only exceptions: `runs_immutable_delete`, `run_steps_immutable_delete`, `run_context_immutable_delete`, `agent_bindings_immutable_delete`, `run_receipts_immutable_delete` and `run_issued_immutable_delete`. Each requires an extant run of kind `search`, its retained turn mapping, and that mapping's owning session with non-null `deleted_at`. Neither an arbitrary tombstone nor a supplied session ID grants purge authority. Non-search and live-session execution remain undeletable; library immutability is unchanged.

Purge removes content dependencies before their messages/discoveries, composer dependencies before composer rows, and execution children before runs. The run deletion guard checks the retained mapping before the FK cascade removes the now-empty turn. Direct turn deletion while its run exists is blocked, preventing loss or reassignment of the ownership proof. The session row cannot be deleted or revived: its title-free tombstone retains only identity, creation key, times, revision and deletion marker.

Cleanup rows are reserved for **non-content** binding/owner/prompt/hash/phase evidence, never prompt text, output, rationale or raw provider errors. Insertion requires either the retained tombstoned search owner or a retained terminal search run with pending cancellation and a closed slot. Non-search/import runs and live active sessions cannot acquire cleanup authority. The referenced focus prompt must belong to that run; this exception grants neither execution nor library-write authority. Existing child-first purge guards are unchanged.

### Cleanup journal and internal snapshot

[`search-cleanup-schema.ts`](../src/storage/search-cleanup-schema.ts) separates immutable sealed identity from evolving observations. New rows require a complete manifest, `state='pending'`, no evidence and an undrained state. Null manifest is a migration allowance only: an older pending row cannot gain new drain/terminal/settlement authority, and an older already-settled row stays historical and immutable. Identities, manifest, focus owner/hash and binding cannot be updated or replaced; unsettled rows cannot be deleted. Admission/drain evidence cannot regress. A never-authorized manifest cannot be promoted to admitted/terminal merely because foreign native input appeared.

[`search-cleanup-manifest.ts`](../src/storage/search-cleanup-manifest.ts) exports `SearchCleanupManifest`, `SearchCleanupPrompt`, `parseSearchCleanupManifest`, `encodeSearchCleanupManifest` and `searchCleanupFocus`. Version 1 has exactly these fields:

| Object | Exact keys / meaning |
| --- | --- |
| Manifest | `version:1`, `runId`, `searchSessionId`, `nativeSessionId`, `fencedGeneration`, `setupOwnerId`, `steps`. The generation is a nonnegative safe integer; setup owner is an ID or honest null. |
| Each step | `position`, `promptId`, `inputSha256`, `submitOwnerId`, `authorization`, `state`, `nativeState`. Positions are contiguous from zero, prompt IDs unique, and every owned step is included. Hash is exactly 64 lowercase hexadecimal SHA-256 characters for the exact UTF-8 input, or honest null for unavailable historical input. Submission owner is an ID or null, never a guessed replacement. |
| Authorization | `never-authorized` requires prepared/unknown state with null owner; a nonprepared step with an owner is `authorized-uncertain`; a nonprepared step without one is `unattributed`. Native completion remains a snapshot enum, not a terminal certificate. Missing hashes for possibly authorized history retain uncertainty rather than granting reconciliation/settlement authority. |

The codec rejects unknown/duplicate keys, invalid versions/phases/hash encodings, reordered/gapped positions, duplicate prompts and inconsistent phase/owner/native-state combinations, returning only a frozen whitelist. `encode` canonicalizes JSON object keys. It accepts no prompt text, result, clock, topic, provenance, credentials or arbitrary metadata fields. Errors use fixed `SearchCleanupJournalError` text without parser excerpts. The focus is the last possibly authorized step, or the current last prepared step if all were never authorized; a prepared successor never hides an earlier authorization.

[`readSearchCleanupSnapshot(db,runId)`](../src/storage/search-cleanup-snapshot.ts) is a trusted internal read helper, not a user/agent facet. It requires an existing SQL transaction and an already-terminal, closed-slot bound search run whose session is tombstoned or cancellation is pending. It derives ownership/binding and **all** steps from SQL; inputs are iterated one at a time only to hash them, accumulating metadata rather than an array of private input bodies. It returns `SearchCleanupSnapshot` with `runId`, `sessionId`, canonical `bindingJson`, `lastPromptId`, nullable `submitOwner`/binary `promptSha256`, `promptManifestJson`, `drainState:'unknown-after-restart'`, `state:'pending'`, `evidenceJson:null`, and admission `never-submitted` only if every step was never authorized, otherwise `uncertain`. The helper itself inserts nothing, fences nothing, purges nothing, and produces no drain/terminal proof. Cleanup and retention use it before reconciliation or content removal.

New SQL inserts correlate manifest IDs/generation/setup owner, complete ordered step membership, phase/owners and hash presence with the retained journal; the focus binary hash must match its manifest hex. SQLite does **not** compute input SHA-256: trusted snapshot construction supplies it. Missing focus hashes outside `never-submitted` are allowed only in pending/ownership-conflict with unknown-after-restart drain. Unattributed/missing-hash or unmatched registry lineage cannot enter waiting/drained proof paths; historical strings are not qualified merely by being present.

Drain/terminal/settlement transitions require at least evidence object `version:1` and `drainOwnerId`, with registered setup/issuer/drainer identities sharing database identity/protocol. For any authorized prompts, terminal/settlement additionally requires `admission_state='terminal'`, `inboxEmpty:true`, `inactive:true` and one matching `prompts` certificate per authorized step: `promptId`, `inputSha256`, `userMessageId` equal to the prompt ID, nonempty `idleMessageId`, explicit nullable `assistantMessageId`, and outcome `completed`, `failed` or `interrupted`. Empty `{}` evidence cannot settle even a never-authorized snapshot. These are necessary metadata checks, **not** SQLite verification of an actual joined flight, held current lease or remote certificate. The internal runtime path below supplies those checks; raw SQL fixtures do not.

### Retained search cancellation

The existing [`RunWorker`](../src/agent/worker.ts) flight map retains `{execution,cleanupTail,retired}` per run. Preflight/setup/submission/observation and synchronous ACK-fact handling remain inside execution. A serialized cleanup tail runs only after that captured execution promise settles; execution never awaits its own tail or recursively calls cleanup. Concurrent ticks share the whole lane. The existing supervisor's bounded terminal-pending run scan/capacity drives retry; no separate worker, timer or unbounded cleanup queue exists. Pause blocks new execution/cleanup RPCs, and final runtime drain joins the actual tails, including direct ticks outside the supervisor's map, before DB/lease closure.

[`SqliteSearchCleanup`](../src/storage/search-cleanup.ts) creates or exactly reuses immutable snapshots for **retained terminal search runs with pending cancellation and closed slots**, without `REPLACE` or re-reading inputs on replay. Before recording local drain, it requires the actual held/registered lease, the current canonical DB identity/protocol for the binding setup owner and every authorized step owner, known authorized hashes and no unattributed step. Current execution has already joined; matching prior lease owners cannot issue future calls under the held exclusive lease. Legacy/null/copied/mismatched ownership stays unknown/pending and gets no native cancellation authority. No PID, heartbeat, grace period or empty remote state substitutes for qualification. An entirely never-authorized qualified snapshot can settle locally after that join; no remote-container erasure is promised.

[`search-cleanup-contract.ts`](../src/agent/search-cleanup-contract.ts) defines cancellation-only identity, admission facts, terminal certificates and observations. `OpenCodeAdapter.cancelSearch` uses [`search-cancellation.ts`](../src/agent/search-cancellation.ts) and [`search-cleanup-history.ts`](../src/agent/search-cleanup-history.ts), not ordinary `cancelOwned` or an active claim. It requires the exact recorded endpoint/current matching server-side credentials and strict session/run/protocol/model/variant/location/deny-all/unsafe-state ownership. Complete paged history and every inbox ID/hash are checked against the sealed **authorized** prompts. Duplicate/foreign inputs, unsafe context, unsubmitted successors and ownership drift fail closed without retargeting or interrupting foreign work. Only a wholly represented owned conversation permits mutation; ownership is re-read before each cancellation/interrupt. These separate RPC checks are not an atomic barrier against an external writer.

Only owned user inbox IDs are cancelled. A queued non-user item is not attributed to an authorized prompt: it keeps the complete inbox nonempty and prevents cleanup mutation and settlement until it drains. An active flag or queued input alone does not identify active work: interrupt additionally requires every authorized user to appear in owned history with an unfinished owned terminal boundary. After mutation, reconciliation reads again; successful cancellation/interrupt, timeout, missing session or empty/idle history alone cannot settle. Settlement requires positive matching admitted user/hash and correlated assistant/idle terminal boundaries for **every** authorized prompt, plus current empty inbox/inactive state. Assistant prose is neither parsed as application protocol nor published. Missing authorized prompts remain metadata-pending indefinitely, without resend. Ordinary/import cancellation also leaves queued non-user work untouched and pending.

[`search-cleanup-evidence.ts`](../src/storage/search-cleanup-evidence.ts) validates exact version-1 `{version,drainOwnerId,admissions,prompts,inboxEmpty,inactive}` metadata, bounded by the manifest. `drainOwnerId` is null until the real joined/qualified tail records it; flags are boolean or unknown null. Each admission fact is exact `{runId,nativeSessionId,promptId,inputSha256}` and each terminal certificate has the fields above. A search-only transport callback validates the matching ACK and supplies its hash fact **before** the active-claim post-await fence can discard it. It only updates an existing matching sealed pending row for this issuer; it never creates a row/run, schedules work, writes prose or settles cancellation. The row's admitted state follows its focus prompt; facts about earlier prompts cannot promote that focus. Lost facts remain uncertainty. Historical certificate retention cannot replace a fresh complete owned observation for settlement.

Conclusive cleanup and the retained run's pending cancellation settle in one short transaction, without changing terminal status/generation/slot, messages, confirmed discoveries or library records. Configuration absence, missing credentials or endpoint mismatch leaves pending work; conflict rows remain retained and do not gain mutation authority. Stop/rejection alone retains local content. Purging it requires the explicit retention dependency below; the default session facet still refuses bound Delete even after cancellation settles. Public search control exposes cancellation state, not the cleanup journal or native evidence.

### Explicit search retention and purged cleanup

[`ConfiguredRunWorker.searchRetention()`](../src/agent/configured-worker.ts) delegates to its actual [`RunWorker`](../src/agent/worker.ts), which returns a [`SqliteSearchRetention`](../src/storage/search-retention.ts) capability only with an actual held, registered execution-owner lease; otherwise it returns null. Trusted application code can explicitly pass that capability to `SqliteStore.searchSessions(sources,controller)`. It must belong to the **same SQLite connection**, not merely another handle on the same file. Caller DTOs, owner strings and AI actors cannot supply retention authority. The daemon installs it for its HTTP session service before readiness, with or without agent configuration. Omitting it from an internal facet preserves the previous local-only purge/refusal contract.

Controller-backed Delete requires a root repository-owned immediate transaction; invoking it inside an existing transaction is rejected before mutation, because savepoint release is not a postcommit boundary. That single transaction:

- Advances every owned run generation, interrupts only active runs, closes their slots and invalidates active composers. Existing terminal status/outcome is preserved: completed work is not relabeled user-stopped.
- Writes the title-free tombstone, session activity/revision and catalog revision, and seals every bound run's all-step cleanup metadata **before** erasing inputs. Existing Stop/rejection snapshots are reused without replacement or identity changes, including their earlier fenced generation; binding and complete journal identity must still match. Legacy null manifests remain unchanged and unqualified, never backfilled into proof.
- Uses the existing guarded child-first purge while turn mappings still prove ownership, removing session content and owned execution rows without touching knowledge/library records. Ambiguous unbound execution or an unsealable journal fails closed rather than guessing native identity. No await or SDK call occurs under the SQL lock.

An interrupted user-stopped run marked pending can still be locally purged with this controller when its closed turn, absent binding and cleanup row, and sole matching prepared/unknown initial step with null input, owner, envelope and result prove it was untouched. This classification does not settle cancellation or assert native cleanup; missing or contradictory evidence remains a refusal.

Only after successful commit does the repository hand the exact captured ID batch back to the controller. The worker synchronously marks existing lanes retired without dropping their execution/cleanup promises, clears claim and clock metadata, and notifies the existing scanner. Delete returns before joining those promises or calling the SDK. Rollback leaves content, fences, slots and outbox unchanged and performs no retirement/notification. Tombstone/key replay does not repeat the purge or activity. This adds no schema or SQL-guard exception beyond the existing tombstoned-search rules.

The supervisor shares its eight run lanes between ordinary/retained work and pending cleanup rows whose session is tombstoned and run is absent. Alternating source preference and separate rowid cursors with finite membership high-water marks prevent one growing source from extending a scan forever. A successful purge coalesces one wake of that same scanner; there is no second timer, per-ID SDK fanout or permanent retired-ID blacklist. Purged ticks bypass execution/model preflight and use only the sealed cleanup identity. No run, binding, input, message or late assistant reply is recreated.

The same qualified-owner, joined-flight and positive native-terminal requirements apply after purge. A new actual lease can exclude future predecessor calls only when setup and every issuer match its canonical DB identity/protocol; it cannot prove that an old request will never arrive. Legacy/copied/unattributed identities, missing hashes, missing credentials, endpoint mismatch and incomplete native history remain pending or conflict without resend/retargeting. Settlement after purge updates only the outbox; retained cancellation still updates its run atomically. Settled metadata is retained. Configuration-less runtimes own local retention through the same lease-bound `RunWorker` with no native port or binding selector. Its ticks admit no execution/cleanup work; no supervisor/native scanner, discovery or client is constructed. Purge seals honest pending/unknown metadata without advancing remote evidence, for a future matching configured runtime.

This is local logical retention, not physical SQLite free-page/WAL erasure, backup deletion or native/provider erasure. Client integration and broader recovery/race acceptance remain later work.

### Internal session lifecycle

`SqliteStore.searchSessions({id,now,logger?},controller?)` exposes the typed user-only service below. The optional controller is the explicit trusted retention dependency above. The service uses injected daemon IDs and canonical UTC timestamps; callers cannot assign record metadata. Selected metadata methods are exposed by the daemon; the full facet is not an agent capability.

| Method | Implemented contract |
| --- | --- |
| `create(actor,requestKey,{})` | Returns `{session,replayed}`. The exact payload is empty; keys use `[A-Za-z0-9._:-]{1,128}`. New sessions have neutral `Search — YYYY-MM-DD` titles and revision zero. Matching create-key replay returns current metadata without allocating another ID, sampling a new record time or changing activity. A deleted key returns `session-deleted`, never resurrection. |
| `list(actor,{limit?,cursor?})` | Returns `{items,nextCursor}` of live metadata only, ordered by last activity then sequence descending. Default limit 50, maximum 200. Strict typed cursors bind collection, user scope, fixed order, limit, membership high-water, last sort key and catalog revision. A changed catalog returns `list-changed`; limits/unknown fields and cross-contract continuations are rejected. The HTTP adapter authenticates its opaque continuations. |
| `get(actor,sessionId)` | Returns live session metadata or null for missing/deleted sessions. No conversation, native binding or active-run DTO is returned. |
| `metadata(actor,sessionId)` | In one transaction returns live session metadata, open-slot search control DTO or null, and eligibility revision; missing/deleted sessions return null. No prose or composer is read or changed. |
| `rename(actor,sessionId,expectedRevision,{title})` | Requires exactly a nonempty title and a nonnegative safe revision. A stale revision returns `revision-conflict`. An actual change updates title, activity, session revision and catalog revision atomically; an identical title is a no-op after revision validation. HTTP `PATCH` passes its unquoted decimal `If-Match` revision to this comparison. |
| `history(actor,sessionId,{messages?,discoveries?})` | Returns `{scope:'history',session,messages,discoveries}` with independently bounded `{items,nextCursor}` collections. Each collection accepts `{limit?,cursor?}`, default 50/maximum 200, with session/kind/history-scope/limit-bound position cursors and a fixed membership high-water. Exact retained messages and removed occurrences remain deliberate human history, with current eligibility indicators and current thought title/fallback metadata. No composer token is issued and this read is never AI context. |
| `delete(actor,sessionId)` | Missing sessions fail; known tombstones replay without activity. The default facet supports only proven never-authorized unbound local work. With an explicit retention controller, bound runs are fenced and sealed before the same atomic local purge; remote cleanup remains independent. Library records and unrelated runs are not deleted. |
| `openComposer(actor,sessionId)` | Creates a daemon-owned blank active composer and returns `{composerId,contextToken,eligibilityRevision}`. It copies no previous ledger or draft, starts no run and does not bump session activity. |
| `discardComposer(actor,sessionId,composerId)` | Atomically marks an active owned composer discarded; known terminal contexts replay as a no-op. Its ledger is not reset, and saved content is unchanged. |
| `offerMessage(actor,sessionId,composerId,messageId)` | Reads one existing same-session message through normal eligibility and records all offered source dependencies before returning `{composerId,contextToken,eligibilityRevision,sessionRevision,message}`. Unsafe message text is a placeholder (`text:null`, empty evidence); deliberate `history` output is not a fallback. |
| `messages(actor,sessionId,{composerId,limit?,cursor?})` | Returns normal chronological `{items,nextCursor,composerId,contextToken,eligibilityRevision,sessionRevision}` after registering all eligible messages' offered dependencies. Unsafe messages retain control identity/position but have null text and empty evidence. |
| `discoveries(actor,sessionId,{composerId,limit?,cursor?})` | Returns the same page envelope in occurrence order, excluding removed entries. Unavailable targets have `thought:null`, null rationale and empty evidence. A safe target with unsafe rationale retains fresh thought summary metadata, but returns `why:null`, empty evidence and `reasonStatus:'context-unavailable'`. Normal entries have `removedAt:null`. |
| `previewThought(actor,sessionId,composerId,thoughtId)` | Returns `{thought,composerId,contextToken,eligibilityRevision,sessionRevision}` using the AI-normal Thought projection. Rejected targets are unavailable; rejected parent/source IDs are removed. Registers the thought and every visible parent/source reference, not a model full-read witness. No import document/source-artifact inspection is included. |
| `refreshComposer(actor,sessionId,composerId)` | Revalidates the draft's entire existing dependency union and returns its current `{composerId,contextToken,eligibilityRevision}`. It allocates no new draft, removes no coverage and changes no activity. Consumed, invalidated and discarded contexts fail with `context-changed`. |
| `admitTurn(actor,sessionId,requestKey,input)` | Atomically admits a validated fresh request or exactly replays its receipt. Returns control-only `{receipt,run,session}`, never submitted/recovered message text. Details below. |
| `admitTurnWithPolicy(actor,sessionId,requestKey,input,configured)` | Trusted transport policy checks configuration inside the admission transaction after exact replay and active-turn checks, before IDs or writes. Returns control and replay status. |
| `searchRun(actor,runId)`, `stopSearchRun(actor,runId)` | User-only scoped control read or atomic owned Stop and control projection; absent/non-search/deleted owners return null. No generic run DTO or content is exposed. |
| `turnByKey(actor,sessionId,requestKey)` | Returns that same control-only view for an existing admitted key, or null for an absent/deleted session or key. It does not submit work or read conversation for display. |
| `removeDiscovery(actor,sessionId,entryId)` | User-only removal of this occurrence, never “whatever entry has this thought ID.” First removal writes its daemon timestamp and updates session/catalog activity; a retry is a no-op without sampling another time or affecting a later rediscovery. Missing/foreign entries fail. No library rejection or deletion occurs. |
| `removeDiscoveryWithRevision(actor,sessionId,entryId)` | Performs the same fixed-occurrence command and returns the current session revision in the same transaction, including on replay. |

All session-facet methods reject AI actors. Create, changed rename, fresh turn admission, confirmed discovery additions, final replies, first occurrence removal and first successful deletion update catalog membership/order metadata; reads, composer opening, identical-title renames and command replays do not. History uses current thought/connection/response dependency eligibility, including exclusion of a shared response if any member is rejected, but retains exact prose for the user rather than presenting it as safe normal content. Publication is a separate trusted claim-bound facet, not actor-selected authority on this user interface.

### Composer and turn transactions

[`search-composer.ts`](../src/storage/search-composer.ts) extends a draft's persistent dependency union before returning eligible message prose. It copies the message's complete flattened source set and offered evidence identities, not a caller-supplied dependency list or only the latest model window. Dependencies are deduplicated and never dropped while active; adding coverage increments the composer revision. An unsafe incoming message contributes no hidden prose, evidence or dependencies. If previously offered coverage is now unsafe, the transaction permanently invalidates that composer and commits the fence before the domain reports `context-changed`.

[`search-context-token.ts`](../src/storage/search-context-token.ts) signs version-1 `{sessionId,composerId,composerRevision,eligibilityRevision}` claims with process-local HMAC-SHA256. Tokens are opaque caller data, not source authority or bearer credentials. The key is neither persisted nor logged. Admission verifies the exact current composer/eligibility revisions and source eligibility inside its immediate transaction. Explicit discard closes only the selected draft and never resets its coverage.

[`agentic-search-workspace.ts`](../src/domain/agentic-search-workspace.ts) owns the separate user-only normal-read service. [`search-workspace.ts`](../src/storage/search-workspace.ts) and [`search-workspace-content.ts`](../src/storage/search-workspace-content.ts) read bounded position pages and use the same composer-offer primitive as `offerMessage`. The immediate transaction first rechecks the complete existing ledger, then unions all actually offered eligible message/rationale dependencies and evidence, safe discovery targets, or preview thought/provenance identities before returning prose and a newly signed token. A lookahead row is not offered and contributes no ledger dependencies. History projections are never reused to build these responses. No run context or full-read witness is written by a user workspace read.

Normal pages default to 50 items, maximum 200. [`search-workspace-cursor.ts`](../src/storage/search-workspace-cursor.ts) authenticates opaque, process-local continuations bound to collection, session, normal scope, ascending position order, page size, last position and initial membership high-water. A continuation without an explicit limit keeps its original size. New arrivals require a fresh walk; eligibility, removal and current titles stay live, so a continuation may finish empty. These position cursors do not invalidate merely because activity/session revision changed: each response instead reports current `sessionRevision` and `eligibilityRevision`. Restart invalidates the page signature and requires a fresh walk, without resetting the persistent composer ledger. Catalog/history cursors remain separate internal typed contracts, each with an authenticated HTTP transport adapter.

A normal-page cursor is not bound to a composer and grants no content authority. A fresh read with another active same-session composer rechecks eligibility and registers every item it actually returns for that composer, then echoes its ID. It does not register earlier pages that were only shown under another composer. Cached/delayed C1 prose must never be relabeled C2; clients must discard it or re-fetch it under C2 before display. Reading older pages, changing page size or refreshing a composer cannot shrink its union. Out-of-order responses may carry older tokens, but cannot admit against the current larger composer revision; refresh returns the same draft's latest valid token. If an unsafe existing union is observed, invalidation commits before `context-changed` is reported, without returning prose. Permanently invalidated/consumed/discarded contexts cannot be refreshed into empty active drafts.

Turn input has required `text`, `requestClock:{at,timeZone}`, `composerId` and `contextToken`; `startingThoughtIds` defaults to `[]`, `effort` to `standard` and `contextMode` to `continue`. Starting IDs must be unique and currently eligible; effort also accepts `quick`/`thorough`, and mode accepts `restart`. Unknown fields, caller-selected IDs/record times/dependencies, malformed text and AI authority are rejected. The client-reported full timestamp/offset (up to millisecond precision) and named time zone are validated against the calendar/zone, preserved verbatim and never used as SQL record timestamps. This validation does not interpret relative-time prose, impose a skew threshold, update a model clock or implement hourly prompt refresh.

[`search-turns.ts`](../src/storage/search-turns.ts) persists the run, ordered turn, one exact user message, dependencies, exposures, composer consumption and session/catalog activity changes together. IDs and one canonical UTC admission instant come from injected daemon sources. The run receives distinct allocated native session/prompt identities but no native call or binding; its initial step remains `prepared`/`unknown` with unprepared input. The version-1 `intent_json` retains starting IDs, original request clock, `daemonObservedAt`, mode, composer ID, original token and verified decoded claims, never the signing key or a second copy of user text.

The new user message and `run_context` inherit **all** offered composer dependencies plus eligible starting references. `restart` does not erase that inherited coverage. These run exposures are recorded with `full_read=0`: prior human or earlier-run reads do not become model full-read witnesses. The composer becomes consumed only after copying; its redundant dependency rows are then removed in the same transaction. The unique active slot serializes admission across connections.

Exact key replay compares original normalized caller intent, frozen clock/token and user text **before** checking a consumed/stale composer or another active turn. It allocates no IDs, samples no new admission time and does not revalidate an old token against a restarted process key. Changed input returns `idempotency-conflict`; a fresh key while a turn is active returns `turn-active`. Admission, replay and by-key lookup contain only immutable receipt IDs/time plus current search-run/session control metadata, not conversation prose, evidence excerpts or native identities. The dedicated `SearchRunView` grants no execution authority; `OrdinaryRunKind` remains separate from the internal search execution kind.

Current message reads/admission use the real transactional library state through [`search-eligibility.ts`](../src/storage/search-eligibility.ts), including connection endpoints and all shared-response members. They retain their current-eligibility rechecks in addition to the rejection-event fence below. A restored source can become eligible for a fresh read, but cannot reactivate an invalidated composer or an interrupted run.

Unexpected persistence failures have sanitized outer `SearchStorageError('search-persistence-failed')` messages. The original exception is retained only as standard non-enumerable `Error.cause` for bounded internal diagnostics/tests. Do not log/serialize that cause or expose it from a future HTTP error handler.

### Rejection-event transactions

[`storage/rejection.ts`](../src/storage/rejection.ts) integrates [`search-invalidation.ts`](../src/storage/search-invalidation.ts) into the existing user-only rejection engine, not a new search-specific rejection command. Each marker insert/delete with an actual effect increments `eligibility` and `retrieval` by one in the same immediate transaction; a branch increments once per changed thought. Repeated reject/restore no-ops and denied AI calls do not increment either counter. Catalog/activity metadata, retained conversation, occurrences and library content are unchanged.

On rejection, the helper resolves affected source identities without loading library prose: the thought itself, connections with that thought as either endpoint, and responses associated with that thought; explicit connection rejection resolves that connection alone. Reverse-index joins into `run_context` and `search_composer_dependencies` find all exposed dependencies, including uncited and inherited flattened sources. An active descendant is not automatically rejected or fenced merely because its parent/supporting source was rejected: fresh reads redact that provenance, while previously exposed rejected identities in its run/composer closure still cause fencing. Branch commands explicitly walk only evolution descendants.

Only live-session search runs in `queued`, `submitting`, `running` or `uncertain` with an open slot are interrupted. Their generation increments, `outcome_reason` records `context-invalidated` when not already set, and the terminal-status trigger releases the slot. Affected active composers become permanently `invalidated` without deleting coverage. Terminal runs, other run kinds, unrelated work and non-active composers are not rewritten. Restoration advances revisions but never revives work, even when rejection and restoration both finish before another search poll/admission.

Bound or possibly dispatched runs retain `cancellation_state='pending'`. A queued unbound run needs no remote cancellation only when its matching initial journal is intact and still `prepared`/`unknown`, with no submission owner, envelope, result or later step and cancellation `none`; missing or ambiguous evidence stays pending. The rejection transaction records only this local fence: it makes no service call or native settlement claim. The separate retained cleanup tail later joins execution and reconciles pending work. Wider restart, shutdown and deletion races still require additional integration evidence.

The marker, existing spelling revision, dedicated revisions, generation/status/slot/outcome and composer state roll back together if any write or commit fails. Internal SQL failures remain observable to owned rejection tests; service/HTTP error handling must not expose raw exceptions. Mutation existence checks and branch previews use [`rejection-state.ts`](../src/storage/rejection-state.ts)'s targeted identity/rejection projection rather than the SQLite repository's full library-content snapshot. Domain traversal, exact branch confirmation, user-only authority and existing read-scope policies remain in `RejectionService`; simpler repositories may still provide its existing snapshot contract.

### Trusted discovery and reply publication

`SqliteStore.searchPublication({id,now,logger?})` implements [`SearchPublication`](../src/domain/search-publication.ts) through [`search-publication.ts`](../src/storage/search-publication.ts). Its methods are `addDiscovery(claim,promptId)` and `finalizeReply(claim,promptId)`; neither accepts a user actor, caller proposal or caller-selected dependencies. The worker invokes publication only after its owned native output is recorded; discovery dispatch likewise supplies its own claim and completed step. This is not a user HTTP capability or a replacement for native history observation.

The [publication guard](../src/storage/search-publication-guard.ts) requires a live owning session/turn with an open slot, active search status, exact current generation, no pending cancellation, an immutable owned protocol-1 binding, and the requested prompt belonging to that run. Native completion, retained nonempty exact input and a whole completed envelope must already be persisted; previous prompt steps must be durably processed. SQL fixture completion is not proof that a real provider/native service was correlated. Non-search authority, library-write bookkeeping, superseded/terminal claims and unknown/foreign prompt evidence fail closed.

Fresh effects require the **current** completed prompt. Discovery envelopes are exact version-1 `request`/`addDiscovery` objects with `{thoughtId,why,evidenceThoughtIds}`. Final replies are exact version-1 `search-reply` objects with `{reply,disposition,sourceThoughtIds}`; disposition is `awaiting-user` or `done`. Unknown/duplicate fields, unsupported kinds, malformed/truncated output and duplicate citation IDs are rejected. The target and every cited/evidence thought need a currently eligible `run_context` thought full-read witness in **this run**; a response full read, snippet, human preview or another run's witness is insufficient.

Every publication rechecks the complete current exposure set, not only citations. It records all exposures as the new occurrence/reply's flattened dependencies, including uncited snippets and inherited context, and rechecks ownership/eligibility before committing. Observed unsafe run context interrupts the run, increments generation, records `context-invalidated`, releases its slot and retains pending cancellation **before reporting the fence**, without publishing an occurrence/reply. This remains a defensive read-time fence alongside the repository's rejection-event integration, not remote cancellation.

`addDiscovery` commits the immutable step receipt **before** inserting the matching occurrence (as required by its SQL guard), then dependencies and session/catalog activity in the same immediate transaction. A fresh request with an unremoved occurrence records `already-active` and preserves that entry's ID/rationale/order without activity or dependency rewrites. Otherwise it allocates a new occurrence at the tail across removed and unremoved entries, preserving the new proposal's rationale/evidence.

Before inspecting membership, replay resolves the exact owning step's confirmed `{type:'discovery-add',entryId,outcome}` receipt against its immutable original arguments and occurrence ownership. An already **processed** historical step may return this control fact under the same still-active current claim, binding, live session and whole-run eligibility fence, even after E1 was removed and E2 added. It gains no execution authority and changes no membership, prose, IDs, scheduling, dependencies or activity. A historical step without such a confirmed processed receipt cannot publish; stopped/failed/superseded claims cannot use a receipt to reopen authority. There is no caller-supplied alternate payload to replace the stored command.

`finalizeReply` inserts one immutable assistant message and its full exposure dependencies, updates session/catalog activity, and completes the run with an incremented generation/released slot atomically. Both dispositions end this run, not the saved session. It creates no fallback thought, library response, knowledge receipt or weave invitation. Interrupted/failed runs cannot finalize a late reply and their already confirmed occurrences remain retained. Stop/failure fences retain that search content; user-only public status/Stop use the search-specific control DTO.

### Initial configured search runtime

[`ConfiguredRunWorker`](../src/agent/configured-worker.ts) and the existing supervisor now include retained search runs. They reuse the same claim, immutable binding, exact-input preparation, submission, decoded-history correlation and observation engine as ordinary jobs; no second native journal exists. Each admitted user turn retains fresh prefixed native session/prompt identities, including clarification follow-ups. Search bindings must match that allocated native identity and deny all native permissions. The configured model's variant follows the turn's immutable quick/standard/thorough effort; no provider/service is started or upgraded.

[`search-initial-context.ts`](../src/storage/search-initial-context.ts) builds initial context in the claim's immediate transaction. Continue mode selects at most the latest 50 same-session messages through the admitted user message, in chronological order, with current dependency eligibility and content-free unsafe placeholders; restart mode includes only the current message. This is a model-input window, not a session-size or investigation quota. Complete dependencies of everything sent are added to `run_context` before input persistence/transmission, in addition to the full composer union inherited at admission. Starting IDs remain references (`full_read=0`); no library thought, connection or response full text is included by this first slice. Existing exposure rows are checked/monotonically updated rather than duplicated through an INSERT path forbidden by retained-search guards.

Every fresh context attaches the existing paired-clock helper's immutable request anchor and a current daemon preparation time. [`search-prompt-clock.ts`](../src/storage/search-prompt-clock.ts) now connects that helper to initial and normal capability-result preparation. Initial context retains `context.job.clockContext`; a due successor adds a root `clockContext`, separate from the confirmed capability result. Refresh is strictly after 3,600,000 elapsed milliseconds or on a detected backwards clock discontinuity, never a timer-driven model call, clock-only step or observation-poll effect. A fresh user turn still gets its own immutable request anchor. The time-conversion capability below independently resolves its explicitly selected eligible old intent; a refreshed observed-now cannot rebase that intent.

`ConfiguredWorkerDependencies.searchClock` and `WorkerDependencies.searchClock` accept optional trusted `SearchClockDependencies`: `{monotonicNow?:()=>number, latestObservation?:(owner)=>SearchClientClockObservation|null}`. The owner is derived from the current SQL claim and contains `{runId,generation,searchSessionId,nativeSessionId}`. A latest observation has exact `{searchSessionId,clock:{at,timeZone},daemonObservedAt}` fields; it must match that session, with a valid client calendar/zone/offset and canonical daemon receipt time. The runtime installs a synchronous, bounded process-local HTTP receipt provider; it rechecks the current run/generation and immutable run/session/native identity, with receipt arrival ordering independent of wall time. A claim may advance generation within the same run. Missing or evicted observations use the last retained report and its original receipt, age and apparent skew, not an invented fresh browser time. The provider is not a model tool or HTTP call; browser forwarding remains later work.

Elapsed time defaults to process-local `performance.now()` and can be injected independently of daemon `now`. The controller's at-most-128-entry lifecycle cache holds only clock/ownership metadata, keyed by run and checked against generation, native/session identity and current prompt. While retained in that controller, elapsed time uses its monotonic source. A restart/cache miss recovers only validated clock metadata from known paths in that run's immutable SQL inputs, bounded to the current step, using the run/step/turn mapping as source identity. It derives elapsed time from the retained daemon attachment time, then resumes monotonic accounting; absolute monotonic values are never reused across controller instances. The backwards read of the run's position index is a cold-cache operation, not a whole-transcript read on every poll, and does not load old prompt/query/native prose. Wall-clock reversal against the retained attachment or previous preparation forces a labeled attachment; client age is null when the daemon precedes its receipt.

Clock metadata becomes durable only with the exact prepared `run_steps.input`; cache state is remembered after persistence succeeds. Preparation of an already retained initial step and processed-successor replay never sample either clock or the latest-observation provider. Replay validates and reuses the successor's recorded clock bytes instead of generating a new observation. Lost acknowledgements/observation-only ticks continue with the existing immutable input and identity. Terminal/failure/stale-claim/missing-run handling and pause clear local timing state. Successful controller-backed local purge invokes the trusted `forgetSearchClock(runId)` hook without changing native identity or supplying cleanup proof. Cache eviction likewise changes no SQL state or prompt identity.

[`search-prompts.ts`](../src/agent/search-prompts.ts) advertises exactly nine implemented logical capabilities. [`domain/search-capability.ts`](../src/domain/search-capability.ts) validates the exact request union and [`domain/search-capability-result.ts`](../src/domain/search-capability-result.ts) validates retained results. [`storage/search-capability.ts`](../src/storage/search-capability.ts) dispatches only an owned current completed prompt under its active claim, live session, binding/native-completion proof and whole-run eligibility fence. It accepts no caller actor, alternate proposal, result, dependencies, session/run IDs, record timestamps or request keys. Interpreted date endpoints are query/conversion data, not metadata authority.

| Capability | Implemented arguments and result |
| --- | --- |
| `findThoughts` | All fields are explicit: `{query,authors,kinds,from,until,sort,limit,cursor}`. Query is nonempty text or null with a bounded UTC date interval and chronological sort; `until` is exclusive. Limit is 1–100 per page, not an investigation quota. It reuses the internal investigative facet and returns its narrow `{type:'page',items,nextCursor}` or `{type:'retrieval-changed'}` result. Every returned thought/response identity and destination thought is recorded as an exposure, never as a snippet-derived full-read witness. |
| `readThought` | Exact `{id}`. Returns `{type:'thought',thought}` with the fresh AI-normal Thought DTO, or `thought:null` for missing/unavailable targets. The returned target alone receives `full_read=1` in this run; visible parent/supporting-source references are exposures only. Rejected provenance is redacted and import source artifacts are not read. |
| `addDiscovery` | Exact `{thoughtId,why,evidenceThoughtIds}`. Calls the existing `SearchPublication.addDiscovery` in its own transaction, preserving completed-prompt ownership, current target/evidence full-read checks, the entire exposure fence, immutable control receipt and atomic occurrence/dependency/activity changes. No ordinary knowledge-operation receipt is created. |
| `relatedThoughts` | Exact `{thoughtId,relation,limit,cursor}`; relation is `connections`, `children`, `parent`, `sources` or `responses`, limit 1–100. Delegates to the existing direct bounded relationship facet. Returns `{type:'related',thoughtId,relation,items,nextCursor}` or typed `retrieval-changed`; items are references, with direction/category for connections. Starting thought, returned records and visible endpoints become exposures, never full reads. No recursive expansion occurs. |
| `readConnection` | Exact `{id}`. Returns `{type:'connection-read',connection}` or null, using the existing AI-normal connection policy through a targeted lookup. Rejected connections/endpoints are unavailable; rejected supporting-source IDs are redacted. Only the connection gets a full-read witness; endpoints and visible sources remain references. |
| `readResponse` | Exact `{id}`. Returns `{type:'response',response}` or null through the existing shared-response AI-normal policy. Any rejected member hides the entire shared response. Only the response receives a full-read witness, never its associated thoughts. |
| `readSearchConversation` | Exact `{beforePosition,limit}`, with null for the latest page and limit 1–200. Returns `{type:'search-conversation',messages,nextBeforePosition}` in descending original message position; the continuation is exclusive. Only currently eligible SQL messages in the owning session are included. Each message carries `intentTurnPosition` for its owning user turn, distinct from interleaved message `position`; `role` identifies actual user messages. Entire flattened dependencies, including uncited sources, become run exposures, not thought full reads. No user-history fallback or composer token exists on this port. |
| `listDiscoveries` | Exact `{afterPosition,limit}`, with null for the first page and limit 1–200. Returns `{type:'discoveries',items,nextAfterPosition}` in increasing occurrence position. Only nonremoved entries with currently eligible targets in the owning session are included. It reuses normal workspace projection: a safe target with unsafe rationale has `why:null`, no evidence IDs and `reasonStatus:'context-unavailable'`. Target/evidence and complete offered rationale dependencies are exposures only. |
| `normalizeTimeRange` | Exact `{intentTurnPosition,interpretation,from,until,timeZone}`. The private adapter selects an eligible user message/turn in the owning session, loads its immutable request clock and daemon admission time without reading old user prose, and rechecks all selected-message dependencies. Returns `{type:'time-range',range}` containing the existing calendar helper's UTC `[fromUtc,untilUtc)`, original endpoints/zone/interpretation, paired `requestAnchor`, selected position and `basis:'agent-interpretation'`. Explicit endpoint offsets must match the IANA zone/calendar, including DST folds/gaps. It neither parses natural language nor confirms user intent, refreshes clocks or assigns record timestamps. Missing/unsafe selectors fail closed. |

Read/search results and their exposure/full-read witnesses commit together in `run_steps.result_json`. Cached results require current ownership, current whole-run visibility and matching durable record-kind witnesses through [`storage/search-capability-result.ts`](../src/storage/search-capability-result.ts). The private [`search-capability-context.ts`](../src/storage/search-capability-context.ts) derives session ownership only from the run's retained turn mapping. Cache validation reads identity/dependency/eligibility metadata, not source prose: it rechecks same-session message/turn mapping, current occurrence membership/rationale eligibility, and the selected immutable time anchor. Replay neither reruns retrieval/projections nor adds IDs, witnesses or activity. A removed cached list occurrence fails closed rather than becoming live membership or retrying that unusable page forever. The separate `addDiscovery` replay still returns only its existing immutable control receipt, never reconstructed membership. Publication remains outside the dispatcher's preflight transaction so a committed context fence is not accidentally rolled back by an outer transaction. Targeted connection/response adapters in [`search-library-read.ts`](../src/storage/search-library-read.ts) reuse the existing domain scope policies without a whole-library rejection snapshot.

Search-only `advanceSearch` reads the confirmed request/result from the journal and derives the exact successor input itself: callers supply only a lazy next-prompt identity source, not result/input bytes. Fresh search advancement additionally requires the trusted clock controller installed by the worker; that controller contributes only validated clock metadata. It uses the same successor append primitive as ordinary advancement, marks the prior step processed and creates a new prefixed message ID with unknown native state atomically, including any due clock attachment in the new input. A matching processed retry returns its existing successor without allocating another ID or resampling a clock. Steps within one run share that run's native session; later user turns do not. No clock update rewrites an already prepared/submitted input or its capability result.

Only strict `search-reply` completion finalizes an assistant message, with both dispositions routed through the existing publication transaction. Generic ordinary capability dispatch, knowledge/title/development/connection writes, library replies, import-source authority and arbitrary generic prompt preparation/advancement remain denied to search. Ordinary runs retain their shared `readThought`/`readConnection`/`readResponse` capabilities but cannot complete search-only requests or search replies. Unsupported or malformed requests, unavailable time anchors and missing full-read publication evidence fail closed through the worker's failure path; no fallback thought/reply is manufactured. `retrieval-changed` is instead a normal typed result inviting a fresh query, not failure or a model-cost budget. Failure/Stop records its terminal outcome/generation and releases the active slot while retaining the user message and confirmed discoveries. Nine logical capabilities, clock preparation and cleanup do not imply browser integration or complete recovery/race proof; public Delete uses the explicit retention controller above.

The execution guard checks live session/turn ownership, current generation/prompt, binding identity and whole-run source eligibility before/after native boundaries. Runtime-created workers additionally receive the actual [`ExecutionOwnerLease`](../src/storage/execution-owner.ts), which checks the held private SQLite sidecar and canonical file identities around native calls; ordinary/import permissions and claim checks remain separate. The sidecar remains a separate lifecycle resource; its [immutable knowledge-DB registry](#execution_owners) attributes search setup/submission, not remote settlement by itself. Configured service preflight enters the existing coalesced run lane, now including the [retained cancellation tail](#retained-search-cancellation). Runtime shutdown joins handlers and final run/cleanup/import/shared-resolver flights before knowledge DB then sidecar closure. Generic ordinary settlement still rejects search; only the qualified search cleanup path may settle it. Public search run status/Stop use a separate scoped search projection, not the ordinary run projection.

**Default no-controller deletion fails closed with `native-cleanup-required` before any write** if a session has a binding, a cleanup row, possible submitted/uncertain execution or a missing/dispatch-marked initial journal. An unbound run must retain only its matching initial `prepared`/`unknown` step, with no submission owner, envelope, result or later step, `cancellation_state='none'` and no submitting/running/uncertain run status. Terminal local status alone does not establish native absence. Bound local purge instead requires the [explicit retention capability](#explicit-search-retention-and-purged-cleanup); retained cancellation settlement alone does not change the default facet's authority. Neither path fabricates settlement or remote-erasure claims.

## Search indexes and vocabulary cache

Core migration creates these derived FTS5 virtual tables:

| Table | Columns |
| --- | --- |
| `thought_search_fts` | `thought_id UNINDEXED`, `text`, `title` |
| `response_search_fts` | `response_id UNINDEXED`, `text` |

Title metadata insert/update/delete triggers maintain thought index entries. Every supported thought creation includes its title metadata row, even when untitled. A response-insert trigger indexes retained reply text. Migration rebuilds both indexes from canonical records on each open; existing thoughts and replies are backfilled without changing their content.

For media roots, the thought index's `text` column contains exact clarification or an empty indexed body when absent, not `thoughts.text`. Only clarification and explicit title metadata enter FTS/spelling vocabulary. Filename fallback, MIME, IDs, request keys, digest, binary content and extraction output do not enter the corpus unless wording is deliberately recorded as a title. This does not create an empty or invented thought body. Title updates/clears and migration reindexing retain this rule.

Indexes include rejected records. Scoped retrieval applies rejection rules in SQL before returning text or selecting a reply's latest eligible association. AI access excludes an entire shared reply if any associated thought is rejected. Retained interrupted fallback replies remain searchable through their eligible associated input; this does not promote unfinished output to a completed development.

`search_revision(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL)` contains one row, initially `(1,0)`. Triggers increment it transactionally for title metadata insert/update/delete, response insert, response-association insert/update/delete, and thought rejection/restoration. Thought text is immutable; connections are not part of this search corpus.

Suggestion vocabularies use connection-local temporary FTS5 and spellfix1 tables, separated into AI, normal-user and user-inspection scopes. An unchanged revision reuses the vocabulary. A changed revision rebuilds that scope's vocabulary from eligible text and titles in a consistent transaction, including changes committed through another connection. These temporary tables are not durable knowledge or public API tables.

## Constraints and access boundaries

Migration enables `PRAGMA foreign_keys = ON` and verifies it, and also enables `PRAGMA recursive_triggers = ON` for the connection. Primary-key and unique constraints create their supporting indexes.

SQL constraints and triggers protect persistence invariants; they do not replace service authorization or scoped reads. Raw storage access is internal. Future agents and routes must use the domain services to exclude rejected thought content, ancestry, sources, connections and responses appropriately.

Direct SQL creation is not the supported write boundary. For ordinary textual thoughts, bypassing `saveThought()` can omit title metadata or leave a source set unsealed; media sources additionally have the deferred title/seal requirements above. Do not populate application data by inserting partial rows manually.

## Migrations

The daemon calls `migrate()` on opening its database. Bootstrap and schema changes run in an immediate transaction and are safe to repeat; the implementation currently uses schema inspection, not a separate migration-version table.

For the legacy schema with `thoughts.title`, migration:

1. Creates the current tables and triggers if absent and seals source sets for existing thoughts.
2. Detects the old title column with `PRAGMA table_info(thoughts)`.
3. Copies each title into `thought_titles`, assigning a non-null legacy title the original thought's author as title attribution. Untitled rows retain null title/author.
4. Drops the old title column, leaving metadata as the authoritative title source.

For legacy responses with a single `responses.thought_id`, migration adds a `complete` state, copies that owner into `response_thoughts` at position `0`, creates its seal, and drops the old owner column. Current records use the association table as the single ownership source.

Subsequent opens do not recopy cleared titles or response associations. Existing identity, text, authorship, dates, ancestry, sources, connections, rejection state and responses are preserved. [Migration tests](testing.md#controlled-inputs-not-production-assumptions) exercise populated legacy fixtures and reopen behavior.

Core migration also initializes run storage; callers do not need a separate run-repository initialization step. Older run schemas gain missing input/cancellation fields without guessing an Evolve input. An unmapped legacy Evolve run cannot safely resume. Existing initial prompt identities and native evidence move into step zero with unknown input; the old run-level `native_state` column is removed. Previously interrupted runs receive pending cancellation settlement when that field is introduced. When issued membership is first introduced, existing receipt rows are backfilled in their persisted insertion order, not sorted by identity or timestamp. Repository migration delegates to the same authoritative core path.

Back up valuable data before upgrading and stop the daemon before replacing a disposable database. Automatic weaving is enabled only by explicit server-side agent configuration; schema migration itself does not call a model.

Receipt migration rebuilds the receipt/issued-membership pair together to permit typed non-thought results, preserving legacy requests, results and issued positions. Foreign-key enforcement remains enabled throughout the core migration transaction. Legacy weave subject/trigger fields remain null; migration does not infer a subject from surrounding data.

After predecessor upgrades, import migration stages the complete incoming FK closure of `thoughts`, `runs` and `run_steps`, drops children before parents, recreates the widened tables and restores rows with their original rowids. Cross-table triggers are suspended during copying, then restored with the original indexes; FKs remain enabled throughout. Both sides of the new document/seal cycle exist before copying rows. `foreign_key_check` must be empty before commit, and `foreign_keys=ON` is verified afterward. Existing thoughts receive null import membership; no source bytes, imports, titles, ancestry or native histories are inferred or reset.

Search migration runs afterward in the same authoritative transaction. It captures the actual current `runs` DDL and changes only its kind CHECK, preserving import-era constraints and the allowance for unmapped legacy Evolve input. It stages the complete incoming run-FK closure, including import-file/payload and execution descendants, preserves rowids, drops children before parents and restores their captured table/index definitions. Cross-table triggers are suspended only during migration copying, then restored; only the six named search-purge guards are intentionally replaced. It adds nullable `submit_owner`, the separate search tables and supporting indexes, and requires an empty `foreign_key_check` before commit. FK enforcement stays on, and failure rolls back schema, data and trigger work. Reopening does not backfill sessions, infer native ownership, reset existing histories or reset search revision counters.

Execution-owner migration follows those predecessor upgrades in the same transaction. It creates the immutable registry and adds `agent_bindings.execution_owner_id TEXT REFERENCES execution_owners(id)` only when absent, with its null default and a separate owner-update guard. This addition uses `ALTER TABLE ADD COLUMN`, not another run/knowledge closure rebuild, and retains existing rows/rowids, submission strings, indexes and unrelated trigger definitions. `foreign_key_check` must remain empty; failure after registry creation rolls the entire migration back. Schema inspection, rather than a numeric migration version, determines the upgrade. Migration itself creates no owner records and does not qualify any legacy binding/submission; only subsequent actual held-lease registration supplies new runtime provenance.

Cleanup journal migration then runs through [`search-cleanup-migration.ts`](../src/storage/search-cleanup-migration.ts) in that same transaction. To make `submit_owner` nullable and add `prompt_manifest_json`, it stages/rebuilds **only** the leaf cleanup control table, preserving original rowids and every old field; new manifest values for old rows remain null. It restores unrelated cleanup indexes/triggers verbatim and deliberately replaces only its named cleanup guards. Other tables, incoming run/knowledge closures and their guards are not rebuilt for this addition. Unexpected incoming cleanup FKs or unknown cleanup columns fail closed rather than silently expanding or discarding data. FKs remain enabled and are checked before commit; an injected failure after actual manifest-table creation rolls back schema, rows and guards. No cleanup/native evidence is inferred during migration.

Media migration follows through [`media-migration.ts`](../src/storage/media-migration.ts). When `thoughts.text` is still `NOT NULL`, it stages the complete incoming thought-FK closure, including unknown referencing tables, with original rowids/data, captured table/index/trigger SQL and AUTOINCREMENT high-water values. Backedges are visited rather than rejected. FK enforcement stays ON; `PRAGMA defer_foreign_keys=ON` defers row checks until the outer transaction commits. Cross-table triggers are temporarily removed, tables are rebuilt with the widened thought constraints, and all table definitions and explicit key indexes exist before row restoration. Original triggers and sequence values are restored afterward. Existing Markdown document membership, source seals, bytes and execution/search histories are not rewritten into media records. The migration neither edits `sqlite_schema` nor disables FKs.

The same transaction creates missing media metadata tables, installs association/immutability guards and rebuilds clarification/title FTS projections. A development-schema cleanup preserves core thoughts, runs, exact step inputs/envelopes/results, bindings and source/file metadata while removing unused media-specific execution structures. Affected active runs are interrupted with a generation increment and pending cancellation; saved prompts are not reinterpreted or resumed, and unresolved native work is not marked settled. `foreign_key_check` must be empty; failed DDL/copy/commit rolls back the enclosing migration. Repeated migration/reopen preserves retained data. Migration never allocates a media identity, backfills source associations, touches the filesystem or submits agent work. See the [controlled preservation checks](testing.md#media-source-domain-and-persistence-checks) and [admission checks](testing.md#media-admission-and-lifecycle-checks).
