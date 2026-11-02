---
title: Thoughtloom indexed search and retrieval
date: 2026-11-01
status: approved
tags: [thoughtloom, search, retrieval, sqlite, fts5]
modules: [daemon, contracts, agent-tools, web]
related: [.lore/work/design/thoughtloom-mvp.md, .lore/work/concept/thoughtloom-concept.md]
---

# Thoughtloom indexed search and retrieval

## Current direction and authorization

**Use plain indexed SQLite FTS5 search, word prefixes and bounded typo tolerance, through one shared user/agent retrieval engine.** The user explicitly selected this direction, authorized the fix, and asked that the abandoned fuzzy-search attempt not be treated as canonical. `approved` records that agreed direction, not verification of an unseen implementation or a new approval process.

**Implemented and source-verified; not activated.** `apps/daemon/src/search.ts` now uses the FTS5 projection and bounded query correction. Schema 22 restores the derived indexes from canonical records and retires the abandoned fuzzy projection. Backend/unit, browser, contract, migration, typecheck, offline-provenance and build checks are recorded against `thought-loom-8r5.28.7`. The two browser failures caused by an over-specific spelling tie expectation were reconciled, retested and reviewed without changing production behavior. A complete rollout still requires a matching web build and controlled activation of the reviewed plugin at its existing location; no private configuration, running server or application database was changed during implementation. Do not rerun fresh native setup, which would create new connection material.

## Search behavior

- Search the complete immutable original text, complete current idea/formulation text and effective titles, including protected user title overrides. Keep these distinct, attributable targets; retain historical versions for exact reads rather than overwriting them or indexing every historical revision by default.
- Interpret ordinary queries as words/terms using the configured FTS tokenizer and case handling. Support unfinished word prefixes. Query spaces separate terms; they are not a literal-whitespace or ordered-character alignment contract. Construct FTS queries safely from input rather than treating arbitrary user text as executable MATCH syntax.
- Add bounded application-level typo correction against indexed vocabulary, including `typoi` → `typo`, `softwsre` → `software`, and `develpment` → `development`. Bound correction candidates and query expansion; do not scan every note body with a custom fuzzy matcher. The implementation chooses a small, testable approach, not another retrieval framework.
- **FTS5 supplies token/keyword lookup, prefix queries and BM25 ranking; typo correction is additional query-layer work.** FTS5 alone does not automatically correct spelling or expand acronyms. Existing recorded aliases may remain a practical, attributable supplement, but alias/native/semantic work must not block the basic fix.
- The earlier SDK examples illustrated useful retrieval, not a requirement that `sdk` match every scattered `s…d…k`, `shoulD Know`, or a concatenated phrase without indexed terms or an alias. Do not turn those rough examples back into strict subsequence or grapheme rules.
- Use bounded results, ordinary relevance ranking and stable identity tie handling. Exact words should not be displaced gratuitously by weaker corrections. No globally optimal alignment, exact global-rank proof, paragraph admission engine or new generation-journal architecture is required.

## Storage and consumer boundaries

SQLite remains authoritative for sources, attributed current versions/history, titles, relationships, rationale, evidence and derivation. The FTS index is a derived, rebuildable SQL search representation maintained consistently with canonical writes; it is not a second editable source of truth. Existing migrations already contain source/formulation/title FTS projections, but their existence in migration history does not prove the current reader or index is ready. No new database vendor, service, reset or data loss is part of this direction.

Human search and the authorized agent tool use the same normalization, candidate engine, ranking and policy. Agents can issue several conceptual queries, not use a hidden slower corpus scan or different retrieval semantics. Search only finds candidates; it does not form connections, write knowledge or supply a full-read witness. Preserve per-run reads, root scope, protected corrections and expected-version checks before relationship writes.

Keep the current result UI: matching excerpts with truthful source/idea/title attribution, query-preserving navigation, exact formulation/title identities and full original or pinned-formulation disclosure. A preview is not the complete item. An item/title hit need not occur in its original-source context excerpt. Expanding a result must not silently replace its represented version or metadata. Display snippets do not restrict which parts of a complete indexed body are searchable.

## Verification and performance

Reuse meaningful existing search, title, disclosure and tool-boundary coverage. Verify keyword/prefix/typo examples, original/current-idea/title hits, shared user/tool results, bounded correction work, index/write consistency and retained provenance/history/read-before-link. Replace assertions belonging only to the abandoned subsequence contract; do not discard useful safety coverage. No new design-approval or experimental-engine gate is introduced by this document.

The user's working guideline is **under one second is good** for both human and agent retrieval, not a universal hard requirement or the former self-imposed 150/400 ms p95 gates. Keep shared retrieval responsive; slower agent work must not monopolize user search or capture. Actual capacity at 10,000 originals plus ideas/titles, or 100,000 originals, remains unmeasured for this implementation. Do not extrapolate linearly from the old small fuzzy fixtures or promise a capacity result not measured.

## Superseded attempt

The whole-field custom matcher and later passage/fzf experiments solved an over-literal interpretation of the examples instead of ordinary note search. They are historical work, not the product contract. Fzf and related finders may be useful for other jobs; their Unicode observations do not decide Thoughtloom's current search architecture. No fzf, exhaustive DP, paragraph fuzzy engine, native matcher comparison, new search service or semantic embeddings belong to this fix.

Earlier implementation checkpoints and experiment measurements remain evidence only for their stated historical scope. They do not prove this FTS fix is complete. The source/test and Beads owners handle implementation and task status; this document changes neither deployment state nor live-operation permissions.
