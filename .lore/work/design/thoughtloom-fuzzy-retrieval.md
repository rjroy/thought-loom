---
title: Thoughtloom ordered fuzzy retrieval
date: 2026-11-01
status: approved
tags: [thoughtloom, search, fuzzy-retrieval, provenance, sqlite]
modules: [daemon, contracts, agent-tools, web]
related: [.lore/work/design/thoughtloom-mvp.md, .lore/work/concept/thoughtloom-concept.md]
---

# Thoughtloom ordered fuzzy retrieval

## Decision and authority

Replace the current FTS-gated search with **ordered character-subsequence retrieval over titles and complete current thought text**, using one local engine for the user and agents. Query characters must occur in order; intervening characters may be skipped. A typed space requires actual whitespace. Search retrieves candidates; the agent reads their evidence and decides whether a meaningful connection exists.

The user explicitly confirmed that `sdk` must find **both** `SoftwareDevelopmentKit` and `shoulD Know`, and delegated the remaining search/retrieval decisions. Neither an alias nor an embedding is necessary for these matches. After independent design acceptance, the user explicitly requested **“Prepare an implementation plan then execute.”** That next-step request records approval of this design and authorization to implement it. This document is not itself an implementation plan or evidence of successful implementation; live activation and native/provider operations remain separately bounded.

SQLite remains authoritative. Keep Bun, Hono, Next.js and the existing agent integration. Do not add an embedding model, database vendor, search service, model request, corpus-wide agent pass, or connection-writing behavior to search. Semantic retrieval, if later wanted, is a separate design rather than an interpretation of fuzzy matching.

## Review and validation record

On 2026-11-01, the source-grounded design received **Accept, with no findings** from a fresh independent `design-reviewer` invocation, session `ses_e66cf5df3ffe3d3Z7yszEdNpBs`. The parent read the full artifact and review. Document structure, related paths and whitespace were checked. This is design-review evidence only: no retrieval implementation, executed tests/builds, benchmark results or supported-capacity claim follows from it. The subsequent explicit request to plan and execute supplies user approval/implementation authority separately from that review; it does not authorize live rollout.

## Current behavior and the actual gap

Inspected working-tree source at code HEAD `3dde629`; pre-existing Beads export changes were present. Relevant boundaries are:

| Current source | Observed behavior |
| --- | --- |
| `apps/daemon/src/storage.ts:590–678` | `searchSources` tokenizes away punctuation/whitespace, runs multiword AND queries through source/current-formulation/title FTS tables, then prefix passes, recorded aliases, and a one-term edit-distance fallback only when no results exist. Defaults are 50 results, 100 aliases and 256 vocabulary candidates. |
| `storage.ts:603–649` | Each FTS pass has a limit; source results are appended before item and title results. This is not one globally ranked top-K. A reranker after these queries cannot recover omitted subsequence candidates. Source excerpts are the first 240 UTF-16 code units, not necessarily the matching passage. |
| `storage.ts:43–138, 229–232`; `knowledge.ts:121–129` | Sources and formulation history are retained; current formulation is selected by the latest formulation row, and FTS is a replaceable projection. `tool_reads` records per-run read witnesses. |
| `title-schema.ts`; `title-projection.ts:5–18`; `title-write.ts:20–55` | Titles have independent revisions/heads, protected user overrides and formulation-specific AI labels. Effective title is not interchangeable with the title CAS head. |
| `apps/daemon/src/app.ts:72–85`; `tool-boundary.ts:394–399` | User and agent search call the same function, but only the user route receives configured search-limit overrides. Both duplicate the 512-code-unit/16-token check. Search does not create a read witness. |
| `packages/contracts/src/index.ts:30–38`; `inspection.ts:141–159` | Results retain source provenance, discussion-turn origin, item/formulation identity and title revision identity. Search is not a substitute for reading the immutable original. The response parser already caps the result list at 200. |
| `tool-boundary.ts:147–176, 318–328, 359–399` | Relationship writes require root scope, candidate item/source reads, and current expected endpoint versions. Search grants none of that authority. |
| `packages/agent-tools/src/plugin.ts:101–115, 145–154`; `apps/web/lib/daemon.ts:99–106`; `apps/web/app/search/page.tsx:28–38` | Plugin and web also validate queries. UI distinguishes match origins, preserves query navigation and opens item hits at their exact formulation; it currently shows the full formulation and a separate source excerpt. |
| `apps/daemon/src/inquiry.ts:55–99`; `apps/web/lib/thought-text-client.ts:3–38`; `apps/web/app/ui/text-disclosure.tsx:33–73` | Exact historical item selections remain readable. The existing disclosure can fetch either an immutable source or a pinned item formulation without accepting newly fetched metadata into the surrounding page. |

