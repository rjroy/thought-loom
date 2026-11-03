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

The HTTP API can read these records but does not currently provide a response-creation route. These states represent retained output; they do not themselves implement agent jobs or cancellation. Real agent integration is still pending.

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

These tables are initialized by core migration through [`run-schema.ts`](../src/storage/run-schema.ts). They support internal run services, not an active worker or public job API yet. No table causes a model call merely by containing a row.

### `runs`

| Column | Type | Constraint / meaning |
| --- | --- | --- |
| `id` | `TEXT` | Primary key; daemon-owned run identity. |
| `kind` | `TEXT` | Check: `weave`, `evolve`, or `export`. |
| `status` | `TEXT` | Check: `queued`, `submitting`, `running`, `uncertain`, `completed`, `interrupted`, or `failed`. |
| `session_id` | `TEXT` | Unique, stable external session identity. |
| `prompt_id` | `TEXT` | Unique, stable external prompt identity. |
| `created_at` | `TEXT` | Creation timestamp. |
| `generation` | `INTEGER` | Nonnegative claim generation used to fence stale owners. |
| `input_thought_id` | `TEXT`, nullable | Foreign key to the admitted user contribution; required exactly for new `evolve` runs and null for other kinds. |
| `native_state` | `TEXT` | `unknown` (default), `running`, or `completed`; external observation is distinct from local status. |

Identity, kind, session/prompt identities, creation time and input identity are trigger-protected; deleting runs is blocked. Once native completion is recorded, a trigger prevents downgrading that evidence. Status and generation remain mutable through guarded repository operations, not arbitrary model instructions.

Evolve contribution creation and run admission commit together. The persisted input link identifies the exact contribution after restart and constrains where the run may add developments. A claim contains the run ID and generation. Claims currently have no time-based expiry; this is ownership fencing, not a model-runtime or effort quota.

### `run_context`

| Column | Type | Constraint / meaning |
| --- | --- | --- |
| `run_id` | `TEXT` | Foreign key to `runs.id`. |
| `kind` | `TEXT` | Check: `thought`, `connection`, or `response`. |
| `ref_id` | `TEXT` | Referenced identity; polymorphic, so not a declared foreign key. |

Composite primary key: `(run_id, kind, ref_id)`. The repository checks AI visibility before recording exposed context and revalidates it when authorizing submissions and writes. A shared reply becomes ineligible if any associated thought is rejected. No update/delete triggers are defined on this table; authority and visibility checks live in the domain/repository boundary.

### `run_operation_receipts`

| Column | Type | Constraint / meaning |
| --- | --- | --- |
| `run_id` | `TEXT` | Foreign key to `runs.id`. |
| `operation_id` | `TEXT` | Stable operation identity within the run. |
| `operation_json` | `TEXT` | Recorded operation request. |
| `thought_id` | `TEXT` | Foreign key to the resulting development. |
| `result_json` | `TEXT` | Recorded result returned for an eligible replay. |

Composite primary key: `(run_id, operation_id)`. Unique index `run_receipt_result` covers `(run_id, operation_id, thought_id)` for the issued-membership foreign key. Update/delete triggers protect receipts.

The current internal operation contract creates a development. Its knowledge change, receipt and issued membership commit atomically. Reusing the operation identity with the same request reuses the result rather than writing another thought; a different request conflicts. A stopped, stale or rejected-context claim cannot use replay to bypass its fence. Export runs cannot dispatch knowledge writes.

### `run_issued_thoughts`

| Column | Type | Constraint / meaning |
| --- | --- | --- |
| `run_id` | `TEXT` | Foreign key to `runs.id`. |
| `operation_id` | `TEXT` | Operation that issued the development. |
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

## Constraints and access boundaries

Migration enables `PRAGMA foreign_keys = ON` and verifies it, and also enables `PRAGMA recursive_triggers = ON` for the connection. In addition to indexes created for primary-key and unique constraints, the run schema defines the unique `run_receipt_result` index.

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

Core migration also initializes run storage; callers do not need a separate run-repository initialization step. For an older run schema, missing input/native-state fields are added without guessing an Evolve input. An unmapped legacy Evolve run cannot safely resume. When issued membership is first introduced, existing receipt rows are backfilled in their persisted insertion order, not sorted by identity or timestamp. Repository migration delegates to the same authoritative core path.

Back up valuable data before upgrading and stop the daemon before replacing a disposable database. No FTS5/search tables or automatic weaver execution are part of this schema yet.
