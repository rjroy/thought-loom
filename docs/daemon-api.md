# Daemon API

[Start here](../README.md) · [Server startup](server-startup.md) · [Database schema](database-schema.md) · [Testing](testing.md)

This is the loopback Hono API. Route definitions are in [`src/daemon/app.ts`](../src/daemon/app.ts); business creation and title rules live in [`creation.ts`](../src/domain/creation.ts) and [`title.ts`](../src/domain/title.ts). There is no version prefix. Configured agents run asynchronously; HTTP admission is not model completion.

## Authentication

Every request requires:

```http
Authorization: Bearer <configured-role-token>
```

The daemon compares the credential with `THOUGHTLOOM_USER_TOKEN` or `THOUGHTLOOM_AI_TOKEN` and assigns the corresponding role. Body fields, query parameters, and `x-role` headers cannot select or elevate that role.

These are server-side service credentials, not user accounts. The future browser must call through Next.js; neither credential belongs in browser code. No permissive CORS access is enabled.

## Requests and responses

- Commands with JSON input require an object. Unknown body properties are rejected rather than silently accepted.
- Text and reference fields must satisfy domain validation. Most creation fields are assigned by commands, not supplied by clients.
- Ordinary record read routes accept only the optional `scope` query parameter, once. Browse and Search have their own parameters below. The command routes below reject query parameters.
- Successful creates normally return `201`; queued file admissions use the `202`/replay contracts below. Reads and title changes return `200` JSON; rejection/restoration returns `204` with no body.
- Ordinary record collections are plain arrays. Search returns results and filter counts; import and search-session catalogs have bounded pagination.

### Read scopes

| Scope | User role | AI role |
| --- | --- | --- |
| `normal` (default) | Active material. | Active material with rejected parent/source references redacted. |
| `history` | Active and rejected material for deliberate inspection. | Forbidden. |
| `show-rejected` | Active and rejected material, not rejected-only. | Forbidden. |

Normal connection reads also exclude connections whose endpoints are rejected and connections explicitly rejected on their own. Responses have ordered thought associations: normal user reads remove rejected IDs and hide a reply if no eligible association remains; AI reads hide the entire reply if any associated thought is rejected. User history/show-rejected reads retain all associations. Inspection changes visibility, not the response record shape.

User `history` and `show-rejected` thought and connection reads add `rejected: boolean`. This reports explicit rejection of that record, not rejection of a connection's endpoints. An active connection to a rejected thought can therefore have `rejected: false` in inspection reads. Normal thought/connection reads retain their existing record shapes, without this field. Inspection metadata does not change immutable thought content.

AI can still read an active descendant of a rejected thought, but its returned `parentId` becomes null and rejected source IDs are removed. Persisted ancestry is not changed by this projection.

## Additional agent instructions

`GET /settings/agent-instructions` and `PUT /settings/agent-instructions` are
user-only routes. AI-role requests are forbidden. Responses use
`Cache-Control: private, no-store`.

GET returns the global server-side settings:

```json
{"weaver":"","evolve":"","search":"","export":"","revision":0}
```

PUT requires all five fields with no unknown properties. Each instruction is a
string of at most 16 KiB of UTF-8 text. Accepted whitespace and leading BOM are
preserved. Empty strings mean no additional guidance. The JSON request stream
is independently limited to 397,312 bytes.

Submit the revision returned by the last read. The daemon atomically replaces
all four fields, increments the revision, and returns the complete saved object
with status `200`. A stale revision returns `409` without changing settings.
Invalid input returns `400`; oversized bodies return `413`; unsupported content
types return `415`.

These instructions supplement built-in instructions for Weaver, Evolve,
Agentic Search and Agentic Export. They do not configure import segmentation,
models, effort levels, tool permissions or data-access rules. Settings are read
when a run prepares its initial prompt, then retained unchanged through that
run's capability exchanges and recovery. An already-prepared run is not changed
by a save; the next turn in an existing conversation uses the latest settings.
See the [product agreement](../.lore/context/agent-instructions.md).

## Response records

| Record | Fields |
| --- | --- |
| Thought | `id`, `text`, `title`, `titleAuthor`, `author`, `kind`, `createdAt`, `origin`, `parentId`, `sourceIds`; media originals additionally require `mediaSource`. |
| Connection | `id`, `fromId`, `toId`, `category`, `proposedBy`, `explanation`, `sourceIds`. |
| Response | `id`, `text`, `role` (`addendum` or `fallback`), `state` (`complete` or `interrupted`), `thoughtIds` in issued order. |

Thought and connection IDs are generated by the daemon. Thought creation timestamps are UTC ISO strings. `author` describes the immutable thought; `titleAuthor` describes its current title and may differ. Untitled HTTP-created thoughts have `title: null` and `titleAuthor: null`; the display fallback is the first five words of the text, not a generated title stored by capture.

Thought attribution also supports `author:'source'`, `kind:'imported-original'`, `origin:'markdown-import'`: imported wording with unverified original authorship, not user endorsement or AI authorship. Such thoughts are independent roots with empty supporting `sourceIds`. Title authors, connection proposers and credential actors remain only `user`/`ai`. Import membership is not an extra ordinary Thought field; it is available separately through the user-only provenance route below.

Retained media originals are the other source variant: `author:'source'`, `kind:'media-original'`, `text:null`, `origin:'media-import'`, `parentId:null`, `sourceIds:[]`. Their required `mediaSource` is `{id,name,mimeType,byteLength,fileAuthorship:'unverified',clarification,clarificationAuthor}`. Clarification is exact nonblank user wording or null, with `clarificationAuthor:'user'` exactly when present, otherwise null. An absent title uses the display filename, not invented thought text. Ordinary/scoped/inspection reads, nested search context and saved-search thought previews hydrate this variant with the same visibility rules; rejecting a source hides its descriptor from AI access, including through an active descendant's provenance.