The older MVP design's FTS-plus-alias proposal and the historical local MVP plan describe the existing approach, not a constraint on this improvement. This design replaces their lexical admission rule and, explicitly, their default typo fallback. Their source/history/attribution and candidate-versus-evidence boundaries remain.

There is no separate intent artifact or maintained reference/learned directory in this checkout. The concept and MVP design supply historical intent. Existing search, expanded-retrieval, title, tool-boundary and browser tests cover valuable contracts; inspection found no dedicated retrieval performance benchmark. No tests or benchmarks were run for this design.

## Matching contract

### Normalized characters, not query syntax

Define a character as an **extended grapheme cluster**, not a UTF-16 code unit. The same pure normalizer handles query and candidate text:

1. Segment original text with `Intl.Segmenter("und", { granularity: "grapheme" })` on the pinned Bun runtime. Retain each cluster's half-open original UTF-16 interval.
2. Normalize each non-whitespace cluster to NFC, apply locale-independent `toLowerCase()`, then NFC again. Treat that resulting string as one comparison key, even if it contains multiple code points. Do not lowercase the whole field and try to reuse its old offsets.
3. Collapse each maximal run of Unicode `White_Space` characters to one whitespace key. Keep its entire original interval. This includes spaces, tabs, line breaks and nonbreaking spaces; zero-width space is not whitespace. A CRLF cluster is whitespace. A cluster containing non-whitespace marks is not a whitespace run.
4. Preserve punctuation, symbols and diacritics. No stemming, transliteration, compatibility folding, accent stripping, operator parsing or punctuation deletion. `*`, `?`, quotes and backslashes are literal characters.

This is a specified lowercase comparison, **not** full Unicode caseless equivalence: `é` equals its decomposed spelling, but `e` does not equal `é`; `ẞ` equals `ß`, but `ss` does not equal `ß`; dotted `İ` is not plain `i`. These choices avoid silently erasing meaningful script distinctions. International support means correct character handling and explicit behavior, not a claim that all linguistically related spellings are equivalent. Runtime/Unicode-data upgrades require compatibility tests and a projection-version change if boundaries or keys change.

For nonempty normalized query `q` and a single normalized field `t`, a direct match exists exactly when there are strictly increasing positions `p[0] … p[m−1]` with `q[j] = t[p[j]]` for every query key. Repeated query characters consume distinct positions. No substitutions, transpositions, omitted query characters or cross-field stitching are permitted.

Whitespace is a required comparison key, not a wildcard or an AND separator. Thus `s k` may match `Software Kit` but not `SoftwareKit`; `ab cd` may match `abXX YYcd`, because it contains the required whitespace in order. It is not an exact-phrase request. `ab cd` against `ab cd` is contiguous and ranks higher. Multiple consecutive typed whitespace characters request one whitespace run; leading/trailing whitespace on a query containing other characters remains meaningful, not silently trimmed.

| Query | Candidate | Direct result |
| --- | --- | --- |
| `sdk` | `SoftwareDevelopmentKit` | Match, without aliases |
| `sdk` | `shoulD Know` | Match, without aliases |
| `sdk` | `Software Development Kit` | Match |
| `sdk` | `kit development software` | No match unless some other ordered `s`, `d`, `k` actually occurs |
| `s k` | `Software\tKit` | Match; `\t` here denotes a real tab |
| `s k` | `SoftwareKit` | No match |
| `s*k` | `Software Kit` | No match: a literal `*` is absent |
| `telescoppe` | `telescope` | No match: two `p` characters are required |
| `telscope` | `telescope` | Match: skipping a candidate character is allowed |

Empty or whitespace-only queries return no results, never all thoughts. Otherwise accept literal punctuation-only and one-character queries. Retain the existing **512 UTF-16-code-unit input ceiling**, including whitespace, to keep frontend compatibility and bound query state; reject malformed Unicode queries. Remove the unrelated 16-word ceiling. Validate once through a shared contracts parser used by daemon, plugin and web; neither transport can reinterpret spaces. Reject invalid input with 400, not an empty successful response.

### Complete fields and long-distance matches

