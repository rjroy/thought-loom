---
title: Thoughtloom passage-level retrieval
date: 2026-11-01
status: archived
tags: [thoughtloom, search, passage-retrieval, architecture, sqlite, performance]
modules: [daemon, contracts, agent-tools, web]
related: [.lore/work/design/thoughtloom-fuzzy-retrieval.md, .lore/work/research/thoughtloom-fuzzy-search-algorithms.md, .lore/work/design/thoughtloom-mvp.md, .lore/work/concept/thoughtloom-concept.md]
---

# Thoughtloom passage-level retrieval

> **ARCHIVED / SUPERSEDED — abandoned search attempt.** Current direction is [indexed SQLite FTS5 search with prefixes and bounded typo tolerance](thoughtloom-search-retrieval.md), explicitly selected and authorized by the user. The paragraph/window fuzzy engine, strict SDK/grapheme contract, fzf/native comparison gates, generation machinery and numerical adoption targets below are historical proposals, not current requirements or work to resume. Preserve the record, not its authority. The FTS implementation is in progress; no restoration, validation or live-rollout success is asserted here.

## Decision and authority

**Keep canonical knowledge in SQLite. Maintain a separate, derived passage-search representation. Retrieve readable local candidates through one shared user/agent engine; do not compute an exact global optimum over arbitrary gaps through complete bodies.**

The user explicitly selected the recommended **passage-level** direction after questioning the whole-field architecture and its scale. That authorizes this architecture revision, not production implementation, a dependency installation, a benchmark prototype, a database reset, or live activation. This newly authored document is `draft`; approval of the direction is not approval of every parameter below. The parent owns fresh independent design review. The next consequential permission is a bounded, disposable comparative experiment, described below; it has not been granted by this document.

This supersedes the matching extent, exact ranking, scan strategy, alias fan-out and resource policy in [the earlier whole-field design](thoughtloom-fuzzy-retrieval.md). That design remains archived history. Its implemented phases 1–4 retain their historical verification; neither phase 5 nor the retrieval epic is accepted as complete. Do not continue the old implementation plan automatically.

## Why change the architecture

The existing `fuzzy_targets`/`fuzzy_fields`/`fuzzy_chunks` tables already form a second representation. They copy and organize current text for traversal, not selective lookup. `fuzzy-retrieval.ts:78–102` still enumerates every canonical target and evaluates its fields against direct and alias queries. Reorganizing those chunks into paragraphs alone does not create an index or prove scale.

Prior supplied measurements used short synthetic, source-only bodies, approximately 60 characters each. Ordinary 10k-target queries were roughly 0.28–0.86 seconds and 100k-target queries roughly 2.6–3.9 seconds; maximum-query and alias cases included deadline failures, even at smaller sizes. These are reported earlier observations, not measurements reproduced for this design. They do not represent 10k originals plus ideas, titles, discussions and ordinary long bodies. Good matcher-oracle results establish correctness under the old objective, not that it is the right retrieval product.

The normal collection target is **10,000 originals plus associated ideas and titles**. **100,000 originals** is a meaningful larger target, not an automatic capacity claim. Count roots, current entities, titles, total text, passages and historical versions separately. One original is not one search field or one passage.

## Canonical knowledge and derived search

| Representation | Authority and responsibility |
| --- | --- |
| Canonical SQLite records | Immutable original sources, user discussion contributions, attributed idea/formulation history, current versions, effective titles and overrides, typed directed relationships, rationale, evidence, derivation, receipts and jobs. |
| Derived SQLite passage catalog | Exact current source/item/title identities, paragraph/window ranges, original text slices and coverage metadata, format/normalization/segmentation versions and a search-content revision. Rebuildable from canonical records without an AI pass. |
| Prepared search accelerator | Matcher keys, original-offset maps and the structures required by the selected engine. Replaceable, versioned and generation-scoped. May initially be an immutable in-process prepared array **only if the experiment passes**; that is a scan baseline, not a selective corpus index. |

Use the same SQLite database for the durable passage catalog initially: canonical and derived current content can change in one transaction. A separate SQL file or search service is not required merely because there are two logical representations. No duplicate authority, independent editable search documents, embedding model, or generated search summaries are introduced.

SQLite remains appropriate for this local single-user application. Indexed relationship endpoints support the present local-neighborhood operations; a graph-shaped knowledge model does not itself require a graph database. PostgreSQL would address materially different deployment/write-concurrency needs, not remove custom matching work. Reconsider storage only on evidence of those needs or materially different graph-query workloads.