The [media import routes](#retained-media-import-and-source-inspection) retain and validate originals, admit normal weaving and support inspection/download/retry. `/thoughts` creation commands still create textual thoughts only. Daemon startup connects the private store, [bounded validators](server-startup.md#internal-media-validation) and normal Weaver/Evolve [shared-file path resolver](server-startup.md#retained-media-and-shared-filesystem). Paths are private model context, not public Thought or capability-result fields. Search and Agentic Export read eligible descriptors/clarification, not originals; Markdown whole-document exclusion is unchanged. The existing Next.js decoders remain text-only: no media upload/rendering client is implemented. See the [agreement](../.lore/context/media-import.md) and [storage contract](database-schema.md#media-source-storage-foundation).

A response has a nonempty, unique association list; a fallback has exactly one associated thought. Shared text is retained once. The state field describes that retained output. A completed Evolve reply links to its issued developments in order, or uses the admitted contribution as fallback when no separate development was recorded. Machine protocol envelopes and malformed output are not conversational replies.

### Read routes

All accept the read scopes above and return `200` JSON:

| Method | Path | Result |
| --- | --- | --- |
| GET | `/thoughts` | Thought array, including parent links for tree inspection. |
| GET | `/thoughts/:id` | One visible thought; otherwise `404`. |
| GET | `/thoughts/:id/responses` | Visible retained responses associated with this thought. |
| GET | `/thoughts/:id/connections` | Visible incoming and outgoing connections, retaining their recorded direction. |
| GET | `/thoughts/:id/children` | Visible direct evolution children, not all descendants. |
| GET | `/connections` | Connection array. |
| GET | `/connections/:id` | One visible connection; otherwise `404`. |
| GET | `/responses/:id` | One visible retained response; otherwise `404`. |

Each per-thought relationship route requires the requested thought to be visible under the same read scope; a missing or hidden thought returns `404`. A visible thought with no visible related records returns an empty array. These reads use existing response, connection, and evolution relationships; they do not traverse discovered connections as evolution ancestry. Child and connection inspection records include the `rejected` field described above. Shared response associations follow the same visibility policy as `/responses/:id`, including the stricter AI rule.

Completed weaving retains its final outcome through these response routes, associated with the original capture and any issued interpretations. This includes no-findings outcomes and source-access limitations; a failed URL does not create a fake interpretation. Shared-response AI visibility still requires all associated thoughts to be eligible. URL summaries are ordinary searchable interpretation thoughts with inline source links, not a new response or source-record type. Capture requests remain unchanged.

### Chronological browse: `GET /browse/thoughts`

Both authenticated roles can browse thoughts without a search query. The response is `{items, nextCursor}` with scoped Thought records and a string continuation or null. This does not include conversational responses; `/thoughts` remains an array.

| Parameter | Values and default |
| --- | --- |
| `sort` | `newest` (default) or `oldest`; ties use thought ID in the same direction. |
| `author` | Repeatable `user`, `ai`, or `source`; omitted means all. Repeated values are deduplicated. |
| `scope` | `normal` (default) or user-only `show-rejected`. `history` is not accepted here. |
| `limit` | Integer 1–200, default 50. |
| `cursor` | Opaque continuation from a preceding page. |

Unknown parameters, repeated singleton parameters, invalid values and invalid or mismatched cursors return `400`; AI inspection returns `403`. Cursors are authenticated with a process-local key and bind the normalized authors, sort, scope, actor and limit. Repeat the same effective query on continuation; a restart requires a fresh listing. Reads use a live `(createdAt,id)` keyset, not a snapshot: changes after the boundary can appear on later pages, while changes before it require refresh. Normal and inspection records retain the visibility, provenance and media projections described above.

### Direct neighborhood: `GET /thoughts/:id/neighborhood`

Both authenticated roles can request a bounded page of direct relationships around a visible thought. Parameters are singleton `scope` (`normal` by default or user-only `show-rejected`), `limit` (1–200, default 50) and an opaque `cursor`. `history`, unknown or repeated parameters, invalid limits and invalid or mismatched cursors return `400`; AI inspection returns `403`, and a missing or hidden focus returns `404`.

The response is `{thought,nodes,edges,nextCursor}`. `thought` is the scoped focus; `nodes` contains the unique other scoped thoughts needed to resolve this page's edge endpoints. Edges are direct and retain direction:

- `{kind:'evolution',id,fromId,toId}` points from parent to child.
- `{kind:'provenance',id,fromId,toId,position}` points from a supporting source to the thought that records it. Distinct persisted source positions remain distinct edges, even when their endpoints match.
- `{kind:'connection',id,fromId,toId,connection}` preserves the existing scoped connection DTO and recorded direction. Its evidence `sourceIds` do not create adjacency.

Edge IDs are stable opaque identities for the same recorded relationship across pages and focus choices. Separate relationship roles are not merged. Each page contains at most `limit` edges; `nextCursor` is null when no further edge is currently visible. Cursors are authenticated with a process-local key and bind the focus, actor, scope and limit; a restart requires a fresh listing. The ordered edge walk is live, not a frozen snapshot: concurrent changes may appear after the continuation boundary, while earlier changes require refresh. Normal rejection rules apply to focus, endpoints and connections; AI parent and source references are redacted. User inspection includes explicit rejection flags on thoughts and connections.

## Agentic search sessions

All routes below are user-only; AI credentials receive `403`. Only fresh turn admission requires agent configuration. All responses, including authentication failures, are `Cache-Control: private, no-store`. The metadata routes expose no conversation text or composer context. The [conversational search web client](server-startup.md#conversational-search) uses fixed Next.js server boundaries; the browser never calls the daemon directly. See [`search-session-routes.ts`](../src/daemon/search-session-routes.ts) and the [isolated walkthrough](testing.md#isolated-agentic-search-walkthrough).

| Method | Path | Contract |
| --- | --- | --- |
| POST | `/search-sessions` | JSON `{}` and required `Idempotency-Key` (1–128 ASCII letters, digits, `.`, `_`, `:`, `-`). Returns `201 {session}` or `200` for an exact live replay. Reusing a deleted key returns `409 session-deleted`. |
| GET | `/search-sessions` | Optional singleton `limit` (1–200, default 50) and `cursor`; returns `{items,nextCursor}` ordered by last activity. |
| GET | `/search-sessions/:id` | Returns `{session,activeRun,eligibilityRevision}` atomically. `activeRun` is the current open-slot search control DTO or null; it contains no message text or native identity. |
| PATCH | `/search-sessions/:id` | JSON `{title}` and required `If-Match` containing the unquoted nonnegative decimal session revision; returns `{session}`. A stale revision is `409 revision-conflict`. |
| DELETE | `/search-sessions/:id` | No body or query. Returns `204` after local purge/fence, including bound work, and for known tombstone replay; unknown ID is `404`. The owned daemon installs its retention controller with or without agent configuration. |

Session metadata is `{id,title,createdAt,lastActivityAt,revision}`. Active control is `{id,kind:'search',status,searchSessionId,userMessageId,assistantMessageId,outcomeReason,cancellation}`. Catalog cursors are opaque, process-authenticated, bounded and tied to this endpoint and limit; omission of `limit` on continuation preserves its size. Restart invalidates them; ordering changes yield `409 list-changed`, requiring a fresh walk. JSON requests use `application/json` with optional UTF-8 charset, reject duplicate/unknown fields, and have a 4096-byte bound. Unknown or repeated query parameters and malformed singleton headers are rejected. Errors include `400 invalid-search-request`, `413 request-too-large`, `415 unsupported-media-type`, `401`, `403`, `404`, `409`, and sanitized `500`.

Delete removes local session content and search execution inputs transactionally, preserves library records, and leaves a title-free creation-key tombstone plus any sealed non-content native-cleanup evidence. It returns without awaiting native cancellation or settlement. Without agent configuration there is no native producer or cleanup polling; unresolved metadata stays pending for a future matching configured runtime. A held local lease excludes qualified predecessor issuers, not delayed network admission. This is local logical deletion, not erasure from native/provider history, backups or SQLite free pages/WAL. The internal no-controller storage facet still refuses bound or potentially dispatched deletion with `native-cleanup-required`.

### Composer and workspace reads

These user-only routes share the same authentication, privacy, validation and error rules. They make no model call. See [`search-workspace-routes.ts`](../src/daemon/search-workspace-routes.ts).

| Method | Path | Contract |
| --- | --- | --- |
| POST | `/search-sessions/:id/composer-contexts` | JSON `{}` creates a new blank composer and returns `201 {composerId,contextToken,eligibilityRevision}`. |
| GET | `/search-sessions/:id/composer-contexts/:composerId` | Revalidates the same composer's complete offered union and returns its current token; invalidated, consumed or discarded contexts return `409 context-changed`. |
| DELETE | `/search-sessions/:id/composer-contexts/:composerId` | No body/query. Discards an active draft; known terminal drafts replay as `204`. Saved session content is unchanged. |
| GET | `/search-sessions/:id/messages` or `/discoveries` | `scope=normal` (default) requires `composerId`; optional `limit` 1–200 and `cursor`. The response is `{items,nextCursor,sessionRevision,eligibilityRevision,composerId,contextToken}` after registering the entire offered page. `scope=history` forbids `composerId` and returns only `{items,nextCursor}`, including deliberate user-only history. |
| GET | `/search-sessions/:id/composer-contexts/:composerId/thoughts/:thoughtId` | Registers eligible AI-normal preview dependencies before returning `{thought,sessionRevision,eligibilityRevision,composerId,contextToken}`; missing/invisible thought is `404`. It does not grant a model full-read witness. |
| DELETE | `/search-sessions/:id/discoveries/:entryId` | No body/query. Returns `204` with `Search-Session-Revision` for both first removal and replay of that exact occurrence. |

Normal unavailable messages have `text:null` and empty evidence; unsafe discovery rationales are redacted. Explicit history never supplies a composer token and is not a normal-read fallback. A context token represents offered coverage, not authentication. Normal cursors are bound to collection/session/limit, not to a composer: using one with another valid composer registers the returned page for that composer. History cursors are separately authenticated and bound to collection, session, history scope and limit; neither cursor type crosses scopes. Both use bounded high-water walks and process-local signatures, so restart requires a fresh walk. A `409 context-changed` cannot be repaired by silently opening a blank composer.

Thought previews use the full Thought union, including a media descriptor when eligible. Discovery summaries retain their existing fields (`id,title,titleAuthor,author,kind,createdAt`); a media summary uses `kind:'media-original'`, source attribution and the filename fallback, not a binary payload. The internal AI-normal investigative facet accepts the media kind for lexical and date-only retrieval; its candidates contain clarification-only snippets, not full reads. A subsequent `readThought` exposes descriptor/clarification only and grants no file-read evidence.

### Turn admission and control

`POST /search-sessions/:id/turns` requires an `Idempotency-Key` and JSON `{text,requestClock:{at,timeZone},composerId,contextToken,startingThoughtIds?,effort?,contextMode?}`. `requestClock.at` must be an offset-bearing timestamp consistent with its IANA zone; it is the user's intent anchor, not a daemon record timestamp. Effort is `quick`, `standard` (default) or `thorough`; context mode is `continue` (default) or `restart`. The daemon assigns all run/message/native IDs and record times. A fresh admission returns `201`, exact replay `200`; both return only `{receipt,run,session}`, never message text, token, native binding or tool output. `receipt` is `{searchSessionId,runId,userMessageId,admittedAt}`; `run` has the search control fields above.

`GET /search-sessions/:id/turns/by-key/:requestKey` returns that control-only view or `404` for an absent/deleted owner. An exact replay resolves before checking current composer, active turn or configuration; changed payload under the same key is `409 idempotency-conflict`, and a new key with active work is `409 turn-active`. Fresh turns require configured agents and otherwise return `503 agents-not-configured` before admission or ID allocation. Known replay, by-key, Check and Stop work without current agent configuration. Configuration is checked, not service connectivity: an unavailable configured service leaves admitted work queued/uncertain. After admission the existing bounded supervisor is notified; no native call occurs in the handler.

A permanently restore-fenced composer cannot authorize a new turn, even with its still-valid token (`409 context-changed`); known exact turn-key replay still resolves first. Saved sessions are not globally fenced, so a fresh composer remains available under ordinary admission rules. Local Delete uses the existing retention boundary, retaining permanent fences and old cleanup evidence without creating a new native certificate for historical runs.

`GET /runs/:id` returns search control for a live owned search run. `POST /runs/:id/stop` requires JSON `{}` and returns the current search control after local fencing; user messages and confirmed discoveries remain retained. Both use `private, no-store`, are user-only, and do not dispatch or re-submit. Search run IDs from deleted sessions return `404`.

Search-session requests and known search-run Check/Stop accept optional `X-Thoughtloom-Client-Time` and `X-Thoughtloom-Client-Zone` **together**. The time must be a full ISO timestamp with `Z` or numeric offset matching the IANA zone; a missing partner, ambiguous/duplicate header or invalid calendar/zone/offset gives `400 invalid-search-request`. Large valid skew is accepted. User authentication precedes validation. Direct API clients can omit both headers; turn `requestClock` remains mandatory and is the immutable original intent anchor.

The daemon stamps a valid header sample with its own receipt time and keeps at most 128 transient active-run associations. It records an admitted turn's sample after commit and before waking the existing supervisor; later polls can update the in-memory sample without a SQL write or model call. Owner/session/native identity and current execution generation are checked before the configured worker can use it. New turns never inherit a prior run's sample. At a normal initial or due successor preparation boundary, the worker may attach the latest available pair; already prepared input and exact replay keep their original bytes. Stop and successful local Delete forget affected associations; eviction, restart or absence of a fresh sample falls back to the last retained report, not an invented current user clock. A reported client/daemon difference includes unknown transit delay and does not change record timestamps. The web client forwards fresh paired clock headers through Next.js while retaining the original turn `requestClock` for uncertain-admission reconciliation.

## Search: `GET /search`

Both authenticated roles can search; AI callers may use only normal scope. Unknown parameters and repeated singleton parameters are rejected.

| Parameter | Values and default |
| --- | --- |
| `q` | Required nonempty search text. Words combine with AND and match prefixes. |
| `scope` | One read scope above; default `normal`. |
| `author` | Repeatable `user`, `ai`, or `source`; omitted means any. |
| `kind` | Repeatable `captured-original`, `user-contribution`, `ai-interpretation`, `developing-idea`, `imported-original`, `media-original`; omitted means any. |
| `from`, `to` | Optional inclusive creation-time bounds. Accept `YYYY-MM-DD` or UTC timestamps ending in `Z`, with seconds and optional 1–3 fractional digits. Date-only bounds include the whole UTC day. `from` must not exceed `to`. |
| `sort` | `relevance` (default), `newest`, `oldest`. Chronological sorts use creation time. |

Selections within one filter group combine with OR; groups combine with AND. Date presets are client choices expressed as these date bounds, not separate daemon settings.

The response is `{results, counts: {authors, kinds}}`. Each result has:

- `kind`: match identity, `thought` or `response`; `id`: that record's ID.
- `thoughtId`: eligible destination for opening the result.
- `text`: full matching record text for textual thoughts/responses. A media thought hit instead has `text:null` and its required `mediaSource` descriptor.
- `snippet`: the first 160 characters of matching record text or media clarification (empty when absent), not a generated summary.
- `title`: destination thought's current title, otherwise its filename for media or first five text words for other kinds.
- `author`: matching record's author. Response hits are AI-authored even when their destination is a user contribution.
- `materialKind`, `createdAt`: destination thought's classification and creation time.
- `context`: `null`, `{kind: "connection", thought, connection}`, or `{kind: "predecessor", thought}`. Nested records use the normal scoped Thought and Connection projections above.

Thought and response matches are distinct results. A shared response opens its latest eligible association; an interrupted fallback opens its associated input without becoming a completed development. Response visibility follows the read-scope rules above.

Context belongs to the result's destination thought, including for response hits. Prefer a normally visible directly connected thought whose own text (clarification for media) matches the effective search query. Choose the best text relevance regardless of the selected result sort; break ties by thought ID, then connection ID. Context candidates need not satisfy the result's author, kind, or date filters. Connection direction and recorded explanation are preserved. If there is no qualifying connection, use the immediate normally visible evolution parent; do not skip a hidden parent to find a more distant ancestor. Otherwise return `context: null`.

Context always excludes rejected thoughts and explicitly rejected connections, even when the result scope includes rejected records for user inspection. AI context applies the existing parent/source redaction rules. Spelling-corrected searches use the effective corrected query for context selection too. Context adds no generated explanation and does not alter result identity, ordering, or filter counts.

Author counts apply the query, dates and kind filter, but omit the selected author filter. Kind counts similarly omit the selected kind filter. Both maps include zero-valued options. Counts count matching records, not unique destination thoughts. There is no count for Show rejected: user `scope=show-rejected` adds rejected material alongside active results, while normal search excludes it server-side.

The exhaustive count maps include `authors.source`, `kinds['imported-original']` and `kinds['media-original']`, including zero when no matching material exists. Source results, scoped agent candidates and export citations preserve thought attribution without fetching whole-document artifacts or media bytes. For media roots, only clarification and explicit titles are indexed; filename fallback, MIME, digest and other metadata are not search/spelling input unless deliberately recorded as a title. A root without clarification or title has no lexical body to match.

FTS5 retrieves words and prefixes. If the original query has no scoped hits, search can retry with modest spellfix1 corrections drawn only from scope-visible vocabulary. This does not invoke an agent, expand acronyms or modify saved text. A query requiring spelling support fails with sanitized `500` if the [native extension](server-startup.md#native-spelling-extension) is unavailable; it does not silently substitute another search engine.

```sh
bun run api --role user GET '/search?q=thinking&author=user&sort=newest'
bun run api --role user GET '/search?q=thinking&scope=show-rejected'
```

## Simple export: `POST /exports/simple`

**Role:** user. **Body:** exactly `rootId`, `count`, and `traversal`. Query parameters are not accepted.

```json
{"rootId":"<thought-id>","count":20,"traversal":"breadth"}
```

`count` is a positive integer. `traversal` is `breadth` or `depth`. The root must exist and be normally visible; a missing or rejected root returns `404`. AI access returns `403`; invalid requests return `400`.

Success returns `200` with `Content-Type: text/markdown`. The root counts toward the limit. Only evolution descendants are visited, never discovered connections. Rejected descendants are omitted without consuming the count, but traversal continues through them to active descendants. Full response addenda are excluded; a retained fallback recorded as thought text is included like any other thought.

Each Markdown section includes the current title or display fallback, thought ID, immutable author, material kind, creation time, origin and eligible source IDs. Textual thoughts include their original text. A media root instead includes labeled filename, media type, byte length and unverified file authorship, plus a separately labeled **User clarification** section containing exact wording when supplied. It includes no binary or extracted text. Rejected source IDs are omitted. Export reads knowledge without creating or changing thoughts, titles, connections or rejection state.

```sh
bun run api --role user POST /exports/simple '{"rootId":"<thought-id>","count":20,"traversal":"depth"}'
```

## Agentic export

All Agentic export routes are user-only. AI credentials receive `403` and missing credentials receive `401`. Responses, including failures, use `Cache-Control: private, no-store`.

### History and local deletion

| Method | Path | Contract |
| --- | --- | --- |
| GET | `/exports/agentic` | Optional singleton `limit` (1–200, default 50) and `cursor`; returns `{items,nextCursor}`. |
| GET | `/exports/agentic/:runId/metadata` | Returns one history item, or `404` if absent or not an export with retained intent. No query parameters. |
| DELETE | `/exports/agentic/:runId` | Deletes a ready export locally and returns `204` with no body; unknown or non-export IDs return `404`, and work requiring Stop or settlement returns `409`. No query parameters. |

Each item contains `id`, `status`, `createdAt`, the original `request`, `effort`, `restored` and `deletionState` (`stop-required`, `settling`, or `ready`). Legacy export runs without retained intent are not catalog entries. History exposes neither native identity nor protocol input. Results use a live descending `(createdAt,id)` keyset, not a snapshot. The opaque process-authenticated cursor binds the endpoint and limit; omitting the limit on continuation preserves it. Restart requires a fresh listing. Unknown or repeated parameters, invalid limits and malformed or mismatched cursors return `400`.

Use `POST /runs/:id/stop` before deleting active work, then wait for cancellation settlement until metadata says `ready`. For a restored export, Stop acknowledges local discard without contacting the old provider; it does not imply remote work stopped. Local deletion removes the export's execution history and Markdown while preserving thoughts and unrelated records. It does not erase provider history, backups, or SQLite free pages/WAL.

### Admission: `POST /exports/agentic`

**Role:** user. **Body:** required nonempty `request`, optional `effort` (`quick`, `standard`, or `thorough`; default `standard`). Unknown fields and query parameters return `400`.

```json
{"request":"Gather the recorded arguments about this approach","effort":"thorough"}
```

Returns `201 {run}` using the run-status shape below. Missing agent configuration returns `503` before admitting a run or intent. A configured but unavailable service leaves work queued for execution, not falsely completed. Poll `GET /runs/:id`; use the existing Stop command to interrupt it.

Effort selects the corresponding server-configured native model variant. It does not impose application turn, token, cost, search-count or note-count quotas. The selected model/variant is bound to the run; restart does not replace it with changed configuration.

The agent investigates existing, AI-eligible thinking through read/search capabilities only. It cannot create thoughts, change titles or connections, reject/restore material, or schedule new development. Structured source IDs must identify fully read, currently eligible thoughts before publication. For a media source, this is a descriptor/clarification read, not a binary read. The report appends validated IDs, titles (including media filename fallback) and thought attribution; arbitrary prose and body links remain model text, not independently fact-checked evidence.

### Download: `GET /exports/agentic/:runId`

**Role:** user. No query parameters. A completed artifact returns `200 text/markdown`. Missing or non-export runs return `404`; queued, running, uncertain, interrupted or failed runs return `409` rather than partial machine output. AI callers receive `403` for admission and download.

Historical artifacts are retained for deliberate user download, including after later source rejection. They are not indexed as thoughts or made available through AI capabilities. Rejection or Stop during investigation fences further work and publication; already-sent native context cannot be withdrawn retroactively.

```sh
bun run api --role user POST /exports/agentic '{"request":"Summarize the existing thinking about search","effort":"quick"}'
bun run api --role user GET '/runs/<run-id>'
bun run api --role user GET '/exports/agentic/<run-id>'
```

## Agent runs

These routes are **user-only**; AI-role credentials return `403`. Query parameters are not accepted.

### Reinterpret: `POST /thoughts/:id/reinterpret`

Body: exactly `{}`. Supply an `Idempotency-Key` matching case-sensitive `[A-Za-z0-9._:-]{1,128}`; keys are not trimmed or normalized. The selected active thought can have any authorship. This requests a fresh weave without a new user contribution; use Evolve for additional instructions or development.

Fresh admission returns `202`; an exact subject/key replay returns `200` with the original run, including after completion. Both return:

```text
{
  receipt: {subjectId, requestKey, runId} | null,
  run: {id, kind, status, confirmedThoughtIds, responseId} | null,
  eligibility: {eligible, reason, blockingRun}
}
```

Eligibility reasons are `null`, `subject-rejected`, `work-active`, `work-unsettled`, or `work-unverified`. Eligibility is advisory; admission transactionally checks all interpretation-capable weave work for the subject. A text title-clear job participates; a genuinely media-title-only job does not fulfill or block interpretation. Unverified historical cancellation settlement cannot authorize replacement work. With agent configuration, the existing cleanup worker can re-observe the saved native identity and journal; only positive terminal proof clears that blocker, without resubmitting or reviving the old run. A fresh interpretation still requires an explicit new key; replaying the old key returns its old receipt. Missing or conflicting evidence remains blocked. Configuration absence permits durable queue admission without native execution.

New interpretations are immutable children of the selected thought, not replacements for earlier output. Each run retains its own Full reply through the existing response readers. A media reinterpretation can create one new interpretation for that run; a historical child cannot satisfy completion. If it produces no new interpretation, the run fails while retaining its complete limitation reply. Ordinary text/URL weaving may finish honestly with a fallback reply and no new thoughts.

Conflicting work returns `409` with `error`, `code` and the snapshot. Codes are `interpretation-active` or `interpretation-unsettled`. An unadmitted key has null `receipt` and `run`; the existing work is identified only by `eligibility.blockingRun`. Returning existing work does not assign the new key to it.

Missing or freshly requested rejected subjects return `404`; restore a rejected subject before new work. Exact receipt replay remains user-only control access after rejection, does not resume work, and exposes no thought text, Full reply, file path or native binding. Anonymous requests return `401`, AI requests `403`, invalid input `400`, oversized bodies `413`, and unsupported content types `415`. Responses use `Cache-Control: private, no-store`.

### Reinterpret receipt: `GET /thoughts/:id/reinterpret/by-key/:key`

Returns `200` with the same control snapshot, including a null receipt if no admission is recorded for that subject/key at this read. A missing subject returns `404`. The route is user-only and can recover a known receipt after subject rejection without granting AI history access.

After an uncertain POST, retain the original subject/key. Lookup absence cannot prove that a delayed POST will never arrive. An explicit resend uses the identical empty payload and the same key; never turn a timeout, missing receipt or advisory eligibility into an automatic new-key submission. Once a run is known, use its existing status and Stop routes. A terminal status alone does not certify native cancellation settlement.

### Evolve: `POST /thoughts/:id/evolve`

Body: exactly `{"text":"A contribution to this discussion"}`. The path selects a normally visible parent. Missing or rejected parents return `404`; unknown body fields return `400`.

Success returns `201 {contribution, run}`. The daemon creates the user contribution and queued Evolve run atomically. IDs, timestamps, authorship, classification and ancestry defaults are daemon-owned. The returned `run` uses the status shape below; it does not claim generation has finished.

During the run, Evolve may fill an absent title only on the admitted contribution and may record warranted connections after scoped full reads. A current title wins over a late AI fill. Confirmed changes remain saved on Stop or failure. A completed run schedules ordinary follow-up weaving on its latest issued development when one exists; a reply without a development remains associated with the contribution without scheduling a contribution weave.

Without [agent configuration](server-startup.md#agent-configuration), this returns actionable `503` before saving the contribution. With configuration present, service unavailability leaves admitted work durable rather than discarding the contribution. The daemon owns execution; disconnecting the HTTP client does not cancel it.

### Status: `GET /runs/:id`

Returns `200` with `{id, kind, status, confirmedThoughtIds, responseId}`; missing runs return `404`. Status is one of `queued`, `submitting`, `running`, `uncertain`, `completed`, `interrupted`, or `failed`. Confirmed thought IDs refer to saved output, not uncommitted native proposals. `responseId` is null until a canonical reply exists. No native binding, credentials, protocol envelopes or provider reasoning are returned.

An import run instead returns `{id,kind:'import',status,importId,fileId}` without an unbounded thought-ID list or private segmentation input/result. A search run returns its distinct control-only shape described above. Existing Evolve/Export projections are unchanged.

## Retained media import and source inspection

All routes here are **user-only**. Missing/invalid authentication returns `401`; AI credentials receive `403` before handler body reading or route upload-limit checks. Responses, including these errors, use `Cache-Control: private, no-store`. See [`media-routes.ts`](../src/daemon/media-routes.ts). The source ID in these paths is `thought.mediaSource.id`, not the Thought ID.

| Method and path | Input | Success |
| --- | --- | --- |
| `POST /imports/media` | `Idempotency-Key`; multipart `metadata` JSON text and exactly one named, typed `file` | Fresh `202 {thought,run}`; matching replay `200 {thought,run}`. Retention/admission has finished, not interpretation. |
| `GET /imports/media/by-key/:key` | No body/query; the upload's request key | `200 {thought,run}` for the original admission; unknown key `404`. |
| `GET /media-sources/:id` | Optional `scope=normal` (default) or `scope=history`, once | `200 {thought,run,retry}`; missing or normally hidden source `404`. |
| `GET /media-sources/:id/raw` | Same scope rules | `200` exact verified original bytes. |
| `POST /media-sources/:id/retry` | `Idempotency-Key`; `Content-Type: application/json` with exactly `{}`; no query | Fresh `202 {run}`; same source/retry-key replay `200 {run}`. |

`thought` is the media Thought above. `run` is the ordinary [status projection](#status-get-runsid): `{id,kind:'weave',status,confirmedThoughtIds,responseId}`. Poll `GET /runs/:id`; the normal response/Thought routes expose confirmed interpretations and Full replies. No native IDs, file paths, digests or private inputs are returned. History inspection includes rejection state, with `rejected: true` for a rejected source. Both normal and history inspection/download are forbidden to AI credentials.

Source inspection returns the latest source-interpretation weave in `run`, or `null` if none exists. Later retries replace that selection; title-clear work does not. This differs from an upload receipt, whose run remains the original admission. A queued status does not identify why processing has not started.

`retry` describes eligibility for a **fresh** retry: `{eligible:true,reason:null}` or `{eligible:false,reason}`. Reasons are `source-rejected`, `interpretation-exists` (including a rejected interpretation), `work-active`, `work-unsettled` (failed/interrupted work whose cancellation has not settled), and `work-completed`. The read and retry admission share the same eligibility rules. This snapshot is advisory: admission rechecks the current state and can return `409` after a race. Replaying an existing retry key is a receipt lookup through the POST, not a fresh retry, and may succeed even when fresh retry eligibility is false.

### Media upload and replay

The `metadata` part must be a UTF-8 JSON object containing only optional `clarification`: omit it or use null for default summary instructions; otherwise supply exact nonblank user wording. Duplicate JSON keys, extra fields (including paths or caller-selected identities), duplicate/extra parts and malformed framing are rejected. The `file` part supplies the display filename and a declared supported MIME: `image/png`, `image/jpeg`, `image/gif`, `image/webp` or `application/pdf`. The filename is not opened as a path: slash, backslash, CR, LF and NUL are refused, and its UTF-8 length is at most 1024 bytes. The daemon generates source/Thought/run identities and timestamps.

Fresh file bytes pass the actual format validator; the **detected MIME** is stored and used on download, not inferred from the extension or trusted from the declaration. The file limit defaults to 16 MiB and is configurable; metadata is at most 4 KiB and multipart framing/headers at most 64 KiB. At most two upload receivers buffer concurrently. See [configuration and validation limits](server-startup.md#configure).

The key is an opaque 1–128 character ASCII token using letters, digits, `.`, `_`, `:`, `-`. Reusing it requires the same display filename, exact clarification, byte length and SHA-256 of the uploaded bytes. A match reuses the retained source and original run without publishing another file or scheduling another weave; it retains the original validated MIME. Changing an allowed MIME declaration alone does not replace that stored MIME. A new key creates an independent source even for identical bytes.

After an uncertain admission response, look up the same upload key; do not invent another key to recover it. Lookup and upload replay are user command receipts and can return retained metadata for a rejected source, but do not open its file or resume work. Their `run` is always the **original** weave's current status, not a later retry's run.

### Media download, rejection and retry

Raw download uses the stored validated `Content-Type`, `Content-Disposition: attachment; filename="source.<extension>"` (`png`, `jpg`, `gif`, `webp`, `pdf`) and `X-Content-Type-Options: nosniff`. The untrusted display name is not inserted into response headers. Normal scope excludes rejected sources; explicit user history can inspect/download them. Eligibility is checked again after file reading. Rejection does not delete the original; unavailable/corrupt originals produce a sanitized failure, not substituted content.

A deliberate retry uses the retained source without another upload. The source must be normally eligible; a fresh retry also requires no confirmed initial interpretation and safely settled previous interpretation work. Admission checks all relevant subject runs, including reinterpretation, not only the latest run. Active, uncertain, unsettled or unverified work is not duplicated. Retry keys are scoped to their source and separate from the upload key. Matching replay returns its existing run, not a new execution. An existing interpretation prevents another initial summary even if later rejected. Use Reinterpret for a fresh interpretation alongside retained output, or Evolve for additional instructions and development. Clearing a media title schedules title-only work, not a summary. Without agent configuration, retention succeeds and weaving stays queued; enabling agents later can process that queue.

### Media errors

Except for the general `401 {error:'Unauthorized'}`, errors have sanitized `{error,code}` bodies:

| Status | Code / meaning |
| --- | --- |
| `400` | `invalid-media-request`: invalid key, metadata/filename, body, duplicate/unknown fields or scope/query. |
| `403`, `404` | `forbidden`; `not-found` for unknown or normally hidden sources/receipts. |
| `409` | `idempotency-conflict` for changed upload input; `media-processing-conflict` for unavailable retry/admission state. |
| `413`, `415` | `source-too-large`; `unsupported-media-type` for unsupported request/file declarations. |
| `422` | `unsupported-source-content`: empty or refused fresh media validation, including corrupt pixels/PDF policy or validation resource failure. |
| `503` | `receiver-busy` with `Retry-After: 1`; `storage-unavailable` or `original-unavailable` when retention/read cannot complete. |
| `500` | `media-request-failed`: unexpected failure without raw exception, content or filesystem path. |

A later interpretation failure is recorded on its ordinary run and retained outcome, not retroactively returned as an upload error. See the [owned HTTP checks and manual walkthrough](testing.md#media-import-http-workflow-checks).

## Markdown import and source inspection

All routes in this section require user-role bearer authentication; AI credentials receive `403` before a request body is read. Responses use `Cache-Control: private, no-store`. Browser clients must use a server-side boundary; there is no browser import interface or direct browser-to-daemon access.

| Method and path | Input | Success |
| --- | --- | --- |
| `GET /import-namespaces` | None | `200 {items:[{id,kind,label}]}`; the built-in loose Markdown namespace. |
| `POST /imports/markdown` | JSON `{}` or `{namespaceId}`, `Idempotency-Key` | `201 {import}` for new admission, `200` for replay. |
| `POST /imports/markdown/:id/files` | Multipart `metadata` text containing exactly `{"relativePath":"notes/a.md"}` and one `file` byte part; `Idempotency-Key` | `202 {file}` for new queued/waiting work; `200` for an immediate skip or replay. Multipart filename is not the source identity. |
| `POST /imports/markdown/:id/seal` | JSON `{}` | `200 {import}`; closes new admission, allowing same-key replay. |
| `GET /imports/markdown` | Optional `limit`, `cursor` | `200 {items,nextCursor}` batch summaries. |
| `GET /imports/markdown/:id` | None | `200 {import}`. |
| `GET /imports/markdown/:id/files` | Optional `limit`, `cursor` | `200 {items,nextCursor}` file reports. |
| `GET /imports/markdown/:id/files/:fileId` | None | `200 {file}` if the file belongs to the batch. |
| `GET /import-sources` | Required `scope=history`; optional `limit`, `cursor` | `200 {items,nextCursor}` retained source metadata. |
| `GET /import-sources/:id` | Required `scope=history` | `200 {source}` metadata, not inline bytes. |
| `GET /import-sources/:id/parts` | Required `scope=history`; optional `limit`, `cursor` | `200 {items,nextCursor}` ordered original byte ranges and current rejection flags. |
| `GET /import-sources/:id/raw` | Required `scope=history` | `200` original bytes, `text/markdown; charset=utf-8`, constant attachment filename and `nosniff`. |
| `GET /thoughts/:id/import-source` | Optional existing user `scope` | `200 {importSource:null}` for a visible non-import thought, otherwise `{importSource:{documentId,ordinal,startByte,endByte}}`. Invisible thought: `404`. |

Batch summaries contain `id`, `namespaceId`, `createdAt`, `sealedAt`, `state` (`open`, `processing`, `completed`) and counts `admitted`, `pending`, `imported`, `skippedIdentical`, `skippedChanged`, `failed`, `interrupted`. File reports contain `id`, `importId`, `position`, `relativePath`, `byteLength`, `createdAt`, `state`, `runId`, `documentId`, `thoughtCount`, `segmentation`, and `error`. Queued and waiting work is not yet imported; poll the file. After a successful import, ordinary weaving proceeds independently. Structural fallback is reported as a successful import with its segmentation reason. Stopping an import run uses the existing run Stop endpoint and does not undo an already committed source.

Source metadata contains `id`, `originalNamespaceId`, `originalPath`, `sha256`, `byteLength`, `encoding`, `createdAt`, `parserVersion`, `segmentation` and `thoughtCount`. Parts contain `position`, `kind`, `startByte`, `endByte`, `thoughtId`, `ordinal`, and for thought parts `rejected`. Byte ranges are zero-based and half-open. Original source bytes, paths, frontmatter, and source metadata are unavailable to AI routes, including when every segment is active. Provenance itself does not authorize a source inspection without history scope.

The request key is an opaque 1–128 character ASCII token drawn from letters, digits, `.`, `_`, `:`, `-`, not an entity ID. Reuse it only with identical inputs: the daemon checks path and bytes, returns the current file and original identity on replay, and returns `409 idempotency-conflict` for different inputs. A nonexistent requested namespace returns `404` even on replay. A new key after sealing returns `409 import-sealed`. In the default `loose-markdown` namespace, whether selected implicitly or explicitly, `relativePath` is metadata, not identity: different bytes import even under the same name, and exact bytes already retained anywhere in the library skip without new agent work. In a non-loose namespace a known locator with changed bytes skips without overwriting or restoring, even if those bytes match another document; otherwise identical bytes skip across namespaces without binding an alias. Submitted bytes must be UTF-8 without NUL. Unknown or repeated singleton parameters/parts/fields, duplicate JSON keys, bad paths, missing keys and malformed input return `400 invalid-import-request`. Missing source history scope returns `400 inspection-scope-required`; oversized transport returns `413 source-too-large`; unsupported media returns `415 unsupported-media-type`; invalid encoding or NUL returns `422 unsupported-source-encoding` or `unsupported-source-content`. Busy upload receivers return recoverable `503 receiver-busy` with `Retry-After`. Import errors use `{error,code}`; no raw source or exception is returned. An admitted file's later failure is reported on its file record, not as a retroactive upload error.

A restore-fenced import batch is closed to new file keys (`409 import-sealed`), but exact batch/file key replays remain historical receipts. Seal on that batch returns its stored state without setting a missing `sealedAt`. A fence on the batch, file or associated run prevents old local/native processing, including Stop/cancellation writes and payload deletion. No fence fields are added to public records. Offline recovery adds missing fences and interrupts historical pending reservations while retaining accepted payloads; final installation preserves that recovered state under an actual target lease/marker. It exposes no daemon route and requires no daemon role credentials. Internal stages retain their marker; only the complete validated installation protocol removes the target marker.

List pages default to 50 items, maximum 200. A continuation is authenticated and bound to route, parent, scope, limit, last position and the first page's high-water mark. Later arrivals require a fresh listing; status and rejection flags remain live. Wrong-parent, altered or otherwise invalid cursors return `400`. Cursor signing uses a random process-local key: daemon restart invalidates outstanding cursors, so refresh from the first page.

Upload and in-process parser resource limitations are described in [server startup](server-startup.md#configure). There are no file-count, model-turn, token, or cost quotas in this API.

Native completion is not local completion: a response may still need validation and transactional finalization. A definitely pre-dispatch failure leaves the prepared run retryable with its existing identities. Once submission intent is durable, ambiguous outcomes are observation-only. `uncertain` does not authorize the caller to submit a replacement run. Poll the same run while the daemon reconciles its stable native identities.

### Stop: `POST /runs/:id/stop`

Body: `{}`. Returns the same run-status shape after local authority is fenced, without waiting for native cancellation to settle. Confirmed saved thoughts remain saved; Stop does not reject or undo them. Pending native cancellation is reconciled separately. A safely identified unfinished reply can remain interrupted; raw machine JSON is not published as partial prose. Weaver/Evolve native tools run in a trusted operator environment; Stop cannot undo their external side effects. See the [tool-access policy](server-startup.md#agent-configuration).

For a run with a [restore fence](backup-restore.md#small-durable-guard-not-a-second-execution-engine), or an import run whose file/batch is fenced, Stop preserves the stored execution status, generation and cancellation facts and authorizes no old native call. For a locally terminal, intent-backed restored export only, the application adapter additionally records an export-owned local-discard acknowledgement. This acknowledges local Stop, **not** remote cancellation: old remote work remains unknown/unaffected. Other fenced runs retain the idempotent history-read behavior. The Stop response shape is unchanged; use `GET /exports/agentic/:runId/metadata` to read export deletion eligibility before calling `DELETE /exports/agentic/:runId`. See [offline restore](backup-restore.md#standalone-offline-installation) for recovery.

```sh
bun run api --role user POST '/thoughts/<thought-id>/evolve' '{"text":"What if we explore the opposite?"}'
bun run api --role user GET '/runs/<run-id>'
bun run api --role user POST '/runs/<run-id>/stop' '{}'
```

## Creation commands

### Capture: `POST /thoughts`

**Role:** user. **Body:** `text` and optional `title` (string or null).

```json
{"text":"An idea to explore"}
```

The returned thought contains daemon-generated `id` and `createdAt`, `author: "user"`, `kind: "captured-original"`, `origin: "capture"`, `parentId: null`, and `sourceIds: []`. If supplied, the title is user-authored metadata.

Do not send `id`, `createdAt`, `author`, `kind`, `origin`, `parentId`, or `sourceIds` to capture. Copy the returned ID for later operations. Each successful capture creates a distinct thought, even if its text is identical to another capture; the helper does not automatically retry writes.

### Contribution: `POST /thoughts/:id/contributions`

**Role:** user. **Body:** `text` and optional `title`.

The path selects an existing, normally visible parent. The daemon derives `kind: "user-contribution"`, `origin: "contribution"`, the parent link, an empty source list, and the generated identity/time. It returns the new thought with `201`.

### Development: `POST /thoughts/:id/developments`

**Role:** AI. **Body:** `text`, optional `title`, and optional `sourceIds` (defaults to `[]`).

The daemon derives `kind: "developing-idea"`, `origin: "development"`, and the path-selected parent. The parent and every supplied source must be visible to the caller in normal scope. A rejected or missing reference gives `404`. It returns the new thought with `201`.

This command accepts a supplied development; it does not ask a model to create one. Extra source references do not become evolution parents.

### Connection: `POST /connections`

**Role:** user or AI. **Body:**

```json
{"fromId":"<thought-id>","toId":"<other-thought-id>","category":"related","explanation":"Why these thoughts matter together","sourceIds":[]}
```

`sourceIds` is optional. Categories are `supports`, `contradicts`, `extends`, and `related`. Endpoints and supporting sources must be normally visible to the caller. The daemon generates the connection ID and derives `proposedBy` from the credential, then returns the connection with `201`. Do not supply `id` or `proposedBy`.

## Title commands

### User edit or clear: `PUT /thoughts/:id/title`

**Role:** user. **Body:** required `title`, a non-empty string or null to clear.

```json
{"title":"A better title"}
```

The user can edit a title even on an AI-authored or rejected note. The response is the full thought with updated `title` and `titleAuthor`, status `200`. Text, note authorship, creation time and ancestry stay unchanged. Clearing sets title and title author to null and permits a future fill. For an eligible active note, the daemon atomically queues a new weaving invitation, including when its title was already absent. Rejected notes remain excluded from agent work.

### AI fill: `POST /thoughts/:id/title/fill`

**Role:** AI. **Body:** required non-empty `title` string.

The supplied title is saved only if the thought exists, is not rejected, and still has no title. An existing title gives `409`; a missing or rejected thought gives `404`. Success returns `200` with the thought and AI title attribution. The eligibility check and write are transactional, so a late fill cannot overwrite a current user title.

**This endpoint does not generate a title:** it accepts a supplied value. Separately, configured background weaving can generate and conditionally fill missing titles after capture or user clearing. Without agent configuration, those jobs remain queued and the first-five-word display fallback applies until a supplied fill or user edit occurs. A late model fill still cannot overwrite a current user title.

## Rejection and restoration

All operations in this section are **user-only**. They change availability state, never erase recorded thoughts.

| Method | Path | Result |
| --- | --- | --- |
| POST | `/thoughts/:id/reject` | Reject only this thought; descendants remain active. `204`. |
| POST | `/thoughts/:id/restore` | Restore only this thought. `204`. |
| POST | `/connections/:id/reject` | Explicitly reject this connection. `204`. |
| POST | `/connections/:id/restore` | Remove this connection's explicit rejection. Normal visibility still requires active endpoints. `204`. |
| GET | `/thoughts/:id/branch/preview` | Current branch confirmation payload. `200`. |
| POST | `/thoughts/:id/branch/reject` | Confirm rejection using the exact preview body. `204`. |
| POST | `/thoughts/:id/branch/restore` | Restore the subtree beginning here. `204`. |

Single-item and branch-restore commands need no body. Branch preview returns:

```text
rootId       selected starting thought
branchIds    that thought and all evolution descendants
affectedIds  currently active thoughts that would become rejected
count        affectedIds.length
```

POST the unchanged preview JSON to the corresponding branch-reject path. The daemon revalidates current membership and state transactionally; mismatched or stale confirmation gives `409` without partial rejection. Branch operations never walk discovered connections. Restoring a later subtree need not restore its ancestors, and it does not restore independently rejected connections.

## Errors

Registered handlers return a sanitized JSON object such as:

```json
{"error":"Bad request"}
```

| Status | Error string | Typical cause |
| --- | --- | --- |
| `400` | `Bad request` | Invalid JSON/object, unknown body fields, invalid values or query parameters. |
| `401` | `Unauthorized` | Missing or unmatched bearer credential. |
| `403` | `Forbidden` | Wrong role or AI request for a user inspection scope. |
| `404` | `Not found` | Missing or invisible record/reference. |
| `409` | `Conflict` | Stale/mismatched branch confirmation or title already present during fill. |
| `500` | `Internal server error` | Unexpected failure; raw SQL, exception text and credentials are not exposed. |

Malformed branch-confirmation field types are handled as conflicts after body parsing; malformed JSON or unknown body keys remain bad requests. Unknown routes may use Hono's plain-text `404`, rather than this JSON error shape. The manual helper retains that HTTP status without echoing an arbitrary non-JSON body.

## Manual requests

Follow [server startup](server-startup.md) first and configure the helper with the same credential as the running daemon:

```sh
export THOUGHTLOOM_DAEMON_URL=http://127.0.0.1:3001
bun run api --role user POST /thoughts '{"text":"An idea to explore"}'
```

The helper prints the status followed by JSON. Replace the placeholder below with the returned thought ID:

```sh
THOUGHT_ID='paste-the-returned-id'
bun run api --role user PUT "/thoughts/$THOUGHT_ID/title" '{"title":"A working title"}'
bun run api --role user PUT "/thoughts/$THOUGHT_ID/title" '{"title":null}'
bun run api --role user POST "/thoughts/$THOUGHT_ID/contributions" '{"text":"A further thought"}'
bun run api --role ai POST "/thoughts/$THOUGHT_ID/developments" '{"text":"A simulated development"}'
bun run api --role user GET '/thoughts?scope=show-rejected'
bun run api --role user POST "/thoughts/$THOUGHT_ID/reject"
bun run api --role user GET "/thoughts/$THOUGHT_ID/branch/preview"
```

Development uses a supplied test thought, not a real model. Copy only the preview's JSON body, not the printed status, when confirming branch rejection. These commands affect your selected daemon; use [the isolated walkthrough](testing.md#isolated-walkthrough) for a complete disposable scenario instead.
