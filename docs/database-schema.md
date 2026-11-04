# Database schema

[Start here](../README.md) · [Daemon API](daemon-api.md) · [Server startup](server-startup.md)

Thoughtloom uses SQLite through Bun's built-in `bun:sqlite`. The authoritative schema and migration are in [`src/storage/sqlite.ts`](../src/storage/sqlite.ts). This document describes the current schema, not proposed search or agent tables.

## Model and relationships

- A thought is an immutable piece of recorded thinking. A non-root thought has one evolution parent; roots have no parent.
- Titles are separate mutable metadata, returned alongside thoughts in ordinary reads.
- Conceptual connections are separate from evolution ancestry. They never become extra evolution parents or extend the scope of a branch operation.
- Source associations record supporting provenance. Their position preserves the order of each source list.
- Rejection is presence in a separate state table, not deletion or modification of the recorded thought.

Database names use `snake_case`; the [API](daemon-api.md#response-records) uses `camelCase`.

## Tables

Unless marked nullable, columns below are `NOT NULL`. Every listed foreign key references the identified parent row; no cascading-delete action is declared.

### `thoughts`

| Column | Type | Constraint / meaning |
| --- | --- | --- |
| `id` | `TEXT` | Primary key; assigned by the daemon's creation command. |
| `text` | `TEXT` | Recorded wording. |
| `author` | `TEXT` | Check: `user` or `ai`. |
| `kind` | `TEXT` | Check: `captured-original`, `user-contribution`, `ai-interpretation`, or `developing-idea`. |
| `created_at` | `TEXT` | Daemon-generated UTC ISO timestamp. SQLite itself stores text rather than enforcing timestamp syntax. |
| `origin` | `TEXT` | Provenance label. Current HTTP creation commands use `capture`, `contribution`, or `development`; this column is not a SQL enum. |
| `parent_id` | `TEXT`, nullable | Foreign key to `thoughts.id`; a check forbids self-parenting. |

There is no title column in the current table. `BEFORE UPDATE` and `BEFORE DELETE` triggers abort mutations with an immutability error. Further development creates another thought rather than a revision of this row.

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

These tables are initialized by core migration through [`run-schema.ts`](../src/storage/run-schema.ts). Configured workers and public Evolve/status/Stop routes use the same run aggregate. Migration itself makes no model calls; with agent configuration present, the daemon supervisor can process queued rows, including jobs retained from an earlier run.

### `runs`

| Column | Type | Constraint / meaning |
| --- | --- | --- |
| `id` | `TEXT` | Primary key; daemon-owned run identity. |
| `kind` | `TEXT` | Check: `weave`, `evolve`, or `export`. |
| `status` | `TEXT` | Check: `queued`, `submitting`, `running`, `uncertain`, `completed`, `interrupted`, or `failed`. |
| `session_id` | `TEXT` | Unique, stable external session identity. |
| `prompt_id` | `TEXT` | Unique, immutable initial external prompt identity. Later prompt identities live in `run_steps`. |
| `created_at` | `TEXT` | Creation timestamp. |
| `generation` | `INTEGER` | Nonnegative claim generation used to fence stale owners. |
| `input_thought_id` | `TEXT`, nullable | Foreign key to the admitted user contribution; required exactly for new `evolve` runs and null for other kinds. |
| `weave_subject_id` | `TEXT`, nullable | Foreign key to the thought being woven; paired with the trigger identity and permitted only for weave runs. |
| `weave_trigger_id` | `TEXT`, nullable | Immutable trigger identity; legacy weave intent remains unknown rather than inferred. |
| `cancellation_state` | `TEXT` | `none` (default), `pending`, or `settled`; remote cancellation settlement is distinct from local interruption. |

Identity, kind, initial session/prompt identities, creation time and input identity are trigger-protected; deleting runs is blocked. Status and generation remain mutable through guarded repository operations, not arbitrary model instructions. The internal `RunRecord.promptId` and `nativeState` project the current ordered step, rather than duplicating its native completion evidence in `runs`.

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

Triggers enforce append order, immutable identities/input, durable completion, and immutable recorded envelopes/results. A run insert creates step zero. Preparation records its exact input once; migration never invents missing legacy input. A completed capability step can retain its confirmed result before advancement. Advancing atomically verifies or records that result and creates the successor's exact input and identity. Matching replay reuses that successor; a mismatch conflicts. Every successor begins with its own unknown native state.

Protocol input is one strict version-1 JSON request or completion envelope. Duplicate keys, extra fields, unsupported versions, model-supplied operation IDs and malformed/truncated output are rejected. Machine envelopes are not retained conversational replies. Async acknowledgements are bound to the original prompt and cannot change a successor step.

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

Update/delete triggers make bindings immutable. No service credentials or authentication headers are stored. Binding is permitted only before the initial native submission; recovery cannot infer a new binding for an already-submitted unbound run. Internal run reads project the bound native session while preserving the initial allocated identity in `runs`.

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