Connections remain authoritative knowledge, independent of search acceleration. A relationship-only revision need not rebuild body passages. Losing the derived index must not lose connections or history. Search relevance, an alias, or an index-generated association never becomes a relationship automatically. Existing item endpoints and relationship authority are retained; this design does not settle the separate original-to-original connection discussion.

## Searchable content and passage boundaries

### Eligible entities and versions

Index immutable original bodies, including retained discussion-turn sources; complete **current** formulation bodies for interpretations and developing ideas; and each target's effective current title. Preserve the existing title resolver, user overrides and formulation-specific AI title association. A source and its distinct ideas remain distinct targets. Do not combine their text to manufacture a match.

Historical formulations and titles remain readable through exact version identities, but are not duplicated into default search. Relationship rationales, provenance labels and aliases are not silently appended to body text. There is no newly generated summary or AI keyword field. Other retrieval routes or a history-search product would be separately designed.

### Initial segmentation policy, version 1

- Use natural paragraphs first. Blank lines delimit paragraphs; a single line break remains actual whitespace within a paragraph. Recognize CRLF, LF, CR and Unicode line/paragraph separators consistently. A Unicode paragraph separator is itself a paragraph boundary. Boundaries are deterministic and covered by fixtures, not chosen by a model.
- Preserve original field slices and offsets. Assign separating blank-line whitespace to the preceding paragraph, with any initial whitespace retained in the first span. Paragraph spans partition the complete field without deleting separators. A whitespace-only span can be omitted from matcher candidates because a whitespace-only query is not searchable; its coverage is still recorded.
- Leave paragraphs of at most **1,024 extended grapheme clusters** intact. Split longer paragraphs into **1,024-cluster windows with 256-cluster overlap**, advancing 768 clusters until the paragraph end. Never split a grapheme. Apply the same bounded-window rule to unusually long titles; title and body remain separate fields.
- Store paragraph ordinal, window ordinal, original UTF-16 start/end, exact field owner/revision and coverage metadata. Every non-whitespace body cluster must belong to at least one candidate passage, including material at the end of a huge source, except explicitly recorded oversized-grapheme ranges described below. Overlap is duplication for retrieval, not duplicated canonical content.
- The overlap conservatively preserves within-paragraph matches whose entire span is at most 256 grapheme clusters across a window seam. It does **not** guarantee every span that fits in a 1,024-cluster window will be represented at every possible alignment. Passage eligibility means the query matches at least one of the actual generated windows.

These are explicit product boundaries: no match stitches across paragraphs, source/item fields, or windows that do not individually contain it. Thus `sdk` in a short passage still finds both `SoftwareDevelopmentKit` and `shoulD Know`, but `s`, `d`, and `k` spread through distant paragraphs no longer establish a hit. All body text is covered; all possible whole-body subsequences are not. Query whitespace outside a passage cannot be borrowed from its neighbor. The UI describes local matching, not an exhaustive full-body fuzzy result.

Grapheme counts are not a byte bound: one cluster or whitespace run can be enormous. Version 1 also limits a prepared matcher passage to **16,384 original UTF-16 code units**. Split at grapheme boundaries earlier when this limit requires it, using up to 256 clusters of overlap while ensuring each window advances. The 256-cluster seam guarantee applies only where both bounds allow that overlap. A single larger grapheme is not split or discarded: record its unsearchable range and return `contentCoverage: limited` with a reason. Any body containing that range remains fully readable canonically. This is an explicit exceptional coverage limit, not a complete-index claim or a reason to fail all unrelated search.

## Matching, ranking and bounded candidates

### Required behavior versus engine scoring

Retain literal ordered-character admission inside one passage: query `sdk` must match **both `SoftwareDevelopmentKit` and `shoulD Know`**, without aliases, and also `Software Development Kit`. Every query character must occur in order; repeats consume distinct occurrences. A query space must consume actual Unicode whitespace, never punctuation or an implicit AND separator. Fuzzy skipping of other passage characters between query characters remains allowed. No automatic edit-distance correction or semantic inference is required.

