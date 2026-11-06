---
title: Agentic search sessions — schema and API design
date: 2026-11-06
status: draft
tags: [agentic-search, sessions, schema, api, rejection, opencode]
modules: [domain, storage, agent, daemon]
related: [.lore/context/architecture.md, .lore/context/agentic-search.md, .lore/context/search-view.md, .lore/context/data-model.md, .lore/context/evolve-view.md, .lore/context/export-view.md, .lore/context/weaver-agent.md]
---

# Agentic search sessions — schema and API design

## Status and scope

This is a proposed design, not an implemented contract or implementation authorization. The user approved moving to schema/API design. Only this document is changed. No migrations, application code, tests, installations, service calls, provider calls, private configuration, database inspection, tracker changes, or commits are part of this invocation. An independent design review follows through the parent session.

The maintained [agentic-search product context](../../context/agentic-search.md) records the agreed direction; [ordinary Search context](../../context/search-view.md#still-to-decide) now links to it as a separate planned workflow. These product requirements are not implementation authorization or approval of this particular schema. Existing ordinary search remains unchanged. The newer paired-clock direction below supersedes this draft's earlier timezone/morning question. Implementing the design would require updating current schema/API/startup/testing contracts, not silently treating the draft as shipped functionality.

## 1. Requirements, proposals, and outstanding decisions

### Confirmed requirements from the present discussion

- The agent investigates a natural-language request, chooses and changes queries, reads promising existing thoughts, follows recorded relationships, and can ask clarifying questions. It may infer a recent time-bound topic, rediscover deep-archive material, or look for corollary, complementary, or contradictory existing thinking from starting notes.
- The goal is **finding existing thinking**, not forming new ideas. No thoughts, evolution steps, conceptual connections, titles on library thoughts, rejection changes, or weaving invitations may be created by search.
- The experience has a conversation and a growing discovered-ideas list. Each discovery references an existing thought and explains why it matters to this investigation. The agent adds entries; it cannot remove them. The user removes a session entry without rejecting the underlying thought.
- Removal is not permanent suppression. A fresh agent discovery may add that thought back, and the user may remove it again. Replaying an old command, returning a cached success, or refreshing a page must never undo a newer removal.
- Multiple sessions persist, survive refresh/restart, and can be resumed. They remain indefinitely until manual deletion. Simple titles, last activity, and Delete suffice; no folders, automatic expiry, or session-as-thought-chain model.
- Deleting a session removes its conversation and selections, **never its thoughts**. Session/control bookkeeping is allowed; knowledge-business mutation is not.
- Every AI access obeys current rejection rules, including saved conversation, rationale, indirect provenance, native history, and resumption. User-only inspection must not become AI context.
- Keep Bun/TypeScript, Hono, SQLite, and browser → Next server → daemon. Daemon and client implementations remain separate. Designer-led comps come later. No MCP/native-tool expansion or changes to the operator-managed OpenCode service.
- Reuse existing effort labels and native binding, claim fencing, exact-input idempotency, uncertain-admission observation, and Stop policies where applicable. Effort does not introduce application turn, token, cost, search-count, or note-count quotas.
- Canonical SQL record times remain daemon-owned. The web client supplies its clock through Next to the daemon; the prompt receives user/database clock context on first use and, during a long turn, at the next suitable boundary after more than an hour. This gives the agent temporal context without requiring an external clock tool or replacing its judgment with an application natural-language parser.
- Thoughtloom owns its local retention/deletion contract. OpenCode/provider retention follows their own policies; this feature does not require native hard-delete integration or another approval before use. Local purge, late-callback fences and cancellation correctness remain required.

User clock direction, verbatim:

> Let's do this ... consider the fact that  all SQL records are based on the daemon time. The web client always sends its time to the server (and thus to the daemon). The daemon then attaches to the prompt either when it hasn't already been sent, or more than an hour has passed since the last time `(user HH:MM; database HH:MM)`. This will allow the agent to reason about time. It doesn't have a clock without using a tool. (or something like this)

User rediscovery decision, verbatim:

> I have mixed feelings ... if the agent discovered it again then maybe its more important than the user thought originally. I think we just go ahead and let the agent add it back, the user can always just re-remove it.

User retention decision, verbatim:

> I only care about the retention of thought-loom ... opencode etc can have their own policies.

### Recommended choices, not additional user approvals

1. Add a durable search-session aggregate and a new `search` run kind. One user message admits one fresh run/native session; several protocol steps can investigate within that turn. Do not reuse a native session across user turns.
2. Use separate message/discovery tables, not `thoughts` or `responses`. Keep session text entirely out of library FTS and spelling vocabulary.
3. Store structured intent and daemon-recorded source dependencies separately from prose. Rebuild each turn's eligible context rather than replaying old native transcripts.
4. Represent discovery **occurrences**: at most one unremoved occurrence per `(session_id, thought_id)`, with immutable rationale/order per occurrence. A fresh eligible agent add after removal creates a new occurrence/ID at the tail; old-command replay does not. This is the recommended technical representation of the approved rediscovery behavior, not an additional product requirement.
5. Default search effort to `standard`, using the existing configured model/effort map. Do not add another model configuration surface initially.
6. Default pages to 50 records, maximum 200, for persisted session collections; narrower investigation result pages default to 25, maximum 100. These bound individual transfers, not total investigation effort.

Clock direction, rediscovery after removal and local-only retention responsibility are resolved by the user. [Section 12](#12-product-decisions-and-approval-boundary) records that no product question remains from this design discussion. Schema/API details remain draft recommendations, not implementation authorization.

## 2. Verified foundations and gaps

| Source anchor | Current behavior and design consequence |
| --- | --- |
| [`src/domain/search.ts:13–34,64–98`](../../../src/domain/search.ts), [`src/storage/search.ts:52–105`](../../../src/storage/search.ts) | FTS/spelling, author/kind/date filters, chronological/relevance sorting, and own-record hits already exist. The public service requires nonempty query text, has no result pagination, and date-only bounds mean UTC days. It does not interpret natural language or store sessions. |
| [`src/domain/rejection.ts:7–16,62–75,205–259`](../../../src/domain/rejection.ts) | Only AI normal scope is allowed; active thoughts redact rejected parent/source IDs. Connections require active endpoints; shared-response AI eligibility is stricter than ordinary user visibility. Raw snapshots are internal, not an agent API. |
| [`src/storage/capability.ts:22–81`](../../../src/storage/capability.ts), [`src/storage/run-aggregate.ts:160–204`](../../../src/storage/run-aggregate.ts) | A completed persisted step controls dispatch. Exposures and full reads are different. Current model `search` accepts only `{query}`, and there is no tool to enumerate a thought's connections/children. Search needs narrow additional read capabilities, not merely a different prompt. |
| [`src/domain/run.ts:8–70,88–150`](../../../src/domain/run.ts), [`src/storage/run-protocol.ts:20–110`](../../../src/storage/run-protocol.ts) | Claims/generations, exact immutable prompts, step results, restart observation, Stop and cancellation settlement are useful infrastructure. Existing run kinds do not include search. A run is not a persistent conversation session. |
| [`src/domain/run-context.ts:6–15`](../../../src/domain/run-context.ts), [`src/storage/run-worker.ts:33–66`](../../../src/storage/run-worker.ts) | Initial contexts cover weave/Evolve/export only. Evolve derives discussion from thought ancestry; that must not be repurposed to persist a search conversation. |
| [`src/storage/agentic-export.ts:38–72`](../../../src/storage/agentic-export.ts) | Read-only knowledge work can finalize a separate artifact. Full-read citations and exposure fences are reusable; a retained, human-only Markdown report is not resumable dialogue. |
| [`src/agent/opencode-adapter.ts:120–232,347–378`](../../../src/agent/opencode-adapter.ts), [`src/agent/history.ts:6–81`](../../../src/agent/history.ts) | Native ownership, exact input history, paginated observation, quarantine, and no-resend-after-uncertainty already exist. Cancellation uses ownership/inbox/active state, not a native-history deletion API. |
| [`src/agent/opencode-client.ts:17–38,53–71`](../../../src/agent/opencode-client.ts) | The facade rejects unexpected files/agents/skills/native tool content and untracked synthetic history. It exposes cancellation, not delete/redact/fork-clean-history. Do not claim native hard deletion or a safe history-edit mechanism. |
| [`src/agent/worker.ts:74–81,174–208`](../../../src/agent/worker.ts), [`src/agent/supervisor.ts:66–79`](../../../src/agent/supervisor.ts) | Existing per-run flights coalesce ticks and shutdown joins owned work. Deletion must retain/join those execution flights before permanent native-cleanup settlement. An HTTP timeout or empty native snapshot does not prove an authorized submission cannot arrive later. |
| [`src/storage/run-schema.ts:36–90,133–159`](../../../src/storage/run-schema.ts) | Runs, bindings, exposures, and steps currently reject deletion. Deleting a new session row alone would leave exact user text and tool results behind. A narrowly scoped deletion design is required. |
| [`src/storage/import-migration.ts:49–92`](../../../src/storage/import-migration.ts), [`docs/database-schema.md#durable-execution-tables`](../../../docs/database-schema.md#durable-execution-tables) | Widening a run-kind CHECK must preserve its incoming FK closure, indexes, triggers and rowids. The existing import rebuild is useful precedent, not permission to rerun it blindly or weaken immutability. |
| [`src/daemon/app.ts:124–153,216–236`](../../../src/daemon/app.ts), [`src/daemon/runtime.ts:77–115`](../../../src/daemon/runtime.ts) | Authenticated scoped routes and daemon-owned worker lifetime already exist. Browser disappearance is not Stop; IDs/timestamps come from daemon sources. |

Also read: README, AGENTS, architecture/data/search/Evolve/export/weaver context, current schema/API/testing documentation, and representative capability/export/worker/adapter/protocol tests. Historical `.lore/local/plans/phase-five-evolve.md` describes intentionally transient Evolve client state, not an existing durable-session capability. No `.lore/reference/` or `.lore/learned/` directory exists here. The independent explorer's findings agree with these code boundaries.

## 3. Domain and execution boundaries

```text
Next server → user-only SearchSessions service → search repository / SQLite
                                               ↓ admit a turn
                                existing runs + steps + bindings + supervisor
                                               ↓
                                search-only capability dispatcher
                                  ↙                       ↘
                          scoped library reads      add session discovery
```

### Domain objects

- **SearchSession:** stable application identity, neutral/user title, creation/last-activity times, revision, deletion marker. It is not `RunRecord.sessionId` (the native identity).
- **SearchTurn:** one admitted user request, immutable intent metadata, effort and run mapping. Exactly one active turn per session. Terminal runs do not close the session.
- **SearchMessage:** actual user text or one validated user-facing assistant reply. Immutable while retained; separate from library thought content and native machine envelopes.
- **SearchDiscovery:** one occurrence of an existing thought in the session list, with its own immutable rationale/evidence/order and optional user-removal time. Rediscovery after removal creates another occurrence, not an edit/revival of the old one. This is a session selection, not a conceptual `Connection`.
- **Dependency:** daemon-owned source eligibility required to reuse a message/rationale. It is broader than model-selected citation IDs and cannot be supplied by the browser or model.
- **Composer context:** one daemon-owned receipt of everything offered to an active composer through normal search-workspace reads. Its dependency union grows monotonically across all pages and previews, independently of the small context window initially sent to the model. It is not a job, transcript, browser-chosen dependency list, or execution engine.

Proposed `src/domain/agentic-search.ts` owns strict intent/DTO definitions, read policy, and the user command service; a storage adapter owns atomic session/run changes. Search-specific capability parsing and finalization remain small typed modules. Extend the existing run worker through explicit search branches/pure renderers and a search dispatcher; do not build another generic workflow framework or another claims/submission journal.

Keep `StepOperation` and knowledge receipts limited to their existing knowledge effects. `addDiscovery` is a separate search control capability with its exact persisted `run_steps.result_json` as its receipt; it never enters `run_issued_thoughts`. Extend protocol advancement to require that this result was committed by its owning dispatcher, just as existing reads require recorded results. A new `search-reply` envelope is valid only for search; existing `complete` and `report` contracts retain their current meanings.

All existing kind guards must be reviewed deliberately: widen execution/observation eligibility where appropriate, **not** knowledge-write authority or import-source authority. Imports keep their separate restricted worker. Search must never be implemented as an `evolve` run without a contribution or an `export` run with a fake report.

## 4. Incremental SQL model

### Core changes

- Widen `runs.kind` CHECK to add `search`; its `input_thought_id` stays null, as do weave-subject fields.
- Reuse ordered `run_steps`, immutable `agent_bindings`, `run_context`, status/generation/cancellation fields, and their ordinary restart invariants.
- Add nullable `run_steps.submit_owner` for the daemon process-instance ID, written with a search step's durable submission authorization and never inferred for an already-submitted unknown owner. Existing non-search rows stay unchanged/null. The existing step phase/exact input plus this owner supply deletion cleanup evidence; no second submission journal is introduced.
- Add reverse exposure index `run_context(kind, ref_id, run_id)` for targeted rejection invalidation. Add supporting `response_thoughts(thought_id,response_id)` and connection endpoint indexes if absent, verifying existing indexes before adding duplicates.
- Add search-owned eligibility, retrieval, and session-catalog revision counters. Eligibility covers **both** thought and connection rejection/restoration. Existing `search_revision` is a spelling-corpus counter and does not cover connection rejection or thought creation without title insertion; it is not the right authorization/pagination token.

The following is the proposed persistent model, not a migration script. Canonical timestamps and IDs are supplied by injected daemon sources; client-reported clock values are separately attributed intent metadata, never record timestamps. Nonempty text, exact JSON shapes, safe integers, IANA zones and timestamps are also validated in domain code. `ON DELETE CASCADE` below applies only to owned search metadata, never to library thoughts.

```sql
CREATE TABLE search_sessions (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT UNIQUE NOT NULL,
  create_request_key TEXT UNIQUE NOT NULL,
  title TEXT,
  created_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  deleted_at TEXT,
  CHECK ((deleted_at IS NULL AND title IS NOT NULL AND length(title)>0)
      OR (deleted_at IS NOT NULL AND title IS NULL))
);
CREATE INDEX search_sessions_activity
  ON search_sessions(last_activity_at DESC, sequence DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE search_turns (
  run_id TEXT PRIMARY KEY NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES search_sessions(id),
  position INTEGER NOT NULL CHECK (position >= 0),
  request_key TEXT NOT NULL,
  admitted_at TEXT NOT NULL,
  effort TEXT NOT NULL CHECK (effort IN ('quick','standard','thorough')),
  context_mode TEXT NOT NULL CHECK (context_mode IN ('continue','restart')),
  intent_json TEXT NOT NULL CHECK (json_valid(intent_json)),
  open_slot INTEGER NOT NULL DEFAULT 1 CHECK (open_slot IN (0,1)),
  outcome_reason TEXT,
  UNIQUE(session_id, position), UNIQUE(session_id, request_key),
  UNIQUE(session_id, run_id)
);
CREATE UNIQUE INDEX search_turns_one_active
  ON search_turns(session_id) WHERE open_slot=1;

CREATE TABLE search_messages (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  text TEXT NOT NULL CHECK (length(text)>0),
  created_at TEXT NOT NULL,
  disposition TEXT CHECK (disposition IN ('awaiting-user','done')),
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  FOREIGN KEY(session_id,run_id)
    REFERENCES search_turns(session_id,run_id) ON DELETE CASCADE,
  UNIQUE(session_id,position), UNIQUE(run_id,role), UNIQUE(session_id,id),
  CHECK ((role='user' AND disposition IS NULL)
      OR (role='assistant' AND disposition IS NOT NULL))
);

CREATE TABLE search_discoveries (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL,
  thought_id TEXT NOT NULL REFERENCES thoughts(id),
  position INTEGER NOT NULL CHECK (position >= 0),
  why TEXT NOT NULL CHECK (length(why)>0),
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  added_run_id TEXT NOT NULL,
  added_prompt_id TEXT NOT NULL REFERENCES run_steps(prompt_id),
  added_at TEXT NOT NULL,
  removed_at TEXT,
  FOREIGN KEY(session_id,added_run_id)
    REFERENCES search_turns(session_id,run_id) ON DELETE CASCADE,
  UNIQUE(added_prompt_id), UNIQUE(session_id,position),
  UNIQUE(session_id,id)
);
CREATE UNIQUE INDEX search_discoveries_one_unremoved
  ON search_discoveries(session_id,thought_id) WHERE removed_at IS NULL;
CREATE INDEX search_discoveries_visible
  ON search_discoveries(session_id,position) WHERE removed_at IS NULL;

CREATE TABLE search_content_dependencies (
  sequence INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES search_sessions(id),
  message_id TEXT,
  discovery_id TEXT,
  ref_kind TEXT NOT NULL CHECK (ref_kind IN ('thought','connection','response')),
  ref_id TEXT NOT NULL,
  FOREIGN KEY(session_id,message_id)
    REFERENCES search_messages(session_id,id) ON DELETE CASCADE,
  FOREIGN KEY(session_id,discovery_id)
    REFERENCES search_discoveries(session_id,id) ON DELETE CASCADE,
  CHECK ((message_id IS NULL) != (discovery_id IS NULL))
);
CREATE UNIQUE INDEX search_message_dependency
  ON search_content_dependencies(message_id,ref_kind,ref_id)
  WHERE message_id IS NOT NULL;
CREATE UNIQUE INDEX search_discovery_dependency
  ON search_content_dependencies(discovery_id,ref_kind,ref_id)
  WHERE discovery_id IS NOT NULL;
CREATE INDEX search_dependency_reverse
  ON search_content_dependencies(ref_kind,ref_id,session_id);

CREATE TABLE search_composer_contexts (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL REFERENCES search_sessions(id),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision>=0),
  state TEXT NOT NULL CHECK (state IN ('active','consumed','invalidated','discarded')),
  created_at TEXT NOT NULL
);
CREATE INDEX search_composer_session ON search_composer_contexts(session_id);
CREATE TABLE search_composer_dependencies (
  composer_id TEXT NOT NULL REFERENCES search_composer_contexts(id) ON DELETE CASCADE,
  ref_kind TEXT NOT NULL CHECK (ref_kind IN ('thought','connection','response')),
  ref_id TEXT NOT NULL,
  PRIMARY KEY(composer_id,ref_kind,ref_id)
);
CREATE INDEX search_composer_dependency_reverse
  ON search_composer_dependencies(ref_kind,ref_id,composer_id);

CREATE TABLE search_revisions (
  id INTEGER PRIMARY KEY CHECK (id=1),
  eligibility INTEGER NOT NULL CHECK (eligibility>=0),
  retrieval INTEGER NOT NULL CHECK (retrieval>=0),
  catalog INTEGER NOT NULL CHECK (catalog>=0)
);
INSERT INTO search_revisions VALUES (1,0,0,0);

-- Survives local content deletion only to settle already-owned native work.
-- No prompt text, tool output, rationale or provider exception belongs here.
CREATE TABLE search_native_cleanup (
  run_id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL REFERENCES search_sessions(id),
  binding_json TEXT NOT NULL CHECK (json_valid(binding_json)),
  last_prompt_id TEXT NOT NULL,
  submit_owner TEXT NOT NULL,
  drain_state TEXT NOT NULL CHECK (drain_state IN ('waiting','drained','unknown-after-restart')),
  admission_state TEXT NOT NULL CHECK (admission_state IN ('never-submitted','uncertain','admitted','terminal')),
  prompt_sha256 BLOB,
  evidence_json TEXT CHECK (evidence_json IS NULL OR json_valid(evidence_json)),
  state TEXT NOT NULL CHECK (state IN ('pending','settled','ownership-conflict')),
  CHECK (prompt_sha256 IS NULL OR length(prompt_sha256)=32),
  CHECK (admission_state='never-submitted' OR prompt_sha256 IS NOT NULL),
  CHECK (admission_state!='terminal' OR evidence_json IS NOT NULL),
  CHECK (state!='settled' OR (drain_state='drained'
    AND admission_state IN ('never-submitted','terminal')))
);
```

`intent_json` is a versioned, exact validated shape, not an arbitrary configuration bag. It contains `{version:1, startingThoughtIds, requestClock, daemonObservedAt, contextMode, composerId}` plus the originally admitted context-token string and its verified decoded data (never the signing key). `requestClock` is the frozen client-reported full timestamp/offset and IANA zone; `daemonObservedAt` is the daemon admission/receipt instant. These distinct clock anchors are described in section 5. The actual request is stored once as the turn's user message; SQL ordering links that message by `run_id` and `role='user'`. Replay compares the original normalized caller intent/text/token data; it does not allocate a new request clock/reference instant or require revalidating an old token against a new process key.

Composer rows retain source identities only, not a second copy of offered prose. A normal read atomically extends their dependency union before returning content. Admission atomically copies that union to the user message and run, then consumes the composer; its now-redundant dependency rows can be deleted in that transaction. Invalidated contexts cannot be reset to active or refreshed into a smaller coverage set. Discard is an explicit composer action, not session expiry.

Cleanup `submit_owner` identifies the daemon process instance that owned the execution flight. `prompt_sha256` and `evidence_json` retain only non-content identity/phase evidence: hashes, prompt/user/assistant/idle IDs and terminal classification, never native text/output or raw errors. Submission authorization is `uncertain`, not evidence of admission or absence. `drain_state='drained'` alone is insufficient to settle an unresolved remote admission; section 8 specifies the required combined proof.

`evidence_json` contains only a unique ordered array of validated existing thought IDs, not embedded thought DTOs or model-authoritative attribution. Dependency identities follow the existing polymorphic `ContextRef` convention; they require trusted existence/type checks rather than imaginary cross-table foreign keys. Presentation always resolves current thought metadata under the requested scope.

### Required guards and transaction invariants

SQL above must be accompanied by explicit guards; application transactions alone do not justify weakening existing triggers:

1. Search-turn insertion requires a `search` run with no thought/weave input and an undeleted session. Its `open_slot` must match an active run status. A terminal run transition clears that slot in the same transaction; it cannot be reopened. The unique active-slot index serializes admission across daemon connections.
2. User admission inserts run, turn, one user message, the **entire offered composer dependency union**, context refs, and request-key receipt identity together, and consumes the composer. It checks its exact revision token, current eligibility and normally eligible starting IDs before commit. This union is not limited to whichever previous messages the next model prompt selects. A partial admission cannot be returned as success.
3. Message/turn identities, input intent, text, role, effort, evidence and added-discovery identity/rationale are immutable while retained. No `INSERT OR REPLACE` path may bypass these guards. `removed_at` is write-once through the user command. Composer source sets may only grow while active; consumption/discard performs its specified cleanup, never a coverage reset. `run_steps.submit_owner` is assigned once in the existing search submission-authorization transaction and cannot be replaced by a restart claim. Session title/activity/revision, guarded slot/reason, composer state/revision and user removal state have their explicit mutable transitions.
4. Every discovery occurrence's unique `added_prompt_id` must belong to `added_run_id`, identify its completed `addDiscovery` request, and match its confirmed `added` result. Validate target and cited evidence as full reads in **this run**. A fresh step returns the existing unremoved occurrence without changing it, or appends a new occurrence when none remains. An existing step receipt is checked/replayed before considering current membership; replay cannot become a new add. A prompt cannot manufacture a selection in another session.
5. Occurrence insert/no-op result, dependency closure and step-result receipt commit together. A new occurrence/removal updates session revision and last activity; an `already-active` no-op/replay does not. Assistant final message, dependencies, terminal run status/generation and released slot commit together. Neither path calls a model or network under a SQLite lock.
6. A committed assistant message is one validated final reply, not a JSON prefix. Initial design does not persist raw streaming drafts as conversation. Stop/failure retains user text and confirmed selections; status explains interruption when no final reply exists. Streaming user-facing text, if added later, needs a separately designed noncanonical draft contract.
7. Each thought/connection rejection/restoration increments `search_revisions.eligibility` transactionally. A **rejection** also fences affected active search runs and permanently invalidates affected active composer contexts in that transaction; see section 6. Restoration never reopens either. Increment `retrieval` on thought/title/response/association and eligibility changes, and `catalog` on live-session list ordering/membership/title changes. These counters and the changes they describe commit together.
8. Search runs are barred from `run_replies`, issued-thought membership, knowledge-operation receipts, import authority, library response finalization, and weave scheduling. Test direct trusted-service misuse, not only the advertised model tool list.
9. Delete is the only session content-purge path. Deletion exceptions require the retained turn mapping to prove `runs.kind='search'` and its owning session's non-null `deleted_at`. Existing non-search immutability remains unchanged. See section 8 for deletion order, joined execution flights, durable unresolved-admission evidence and cancellation-only authority.

The retained session row becomes a **metadata-only tombstone** after deletion: ID, opaque creation key, times/revision and deletion marker, no title/text/selection. It prevents delayed create-key replay from resurrecting deleted sessions. It is excluded from every live list/detail/context route. No session text is copied into that tombstone or native cleanup records.

## 5. Investigation capabilities and dialogue termination

Keep native permissions at `deny *`; all work is application-mediated strict JSON. Existing read implementations are reusable behind AI normal scope. Do not give the search runtime a daemon AI bearer token, generic HTTP proxy, shell, filesystem, network, provider, MCP, other-session, raw run-history, user-history, import-source, or knowledge-write capability.

| Proposed capability | Strict arguments and result |
| --- | --- |
| `findThoughts` | `{query: string|null, authors: [], kinds: [], from: UTC|null, until: UTC|null, sort, limit, cursor: string|null}`. `until` is exclusive. Nonempty lexical query uses existing FTS/spelling behavior; a null query requires a bounded date interval and chronological sort. Returns narrow thought/response candidates and continuation, never full text, facet counts, or automatic surrounding context. |
| `readThought`, `readConnection`, `readResponse` | Existing exact `{id}` shapes and AI projections; record every exposure and distinguish full reads from referenced IDs. A response read does not witness full thought text. |
| `relatedThoughts` | `{thoughtId, relation: 'connections'|'children'|'parent'|'sources'|'responses', limit, cursor}`. Returns eligible direct references and existing relationship metadata only. No recursive whole-graph expansion. Connection reads preserve direction and current visibility. Endpoints/children require their own full thought reads. |
| `readSearchConversation` | `{beforePosition: integer|null, limit}` for **this session only**, latest eligible messages backwards with original positions and safe turn-intent metadata. No `history` scope argument. Returns current safe messages and a continuation; dependencies become run exposures. |
| `listDiscoveries` | `{afterPosition: integer|null, limit}` for this session's nonremoved, normally eligible entries. Never includes removed IDs/old rationale in model context. Safe target references with an unsafe old rationale may be returned without that rationale. |
| `addDiscovery` | `{thoughtId, why, evidenceThoughtIds: []}`. Requires target and all evidence to be currently eligible full reads. A fresh step appends a new occurrence if no unremoved occurrence exists, including after user removal; otherwise it returns that active occurrence's ID without rewriting it. Exact step replay returns its immutable occurrence receipt, never re-adds. No category/connection write, removal, reorder, or title fill. |
| `normalizeTimeRange` | `{intentTurnPosition, interpretation, from, until, timeZone}`. The agent supplies its interpreted full local endpoints with explicit UTC offsets and an IANA zone. Trusted code validates calendar/zone/offset consistency and converts them to UTC `[from,until)`; it does not parse natural language, define morning, or choose a search strategy. Returns the selected turn's paired-clock anchors and a receipt labeled `agent-interpretation`. |

`findThoughts` is an explicit new scoped retrieval contract, not a silent change to `GET /search` semantics or its existing `{query}` capability. Factor shared SQL/tokenization/spelling/visibility helpers as needed, but retain ordinary search's filters/counts/context and inclusive date contract. Avoid building the new page by loading the entire current `SearchPage` and slicing in TypeScript. A date-only inventory cannot be implemented by inventing a wildcard lexical query.

For an investigative result walk, cursors bind query/filter/sort, last sort key, initial membership high-water and a corpus revision. On a corpus/ranking/association/eligibility change that could alter ordering, return a typed `retrieval-changed` result so the agent can start a fresh query, rather than pretending BM25 ranks are an immutable snapshot. Add a retrieval revision covering thought creation as well as titles/responses/associations/rejection; the existing spelling revision alone is not sufficient for a new date-only inventory. One persisted step receipt always replays its original bounded page only while its exposure fence is valid. Page limits are not a limit on how many queries/pages the agent may request.

Every tool argument is validated against an exact run-specific union; unknown/duplicate fields and caller-selected authority are rejected. A denied tool request fails closed without executing it or converting its arguments into user-visible prose. Model requests may change search parameters freely; they cannot widen scope to rejected material.

### Conversation completion

```json
{"version":1,"kind":"search-reply","reply":"Which project did you mean?","disposition":"awaiting-user","sourceThoughtIds":[]}
```

`disposition` is `awaiting-user` or `done`. Both **complete this run** and release its active slot. `done` means the present reply is finished, not that the session expires. A clarification is a retained assistant message, not a fallback thought and not a native job waiting forever for input. The next answer admits a new turn/run. An honest no-findings reply is valid and need not add any discoveries.

The agent can ask clarification when a time range, topic, or starting point is ambiguous, or proceed with an explicitly stated reasonable interpretation. It must distinguish discovery explanation from new speculation and not answer an idea-development request by secretly invoking Evolve. Structured `sourceThoughtIds` are unique current full-read references; arbitrary reply prose is not semantically verified merely because it has citations.

### Natural-language time and query provenance

#### Paired clocks: provenance, not caller record authority

For this workflow every web → Next request carries `X-Thoughtloom-Client-Time` (full ISO date/time with numeric offset or `Z`) and `X-Thoughtloom-Client-Zone` (IANA zone). Next validates and forwards the browser sample; it must not substitute its own server clock and label it “user.” A new-turn payload additionally freezes `requestClock:{at,timeZone}` when the user sends the request. A replay keeps that original payload clock, while its transport headers can report a newer clock. Direct user API clients supply the same intent fields explicitly. The daemon validates timestamps, offsets and zone consistency and stamps `daemonObservedAt` with its own clock. Canonical `created_at`, activity, admission, rejection, deletion and execution timestamps **never** come from these client fields.

The prompt's clock context uses full dates/offsets/zones, for example:

```text
(user 2026-11-06T09:35:00.000-05:00 [America/New_York], client-reported;
 database 2026-11-06T14:35:00.120Z [UTC], daemon-observed)
```

Retain the exact client sample and daemon observation instant; derive `clientMinusDaemonMs` as reported client instant minus daemon receipt instant. This is an apparent clock offset including unknown network/transit delay, **not verified clock synchronization**. An offset/zone contradiction is malformed input; a syntactically valid skewed client clock is retained and labeled rather than changing daemon record times, being silently “corrected,” or automatically shifting historical SQL dates. Show the agent both anchors and their provenance. It may clarify a consequential conflict, but no arbitrary skew threshold or morning-hour wizard blocks ordinary investigation. Client-clock text is untrusted context/data, not an instruction or source of execution authority.

#### When clock context is attached

- Every fresh native search context receives the paired clocks with its initial prepared prompt, because none has been sent to that native session yet. Its trusted `clockContext` separates an immutable `requestAnchor` (frozen request clock plus daemon observation) from `observedNow` (latest available browser sample, its daemon receipt instant and age, and the daemon's current preparation time). If both are the same sample, that is explicit rather than an invented second observation. A delayed first execution can therefore receive current clock context without moving the original phrase anchor.
- During a long turn, the daemon checks elapsed time at the **next existing native/tool boundary**. If more than 3,600 seconds have passed since the last attachment, include updated clock context when preparing the next model-bound initial/capability-result input. It does not start a timer-driven model call, enqueue a clock-only turn, impose an investigation limit, or mutate a prepared/submitted prompt. Observation-only calls cannot deliver a new prompt; a due refresh waits for the next normal model-bound input.
- Web polls/commands can refresh a small latest-clock cache for active sessions without model work. Persist clock samples only when used in admitted intent or an immutable prepared step, not as a new durable row for every poll. After restart use a new browser sample if one arrives, otherwise the last retained client sample, explicitly labeled “last reported at …” with its age and a fresh daemon clock. Do not invent a live user time when the browser is closed. The agent can reason from the disclosed elapsed time; any extrapolation is labeled an estimate, not a fresh client observation.
- The most recent attachment's daemon timestamp and clock sample are part of exact persisted step input; retries and uncertain recovery reuse those bytes and never append a different clock to the same prompt identity. A successor can attach a fresh `observedNow` pair when due, referring back to the unchanged `requestAnchor`. Use an injected elapsed clock while alive; after restart, use retained daemon timestamps, and a detected backwards clock discontinuity forces a fresh labeled clock context at the next eligible boundary rather than treating time as authoritative or indefinitely delaying refresh.

#### Agent-owned interpretation with trusted UTC conversion

“Yesterday morning” is interpreted against the original request's reported local date/zone with its paired daemon anchor, not silently against a later refresh or the day a clarification arrives. The agent can infer a sensible morning interval and search, explaining its interpretation when useful; no fixed morning preset or mandatory hours question is required. It asks only when genuinely ambiguous. A later new request saying “today” has its own frozen clock pair. A changed browser timezone or an hourly refresh does not rewrite an earlier range or request anchor.

`normalizeTimeRange` is a calendar/UTC conversion primitive, **not a deterministic natural-language parser**. `intentTurnPosition` must identify an eligible user turn in this same session; the daemon supplies its retained clock anchors. The agent chooses the interpretation and endpoints. Trusted code verifies each offset against the supplied IANA zone at that endpoint, rejects nonexistent local times, and requires an explicit offset to distinguish a DST fold. It returns the original interpretation/endpoints/zone, UTC `[from,until)`, anchor identity/provenance, and `basis:'agent-interpretation'`. The agent can adjust malformed endpoints or clarify a genuine ambiguity; it does not gain timestamp authority over stored records. Search date filters apply those UTC bounds to **daemon-recorded thought creation times**, not client capture times, session activity, file mtime or title edits. No automatic clock-skew rebasing is applied to the library timeline.

Persist query and time-conversion outputs as exact step results. A trusted context builder may reuse recognized structured receipts only if their generating run's complete retained source exposures are currently eligible; it never loads raw native history or machine transcripts wholesale. A model saying “the user confirmed” cannot manufacture a stronger provenance flag: user wording is retained separately, while model-interpreted bounds stay labeled. If source dependencies become unsafe, drop the derived topic/query/range instead of retaining rejected material through a time receipt. The original client/daemon clock samples alone are not a topic summary and do not authorize reuse of unsafe prose.

## 6. Rejection-safe resumption and native history

### Do not feed an old transcript back wholesale

Filtering only `discovery.thought_id` is insufficient. Old assistant text, user follow-ups, a search query, tool snippet/result, rationale, or a compaction can already contain or derive from rejected thinking. Rejection is an AI eligibility change, not a request to modify immutable original thoughts or promise retraction from providers.

Use two separate projections:

- **Deliberate user history:** exact retained conversation/rationale plus current unavailable/rejected indicators, explicitly requested. It is never an agent input or included in ordinary BFF composer state.
- **Normal/session AI context:** only currently eligible messages/rationales/structured state; resolve thought DTOs through AI normal scope. Omit unsafe prose as a whole and use a content-free “earlier context unavailable” marker. Do not try to redact words inside generated prose with regexes or ask a model to sanitize material it must no longer receive.

Normal user session conversation uses the same conservative dependency eligibility as the AI projection, even though other existing user APIs can deliberately inspect broader history. This is a new search-specific boundary, not a change to the existing Thought/Response DTO policies.

### Dependency closure is daemon-owned

1. Create one daemon-owned composer context for a blank draft. Every normal message/discovery page and thought preview offered in that search workspace requires its `composerId`. In the same short transaction that reads eligible output, union **all actually offered source identities and source dependencies** into `search_composer_dependencies`, then return the page plus a signed token for the updated composer revision. A message adds its flattened dependency set; a discovery adds its target and complete rationale dependencies when that rationale is offered; a preview adds the thought and any exposed eligible provenance. Referenced identities are exposures, not AI full-read witnesses. Returning a content-free unavailable placeholder does not expose the hidden prose or identities. This covers older pages, expanded sources and rationale outside the next model's initial window.
2. Coverage is **monotonic for that draft**: reading another page, changing page size, refreshing metadata or receiving a newer token never drops earlier offered dependencies. Tokens bind `{sessionId,composerId,composerRevision,eligibilityRevision}`; the composer ID names the server-held complete offered-context union, so there is no undefined client-chosen “offered boundary.” Metadata alone cannot mint a token with reduced coverage. Parallel page responses can arrive out of order: admission requires the exact current composer revision, and refresh of the same composer returns its latest token without resetting coverage.
3. At admission, validate the exact composer/token, active state, current source eligibility and starting references in one immediate transaction. Copy the **whole offered union**, not just the next prompt's selected history, onto the new user message and `run_context`; insert the turn/run/message and consume the composer atomically. A page transaction that won the race first makes an older token stale. A page read that loses to consumption returns `409` without offering new prose. A rejected source invalidates that composer permanently in the rejection transaction, including reject-then-restore before admission. `409 context-changed` means the draft must be explicitly reviewed/discarded and restated in a new blank composer, not silently resubmitted with freshly minted empty coverage.
4. At initial preparation and later session-local model reads, separately add the source dependency union of **everything actually sent to the model** into `run_context` before native transmission. The bounded model history window is a performance choice, not the user-message dependency boundary. Raw user history is never a seed.
5. Every assistant reply, rationale and derived query/time interpretation inherits **all** sources exposed before its publication in the generating run, including snippets, connection/response context, indirect IDs and inherited message dependencies—not just cited or discovered IDs. Final replies therefore depend on the full run exposure set; an earlier committed rationale cannot have depended on later reads. This deliberately over-redacts when a run read something irrelevant. Dependency-free user intent remains reusable.
6. At every context read/publication, evaluate those dependencies under current AI visibility. A response dependency is unsafe if **any** associated thought is rejected. A connection dependency needs eligible endpoints and no explicit connection rejection. Rejected parent/source references are removed from fresh Thought DTOs, not from stored ancestry. If an earlier message is omitted, never include a later message that indirectly depends on it; flatten closure when persisting it rather than recursively walking transcripts on each resume.
7. `contextMode:'restart'` suppresses automatic old-dialogue/rationale/query-plan seeding, **not composer dependency inheritance**. To start independent intent after invalidation, the user explicitly opens a new blank composer and may choose currently eligible starting notes. Do not migrate its old draft or previously offered panels into a new context ID automatically. If that new composer then reads an older normal page, those sources again enter its ledger. History inspection is a separate non-composer surface: it cannot issue/extend normal composer tokens or automatically transfer text into a draft.

For example, a user reads old rationale based on thought T, types a paraphrase, and moves to the latest page. T remains in that composer's ledger. If rejection wins before admission, admission fails; if admission wins first, the saved user message inherits T and the subsequent rejection fences the run and hides that message from future AI context. Fetching a fresh latest-page token cannot wash away T. This covers the older-page case in **OR-AS-01**; admission/recovery responses and cross-composer display need the additional boundary below.

### Control receipts cannot supply conversation prose

Choose **control-only** turn admission/reconciliation responses rather than registering prose against whichever composer happens to exist when a response arrives. New admission, exact POST replay and `turns/by-key` all return the same `SearchTurnControlView`: `{receipt,run,session}` with message/run IDs and control/session metadata only. They return no `message` object, submitted/recovered text, assistant reply, discovery rationale, source snippets or other conversation excerpts. Existing run-status/Stop responses remain control-only too. These calls need no current composer and therefore must never serve as a conversation read. A receipt confirms admission and IDs, not current content eligibility.

Normal conversation/discovery/preview display has exactly one path: a fresh ledger-aware read for the **current** composer. A normal response explicitly echoes `composerId` alongside its token/revision. When moving from C1 to C2, clear/hide C1-bound prose, cached pages, source previews and optimistic/submitted-text bubbles; re-fetch any content that should remain visible with C2 so its dependencies are recorded before display. Do not promote a locally retained idempotency-request snapshot into the normal transcript. That snapshot may remain frozen for exact reconciliation, but it is not a content-read receipt.

Delayed responses cannot change this rule. A control response for C1 may update the known admission/run controls but cannot insert conversation content beside C2 or replace C2's token. A prose response requested for C1 is discarded for C2 even if it arrives later and its text looked eligible when read. Cached prose is never re-tagged with a new composer ID; only a new server read can register it. A failed/invalidated current-composer read must not fall back to old response/request prose. Out-of-order replies within one composer still use its monotonic ledger and exact revision rules above; this is a response-boundary correction, not a ledger redesign.

Thus, if M1 inherits T through C1, a later by-key lookup while blank C2 is active supplies only M1's ID. Showing M1 requires a fresh normal read for C2: before rejection that read adds T to C2's ledger, and rejecting T then invalidates C2 so refreshing **that same composer** returns `409 context-changed`. If T was rejected first, M1 is a content-free unavailable placeholder, never recovered prose. No admission/replay/lookup cache can supply M1's text while leaving C2's ledger empty. This addresses the remaining recovery-response case in **OR-AS-01** without changing saved-message immutability or claiming detection of arbitrary human retyping.

An application cannot prove the semantic origin of arbitrary text manually retyped or pasted by a person. Do not claim such a detector. The enforceable boundary is that known saved history, inspection routes, references and derived state never flow automatically into AI. User-history inspection must not offer “send this rejected passage to search”; arbitrary-input prompt instructions also forbid reconstructing rejected sources.

### Fresh native identity per user turn

For each newly admitted user message create a new daemon run ID, `ses_...` native identity, and `msg_...` initial prompt identity. A turn's internal investigation may reuse that native session across its own exact steps; a later user turn never does. Do not fork/copy/revert/compact an old native session to manufacture a clean one. Existing adapters already quarantine untracked compactions/tools/synthetic inputs; keep that behavior.

This prevents old native tool messages from re-entering a later turn just because only the visible transcript was filtered. Saved messages and safe structured state are rebuilt from SQLite under current scope; neither native conversation history nor an export report is an application context authority.

### Rejection while a turn is running

- On rejection, identify affected active search runs from `run_context` and active composers from their offered dependency ledger (including response-member and connection-endpoint eligibility), with indexes rather than a full library-content snapshot. In the **same rejection transaction**, interrupt affected runs, increment generation, retain `outcome_reason='context-invalidated'`, release active slots, mark remote cancellation pending, and invalidate affected composers. Restoration never revives them, even if it occurs before the next worker poll/admission.
- Recheck current eligibility and claim/prompt/session ownership before and after every asynchronous native boundary and before cached result delivery, capability execution, successor preparation or finalization. The existing guarded aggregate's commit-after-fence behavior must remain: do not throw inside the transaction and accidentally roll back the interruption.
- A discovery committed before rejection remains retained history but immediately loses its unsafe normal presentation. A proposal whose final transaction loses the race cannot publish. If target remains active but rationale depends on rejected material, return the target's fresh safe metadata with `why:null, reasonStatus:'context-unavailable'`; never send the old rationale to AI. A rejected target is an unavailable placeholder without its thought identity/title/text in normal context.
- Never resume the contaminated native session or submit another step to it. A later explicit user turn gets a new run and rebuilt eligible context. Do not automatically regenerate dialogue, re-add discoveries, restart investigation, or pretend to undo previously sent bytes.
- Cancellation is best effort and cannot retract an in-flight provider request. A request authorized before the rejection commit may already have crossed the network boundary; after the commit all local outputs and further application capabilities are fenced. State this limitation rather than promising instantaneous remote cessation.

No amount of local redaction makes the operator's retained native history disappear. Do not use that history for future AI work. The daemon may observe it only under owned recovery/cleanup authority, and never publish a late rejected result or use rejected text to prepare another model input.

### Bounded context, not hidden effort quotas

Recommendation: initial context includes current request, eligible starting references, the latest safe clarification/exchange, and a first bounded discovery-reference page. Older eligible messages/discoveries can be paged through the session-local read capabilities. The full transcript is retained indefinitely; no automatic lossy model summary is required. Sources are still fully read before discovery evidence can be asserted; a prior turn's read witness does not transfer merely because its thought ID appears in dialogue.

Choose transfer/window sizes against the configured model context at implementation time and expose omissions/continuations explicitly. A too-large single request/read must receive a clear technical error or a designed chunked-read contract, never silent truncation falsely marked as a full read. This design does not impose a count of turns, searches, notes, tokens or elapsed model work. Existing polling/concurrency/HTTP timeouts remain technical controls, not effort budgets.

## 7. Discoveries, removal, naming, and activity

- **Identity/dedup:** one unremoved **occurrence** per thought per session, regardless of thought/response hit duplication. Historical removed occurrences can repeat that thought ID. Each occurrence has a new daemon-owned entry ID; the partial unique index covers structural membership (`removed_at IS NULL`), even if rejection temporarily hides it. `addDiscovery` still targets a thought, not a standalone response-as-idea entry.
- **Order:** each new occurrence appends at `MAX(position)+1` across all that session's occurrences, including removed ones, inside an immediate transaction. Rediscovery is a new tail position, not restoration to an old slot. No reorder command or ranking churn.
- **Rationale:** rationale/evidence/dependencies are immutable per occurrence. A fresh add with an already-unremoved occurrence returns that ID without rewriting its why. If none is unremoved, the fresh add supplies a newly validated why and current full-read target/evidence witnesses and creates another occurrence; it never copies an old rationale automatically. Current title/author/kind/date still resolve from the thought service. An old rationale cannot override current title metadata or imply endorsement.
- **Removal:** user-only write-once `removed_at` on the specified **entry ID**. Hide that occurrence from normal lists and retain it in deliberate history. A later fresh agent add may reference the same thought, creating a new ID that the user can remove again. No rejection marker, library change, automatic undo, or clearing of an old removal is involved. Earlier conversation is retained under its own eligibility rules.
- **Fresh command vs replay:** fresh means a distinct daemon-persisted agent prompt/step with no committed capability result, possibly in the same turn. Before inspecting current membership, validate authority and match/replay any existing receipt. The exact immutable result is `{type:'discovery-add',entryId,outcome:'added'|'already-active'}`. It confirms a past effect/no-op, not current visibility. A browser retry, cached success, worker recovery or page refresh never becomes a fresh add. Only a new agent `addDiscovery` command can create a rediscovery occurrence.
- **Rejection vs removal:** eligibility changes do not set `removed_at`; restoration can reveal an unremoved retained occurrence/rationale once all its dependencies are eligible again, but never revives a user-removed occurrence or an interrupted native run. An eligible target with an unsafe old rationale keeps that rationale unavailable. Discuss it freshly or remove that occurrence and allow a fresh eligible agent add; do not silently replace its saved why.
- **Titles:** create a neutral daemon title such as `Search — 2026-11-06` and allow explicit user rename. Do not run a separate title model or copy a discovered thought's title into session metadata. Session titles are human-only and never part of native ownership metadata or AI intent. No title write touches `thought_titles`.
- **Activity:** update on turn admission, confirmed new occurrence (including rediscovery), final reply, explicit Stop, rename, or first removal of an occurrence. Polling, opening history, native retries, `already-active` no-ops, duplicate/replayed commands and repeated Stop/removal do not bump it. Use daemon times; dates must not be future timestamps supplied by clients.

All capability result cases below remain subject to the existing claim, current-prompt and eligibility fences. A stopped, stale or rejected-context run cannot obtain replay authority merely because a receipt exists.

| Race/replay | Required linearized result |
| --- | --- |
| P1 added E1, user removed E1, then P1 is replayed | Return P1's original receipt naming E1, with no membership write. It cannot clear E1's removal or allocate E2. |
| Fresh P2 first dispatch sees no unremoved occurrence after E1 removal | Validate its new proposal/full reads and append E2 with a new ID/why/order; keep E1 removed in history. Preparation time is not execution: the first-dispatch transaction determines which membership state P2 sees. |
| Fresh P2 first dispatch sees E1 still unremoved; user removes E1 afterwards | P2 durably records `already-active` E1. A later replay of P2 cannot add E2 merely because membership changed. Another fresh agent step is required. |
| Two fresh adds race | Immediate transactions plus the partial unique index admit at most one unremoved occurrence. The second sees it and records `already-active`, unless an intervening user removal legitimately permits another new occurrence. |
| Old `DELETE .../E1` is retried after E2 was added | Return `204` for E1 without touching E2, its rationale/order or activity. Removing E2 requires E2's entry ID. Never remove “whatever entry currently has this thought ID.” |
| Cached add receipt, old list page or delayed read arrives after removal | None can mutate membership or reconstruct it by merging receipt IDs. Normal pages reflect live removal state at their read transaction; clients reject pages older than a known session revision and retain acknowledged occurrence-ID removals until a fresh list reconciles them. A fresh E2 is distinct from stale E1. |

## 8. Retention and deletion, including active work

### Local application contract

Retain live session content indefinitely until an explicit user Delete. Deletion immediately removes it from normal and history routes, revokes all execution/composer/context authority, and removes messages, discoveries (including removed rows), composer receipts/dependencies, query/time receipts, exact prompt inputs, result caches, bindings and other content-bearing search execution rows from the application database. It does **not** delete a referenced thought, its title, a library response, a connection, provenance, rejection state, or independent weave/Evolve/export/import run.

Existing immutable-run guards currently prohibit this. Proposed solution: a narrow **search-only purge**, not globally mutable/deletable runs:

1. In one immediate transaction, locate owned search runs, fence their generations, interrupt active work, set the session tombstone (`deleted_at`, `title=NULL`), invalidate composers, and create metadata-only cleanup rows for bindings not proven settled. Copy the recorded binding, current/last authorized prompt identity, process owner, submission/native phase and hash of that exact input before erasing it. If no prompt was authorized, retain `never-submitted`; any authorized but unconfirmed dispatch is `uncertain`, not “not admitted.” Start `drain_state='waiting'` for a known local flight. Native phase evidence and local flight outcome are distinct facts.
2. Delete discoveries/dependencies, composer rows and messages while turn mappings still exist; delete search step/context/binding rows under deletion guards; delete search runs, cascading their now-empty turn mappings. Verify no search content rows remain, then commit. Never disable triggers/FKs at request time. No deletion exception applies to other run kinds, library tables, or an undeleted session. Clear active-session clock caches as well.
3. Public routes now return `404`; known-tombstone Delete replay returns `204`. Late callbacks cannot recreate local data. Creation-key replay returns `409 session-deleted`; a new explicit key can create a different session. Return after local fence/purge without waiting for native cleanup.
4. Reuse the existing worker's **per-run flight lane**: preserve its registered promise until all owned setup/submit/observe work settles, block new execution ticks for purged IDs, and expose a drain/join operation to cleanup. Do not clear the flight map merely because the SQL run disappeared. Cleanup for that ID waits on the captured execution promise before it may record `drain_state='drained'`; it is not an independently racing ordinary worker tick. Content-free transport-outcome callbacks may monotonically update the cleanup row after purge (for example a verified admission ACK), but may not publish output or reacquire execution authority. Keep these joins in the same daemon-owned worker/supervisor lifetime, not a second workflow engine.
5. Factor the existing `cancelOwned` into a **cancellation-only identity contract** so cleanup need not retain prompt text merely to satisfy its current signature. After execution drain, verify recorded service/native ownership, cancel the owned inbox ID, interrupt the owned session, and reconcile terminal identity plus empty inbox/inactive state. A pre-drain interrupt may be a best-effort early action, but never settlement evidence. An authorized request can still be admitted afterwards.
6. Persist cleanup until the settlement conditions below are met. Endpoint outage or ownership drift stays `pending`/`ownership-conflict`; never retarget another service, send credentials to an old foreign endpoint, or invent a replacement identity. Only after conclusive settlement may the binding/evidence cleanup record be cleared. The non-content session tombstone remains for creation replay safety.

### Drain and uncertain admission: settlement requires positive evidence

| Situation | Required cleanup behavior |
| --- | --- |
| No submission ever authorized, execution flight joined | `never-submitted + drained` can settle locally. A missing binding alone is not that proof; session-setup work must also be drained. This says no prompt was sent, not that an external empty session container was deleted. |
| Prompt admitted, or authorization recorded with outcome unknown | Join the local flight, then retain the same binding/prompt hash and observe/cancel that identity. Empty inbox/history and inactive state **do not** settle a potentially delayed admission. A transport promise returning/aborting/timing out is not proof that the service cannot later accept its request. |
| Owned prompt later appears | Correlate its native user-message identity and input hash, record `admitted`, cancel/interrupt as needed, and require a corresponding terminal/idle outcome plus empty inbox/inactive state before `terminal + drained` can settle. Cleanup inspects native bytes only to validate identity/hash, never to supply model context or retain output. Failed/interrupted terminal outcomes can settle cancellation; they do not become successful search replies. |
| Daemon restarts/crashes before drain is durably known | Retain `unknown-after-restart` and admission evidence. This design supports one execution-owner daemon per database: enforce exclusive execution ownership for its lifetime (a daemon-owned advisory lock), and fail closed if a predecessor may still issue calls. Once predecessor termination/drain is established, the local lane can be marked drained, but an already dispatched network request remains `uncertain` until its matching terminal evidence appears. Do not resend it. |
| Authorized prompt never appears and no native durable admission-ban/terminal receipt exists | Keep metadata-only cleanup pending indefinitely. The current facade has no verified future-admission barrier; absence or an arbitrary grace period cannot manufacture one. Local deletion remains successful, but remote stop settlement is unresolved. |

This explicitly closes review finding **OR-AS-02**: hold an authorized `prompt()` before native admission, delete, and observe empty/inactive native state. Cleanup must retain its binding/evidence and wait for the existing execution flight; if that call later admits, cancel/reconcile it before settlement. If the call times out before late admission, the flight can be drained but the durable `uncertain` admission still prevents premature clearing. A crash/restart cannot wash away that evidence.

Cleanup polling survives restart and runs even when ordinary search execution is disabled; without matching credentials it remains pending. Same-owner pending cancellation after Stop/rejection follows the same drain/uncertain-admission rule, though retained live-session run journals can supply its evidence without a purge copy. HTTP Delete does not promise immediate remote cessation or wait for provider/service availability. These are explicit proposed integration changes; the current supervisor/adapter does not already guarantee them.

### External retention is a different promise

The current facade has no verified native-session-delete or message-redaction operation. Therefore **Delete means local logical content deletion and cancellation, not hard deletion from OpenCode, provider logs, backups, SQLite free pages/WAL, or copied user exports**. Already transmitted native history may remain indefinitely under operator/provider policy. No new model input may reuse it. Do not silently alter that policy, start/upgrade the service, or promise deletion from a shared operator database.

The user has resolved this responsibility boundary: Thoughtloom must delete its local session content correctly; OpenCode/provider retention follows their own policies and is outside this feature's retention management. Keep the brief disclosure above, with no native-hard-delete guarantee, required integration, or additional approval gate before use. Local purge, late-callback fencing and honest cancellation settlement remain required; this decision does not weaken them.

## 9. Proposed daemon API

All session endpoints are **user-only**, bearer-authenticated, private/no-store, strict JSON/query parsing including duplicate-key rejection, and never advertised to agents. AI-role credentials get `403`. Next later adds fixed-purpose server routes with existing Host/Origin checks and forwarded client-clock headers; no browser daemon credentials or catch-all proxy. Session/composer metadata reads/removal/rename/Delete work without agent configuration; only new-turn execution requires it. Normal workspace content reads require a composer context so they cannot silently bypass its offered-content ledger; explicit history reads forbid `composerId` and return no composer token.

### Routes

| Route | Input | Success / semantics |
| --- | --- | --- |
| `POST /search-sessions` | `{}`, required `Idempotency-Key` | `201 {session}`; `200` identical replay with same ID. Empty session creation does not invoke an agent. Rename is a separate command. |
| `GET /search-sessions` | `cursor?`, `limit?` | `200 {items,nextCursor}`; live session summaries, last activity descending with stable sequence tie-breaker. No conversation preview text. |
| `GET /search-sessions/:id` | No query | `200 {session,activeRun,eligibilityRevision}`. Metadata/current control state only; cannot mint/reset composer coverage. |
| `PATCH /search-sessions/:id` | `{title}`, `If-Match` revision | `200 {session}`; user metadata only. |
| `POST /search-sessions/:id/composer-contexts` | `{}` | `201 {composerId,contextToken,eligibilityRevision}` for a **new blank draft**. Does not copy an old draft or inherit an old context ID. No model call. |
| `GET /search-sessions/:id/composer-contexts/:composerId` | No query | `200 {composerId,contextToken,eligibilityRevision}` after revalidating its complete offered union; invalidated/consumed/discarded context: `409 context-changed`. Refresh never resets dependencies. |
| `DELETE /search-sessions/:id/composer-contexts/:composerId` | No body/query | `204`; explicitly discard that composer, never the saved session or library. Clears unsent draft association, not a rebase permission for its old text. |
| `POST /search-sessions/:id/turns` | `{text,startingThoughtIds?:[],requestClock:{at,timeZone},effort?:label,contextMode?:'continue'|'restart',composerId,contextToken}`, required `Idempotency-Key` | `201 SearchTurnControlView`; `200` control-only exact replay. Shape is `{receipt,run,session}`, **never a message/prose object**. Default mode `continue`; proposed default effort `standard`. Canonical IDs/record times are daemon-owned; client clock is intent only. |
| `GET /search-sessions/:id/turns/by-key/:requestKey` | No query | `200 SearchTurnControlView` for an admitted command; `404` absent/deleted. Reconciles IDs/status only, never returns recovered user/assistant text for display beside an unregistered composer. |
| `GET /search-sessions/:id/messages` | `scope=normal|history`, `composerId` required only for normal, `cursor?`, `limit?` | Normal: `200 {items,nextCursor,sessionRevision,eligibilityRevision,composerId,contextToken}`. Chronological stable positions; register the whole offered page before return. Unsafe messages are placeholders. Explicit history omits composer/token and is not a normal-display fallback. |
| `GET /search-sessions/:id/discoveries` | Same scope/composer/page rules | Same page envelope; occurrence append order. Normal excludes removed occurrences, registers offered target/rationale dependencies and returns current membership at read time. History includes removed occurrences, so thought IDs may repeat there. |
| `GET /search-sessions/:id/composer-contexts/:composerId/thoughts/:thoughtId` | No query | `200 {thought,sessionRevision,eligibilityRevision,composerId,contextToken}`; fresh AI-normal preview with exposed eligible provenance registered. This user read is not a model full-read witness. Existing library/user-history routes are not a search preview bypass. |
| `DELETE /search-sessions/:id/discoveries/:entryId` | No body; no query | `204` plus `Search-Session-Revision` header for first removal or replay. The entry must belong to the session. Targets only this occurrence ID; retrying an old removal never removes a later occurrence of the same thought. |
| `DELETE /search-sessions/:id` | No body; no query | `204` after local purge/fence; known deleted ID also `204`. No matching row: `404`. Does not wait for remote settlement. |
| `GET /runs/:id` | Existing user-only route | Add search-specific DTO below; deleted search runs return `404`. Reads/Stop must remain available without current execution configuration. |
| `POST /runs/:id/stop` | Existing `{}` body | Locally fence current search turn; retain user message and committed discoveries. Returns current search-run DTO, pending remote settlement distinguished from execution status. |

Session creation accepts `{}` only, so replay never compares a later renamed title with an original creation payload or needs a second retained title snapshot. No idempotency key is an entity ID. Reuse the existing 1–128 ASCII key grammar from import admission.

For turns compare exact user text and canonical admitted intent (including the frozen request clock, composer ID and original token), with omitted/default distinctions normalized once. A matching key is resolved **before** checking whether another turn is active, its composer is consumed or its context token is now stale; replay returns its immutable ID receipt plus current run/session control projections, never prepares another prompt or includes the saved message body. Fresh transport clock headers do not alter replay identity or the original phrase anchor. Different payload with the same key is `409 idempotency-conflict`. A new key while a turn is active is `409 turn-active`. Deletion wins over all replay. `contextToken` authenticates server-held complete offered-context coverage; it is not an authorization credential or caller-owned timestamp. A key absent on a check is not proof no earlier request is still in transit; resend only the exact same key/payload when deliberately reconciling, not a new-key retry. The original request snapshot is not a substitute for a fresh normal message read.

### DTOs

```ts
type SearchSessionView = {
  id: string; title: string; createdAt: string; lastActivityAt: string;
  revision: number;
};
type SearchRunView = {
  id: string; kind: 'search'; status: RunStatus;
  searchSessionId: string; userMessageId: string;
  assistantMessageId: string | null;
  outcomeReason: 'stopped' | 'context-invalidated' | 'failed' | null;
  cancellation: 'none' | 'pending' | 'settled';
};
type SearchTurnReceipt = {
  searchSessionId: string; runId: string; userMessageId: string;
  admittedAt: string;
};
type SearchTurnControlView = {
  receipt: SearchTurnReceipt; // immutable admission identity, no prose
  run: SearchRunView; session: SearchSessionView; // current control metadata
};
type SearchMessageView = {
  id: string; position: number; runId: string;
  role: 'user' | 'assistant'; createdAt: string;
  text: string | null; // null when normal-scope context is unavailable
  disposition: 'awaiting-user' | 'done' | null;
  evidenceThoughtIds: readonly string[];
  availability: 'available' | 'context-unavailable';
};
type SearchDiscoveryView = {
  id: string; position: number; addedAt: string; // occurrence ID/order, not thought identity
  thought: ThoughtSummary | null; // current scoped identity/title/attribution
  why: string | null; evidenceThoughtIds: readonly string[];
  reasonStatus: 'available' | 'context-unavailable';
  availability: 'available' | 'thought-unavailable';
  removedAt: string | null; // populated only in explicit history projection
};
```

`ThoughtSummary` means `{id,title,titleAuthor,author,kind,createdAt}` with the established fallback label, not a new immutable title snapshot. Normal unsafe messages return no prose/evidence IDs; unsafe target discoveries return no target/evidence identity or title. For active targets with unsafe rationale, evidence IDs are empty. History may expose exact retained prose/references and removal state only to the user, with live eligibility indicators. Raw native IDs/binding, envelopes, tool payloads, reasoning and provider errors never appear in these DTOs. Discovery counts/confirmed-ID arrays are not embedded unboundedly into a run status.

`SearchTurnControlView` deliberately does not reuse the current Evolve admission's returned contribution/text shape (`src/domain/agent.ts:20,35–38`). Its receipt can locate a message but cannot render it. Decode the exact control DTO, checking receipt/run/session identity agreement; reject an unexpected `message`/text-bearing field rather than supporting a compatibility fallback. Only `SearchMessageView` from a fresh ledger-aware current-composer read supplies normal conversation content. Session title is existing human-only metadata, never a recovered message excerpt or AI context.

### Concurrency, pagination, and errors

- `If-Match` for rename compares session revision; malformed header is `400`, stale revision is `409 revision-conflict`. Content removal and session Delete are idempotent fixed-target actions; they need not fail because an agent added another discovery in the meantime.
- Turn context tokens bind session ID, composer ID, exact composer revision and eligibility revision. Every normal page/preview extends the persistent offered union before returning prose and a new token. Process-local signing means daemon restart requires refreshing the **same composer**, not creating a smaller context. Refresh revalidates its existing union; an unsafe/invalidated composer cannot become empty and active. Persist admitted canonical token data for exact replay; replay is not rejected merely because its old signature expired on restart.
- Admission/replay/by-key/run/Stop results are control-only and never render message bodies. Normal content responses are bound to their echoed composer ID; a response/cache/request snapshot from C1 cannot be re-tagged or displayed beside C2. Re-fetch visible prose for C2, even if that same message was previously displayed under C1. No failure path falls back to recovered or optimistic request prose.
- Discovery membership is read from live occurrence rows, never reconstructed from add receipts or cached page IDs. Normal page/preview `sessionRevision` and removal's `Search-Session-Revision` header prevent an older in-flight page from overwriting a known newer removal. Forward that header through the fixed Next boundary. Retain acknowledged removed entry IDs until fresh listing reconciles them; do not suppress later rediscovery by thought ID. Revision gating does not promise that a read observes future writes: a membership change after a page's read transaction is picked up by another fresh read.
- Persistent pages use keyset positions and an initial membership high-water; cursors are authenticated and bound to route/session/scope/limit/direction. Later arrivals require a fresh page walk. Eligibility/removal state stays live. Empty terminal pages are legal; never hold a SQLite transaction across HTTP requests.
- For last-activity session lists, bind the ordered walk to a list revision. If activity changes ordering, return `409 list-changed` and restart from page one rather than claiming no skips/duplicates in a mutable ordering. Other collection pages use immutable positions. This avoids a persisted list-snapshot table for the initial feature.
- `400 invalid-search-request`: invalid/unknown/duplicate fields, malformed clock/zone/date/cursor, missing normal-read composer or history request with composer, disallowed scope. `401`: authentication. `403`: AI role or forbidden control authority. `404`: missing/invisible/deleted session, composer, entry, run, or starting thought. `409`: exact codes `idempotency-conflict`, `session-deleted`, `turn-active`, `context-changed`, `revision-conflict`, or `list-changed`. `413 request-too-large`: explicit technical transport bound. `503 agents-not-configured` before new-turn admission; a configured but unavailable native service leaves an already admitted turn queued/uncertain. Unexpected failures are sanitized `500`.
- Check = read the known admission/run; observation is daemon-owned. No “Check” endpoint secretly submits again. Stop is not Delete, browser leave is neither, and native completion is not local reply/discovery finalization. A terminal failed/stopped turn may be followed by a new explicit turn; no automatic retry cloning its text and identities.

## 10. Runtime/configuration and implementation boundaries

Reuse explicit `THOUGHTLOOM_AGENT_CONFIG`, existing `quick/standard/thorough` mappings, lazy attachment, service capability checks, fixed service/binding identity on recovery, and deny-all native permissions. Search effort default `standard` is a recommendation specific to this feature, not a claim of an already agreed new search setting. The immutable admitted effort selects the variant before binding; changed configuration cannot retarget an existing bound run. No new environment variable is required initially.

Reuse technical supervisor capacity (currently 8 concurrent ticks), 250 ms technical poll and per-request 10 s SDK transport timeout as starting operational defaults, not new product quotas. Add search scans/cleanup to the existing bounded lifecycle deliberately; no autonomous sweeping/revisiting, provider calls on GET, or per-browser worker. Plain scoped session reads continue when agents are unconfigured. Native cleanup with unavailable credentials remains honestly pending.

The daemon's database-scoped advisory execution lock and process-instance marker support only local execution ownership/drain evidence; they do not control the operator-managed OpenCode service or replace generation fencing. Shutdown pauses execution, joins existing per-run flights, records safe cleanup progress, then releases the lock. An unclean exit leaves durable uncertain admission intact. The in-memory latest client-clock cache is limited to active sessions and never replaces frozen request anchors or persisted exact prompt bytes. Normal composer page reads may record offered-source metadata, and incoming clock headers may update that cache; neither action admits model work or modifies library knowledge.

Log admission/removal/rename/Stop/invalidation/deletion attempts and outcomes and native-boundary episodes using the shared injected logger. Log session/run/prompt identities and reason codes, not user query text, thought content, rationale, timezone-derived topic strings, raw native exceptions or credentials. Polls stay Verbose; meaningful changes Info; recoverable outage/ownership problems Warning; terminal failures Error. A deleted session's text must not survive in diagnostic payloads.

Recommended incremental delivery boundaries, **only after separate implementation authorization**:

1. Daemon/domain/storage session model, scoped history and owned-fixture migration/purge/rejection tests; ordinary contracts unchanged.
2. Search-run capability/runtime integration, owned native-facade/API recovery tests, and a practical isolated Bun walkthrough. Update schema/API/startup/testing docs in that same daemon change.
3. Fresh independent technical validation of security, deletion and resumption boundaries before client work. The parent owns the current draft review.
4. Separate designer-led screen comps and approved Next client scope against the settled daemon API; expand source-copy/browser allowlists and tests then. No visual design or client implementation is implied by this draft.

## 11. Alternatives, migration preservation, and validation design

### Alternatives and decision

| Alternative | Decision and reason |
| --- | --- |
| Store each search message as a Thought/Evolve contribution | Reject. It creates knowledge/evolution and FTS entries merely by searching, invents fallback developments, and makes session deletion conflict with thought immutability. |
| Reuse Agentic export artifact as conversation | Reject. Report citation/publication logic is useful, but human-only report history cannot stand in for safe resumable dialogue and growing session selections. |
| One native session for a persistent application session; filter discoveries on resume | Reject. Old native user/assistant/tool context can retain rejected content. Local ID filtering does not clean provider history; verified native redaction is absent. |
| Own entirely separate search execution tables/worker | Viable if requirements later diverge fundamentally, but not recommended now. It duplicates binding/claims/steps/uncertain-observation/Stop logic. New session tables are justified; a second execution engine is not. |
| Keep run journals immutable forever and soft-delete only session UI | Reject for the agreed local content-deletion contract. Exact prompts/results would retain conversation copies. Use explicit search-only fenced purge, preserving other kinds' immutable audit records. |
| Always include only newest user message and never conversation | Reject as the general design: loses clarification answers and continuity. A user-selected restart is valid; dependency-closed eligible context is the normal path. |
| Model-supplied citations as sole dependency graph | Reject. It misses search snippets, uncited observations, derived tool queries and contextual follow-ups. Conservative daemon exposure closure is less precise but enforceable. |
| Stateless token covering only the next model window | Reject. A user can paraphrase an older offered page that is outside that window. Use one monotonic composer offered-source ledger and atomic inheritance; never trust a browser list of dependencies. |
| Return saved message prose from admission/replay/by-key lookup | Reject. These calls have no active-composer content-read authority and can return beside a later composer. Keep one control-only DTO and re-fetch prose through current-composer ledger-aware normal reads; do not re-tag caches or promote request snapshots. |
| Permanent thought-level suppression, or clearing an old occurrence's removal on re-add | Reject. User direction permits fresh rediscovery, but old replays must not undo removal. A new occurrence/ID/rationale/tail position preserves both facts with one partial unique membership index and existing step receipts. |
| Clear cleanup after an empty native snapshot or transport timeout | Reject. An already-authorized request can still arrive. Join the existing execution flight and retain unresolved admission until matching terminal evidence; do not invent a future-admission barrier. |
| Deterministic parser/preset wizard for “yesterday morning” | Reject as a substitute for the user's direction. Supply paired clocks, let the agent interpret intent, and use trusted calendar/UTC conversion rather than mandatory hour questions or an app-selected search mode. |
| Automatic AI summary of old dialogue | Defer. It adds another generated artifact/lineage/invalidation problem without being necessary. Paging eligible retained exchanges is sufficient initially. |

### Migration preservation

Use the authoritative `migrate()` transaction with FK and recursive-trigger enforcement on. Detect and widen the actual current `runs` definition, preserving import checks and legacy unmapped-input allowances; do not restore the older bootstrap-only three-kind definition. Stage the incoming FK closure as needed, preserve rowids used by supervisor/receipt order, restore indexes/guards and verify `foreign_key_check` before commit. Review the preexisting import rebuild's assumptions when adding new run FKs. Search-only purge exceptions are deliberate new definitions, not a reason to drop unrelated immutability guards.

Fresh/repeated opens create no sessions or invented messages, reset no statuses, infer no native binding, change no content/title/attribution/rejection/ancestry/provenance, and make no model calls. Old unknown native input remains unknown. Existing thoughts, source bytes, import batches/receipts, shared responses, export artifacts, native run histories and cancellation state must compare equal before/after migration. Transaction fault injection must roll back both schema and data work.

### Test-owned validation path for future implementation

These are required validation boundaries, not claims of tests run now and not an instruction to start TDD during this design invocation. Inspect and extend useful existing suites rather than creating redundant frameworks.

| Boundary | Required controlled evidence |
| --- | --- |
| Domain/intent/time | Exact input/unknown/duplicate field rejection; daemon-owned record times despite skewed client input; frozen original request clock vs fresh replay headers; browser → Next → daemon full date/offset/IANA provenance, midnight and DST gap/fold conversion; first attachment in every fresh native context; exactly one hour vs more than one hour at the next existing boundary; closed browser/stale sample, restart and backwards daemon-clock discontinuity; no clock-only model call, prepared-prompt rewrite or silent relative-range reanchoring. Agent may infer morning without a mandatory preset/question. Ordinary UTC/inclusive search remains unchanged; effort is not a quota. |
| Session persistence | Multiple sessions, refresh/reopen/restart; immutable message ordering and clarification terminal disposition; neutral/renamed titles; activity changes only on real effects; no folders/expiry machinery. |
| Scoped retrieval | Lexical FTS/spellfix reuse and date-only retrieval; page order/revision invalidation; response-hit destination vs thought dedup; unrelated deep-archive candidates; eligible direct connections/ancestry only; snippets never grant full-read evidence. |
| Selection control | Duplicate hits/fresh steps while a thought is unremoved produce one active occurrence, with immutable rationale/order and durable `already-active` receipts. Remove E1, fresh-add E2 with new ID/why/tail position/current full reads, and remove E2 again; history retains both. Old P1/P2 replay and `DELETE E1` retry never create/remove E2. Cover two fresh adds, remove-before/after-first-dispatch ordering, duplicate/replayed activity no-ops, current title resolution, live partial uniqueness even when rejection hides an occurrence, and no library/rejection writes. Cached success/page refresh must not reconstruct membership or overwrite a known newer removal. |
| Rejection/resumption | Reject target, uncited candidate, connection, indirect source, and another member of a shared reply. Old assistant prose/tool queries/time receipts and follow-up messages become unavailable; safe active descendants remain readable with fresh provenance redaction. Next user turn uses a new native ID and no rejected-text sentinel. Explicit user history never enters its prompt. |
| Composer coverage (OR-AS-01) | Retain older-page/preview coverage and token/admission race cases. Add the complete recovery regression: C1 offers T, admitted M1 inherits T, C1 is consumed, blank C2 opens; new-admission response, POST replay and by-key lookup all contain IDs/control metadata but no M1 prose sentinel. To display M1, fetch normally for C2 and prove T entered its ledger; reject T, then refreshing **the same C2** and admitting paraphrased M2 both give 409 rather than washing coverage away. If rejection preceded the C2 read, M1 is a placeholder. Test delayed C1 control/prose responses, cached pages and local submitted snapshots: none may populate C2 without a fresh registered read. Also cover out-of-order pages, restart refreshing the same ledger, reject/restore before admission, `restart` not bypassing coverage, history with no composer token, and no old-prose fallback on failed reads. |
| Races | Held native create/submit/observe/capability/finalize against rejection, Stop, deletion and newer claim. Rejection then restoration before poll cannot revive old run. Reject just before/after discovery commit; removed entry vs delayed cached success. Atomic rollback after result, dependencies or final message has been inserted but before terminal/revision update. |
| Restart/native history | File-backed owned SQLite plus deterministic fake native facade; recover same exact bound prompt after lost ACK, empty history, outage and restart without resend/new binding. Full paginated correlation and quarantine for foreign/altered/compacted/tool history. Future user turn does not reuse old native history. Keep newer-capable-service acceptance. |
| Deletion/cleanup (OR-AS-02) | Delete active/queued/completed/failed sessions; prove absence of all local content-bearing search/composer/clock-cache rows and unchanged library/other-run tables. Hold an authorized prompt before native admission: early empty/inactive observations cannot settle while its execution flight is outstanding; release it, then require cancellation and matching terminal evidence. Repeat with transport timeout before delayed admission, crash/restart before drain evidence, and a prompt that never appears (must stay pending). Metadata-only cleanup retains binding/owner/phase/hash without a prompt sentinel. Cover endpoint outage, credential/ownership drift, never-submitted proof, exclusive daemon execution ownership and late callbacks; assert no native-hard-delete promise/call. |
| Authority | Deny every knowledge operation, title fill, reject/restore, import-source/history access, other-session lookup, arbitrary HTTP/file/shell/native tools/MCP. Exercise actual dispatcher and trusted service misuse with positive controls, not just prompt text. |
| API | All role/scope/auth/no-store boundaries; exact control-only admission/replay/by-key DTOs with receipt/run/session identity agreement and rejected unexpected message fields; normal content echoes its current composer ID and registers dependencies. Cover active-turn uniqueness, stale context/session revision, occurrence-ID removal/retry and forwarded revision header, live/history occurrence pagination and high-water behavior, deletion replay, proper 400/403/404/409/413/503 outcomes and no sensitive logs. No new IDs/time authority from browser payloads. |
| Migration | Populated current and frozen predecessor databases, self-parenting thought trees, imported source/seal closure, typed/legacy receipts, shared responses, rejection/title authority and native bindings; repeated migrate/reopen, fault rollback, FK/trigger preservation, no-session backfill and unchanged existing content. |
| Knowledge isolation | Before/after table snapshots around completed/failed/stopped/deleted searches prove unchanged thoughts/titles/sources/connections/rejection/responses/weave jobs/library FTS/spell vocabulary. Search text containing a unique sentinel must never become a library search hit. Allow only session/execution/control metadata changes. |
| Later BFF/browser scope | Fixed Next routes, server-only credentials, trusted Host/Origin, reload selects the same application session, no auto-admission on GET/navigation, chronological dialogue/list controls and explicit history separation. Composer changes clear/re-fetch visible prose rather than relabeling cached/delayed content or optimistic request text; delayed admission/recovery only updates controls. Confirm same-composer invalidation after rejection and that stale list pages cannot undo known occurrence removals while fresh rediscoveries remain allowed. Keep Stop/Delete/leave distinct and maintain source-copy harness inputs. This follows daemon contracts and designer comps, not this invocation. |

Use controlled IDs/clocks/timezones/source text and an injected native facade. SQLite tests use memory or isolated file-backed fixtures; HTTP tests own loopback listeners. Native API acceptance is a separately approved focused compatibility smoke if the integration changes; neither an operator service nor paid provider is an ordinary fixture. No tests, builds or runtime checks were run for this documentation-only draft. Validation of this draft is source-contract/link inspection plus the forthcoming independent design review.

## 12. Product decisions and approval boundary

No product question remains from the current discussion:

- **Time:** supply paired user/database clocks as directed, with technically sufficient date/offset/zone provenance, frozen request anchors and truthful skew/staleness labels. No mandatory morning preset/hour question.
- **Rediscovery:** a fresh agent add may re-add a previously removed thought; the user may remove it again. Exact old-command replay, cached success or refresh may not undo removal. Occurrence IDs, immutable per-occurrence why/order and a partial unique unremoved-membership index are technical recommendations implementing that decision.
- **Retention:** Thoughtloom owns local retention/deletion; OpenCode/providers own their policies outside this feature. Keep a brief truthful disclosure, no remote-hard-delete guarantee/integration requirement and no further approval gate. Local purge, late-result fencing and honest cancellation settlement remain required.

The user has not approved the particular schema, route names, neutral title format, default effort, page sizes, or deletion implementation by approving this design step. Those are concrete recommendations for review, not facts retroactively added to the product agreement.