Eligible fields are immutable source text (including discussion-turn sources), complete **current** formulation text for interpretations/developing ideas, and each target's effective current title. Source provenance, titles of another target, relationship rationales and historical formulations are not extra searchable text fields. Preserve existing effective-title selection, including user overrides and formulation association, through the same title resolver used by reading views.

A match must be wholly within one field. Do not combine the title's `s`, an item's `d` and the original's `k`. Do not silently concatenate a source with its AI interpretation. A source and its distinct items remain distinct searchable targets.

**No semantic maximum gap, maximum span, paragraph barrier or first-N-characters cutoff.** A match near the end of a huge thought, across a traversal chunk, or spanning many paragraphs remains eligible. Broad queries can therefore produce accidental long-distance matches. Demote them by match quality and compactness; do not break the confirmed subsequence semantics to hide them. Return honest match fragments and let the user refine the query. A cancelled/resource-exhausted scan is unavailable, not proof that no match exists.

## Ranking: one deterministic order

First find the best alignment in each field, then the best field/route for each target. Compare this ascending tuple:

1. **Retrieval route:** direct query before recorded-alias supplement.
2. **Match class:** whole-word/phrase contiguous, other contiguous, word/camel initials, scattered subsequence.
3. **Skipped normalized keys within the matched span:** `last − first + 1 − queryLength`; fewer is better.
4. **Field:** title before body when the preceding quality measures tie.
5. **First normalized match position:** earlier breaks an otherwise equal within-field tie.
6. **Stable identity:** source before item, then binary source ID, item ID, matched field revision ID and alias ID as applicable. Never use locale collation or insertion order as an accidental final tie-break.

A whole-word/phrase contiguous alignment consumes consecutive normalized keys and begins/ends at lexical edges or the field's ends. A lexical word is a maximal run of grapheme clusters containing Unicode letters, numbers or marks. Word-initial hints include lexical starts, lowercase-to-uppercase camel boundaries and the last uppercase before a lowercase run in an acronym/camel transition. Compute these hints from original casing before normalization. For initials class, every non-whitespace query key must consume an initial; required whitespace still consumes actual whitespace. These are ranking hints only, not admission filters.

For example, `SDK` as a whole word outranks `sdk` inside `xsdkz`, which outranks initial-letter and scattered alignments. The capital `D` in `shoulD Know` can itself be a camel-boundary hint: the system must not pretend that one spelling is semantically relevant and the other is not. There is no special software vocabulary preference. Recency, popularity, repeated mentions, AI confidence and the existence of a graph connection add no rank or intrinsic-value bonus.

Within a class, optimize the shortest span, then earliest start; an earlier weak occurrence must not hide a later exact or more compact one. When several alignments share class/start/end, choose the lexicographically earliest position sequence for reproducible highlights. Expose class, field, route and span in match metadata; do not turn this tuple into a percentage of relevance or confidence.

## Aliases and typo compatibility

**Keep recorded aliases as a clearly labeled, lower-ranked candidate union through this same matcher.** They are optional retrieval metadata, never a prerequisite for `sdk`, a synonym assertion, evidence of equivalence or a reason to create a connection.

- Only exact equality of the whole normalized query with one stored alias side activates the other side. Do not tokenize away a typed space/punctuation to activate an alias. Legacy records retain their already-stored spelling; this design does not reconstruct punctuation discarded by old writers.
- Expand one hop, in either direction, without chaining or generating aliases. Apply the same subsequence matcher to the other side. Direct matches always beat alias-only matches for the same target and globally.
- Preserve a maximum of 100 activated alias records, additionally bounded to 4,096 total normalized keys across distinct expanded queries. Select in binary alias-ID/direction order, independent of result limit; do not skip an oversized expansion and include later records. Report `aliasExpansionTruncated` if either bound excludes an activated expansion. These bounds constrain supplemental work, not the direct candidate universe.
- Alias-only results include alias ID, original alias/expansion, author, evidence source IDs, direction and the actual expanded query whose passage matched. Do not present an expansion-only passage as containing the user's literal query. A query with spaces can retrieve a space-free alias target **only as an explicitly labeled alias result**, not as a direct whitespace match.
- Keep existing alias records, attribution, receipts and constrained `record_alias` behavior. Do not make search write aliases. Supplement metadata never supplies read witnesses or automatic relationship evidence.