Retain shared validation: well-formed Unicode, at most **512 input UTF-16 code units**, literal punctuation, and no query operators. Collapse whitespace runs to one required whitespace key but do not trim meaningful leading/trailing whitespace. Empty/whitespace-only queries return no results. Normalize each original non-whitespace grapheme as NFC, locale-independent lowercase, then NFC again, without diacritic stripping or transliteration. Preserve the prior documented distinctions for dotted I, sharp S and accents; a library setting is not proof of equivalence.

Original grapheme clusters remain the normalization and display-mapping boundary. A candidate library may work in code points/runes; the adapter must prove ordered eligibility on the normalized grapheme keys and translate its positions to whole original grapheme ranges, including case transformations that expand. If the proposed adapter cannot do that without recreating a complex matcher, reject that library configuration and report the incompatibility. Do not quietly relax Unicode or whitespace behavior to obtain a faster result.

**Mature boundary/camel-case/consecutive-match scoring is acceptable.** The former whole-word/contiguous/initials/scattered tuple, globally shortest span, canonical optimal alignment and exact small-K-prefix property are retired. A greedy or library-ranked occurrence can be acceptable if it satisfies passage admission and produces truthful, useful highlights. The adapter need not reproduce the old DP objective.

### Result selection and diversity

Use default **50 entities**, caller limit **1–200**. Bound the direct shortlist to `min(2000, max(200, 8 × limit))` passage hits. Group by source/item identity, retaining at most two nonredundant body passages and one title hit as context per entity; overlapping windows over the same occurrence do not become separate results. Use library score descending within a route; prefer title over body only on equal score. Break remaining ties by binary target kind/ID, formulation/title revision, paragraph ordinal and window start. Do not rank by recency, popularity or graph connectedness, or display a score as confidence in meaning.

After grouping, admit at most **three entities per original root** to the returned list; preserve separate original and idea identities. This prevents one source with many annotations from crowding out cross-root candidates. Diversity and finite shortlisting can omit otherwise eligible entities; report when either cap binds. Do not repeatedly enlarge the shortlist to fill a requested limit. A short response is acceptable and must not imply no other content matches. Within an entity, preserve the best passage's own field, version and route rather than merging incompatible highlight coordinates.

### Recorded aliases: retain, but stop unconditional fan-out

Keep recorded alias data, attribution, evidence and constrained `record_alias` behavior. Aliases are optional retrieval metadata, never needed for either SDK example and never relationship evidence.

Run the direct query first. Only if fewer than the requested number of direct entities survive grouping/diversity may the engine supplement them through exact whole-normalized-query alias lookup, one hop in either direction. Select at most **four distinct expanded queries and 256 aggregate normalized keys**, in binary alias-ID/direction order; stop before the first expansion that exceeds a bound. Deduplicate identical expansions. There is no chaining, generation, or unconditional 100-record rescan.

Supplemental alias work has a maximum **150 ms** within the request's overall deadline. Alias-only entities follow direct entities, carry the actual expansion and alias provenance, and consume the same result/diversity limits. Bound their aggregate shortlist to the same passage-hit cap as the direct route, not that cap per expansion. Compare scores only within one query variant; merge alias variants in their deterministic selected order rather than assuming raw scores for different-length queries are comparable. A capped, skipped-for-budget or interrupted alias pass sets an explicit status; do not present its unfinished shortlist as exhaustive. Reducing this optional fan-out is a deliberate contract revision, not deletion of canonical aliases.

## Engine decision: mature matcher first, adoption gated

The [revised algorithm research](../research/thoughtloom-fuzzy-search-algorithms.md) shortlists **fzf-for-js first for an authorized comparative experiment**, not unconditional adoption. Its inspected upstream commit is `cf3903255b6bba6143bfbed5a387f3cadfd6938a`; that research pin is not a selected published package version. Verify the actual published release, pin it and its lockfile only within separately authorized dependency scope, and establish Bun 1.4.3 compatibility before any production selection.

Compare a reusable prepared passage generation with basic, case-insensitive matching, diacritic folding disabled, finite limits and deterministic application tie keys. Do not use `extendedMatch`, which treats spaces as query syntax. Verify actual release behavior for NFC, casing, literal whitespace, source positions and cancellation. Test its documented V2 mode first; any fallback mode must preserve admission but need not preserve the retired optimal rank.

**Fzf/AsyncFzf scan their supplied candidate arrays.** Prepared rune arrays avoid some repeated work but are not selective text lookup. Batch yielding, cached normalization, SQL paragraph rows and a finite result limit each solve different costs; none establishes 100k-original viability. The experiment must measure construction and reuse of the finder, not construct a new full-corpus finder for every request or hide that cost outside the result.

