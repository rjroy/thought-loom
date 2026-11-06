# Database schema

[Start here](../README.md) · [Daemon API](daemon-api.md) · [Server startup](server-startup.md)

Thoughtloom uses SQLite through Bun's built-in `bun:sqlite`. The authoritative migration starts in [`src/storage/sqlite.ts`](../src/storage/sqlite.ts); import definitions and the FK-closure rebuild live in [`import-schema.ts`](../src/storage/import-schema.ts) and [`import-migration.ts`](../src/storage/import-migration.ts). The separate [agentic-search foundation](#agentic-search-storage-foundation) has its own schema/migration helpers and an internal user-only lifecycle facet, not search-session HTTP or agent execution. Public import access is documented in the [daemon API](daemon-api.md#markdown-import-and-source-inspection).

## Model and relationships

- A thought is an immutable piece of recorded thinking. A non-root thought has one evolution parent; roots have no parent.
- Titles are separate mutable metadata, returned alongside thoughts in ordinary reads.
- Conceptual connections are separate from evolution ancestry. They never become extra evolution parents or extend the scope of a branch operation.
- Source associations record supporting provenance. Their position preserves the order of each source list.
- Rejection is presence in a separate state table, not deletion or modification of the recorded thought.

Database names use `snake_case`; the [API](daemon-api.md#response-records) uses `camelCase`.

## Tables

Unless marked nullable, columns below are `NOT NULL`. Every listed foreign key references the identified parent row. Library tables do not cascade deletion; the owned search-metadata cascades are identified separately below.

### `thoughts`

| Column | Type | Constraint / meaning |
| --- | --- | --- |
| `id` | `TEXT` | Primary key; assigned by the daemon's creation command. |
| `text` | `TEXT` | Recorded wording. |
| `author` | `TEXT` | Check: `user`, `ai`, or `source` (imported wording; original author unverified). |
| `kind` | `TEXT` | Check: `captured-original`, `user-contribution`, `ai-interpretation`, `developing-idea`, or `imported-original`. |
| `created_at` | `TEXT` | Daemon-generated UTC ISO timestamp. SQLite itself stores text rather than enforcing timestamp syntax. |
| `origin` | `TEXT` | Provenance label. Current HTTP creation commands use `capture`, `contribution`, or `development`; this column is not a SQL enum. |
| `parent_id` | `TEXT`, nullable | Foreign key to `thoughts.id`; a check forbids self-parenting. |
| `import_document_id` | `TEXT`, nullable | Internal FK to `import_document_seals.document_id`, `DEFERRABLE INITIALLY DEFERRED`; present exactly for imported originals. Not part of the ordinary Thought DTO. |

There is no title column in the current table. `BEFORE UPDATE` and `BEFORE DELETE` triggers abort mutations with an immutability error. Further development creates another thought rather than a revision of this row.

`source` and `imported-original` must occur together, with `origin='markdown-import'` and a null evolution parent. Supporting-source inserts are forbidden for imported originals; source membership is not `sourceIds`. All existing user/AI and non-import kind combinations remain valid. Ordinary `saveThought()` refuses imports instead of inferring a title author from `source`; the dedicated import writer owns their mapping and initial null titles. Later user/AI title edits and fills remain valid.

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

The HTTP API reads these records rather than accepting client-created responses. Configured Evolve execution creates them transactionally during local finalization. Response states describe retained output; run/step state and cancellation settlement are tracked separately.

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

## Durable execution tables

These tables are initialized by core migration through [`run-schema.ts`](../src/storage/run-schema.ts). Configured workers and public Evolve/status/Stop routes use the same run aggregate. Migration itself makes no model calls; with agent configuration present, the daemon supervisor can process supported queued jobs retained from an earlier run. SQL acceptance of the new `search` kind does not enable its execution.

### `runs`

| Column | Type | Constraint / meaning |
| --- | --- | --- |
| `id` | `TEXT` | Primary key; daemon-owned run identity. |
| `kind` | `TEXT` | SQL check: `weave`, `evolve`, `export`, `import`, or `search`. `RunKind` and runtime search support are not yet widened. |
| `status` | `TEXT` | Check: `queued`, `submitting`, `running`, `uncertain`, `completed`, `interrupted`, or `failed`. |
| `session_id` | `TEXT` | Unique, stable external session identity. |
| `prompt_id` | `TEXT` | Unique, immutable initial external prompt identity. Later prompt identities live in `run_steps`. |
| `created_at` | `TEXT` | Creation timestamp. |
| `generation` | `INTEGER` | Nonnegative claim generation used to fence stale owners. |
| `input_thought_id` | `TEXT`, nullable | Foreign key to the admitted user contribution; required exactly for new `evolve` runs and null for other kinds. |
| `weave_subject_id` | `TEXT`, nullable | Foreign key to the thought being woven; paired with the trigger identity and permitted only for weave runs. |
| `weave_trigger_id` | `TEXT`, nullable | Immutable trigger identity; legacy weave intent remains unknown rather than inferred. |
| `cancellation_state` | `TEXT` | `none` (default), `pending`, or `settled`; remote cancellation settlement is distinct from local interruption. |

Identity, kind, initial session/prompt identities, creation time and input identity are trigger-protected. Deleting runs is blocked except for the [narrow tombstoned-search purge](#search-retention-and-purge-guards); other run kinds remain protected. Search input and weave-subject fields must be null. Status and generation remain mutable through guarded repository operations, not arbitrary model instructions. The internal `RunRecord.promptId` and `nativeState` project the current ordered step, rather than duplicating its native completion evidence in `runs`.

Evolve contribution creation and run admission commit together. The persisted input link identifies the exact contribution after restart and constrains where the run may add developments. A claim contains the run ID and generation. Claims currently have no time-based expiry; this is ownership fencing, not a model-runtime or effort quota.

### `run_steps`

| Column | Type | Constraint / meaning |
| --- | --- | --- |
| `run_id` | `TEXT` | Foreign key to `runs.id`. |
| `position` | `INTEGER` | Nonnegative step order; composite primary key with `run_id`. |
| `prompt_id` | `TEXT` | Globally unique, immutable daemon-owned prompt identity. |
| `input` | `TEXT`, nullable | Exact immutable input; null only until prepared or when legacy input is unknown. |
| `state` | `TEXT` | `prepared`, `submitting`, `uncertain`, `completed`, or `processed`. |
| `native_state` | `TEXT` | `unknown`, `running`, or `completed`, local to this step. |
| `envelope_json` | `TEXT`, nullable | Validated canonical request/completion envelope. |
| `result_json` | `TEXT`, nullable | Confirmed capability result, retained before advancement and reused for eligible replay. |
| `submit_owner` | `TEXT`, nullable | Search submission process identity. Migration leaves existing rows null; it never infers an owner for unknown history. |

Triggers enforce append order, immutable identities/input, durable completion, and immutable recorded envelopes/results. A run insert creates step zero. Preparation records its exact input once; migration never invents missing legacy input. A completed capability step can retain its confirmed result before advancement. Advancing atomically verifies or records that result and creates the successor's exact input and identity. Matching replay reuses that successor; a mismatch conflicts. Every successor begins with its own unknown native state.

The new owner guard permits a one-time `submit_owner` assignment only on an existing prepared search step becoming `submitting`, with non-null exact input, unknown native state, a live mapped session and an existing binding. Inserts cannot preassign it, and non-search steps cannot acquire it. This is a storage guard for later search submission integration, not an implemented search dispatcher.

Protocol input is one strict version-1 JSON request or completion envelope. Duplicate keys, extra fields, unsupported versions, model-supplied operation IDs and malformed/truncated output are rejected. Machine envelopes are not retained conversational replies. Async acknowledgements are bound to the original prompt and cannot change a successor step.

Import step zero has a separate private storage contract. Preparation saves a canonical version-1 `import-job` containing the unchanged decoded document, validated parser manifest, fixed segmentation instructions and an empty capabilities list. The manifest uses scalar-aligned UTF-8 byte ranges, ordered complete atoms and `b0` through `bN` cut IDs. The parser is responsible for Markdown/dependency safety; storage independently checks byte/range coverage and matches the chosen manifest against that exact prepared input.

A write-once `result_json` with `type:'import-partition'` is allowed only for its owning pending import file's initial step. It retains the validated partition, source fingerprint and private never-submitted/terminal evidence. Choosing increments the run generation and ends initial-source access; if a native binding exists, it also retains pending cancellation independently of file completion. A genuine terminal completion records completed native/step state; a failed terminal observation does not fabricate successful native completion. Only validated AI segmentation gets a `segmentation` envelope; structural choices may retain no envelope. Ordinary runs retain their previous result/envelope requirements. Generic protocol, binding, capability, knowledge-write and context paths reject import authority; the ordinary worker and supervisor deliberately do not dispatch import runs. The separate import worker handles restricted native execution and the same local finalizer used without an agent.

Stop fences local execution before remote cancellation settles. Pending settlement remains durable even after local interruption; marking cancellation settled never restores execution authority. A binding alone is not evidence of submission: an untouched initial step proven never submitted can settle locally without native cleanup. Submitted steps and ambiguous legacy history still require reconciliation. Configured workers process these steps through the daemon-owned supervisor.

### `agent_bindings`

| Column | Type | Constraint / meaning |
| --- | --- | --- |
| `run_id` | `TEXT` | Primary key and foreign key to `runs.id`. |
| `session_id` | `TEXT` | Unique native session identity bound to the run. |
| `service_url`, `directory` | `TEXT` | Selected service and native location. |
| `model_json` | `TEXT` | Explicit provider/model/variant reference. |
| `permissions_json` | `TEXT` | Bound deny rules. |
| `protocol_version` | `INTEGER` | Check: `1`. |

Update triggers make bindings immutable; deletion has only the narrow tombstoned-search exception described below. No service credentials or authentication headers are stored. Binding is permitted only before the initial native submission; recovery cannot infer a new binding for an already-submitted unbound run. Internal run reads project the bound native session while preserving the initial allocated identity in `runs`.

Imports have explicit trusted storage methods, not a mode flag on ordinary binding: `bindImport` requires the active pending holder and its prepared private initial input; `assertImportPreparation` fences session setup and preflight to that never-submitted input, and `recordImportSubmission` records intent immediately before the exact bound prompt is sent. These storage methods make no network calls. `assertImportOwnership` is read-only and additionally requires persisted import kind, current generation, a pending owning file, no library context or knowledge receipts, the exact immutable prompt sequence and recorded submission intent. `recordImportObservation` retains only existing nonterminal native vocabulary; terminal facts enter storage atomically with the chosen partition. Shared source/input validation checks staging bytes against their receipt and the prepared document/manifest. Stop, settlement, a newer generation or a durable partition choice revokes dispatch/observation authority. A separate fenced cancellation gate permits only cleanup of completed, failed or interrupted imports with pending cancellation; it does not reopen source access.

`OpenCodeAdapter.observeImport` requires that repository guard before/after native reads. Production callers use distinct ordinary/import local fences (`AdapterFences`); local pause checks cannot replace persisted authority. The observer shares session/binding checks, paginated history reading and prompt/context/inbox correlation with ordinary observation, but not its terminal classifier or phase transitions. Owned failed/interrupted idle tails produce `terminal-failure`; complete error-free successful tails produce `terminal-completion` with exact output, including empty/whitespace/non-stop output for later segmentation validation. Unknown/incomplete history remains nonterminal. No canonical result is written by observation.

The private `ImportTerminalEvidence` carries `sessionId`, `promptId`, `inputSha256`, user/assistant/idle message IDs, typed idle outcome, nullable completion time/finish, assistant/idle error booleans, and UTF-8 output byte length/SHA-256. Before retaining either terminal result, storage checks the bound session and exact prepared prompt/hash; `userMessageId` must equal that persisted prompt ID, which is the native user-message identity used by submission and history correlation. Storage validates these known persisted identities, not independent proof of unpersisted provider facts; the observer establishes native terminal correlation. The witness contains no raw provider exceptions. These terminal states never enter the ordinary `NativePhase` callback; ordinary failure/error/empty-output semantics remain unchanged.

Adapter authorization checks ownership, context visibility and exact persisted prompt bytes in short transactions before crossing the native boundary. Submission is recorded before dispatch, so an ambiguous acknowledgement cannot justify resending after restart merely because native inbox/history reads are empty. Foreign or conflicting native input quarantines the run. Binding verification and ordinary paginated history establish ownership and output correlation; live event delivery alone is not recovery evidence.

### `run_context`

| Column | Type | Constraint / meaning |
| --- | --- | --- |
| `run_id` | `TEXT` | Foreign key to `runs.id`. |
| `kind` | `TEXT` | Check: `thought`, `connection`, or `response`. |
| `ref_id` | `TEXT` | Referenced identity; polymorphic, so not a declared foreign key. |
| `full_read` | `INTEGER` | Durable full-read distinction; defaults to false for legacy exposure rows and may only be upgraded. |

Composite primary key: `(run_id, kind, ref_id)`. The repository checks AI visibility before recording exposed context and revalidates it when authorizing submissions, reads, writes and cached-result delivery. A shared reply becomes ineligible if any associated thought is rejected. Full-read evidence is monotonic; a candidate snippet or a referenced ID alone does not prove that the model read the thought's full text.

The scoped capability dispatcher returns narrow search candidates and AI-scoped thought, connection or response reads. It records every exposed reference, but does not upgrade indirectly referenced IDs to full-read witnesses. Connections and supporting sources require the appropriate full reads before a write. Model requests cannot select user authority, run/operation identity, authorship or timestamps, and cannot reject/restore notes or access raw SQL/files. Capability effects, exposure evidence, typed receipts, issued membership and the confirmed step result share the aggregate transaction. A Stop or rejected exposed reference fences replay as well as new work.

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

A title-only or no-findings weave can complete without creating a conversational response. Failure retains confirmed knowledge changes and eligible interrupted drafts, fences later callbacks, and keeps pending remote cancellation settlement available.

### Durable weave scheduling

When the scheduling port is enabled, capture, an explicit user title-clear on an eligible active note, and successful Evolve finalization admit a follow-up weave inside the triggering transaction. Capture uses `capture:<thought-id>`; each eligible title-clear has a daemon-generated invitation ID; Evolve uses `evolve:<run-id>` and selects its last issued development or contribution fallback. Clearing an already absent title on an eligible note is still a new regeneration invitation; clearing a rejected note's title is not. Worker finalization uses the same scheduling path as direct run finalization.

Admission reuses the first recorded subject/trigger match without resetting its status or results. A lookup index and insert trigger prevent future duplicates. Migration preserves legacy duplicate jobs and their histories rather than deleting or cancelling them. Network availability and agent configuration are outside these transactions. AI title fills, weaver interpretations, connection writes and interrupted replies do not recursively schedule more weaving.

The import writer admits one ordinary weave per imported thought with trigger `import:<document-id>:<ordinal>` in the same transaction as the canonical file. No model runs inside that transaction. Empty/metadata-only imports admit no thoughts or weaving.

### Agentic export artifacts

These subordinate tables reuse run identities and claims; they are not another execution journal:

| Table | Columns and constraints |
| --- | --- |
| `export_intents` | `run_id` primary key/FK to `runs`; nonempty `request`; `effort` is `quick`, `standard` (default), or `thorough`. Insert requires an export run. |
| `export_reports` | `run_id` primary key/FK to `export_intents`; `prompt_id` identifies its completed report step; nonempty `markdown`; `sources_json` holds validated attribution. |

Insert/update/delete guards prevent replacement or mutation of stored intents and reports. Legacy export runs remain without an intent rather than receiving an invented request. Finalization validates the persisted version-1 report envelope, full-read source witnesses, current source eligibility and all exposed run context. Report insertion and local completion commit together; Stop, rejection or stale ownership fences publication.

The report preserves model Markdown and appends validated source thought IDs, title/fallback, immutable thought author and material kind. This validates citation structure and eligibility, not the truth of the model's connective conclusions. Historical artifacts are deliberately user-only: they are not thoughts, conversation responses, search-index entries or AI-readable context. Artifact and run-state writes do not grant knowledge-write authority. The existing worker/supervisor executes export runs; immutable intent selects the configured effort variant before binding, and user routes admit and download reports through scoped application services.

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

## Agentic search storage foundation

Implemented code is split between [`search-schema.ts`](../src/storage/search-schema.ts), [`search-migration.ts`](../src/storage/search-migration.ts), the domain contracts/service in [`domain/agentic-search.ts`](../src/domain/agentic-search.ts), and [`search-sessions.ts`](../src/storage/search-sessions.ts). This is a partial foundation: schema, structural guards, metadata/history lifecycle, blank composers, ledger-aware individual message reads, atomic turn admission, trusted discovery/reply publication and user occurrence removal exist. Full normal workspace reads, transactional rejection-event invalidation, native execution/cleanup, HTTP and client integration remain unimplemented. Ordinary Search and Agentic export keep their existing contracts.

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
| `search_revisions` | Singleton `id=1`; nonnegative `eligibility`, `retrieval`, `catalog`, initially zero. Guards prevent deletion, replacement and decreasing counters. Lifecycle commands maintain `catalog`; library eligibility/retrieval invalidation is not yet wired to the other counters. They are distinct from the existing spelling `search_revision`. |
| `search_native_cleanup` | `run_id` primary key **without a run FK**, allowing evidence to outlive a purged run; `session_id` FK to `search_sessions.id`; JSON-valid `binding_json`; `last_prompt_id`, `submit_owner`; `drain_state` (`waiting`, `drained`, `unknown-after-restart`); `admission_state` (`never-submitted`, `uncertain`, `admitted`, `terminal`); nullable 32-byte BLOB `prompt_sha256`; nullable JSON-valid `evidence_json`; `state` (`pending`, `settled`, `ownership-conflict`). |

`search_discoveries_one_unremoved` is a **partial** unique index on `(session_id,thought_id) WHERE removed_at IS NULL`; `search_discoveries_visible` indexes live occurrence order. Removed occurrences remain immutable history. A different completed add step may therefore insert a new ID, rationale and tail position for the same thought; it never clears an earlier occurrence's removal. The internal publication and fixed-ID removal methods below implement that transaction boundary without enabling a native dispatcher.

Supporting source lookups use `run_context(kind,ref_id,run_id)`, `response_thoughts(thought_id,response_id)` and indexes beginning with each connection endpoint. Migration checks existing full indexes before adding equivalent coverage.

### Search retention and purge guards

Turn insertion requires a live session and a `search` run with no thought/weave input; its slot must match the run's active/terminal status. Terminal status releases the slot, and a terminal search run cannot reopen. Identity, intent, message text/role/evidence, occurrence rationale/order and source dependencies are immutable while retained. Replace paths are guarded as well as updates/deletes. Occurrence removal is write-once; composer coverage cannot shrink while active, and consumed/invalidated/discarded contexts cannot reset to active. Consumed/discarded dependency cleanup is allowed without resetting their context identity.

A discovery insert must match its own run's completed `addDiscovery` request and confirmed `discovery-add`/`added` receipt, including entry ID, target, rationale and evidence JSON. This SQL correlation is **not** dispatcher authorization, exact domain-intent validation, current eligibility or full-read proof. Raw SQL checks JSON syntax; the separate domain admission command validates the versioned turn intent. Search inserts into library reply bookkeeping, knowledge-operation receipts and issued-thought membership are denied; import/export ownership guards remain in force.

Six existing delete guards have deliberate search-only exceptions: `runs_immutable_delete`, `run_steps_immutable_delete`, `run_context_immutable_delete`, `agent_bindings_immutable_delete`, `run_receipts_immutable_delete` and `run_issued_immutable_delete`. Each requires an extant run of kind `search`, its retained turn mapping, and that mapping's owning session with non-null `deleted_at`. Neither an arbitrary tombstone nor a supplied session ID grants purge authority. Non-search and live-session execution remain undeletable; library immutability is unchanged.

Purge removes content dependencies before their messages/discoveries, composer dependencies before composer rows, and execution children before runs. The run deletion guard checks the retained mapping before the FK cascade removes the now-empty turn. Direct turn deletion while its run exists is blocked, preventing loss or reassignment of the ownership proof. The session row cannot be deleted or revived: its title-free tombstone retains only identity, creation key, times, revision and deletion marker.

Cleanup rows are reserved for **non-content** binding/owner/prompt/hash/phase evidence, never prompt text, output, rationale or raw provider errors. Insertion requires the retained tombstoned search owner and a prompt belonging to that run. Identities/hash cannot be rewritten; phase evidence cannot regress; unsettled cleanup cannot be deleted. A hash is required except for `never-submitted`; terminal admission requires evidence; `settled` additionally requires `drained` and either never-submitted or terminal admission. These are structural constraints, not proof of remote events or a validator that arbitrary JSON contains no prose. No native cleanup producer, observer or settlement loop is implemented yet.

### Internal session lifecycle

`SqliteStore.searchSessions({id,now,logger?})` exposes the typed user-only service below. It uses injected daemon IDs and canonical UTC timestamps; callers cannot assign record metadata. This facet is not an HTTP route or an agent capability.

| Method | Implemented contract |
| --- | --- |
| `create(actor,requestKey,{})` | Returns `{session,replayed}`. The exact payload is empty; keys use `[A-Za-z0-9._:-]{1,128}`. New sessions have neutral `Search — YYYY-MM-DD` titles and revision zero. Matching create-key replay returns current metadata without allocating another ID, sampling a new record time or changing activity. A deleted key returns `session-deleted`, never resurrection. |
| `list(actor,{limit?,cursor?})` | Returns `{items,nextCursor}` of live metadata only, ordered by last activity then sequence descending. Default limit 50, maximum 200. Strict typed cursors bind collection, user scope, fixed order, limit, membership high-water, last sort key and catalog revision. A changed catalog returns `list-changed`; limits/unknown fields and cross-contract continuations are rejected. Transport authentication of cursors remains future HTTP work. |
| `get(actor,sessionId)` | Returns live session metadata or null for missing/deleted sessions. No conversation, native binding or active-run DTO is returned. |
| `rename(actor,sessionId,expectedRevision,{title})` | Requires exactly a nonempty title and a nonnegative safe revision. A stale revision returns `revision-conflict`. An actual change updates title, activity, session revision and catalog revision atomically; an identical title is a no-op after revision validation. This is the internal comparison, not an implemented HTTP `If-Match` handler. |
| `history(actor,sessionId,{messages?,discoveries?})` | Returns `{scope:'history',session,messages,discoveries}` with independently bounded `{items,nextCursor}` collections. Each collection accepts `{limit?,cursor?}`, default 50/maximum 200, with session/kind/history-scope/limit-bound position cursors and a fixed membership high-water. Exact retained messages and removed occurrences remain deliberate human history, with current eligibility indicators and current thought title/fallback metadata. No composer token is issued and this read is never AI context. |
| `delete(actor,sessionId)` | Missing sessions fail; known tombstones replay without activity. The currently supported local-only case fences owned generations, interrupts active local runs, invalidates active composers, writes the tombstone and purges owned content transactionally. Library records and unrelated runs are not deleted. |
| `openComposer(actor,sessionId)` | Creates a daemon-owned blank active composer and returns `{composerId,contextToken,eligibilityRevision}`. It copies no previous ledger or draft, starts no run and does not bump session activity. |
| `offerMessage(actor,sessionId,composerId,messageId)` | Reads one existing same-session message through normal eligibility and records all offered source dependencies before returning `{composerId,contextToken,eligibilityRevision,sessionRevision,message}`. Unsafe message text is a placeholder (`text:null`, empty evidence); deliberate `history` output is not a fallback. |
| `admitTurn(actor,sessionId,requestKey,input)` | Atomically admits a validated fresh request or exactly replays its receipt. Returns control-only `{receipt,run,session}`, never submitted/recovered message text. Details below. |
| `turnByKey(actor,sessionId,requestKey)` | Returns that same control-only view for an existing admitted key, or null for an absent/deleted session or key. It does not submit work or read conversation for display. |
| `removeDiscovery(actor,sessionId,entryId)` | User-only removal of this occurrence, never “whatever entry has this thought ID.” First removal writes its daemon timestamp and updates session/catalog activity; a retry is a no-op without sampling another time or affecting a later rediscovery. Missing/foreign entries fail. No library rejection or deletion occurs. |

All session-facet methods reject AI actors. Create, changed rename, fresh turn admission, confirmed discovery additions, final replies, first occurrence removal and first successful deletion update catalog membership/order metadata; reads, composer opening, identical-title renames and command replays do not. History uses current thought/connection/response dependency eligibility, including exclusion of a shared response if any member is rejected, but retains exact prose for the user rather than presenting it as safe normal content. Publication is a separate trusted claim-bound facet, not actor-selected authority on this user interface.

### Composer and turn transactions

[`search-composer.ts`](../src/storage/search-composer.ts) extends a draft's persistent dependency union before returning eligible message prose. It copies the message's complete flattened source set and offered evidence identities, not a caller-supplied dependency list or only the latest model window. Dependencies are deduplicated and never dropped while active; adding coverage increments the composer revision. An unsafe incoming message contributes no hidden prose, evidence or dependencies. If previously offered coverage is now unsafe, the transaction permanently invalidates that composer and commits the fence before the domain reports `context-changed`.

[`search-context-token.ts`](../src/storage/search-context-token.ts) signs version-1 `{sessionId,composerId,composerRevision,eligibilityRevision}` claims with process-local HMAC-SHA256. Tokens are opaque caller data, not source authority or bearer credentials. The key is neither persisted nor logged. Admission verifies the exact current composer/eligibility revisions and source eligibility inside its immediate transaction. General composer refresh/discard, message/discovery pages and thought-preview ledger commands remain later work.

Turn input has required `text`, `requestClock:{at,timeZone}`, `composerId` and `contextToken`; `startingThoughtIds` defaults to `[]`, `effort` to `standard` and `contextMode` to `continue`. Starting IDs must be unique and currently eligible; effort also accepts `quick`/`thorough`, and mode accepts `restart`. Unknown fields, caller-selected IDs/record times/dependencies, malformed text and AI authority are rejected. The client-reported full timestamp/offset (up to millisecond precision) and named time zone are validated against the calendar/zone, preserved verbatim and never used as SQL record timestamps. This validation does not interpret relative-time prose, impose a skew threshold, update a model clock or implement hourly prompt refresh.

[`search-turns.ts`](../src/storage/search-turns.ts) persists the run, ordered turn, one exact user message, dependencies, exposures, composer consumption and session/catalog activity changes together. IDs and one canonical UTC admission instant come from injected daemon sources. The run receives distinct allocated native session/prompt identities but no native call or binding; its initial step remains `prepared`/`unknown` with unprepared input. The version-1 `intent_json` retains starting IDs, original request clock, `daemonObservedAt`, mode, composer ID, original token and verified decoded claims, never the signing key or a second copy of user text.

The new user message and `run_context` inherit **all** offered composer dependencies plus eligible starting references. `restart` does not erase that inherited coverage. These run exposures are recorded with `full_read=0`: prior human or earlier-run reads do not become model full-read witnesses. The composer becomes consumed only after copying; its redundant dependency rows are then removed in the same transaction. The unique active slot serializes admission across connections.

Exact key replay compares original normalized caller intent, frozen clock/token and user text **before** checking a consumed/stale composer or another active turn. It allocates no IDs, samples no new admission time and does not revalidate an old token against a restarted process key. Changed input returns `idempotency-conflict`; a fresh key while a turn is active returns `turn-active`. Admission, replay and by-key lookup contain only immutable receipt IDs/time plus current search-run/session control metadata, not conversation prose, evidence excerpts or native identities. The dedicated `SearchRunView` does not widen ordinary `RunKind` or grant runtime execution.

Current message reads/admission use the real transactional library state through [`search-eligibility.ts`](../src/storage/search-eligibility.ts), including connection endpoints and all shared-response members. **Rejection-event hooks are not wired yet:** reject-then-restore before any check can still leave the counter/active composer/run unchanged. Permanent invalidation currently occurs when unsafe offered coverage is observed; publication also fences a run when it observes unsafe exposures. Immediate rejection-event fencing, restoration races and native-safe resumption require later integration; current checks must not be described as that completed guarantee.

Unexpected persistence failures have sanitized outer `SearchStorageError('search-persistence-failed')` messages. The original exception is retained only as standard non-enumerable `Error.cause` for bounded internal diagnostics/tests. Do not log/serialize that cause or expose it from a future HTTP error handler.

### Trusted discovery and reply publication

`SqliteStore.searchPublication({id,now,logger?})` implements [`SearchPublication`](../src/domain/search-publication.ts) through [`search-publication.ts`](../src/storage/search-publication.ts). Its methods are `addDiscovery(claim,promptId)` and `finalizeReply(claim,promptId)`; neither accepts a user actor, caller proposal or caller-selected dependencies. A future dispatcher must own the claim and completed step. This is not an HTTP/agent capability or a replacement for native history observation.

The [publication guard](../src/storage/search-publication-guard.ts) requires a live owning session/turn with an open slot, active search status, exact current generation, no pending cancellation, an immutable owned protocol-1 binding, and the requested prompt belonging to that run. Native completion, retained nonempty exact input and a whole completed envelope must already be persisted; previous prompt steps must be durably processed. SQL fixture completion is not proof that a real provider/native service was correlated. Non-search authority, library-write bookkeeping, superseded/terminal claims and unknown/foreign prompt evidence fail closed.

Fresh effects require the **current** completed prompt. Discovery envelopes are exact version-1 `request`/`addDiscovery` objects with `{thoughtId,why,evidenceThoughtIds}`. Final replies are exact version-1 `search-reply` objects with `{reply,disposition,sourceThoughtIds}`; disposition is `awaiting-user` or `done`. Unknown/duplicate fields, unsupported kinds, malformed/truncated output and duplicate citation IDs are rejected. The target and every cited/evidence thought need a currently eligible `run_context` thought full-read witness in **this run**; a response full read, snippet, human preview or another run's witness is insufficient.

Every publication rechecks the complete current exposure set, not only citations. It records all exposures as the new occurrence/reply's flattened dependencies, including uncited snippets and inherited context, and rechecks ownership/eligibility before committing. Observed unsafe run context interrupts the run, increments generation, records `context-invalidated`, releases its slot and retains pending cancellation **before reporting the fence**, without publishing an occurrence/reply. This does not implement rejection-event hooks or remote cancellation.

`addDiscovery` commits the immutable step receipt **before** inserting the matching occurrence (as required by its SQL guard), then dependencies and session/catalog activity in the same immediate transaction. A fresh request with an unremoved occurrence records `already-active` and preserves that entry's ID/rationale/order without activity or dependency rewrites. Otherwise it allocates a new occurrence at the tail across removed and unremoved entries, preserving the new proposal's rationale/evidence.

Before inspecting membership, replay resolves the exact owning step's confirmed `{type:'discovery-add',entryId,outcome}` receipt against its immutable original arguments and occurrence ownership. An already **processed** historical step may return this control fact under the same still-active current claim, binding, live session and whole-run eligibility fence, even after E1 was removed and E2 added. It gains no execution authority and changes no membership, prose, IDs, scheduling, dependencies or activity. A historical step without such a confirmed processed receipt cannot publish; stopped/failed/superseded claims cannot use a receipt to reopen authority. There is no caller-supplied alternate payload to replace the stored command.

`finalizeReply` inserts one immutable assistant message and its full exposure dependencies, updates session/catalog activity, and completes the run with an incremented generation/released slot atomically. Both dispositions end this run, not the saved session. It creates no fallback thought, library response, knowledge receipt or weave invitation. Interrupted/failed runs cannot finalize a late reply and their already confirmed occurrences remain retained. Ordinary runtime protocol unions, native dispatch and Stop/failure command integration are still later work.

**Deletion currently fails closed with `native-cleanup-required` before any write** if a session has a binding, a cleanup row, possible submitted/uncertain execution or a missing/dispatch-marked initial journal. An unbound run must retain only its matching initial `prepared`/`unknown` step, with no submission owner, envelope, result or later step, `cancellation_state='none'` and no submitting/running/uncertain run status. Terminal local status alone does not establish native absence. Joining setup/submission flights and retaining/reconciling uncertain native admission require later integration before bound/in-flight deletion can be enabled. The current service neither fabricates `settled` evidence nor promises remote deletion/cancellation; OpenCode/provider retention, backups and SQLite free pages/WAL are not erased by this local logical purge.

## Search indexes and vocabulary cache

Core migration creates these derived FTS5 virtual tables:

| Table | Columns |
| --- | --- |
| `thought_search_fts` | `thought_id UNINDEXED`, `text`, `title` |
| `response_search_fts` | `response_id UNINDEXED`, `text` |

Title metadata insert/update/delete triggers maintain thought index entries. Every supported thought creation includes its title metadata row, even when untitled. A response-insert trigger indexes retained reply text. Migration rebuilds both indexes from canonical records on each open; existing thoughts and replies are backfilled without changing their content.

Indexes include rejected records. Scoped retrieval applies rejection rules in SQL before returning text or selecting a reply's latest eligible association. AI access excludes an entire shared reply if any associated thought is rejected. Retained interrupted fallback replies remain searchable through their eligible associated input; this does not promote unfinished output to a completed development.

`search_revision(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL)` contains one row, initially `(1,0)`. Triggers increment it transactionally for title metadata insert/update/delete, response insert, response-association insert/update/delete, and thought rejection/restoration. Thought text is immutable; connections are not part of this search corpus.

Suggestion vocabularies use connection-local temporary FTS5 and spellfix1 tables, separated into AI, normal-user and user-inspection scopes. An unchanged revision reuses the vocabulary. A changed revision rebuilds that scope's vocabulary from eligible text and titles in a consistent transaction, including changes committed through another connection. These temporary tables are not durable knowledge or public API tables.

## Constraints and access boundaries

Migration enables `PRAGMA foreign_keys = ON` and verifies it, and also enables `PRAGMA recursive_triggers = ON` for the connection. Primary-key and unique constraints create their supporting indexes.

SQL constraints and triggers protect persistence invariants; they do not replace service authorization or scoped reads. Raw storage access is internal. Future agents and routes must use the domain services to exclude rejected thought content, ancestry, sources, connections and responses appropriately.

Direct SQL creation is not the supported write boundary. In particular, bypassing `saveThought()` can omit title metadata or leave a source set unsealed. Do not populate application data by inserting partial rows manually.

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