**Remove the existing one-edit fallback from default search.** It would otherwise admit a query character absent from the candidate and obscure the user's exact in-order rule. Do not add a parallel legacy endpoint or hidden fallback mode. A query that omits candidate characters remains tolerable via subsequence skipping, but added/replaced/reordered query characters are not corrected automatically. Consequently the existing `telescoppe` → `telescope` test changes by deliberate product decision, not by weakening a failing assertion. A typo-correction feature can be designed separately if wanted; the older MVP's modest-typo goal is superseded here. Remove its vocabulary candidate knobs and retrieval-only vocabulary infrastructure when the replacement is implemented; preserve domain data/history.

## Engine and storage architecture

```text
user GET /search ───────────────┐
                              ├─ shared request parser + retrieval policy
authorized agent search tool ──┘                  │
                                     one SQLite read snapshot
                                                 │
                             complete ordered search-field/chunk stream
                                                 │
                          pure normalizer + ordered matcher/rank comparator
                                                 │
                                  per-target best → top-(K+1) heap
                                                 │
                              pinned passages + attributable target identities
```

### A small first-party matcher, not a finder framework

Use a project-local pure TypeScript module shared by both callers through the daemon. Its boundary is query compilation, incremental field matching, best-alignment selection and total ordering; it knows nothing about SQL, HTTP, graph writes or native sessions. The traversal/scheduling adapter owns I/O. No client-side copy of the corpus or alternate browser ranking engine is needed.