The architecture decision is therefore firm about canonical SQL, derived passage catalog, engine boundary and product contract, but conditional about the accelerator:

1. Adopt the mature in-process matcher only if end-to-end quality, latency, memory, cancellation and incremental-update criteria below pass at both collection targets.
2. If it fails, do not resume the old optimal-DP tuning or call the array a successful indexed design. Identify whether the limiting cost is candidate volume, Unicode/matching, or rebuilding prepared state. Seek a separately bounded comparison of a genuine local character-position/postings accelerator and, only if matcher execution dominates, a maintained native/WASM matcher such as nucleo.
3. A token/ordinary trigram gate is not a lossless index for arbitrary ordered characters with gaps. Any selective route must preserve the required examples and document passage-level candidate omissions/caps. Lexical or semantic supplemental retrieval is not part of this revision. A native dependency, custom index, sidecar or service requires a justified subsequent choice, not a hidden fallback in this experiment.

This is one concrete technology gate, not permission to implement several competing production engines. SQL streaming over prepared passages can be an informational memory/I/O comparison; it is not presumed faster or selective.

## Updates, generations and coherent reads

### Durable catalog publication

Maintain the affected source/item/title passage rows in the same transaction as their canonical current-content mutation. Increment a monotonic **search-content revision** and append the changed target identities to a durable change journal in that transaction. No revision advance is needed for an unrelated relationship/job update. A title-only change replaces title passages, not an unchanged body. An item revision replaces the current item-body membership and resolves its effective title; restored content uses the new formulation ID. Originals and historical versions are never rewritten by indexing.

Catalog format, segmentation policy, normalization/mapping policy and selected engine version are separate identifiers. A full rebuild reads a coherent canonical snapshot, constructs a complete replacement catalog, validates coverage and identities, catches up recorded relevant mutations, and publishes it atomically. Do not expose half a rebuild or hold a canonical write transaction throughout a full-corpus build. If a safe catch-up/publication implementation is not yet available, controlled maintenance may pause indexing/search while canonical capture remains durable; it must not pretend that partial coverage is current.

### Prepared accelerator lifecycle

Each search pins one SQLite read snapshot and its search-content revision. Use an immutable prepared generation for exactly that revision. If the cached generation is behind, load changed target membership from the journal/catalog in that snapshot and prepare a matching new generation within the request's readiness budget; otherwise return retryable indexing/unavailable. Queries begun before a concurrent mutation may finish against their older, pinned snapshot. New requests must not silently label an older cache current.

Hydrate selected source/item/title identities and original passages from that same read snapshot, checking exact field owners, version membership and ranges. A mismatch is an index/coherence error, not a valid hit. Pinning a snapshot does not authorize a later write: returned versions remain explicit and require fresh canonical tool reads for mutation. Existing results may be opened historically after a newer version appears, with their represented version intact.

Publish a prepared generation only after all its changed entities and maps are ready; a late older build cannot overwrite a newer publication. Retain an old generation only while an active query uses it, then release it. Retain journal entries until the active rebuild and oldest usable cache can no longer need them; lag beyond the retained journal requires a complete refresh, never a guessed patch. Bound and measure old/new/cache-builder coexistence.

Incremental preparation is an adoption requirement, not an assumed library feature. The first comparison must include single-source capture, item revision and title update. If fzf-for-js requires rebuilding its entire finder, measure that actual rebuild and temporary duplication. A measured shard/segment adapter could avoid whole-generation reconstruction, but is not selected here without its update, merge, tie and memory evidence. Do not claim incremental support from the existence of a change journal alone.

## Scheduling, budgets and response meaning

The service boundary, query parser, engine policy and ordered response contract are shared by the user route and authorized agent tool. Agents may issue different conceptual query sequences; they do not receive a hidden admission engine, larger unbounded budgets, or authority from snippets.

Supersede the old 5-second full-scan default with an initial **1,000 ms request work deadline**, including readiness/catch-up, matching and response hydration. This is a hard safeguard, not the target latency. Direct work missing its deadline returns retryable unavailable with no arbitrary scan-prefix results. Optional alias interruption may still return completed direct results with honest alias status. Candidate caps are deliberate bounded selection, distinct from a timed-out prefix.

Allow one matcher execution at a time, with at most one pending replacement. A new interactive request may supersede an older request from the **same caller**; other callers receive retryable busy rather than canceling one another. Tool calls cannot silently replace a user's search. Abort signals and transport-owned caller identity control cancellation, not model-supplied authority. Retire work and its snapshot before starting replacement execution. Do not share AsyncFzf's cancellation state across concurrent owners merely because its API allows replacement.

Check cancellation within bounded batches; library support must be proven under dense long passages. Persistent prepared-state memory has a separate measured limit from per-request buffers. Neither inherits the old 64 MiB traversal guard as a claim about total RSS. Reject oversize work/readiness explicitly and keep canonical capture/reads responsive. No unbounded queue, query cache or retained result snapshots.

Use a newly versioned response, not the old exact-global `hasMore` meaning. Include engine/contract version, generation and search-content revision, bounded-selection scope, result-limit and candidate/diversity-cap indicators, coverage (`complete` or exceptional `limited` with reasons), and alias status (`not-needed`, `complete`, `capped` or `budget-limited`). `more` is `known` only when another distinct eligible result under the configured diversity policy was actually observed; `none` requires complete evaluation with no admission/shortlist/alias/coverage limitation; otherwise it is `unknown`. A finite shortlist is not a total count or a guarantee of globally best entities. GET, plugin and web must change together in a later implementation; do not silently reinterpret the old wire contract.

Each result retains immutable source/root identity and discussion provenance; item kind/author and exact formulation ID; visible title text/author/revision ID; passage field/revision, original range and match ranges; and alias provenance when used. Show an original passage as original, an AI formulation as AI, and a title hit as a title. Older pinned results remain clearly represented as their returned version, not silently switched to current on disclosure.

Return up to **240 original grapheme clusters** of matching-passage preview per entity, additionally bounded to **4,096 UTF-16 units**, using at most three ordered fragments. If all matched positions do not fit, mark omissions and separated fragments honestly. Map positions to original half-open UTF-16 ranges and render escaped text with safe highlights. A preview limit is not a passage-admission limit. Preserve exact full-source/formulation disclosure and query navigation; fetching full text must not refresh surrounding cached result identity/title implicitly.

Search writes no knowledge, aliases, relationships, follow-up jobs or `tool_reads`. Preserve root scope, per-run read witnesses, protected user corrections, revocation, evidence requirements and current-version fencing. The agent still searches, selects, fully reads the needed original/item versions, judges meaning, and only then submits a supported connection through the existing domain boundary.

## Bounded comparative experiment: permission and acceptance gate

**Not authorized to run by this design-writing task.** The parent should request a specific disposable experiment, including permission for any temporary published-package installation, before prototype code or dependency changes. No new implementation beads are created until that scope is approved. Use generated, test-owned input only; no private corpus, live services, native/provider/model calls or database reset. The existing exact engine is an informational baseline, not the new quality oracle. Keep all experiment/build artifacts isolated from the running application and the user's ignored script.

### Controlled collections and quality

- Build 10k-original and 100k-original collections with **two current ideas per original**, source/item titles, discussion-source examples and retained historical formulations not indexed by default. Use reproducible mixed original body strata: 80% 1 KiB, 18% 4 KiB, 2% 64 KiB; vary idea lengths independently and report their distribution. Also isolate each body-size stratum to expose its cost. These are test inputs, not claims about a real corpus.
- Include natural short paragraphs, multi-paragraph notes, long unbroken paragraphs, late-body hits and window seams. Exercise **300k and 1m passage** populations explicitly, varying paragraph/idea counts as needed and reporting the resulting original/entity/text totals. Do not call 1m passages 1m originals or force counts by omitting text. Stream fixture generation; measure its peak memory and distinguish it from accelerator cost.
- Cover both mandatory `sdk` spellings, actual-whitespace and non-whitespace decoys, repeats, rare/common/absent keys, literal punctuation, direct query length limits, optional maximum alias budget, dense accidental matches, Unicode normalization/case, non-Latin scripts, combining sequences and emoji. Verify mapping against original slices, not library positions alone.
- Test full nonexceptional passage coverage, the stated seam guarantee and intended paragraph/window exclusions. Verify no cross-field/version stitching, no alias requirement for SDK, and truthful exceptional oversized-grapheme coverage. A 512-unit query must obey the same deadline/cancellation policy; it is not permitted to block the daemon indefinitely.
- Use a test-owned set of at least 30 annotated retrieval scenarios, including long distractors and multiple ideas from one root. Require every mandatory admission/provenance case and every annotated essential entity to appear within the configured candidate universe; target at least **90% recall of annotated relevant entities in the first 20 displayed entities** across the ordinary scenarios. Report each miss, diversity exclusion and cap, not only an aggregate. These scenarios assess passage retrieval and readable evidence, not whether the agent forms meaningful connections in a real corpus.