The FZF-for-JavaScript project is a credible existing subsequence matcher, not a typo/semantic engine. However, its inspected basic finder scans preloaded candidate arrays and stores all hits in score buckets before limiting; it does not supply our grouped streaming top-K, grapheme/source-offset contract or required tier order. Its normalization also makes mappings outside this design's normalization policy. Adapting its finder would not remove the application-specific work. Choose the narrower first-party algorithm, not a dependency plus a second scoring/admission path. This is a fit decision, not a claim that the library cannot be adapted. No new package or version is selected; retain the repository's Bun `1.4.3`/TypeScript `5.9.3` pins. [Sources](#external-sources)

The algorithm need not allocate a query-by-document matrix:

- Contiguous occurrences and their lexical edges determine the first two classes.
- For ordinary subsequences, stream candidate keys left to right and update query-prefix states right to left. For each prefix retain the latest feasible start at the current endpoint. Each completed prefix yields the shortest span ending there; compare all complete spans. Keeping the later start dominates an earlier one for every future endpoint.
- Run the same prefix-state calculation with non-whitespace matches restricted to initial positions for initials class. This restriction affects ranking, not whether the ordinary matcher admits the field.
- Retain only best class/start/end and the bounded prefix states during selection. Re-read winning spans in the **same** snapshot to reconstruct the canonical alignment and original-text passage; do not retain backpointers for every candidate key or all matched records.

The matcher is O(field keys × query keys) worst case and O(query keys) ranking state per compiled variant, not an assertion of interactive performance at an unmeasured corpus size. Contiguous detection may use a linear substring algorithm. Compare it with exhaustive alignment enumeration on small test-owned strings before trusting an optimized implementation.

### Rebuildable, complete SQL projection

Replace FTS as the candidate source with a versioned, rebuildable SQL projection of **all eligible fields**, not a lexical candidate list. Model it as:

| Projection | Responsibility |
| --- | --- |
| Search target/head | Target kind/ID, root source ID, exact current formulation ID where applicable, effective title revision ID, source origin/attribution references, projection-format version. |
| Search field | Target reference, `source-body`/`formulation-body`/`title`, canonical field identity/revision, original length and chunk manifest. |
| Ordered field chunks | Original text slices, ordinal, original UTF-16 start/length and completeness metadata. No agent-produced summaries. |
| Alias lookup keys | Whole normalized alias/expansion lookup keys pointing to retained alias records. |

Use B-tree keys on target kind/ID, field kind and chunk ordinal so iteration is grouped without materializing and sorting the corpus. Keep existing formulation-by-item indexes for authoritative current selection. Do not make millions of per-character SQL rows. Initially normalize original chunks in the pure matcher rather than introducing a persisted binary normalization format. The SQL projection is disposable; source, formulation, title and alias tables retain authority.

Chunks target 16,384 original UTF-16 code units and end at complete grapheme boundaries; a single larger cluster is an oversized chunk, not split or dropped. Carry whitespace-run coalescing, neighboring-case/word-boundary state and matcher-prefix state across chunks. Chunk size bounds routine working buffers, **not** the match window. Do not reset matching at a chunk, newline or paragraph. A chunk manifest identifies complete coverage with no overlap/gap; traversal verifies ordinals and offsets and fails closed on an incomplete/incompatible projection.

Refresh relevant heads/fields/chunks **within the existing canonical write transaction** on capture/discussion-source creation, formulation append/restore, and title-head/override changes. Effective title refresh must use the same resolver as reading, not just blindly copy `title_search`. Immutable source/formulation IDs make the projected text's owner explicit. A restored formulation is the newly appended current version, not its `restored_from` ID. Projection maintenance must not alter original/history triggers, receipts, current-version checks or follow-up scheduling.

Backfill existing records and publish the projection version transactionally before the new reader is ready; rebuilding has the same atomic publication requirement. No asynchronous indexing lag, new indexing job kind or agent backfill. Backfill/migration throughput and peak memory, including the largest legacy field, require controlled validation; this document does not authorize running them. Do not serve a partial index as complete or silently fall back to FTS. Retire the replaced FTS/vocabulary search path and rebuild logic rather than maintain competing live engines. Keep a rebuild operation for the new derived projection.

A projection can be structurally complete yet corrupted; manifests are not cryptographic proof of canonical text. Transactional writers and migration/rebuild equivalence tests provide the normal consistency guarantee. An explicit integrity/rebuild operation must compare field identities/text coverage against canonical records. **Canonical source/item enumeration drives a left join to the projection**, rather than enumerating projection rows alone: otherwise a missing target could never be detected. Compare projected current formulation/effective-title identities against canonical state in the same snapshot. Missing required heads or a mismatched current formulation/title fails the read as unavailable, not by quietly omitting that target.

### Snapshot, traversal and bounded selection

Every search uses one dedicated connection and one read transaction for alias lookup, current target enumeration, chunk traversal, ranking, winner hydration and passage construction. Read both bodies and title identities from that snapshot. Open this connection read-only after daemon-owned schema initialization; do not call the existing migrate/write-capable `openDatabase` from the scan path. Use Bun SQLite's iterator, not `.all()` over corpus text. Do not rerun the same cached statement while its iterator is active; use distinct statements for different streams/hydration. Never write through the scan connection. SQLite WAL snapshot isolation allows canonical writers on other connections to proceed. [Sources](#external-sources)

Group fields by target, finish its best direct/alias match and discard its traversal buffers before moving to the next target. Keep a heap of at most **K+1 distinct targets**, not a set/list of every hit. No SQL `LIMIT`, FTS `MATCH`, prefix, token, character-bag or first-50 gate may restrict direct candidates. Enumerate every eligible target to establish a complete global top-K. A future accelerator is acceptable only if it demonstrably produces a superset of these matches and preserves exact order; a probabilistic/lexical gate is not such an accelerator.

Alias variants may be evaluated during the stream or in a second complete pass in the same snapshot. The second pass can be omitted only when at least K+1 direct targets already dominate every alias-only result. Bounds and alias selection must not depend on K. Complexity grows with the sum of activated variant lengths; the 4,096-key alias budget constrains that optional cost.

Schedule the scan cooperatively within the daemon, keeping the pure kernel resumable and yielding after at most 4,096 prefix-state updates as well as between chunk fetches. Own the read connection exclusively across those yields; use explicit transaction lifetime/finally cleanup rather than an async callback to Bun's synchronous transaction wrapper. Yield only to scheduling, not to a model or remote service. This avoids a new service or reliance on experimental worker termination while preventing an entire corpus scan from monopolizing the request thread. Individual SQLite/segmentation operations are still synchronous; responsiveness must be measured, not assumed.

Allow one active scan per daemon, no unbounded pending queue. An overlapping request receives a retryable unavailable/busy response; ordinary capture and authoritative reads must continue. Use a shared configurable 5,000 ms cooperative scan deadline, checked inside resumable work, with client cancellation and a 64 MiB accounted traversal/normalization working-set guard. Check oversized chunk metadata before loading it. The memory guard excludes SQLite/runtime baseline memory and is not a total-process-memory guarantee. These are initial safety policies, not measured latency/heap promises; five seconds leaves room inside the current web projection fetch's eight-second timeout, but cannot interrupt an individual synchronous SQLite/segmentation call. Do not immediately admit replacement work while cancelled work still owns the scan slot/snapshot. Finalize iterators, release the transaction and connection on every outcome. Timeouts, memory-budget exhaustion, corruption and scan failure return 503 without partial results or `hasMore=false`.

For routine chunks, selection memory is proportional to query/variant state, a chunk and K winner references, not corpus size or the number of matches. Extremely large grapheme clusters are not silently rewritten to fit that claim. They may trigger the explicit resource failure. Huge ordinary multi-paragraph sources remain fully traversable. Long read snapshots can hold WAL pages; log scan duration/outcome and release promptly. No result snapshot, cursor or query history is durably stored.

## Result, passage and consumer contracts

### Limits and response meaning

Both transports accept the same query and optional integer `limit`, default **50**, maximum **200**, with identical ranking and validation. The daemon owns one immutable resolved retrieval policy and supplies it to user and tool routes; remove the current user-only override discrepancy. Configuration/test injection is shared, not a model-controlled work-budget override. The agent tool's existing `{ query }` input remains valid; `limit` is optional. Web may initially use the default without a larger-results control.

Return `results`, `hasMore`, `engineVersion` and `aliasExpansionTruncated`. `hasMore` means at least one additional target under the evaluated direct-plus-bounded-alias policy, not a total match count or a statement that all possible alias expansions were considered. Use K+1 to determine it. No offset/cursor pagination in this change: show “Showing the first 50 matches; narrow the search” when appropriate. A fresh request is a fresh database snapshot. For a fixed snapshot/query/policy, results at smaller K must be an exact prefix of results at larger K. Do not label a deadline-limited prefix as a valid top-K.

### Identity and attribution

One result corresponds to `source:<sourceId>` or `item:<itemId>`, not one field hit. Deduplicate title/body/alias hits for that same target by best rank. Do **not** merge all items into their root source or suppress an original just because its AI item also matched. Retain:

- Immutable `sourceId`, source provenance, creation date and discussion-turn origin.
- For item hits: item ID, kind, author and exact `formulationId` from the snapshot.
- Effective title text, author and **title revision ID** when present; never substitute the entity CAS head for the visible title revision.
- Best match's field kind, exact field owner/version, route, class, normalized span length and original matched-span bounds. Alias provenance is attached only when that route wins.

Keep `matchOrigin` attribution compatible in meaning (`source`, `interpretation`, `title`, `alias`), but do not overload it to communicate every rank/class. `interpretation` remains the existing broad item-origin label even for developing ideas; the item kind/author still distinguishes them.

Add a versioned search-only passage contract. **Do not keep shipping full formulation text in `item.text` just to construct a preview.** Replace that search response member with item identity/attribution plus the passage; do not put an excerpt into a field clients understand to be the complete formulation. This is a coordinated search-contract change for `packages/contracts`, both daemon routes, plugin input projection and web rendering/parsing. It does not change full `read_item`, `read_source`, inquiry or historical-version read contracts. The plugin forwards JSON; a search passage is still not a full-read witness. Reject incompatible response versions rather than silently parse a truncated item as a complete one.

For an item/title-only match, retain a separately labeled bounded original-source excerpt as context; do not highlight the original using the item's positions. A source-body match uses the actual matching original passage rather than the source's first 240 characters.

### Passages and safe highlighting

Return original text, never normalized display text. Every match range maps through normalized-key-to-original-interval metadata, including an entire composed/decomposed grapheme or whitespace run. Offsets are half-open original UTF-16 intervals, explicitly labeled as such for JavaScript consumers. Fragment-local highlight ranges use the same convention. Validate bounds, ordering, field identity and grapheme edges in the response parser. Render escaped text nodes and `<mark>` elements, never HTML supplied by a record.

The passage budget is **240 original grapheme clusters across at most three fragments**, excluding ellipsis separators. It is a display limit, not retrieval admission:

- If the chosen matched span fits the budget, include it with remaining context split before/after (extra cluster after), clipped at field edges.
- Otherwise show up to three nonoverlapping fragments anchored on first, middle and last matched positions. Use up to 80 clusters per fragment, centered on the anchor with odd remainder after; merge overlap, then use available budget for adjacent context in source order. All fragments remain in original order.
- Return each fragment's original start/end, text and actual highlight intervals, the full match's start/end and matched-key count, and `omittedMatchedCharacters` when any consumed query key is outside the displayed fragments. Visible ellipses and an accessible “match spans separated passages” label must not imply contiguous prose.

Do not place the entire text of an enormous whitespace run/cluster into a preview merely to satisfy a grapheme count. Apply an additional **4,096 UTF-16-code-unit passage payload ceiling**; if a required displayed cluster/run alone exceeds it, omit that fragment with an explicit omission flag and retain the full match bounds. No splitting a grapheme/surrogate pair. This limit affects display only. Bound the separate original-context excerpt by the same ceilings. Omitted passages still offer the full-source/exact-formulation reading route.

Web shows the best matching passage under the title, with source/AI/user/alias attribution and separated original context when needed. Preserve the recent in-place full-source disclosure rather than replacing it with a page redirect. For item passages, reuse the existing disclosure's pinned-item target to offer full formulation text in place; expanding either body must not replace surrounding result metadata with a newly fetched version. Item “Open thought” links retain `sourceId + itemId + formulationId` and the original query; source/discussion-turn routing remains distinct. If a later formulation becomes current, opening the search result must still select the returned immutable formulation, not silently retarget to the latest body/title. The agent receives the same passage/rank/IDs and can issue an additional query; it is not given a different hidden relevance engine.

## Evidence and connection safety

Search is read-only retrieval. It creates no knowledge item, title, alias, relationship, follow-up job or read witness, even when the passage happens to contain a complete short thought. Repeated searching does not affect rank or importance.

Keep the existing agent boundary: search → choose candidate → `read_item` and `read_source` as required → independently judge the relationship → submit exact expected versions with rationale and evidence. A stale search formulation requires a fresh read before a current-version write. A read from another run, a snippet, title, alias citation or search result is not a substitute for `tool_reads`. Existing root-endpoint scope, source evidence checks, protected user corrections, revocation and current-version fencing remain unchanged. Retrieval metadata is not permission to alter an off-root thought.

The existing connection model relates knowledge items, not raw original-source rows. This search design neither changes relationship endpoints nor invents interpretations merely to make originals connectable. Improving candidate recall first makes later examination of connection formation more informative; it does not settle that separate product/model question.

`thought-loom-3xp` retains its original connection-formation discussion scope and remains open/escalated. The user's subsequent plan-and-execute request is tracked separately under `thought-loom-8r5.28`, with working plan `.lore/local/plans/thoughtloom-fuzzy-retrieval.md`. Return to connection formation after the retrieval foundation is implemented and validated; do not reframe or close the original discussion as search implementation.

## Quality and performance evidence required

These are design acceptance boundaries, not claims that checks have run and not a task sequence. All automated corpora are controlled/test-owned; no private notes, production configuration, live native service or provider is necessary.

| Boundary | Required evidence |
| --- | --- |
| Pure matching | Both explicit `sdk` examples without aliases; case, repeats and unfinished fragments; required spaces/tabs/newlines/NBSP; leading/trailing/repeated query whitespace; punctuation as literal; no operators, reorder, cross-field stitching or edit fallback; empty/whitespace-only behavior. |
| Unicode/mapping | NFC/decomposed equivalence, accent distinction, dotted-I/sharp-S policy, non-Latin scripts, emoji/ZWJ, astral characters, combining marks, CRLF and chunk boundaries. Highlight ranges reconstruct exact original slices and never split graphemes or surrogates. |
| Algorithm correctness | Exhaustive small-alphabet subsequence/alignment oracle versus resumable matcher, randomized chunk partitions and repeated-character adversaries. Verify later better occurrences, class precedence, shortest spans, canonical alignment and deterministic ties. |
| Ranking/top-K | Exact/contiguous above initials above scattered; stronger body above weaker title; same-target title/body/alias dedupe without collapsing distinct items; stable results after insertion-order changes; all-target full-sort oracle equals heap selection; small-K prefix of larger K. No recency/frequency/relationship-status bias. |
| Complete recall | Matches beyond the old first 240 characters and old 50-result preselection, targets with no FTS term/prefix overlap, long-gap/paragraph-crossing matches, full large sources and matches spanning chunks. A deliberately empty FTS table must not affect the new engine. Never “fix” false positives by introducing an unreported span cutoff. |
| Compatibility/provenance | Alias bidirectionality/ambiguity, direct-over-alias precedence, route provenance, exact whole-key activation, capped-expansion disclosure independent of K, and no alias-driven domain writes. Replace the old inserted-query-letter typo expectation with explicit nonmatch while retaining deletion/subsequence coverage. |
| SQLite consistency | Fresh and upgraded fixtures; source/formulation/title/alias projection backfill and rebuild equivalence; retained receipts/original/history/foreign keys; rollback of canonical+projection changes; protected user titles; new/restored formulation IDs; stale/partial projection failure; concurrent writer cannot mix old text and new IDs/titles in one result. |
| Agent safety | Authorized tool and user GET return identical ordered targets/passages under the same policy; shared configuration/limits; search alone cannot satisfy read-before-link, even for a full short snippet; per-run and stale-version failures remain enforced. Test through in-process apps/fake native contexts, not a real model. |
| Web | Actual late-body passage and safe highlights; ellipsis/omission labels; exact target/query navigation even after revision; title/AI/source/alias attribution; in-place original expansion; empty, more-results, invalid, busy and unavailable states; keyboard and narrow-view behavior. |
| Resource behavior | Fake-clock/scheduler deadline/cancellation tests; slot/iterator/transaction cleanup after each failure; chunk and heap bounds with increasing match counts; oversized grapheme/passage handling. Verify capture/read progress while a search yields and that overlap does not form an unbounded queue. |

Keep useful existing coverage in `apps/daemon/tests/search.test.ts`, `retrieval-expanded.test.ts`, `thought-titles.test.ts`, `tool-boundary.test.ts` and `tests/browser/retrieval.spec.ts`; replace obsolete FTS-mechanism/typo assumptions instead of duplicating entire fixture suites. Current alias tests must distinguish a direct fuzzy hit from an alias-only reverse-expansion hit. End-to-end contracts and unit matcher tests protect different failure modes and both remain necessary.

Measure controlled synthetic corpora varying target count, total text, largest field, query length, match density, near-misses, maximum alias expansion and Unicode composition. Include modest (1,000 targets), growing (10,000/100,000 targets) and huge-single-source cases; these sizes are test probes, **not supported-capacity claims**. Record cold/warm duration distributions, throughput, event-loop delay, peak RSS/heap, projection size, rebuild time, writer latency/WAL retention, consumed work and timeout outcomes on the stated Bun/hardware. Compare exhaustive row traversal with chunk streaming and verify identical results. Inspect query plans for ordered iteration, not just elapsed time.

There is no existing measured latency/capacity baseline to promise. A complete scan may be too slow at larger sizes; the honest outcome is a retryable failure and measurement identifying the bottleneck, not missing candidates disguised as success. The architecture permits later cached normalization or a proven recall-preserving local index without replacing canonical storage or matching semantics. A persistent snapshot/pagination service, remote search infrastructure or semantic model is not preapproved growth.

At the retrieval service boundary log attempt and outcome, engine/projection version, requested K, query length (not query text), target/chunk/work counts, elapsed time, alias truncation, result count and failure category. Log projection write/rebuild outcome with owning IDs and versions. Never log thought text, passages, alias contents, credentials or prompts. Computation and indexing stay local and incur no provider/model calls; agent runs that consume results retain their existing, separate privacy/cost boundaries.

## External sources

Public documentation/source inspected on 2026-11-01. It supports API/fit decisions, not measurements of Thoughtloom:

- [Bun SQLite documentation](https://bun.com/docs/runtime/sqlite): synchronous driver, incremental statement iteration, single-cursor reuse caveat and synchronous transaction-wrapper requirement. These explain explicit snapshot ownership and resumable scheduling rather than an async transaction callback.
- [SQLite isolation](https://sqlite.org/isolation.html): WAL readers keep a stable snapshot while other connections commit; interleaving writes with an active SELECT on the same connection has undefined visibility. The search connection therefore only reads.
- [FZF-for-JavaScript](https://github.com/ajitid/fzf-for-js), inspected revision `cf3903255b6bba6143bfbed5a387f3cadfd6938a`: [`matchers.ts`](https://github.com/ajitid/fzf-for-js/blob/cf3903255b6bba6143bfbed5a387f3cadfd6938a/src/lib/matchers.ts) and [`normalize.ts`](https://github.com/ajitid/fzf-for-js/blob/cf3903255b6bba6143bfbed5a387f3cadfd6938a/src/lib/normalize.ts). Array-oriented collection/scoring and normalization are inspected facts; Bun/package integration was not tested or installed.
- [MDN: `Intl.Segmenter`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/Segmenter), [`normalize`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String/normalize), [`toLowerCase`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String/toLowerCase): grapheme segmentation and canonical-versus-compatibility normalization are distinct operations; lowercase conversion is not a license to strip accents or reuse preconversion offsets.
- [Bun workers](https://bun.com/docs/runtime/workers): Worker termination is documented as experimental. This design does not require force-terminating workers to preserve read/scan correctness.

**Final choice:** one local, SQL-backed ordered-subsequence engine with complete field traversal, explainable global ranking and matching passages; optional attributable alias supplements through that engine; no default edit correction, FTS admission gate, semantic inference or connection-writing side effect.