### Provisional engineering acceptance targets

These are proposed design gates to test and review, **not observed performance or user latency promises**. Report hardware, Bun/package versions, all memory baselines and cold/warm distributions; do not tune the fixture or drop difficult queries to pass. Ordinary workloads use short queries plus the optional bounded alias route when applicable. Worst-length, broad and adversarial workloads must terminate safely even when they cannot meet ordinary latency.

| Measure | 10k originals plus ideas/titles | 100k originals plus ideas/titles |
| --- | --- | --- |
| Warm ordinary query, including hydration | p95 ≤150 ms; p99 ≤300 ms | p95 ≤400 ms; p99 ≤750 ms |
| Request hard deadline | 1,000 ms, honest unavailable on direct overrun | Same; no five-second fallback |
| Cancellation/replacement release | p95 ≤50 ms; max ≤100 ms | Same |
| Event-loop delay during query/update | p95 ≤20 ms; max ≤50 ms | Same |
| Canonical small capture/title write latency while searching | p95 ≤25 ms | p95 ≤50 ms |
| 1–4 KiB target mutation to ready searchable generation | p95 ≤250 ms | p95 ≤750 ms |
| 64 KiB target mutation to ready searchable generation | ≤1 second | ≤2 seconds, with explicit readiness/unavailable rather than stale success |
| Steady total daemon RSS, including accelerator | ≤512 MiB | ≤1.5 GiB |
| Full build/swap total peak RSS, including pinned old generation | ≤1 GiB | ≤3 GiB |
| Complete generation build/rebuild, reported separately from query | ≤30 seconds | ≤180 seconds |

Measure first-query readiness/cold-cache cost, catalog/index disk size, full fixture-generation peak RSS, matcher construction, prepared-state bytes per passage, incremental update allocation and old/new generation coexistence separately. Fixture generation should stream and remain below **256 MiB RSS** independently of corpus size; retained generated input must not disguise accelerator memory. Exercise repeated query replacement, one agent/user overlap, canonical mutations during search, failed/canceled updates, late publication and rebuild catch-up. No reported warm timing may exclude a rebuild required after an ordinary edit.

Index preparation and query work must both respect responsiveness. A background label does not excuse event-loop blocking or temporary memory beyond the gate. If either collection target fails, report the failing boundary and do not claim the engine meets this architecture's scale goal. A smaller supported product scope or different accelerator requires an explicit decision, not a quiet relaxation of these gates.

## Validation, observability and handoff

Future implementation must reuse and revise meaningful existing search, provenance, title, disclosure and tool-boundary coverage. Replace tests of superseded global-optimum/arbitrary-gap behavior with passage coverage, bounded ranking/diversity and explicit boundary tests; retain immutable-history, exact-version, Unicode-offset, shared-engine and read-before-link protections. Do not preserve duplicate old/new production retrieval paths merely to keep historical tests green.

At capture/catalog, generation-build/publication and search service boundaries, log attempt and outcome with owning IDs/revisions, engine/format version, counts, elapsed time, mutation catch-up, cancellation/failure category and capped/limited status. Record generation build/swap peak memory and active snapshot duration. Do not log query text, passage bodies, aliases, prompts, secrets or a fabricated relevance percentage. Release snapshots and prepared generations on every outcome.

The experimental database is disposable from a product standpoint. A later approved implementation may choose a clean test-database rebuild instead of compatibility machinery whose only purpose is preserving experiments. This is not permission to delete or migrate anything now, and it does not weaken the intended product's immutable-source/history guarantees.

No code, dependencies, tests, builds, benchmarks, migration, private corpus access or live operation is part of authoring this design. Research was read, not benchmarked. Final engine adoption, actual package compatibility and measured capacity remain the explicit uncertainties. The next action is fresh design review followed by the user's bounded-experiment permission, not continued production implementation.
