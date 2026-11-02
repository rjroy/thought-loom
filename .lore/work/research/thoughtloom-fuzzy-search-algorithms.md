---
title: Thoughtloom fuzzy search algorithm research
date: 2026-11-01
status: archived
tags: [thoughtloom, fuzzy-search, passage-retrieval, unicode, algorithms]
modules: [daemon, search]
related: [.lore/work/design/thoughtloom-fuzzy-retrieval.md]
---

# Thoughtloom fuzzy search algorithm research

> **ARCHIVED RESEARCH — not current architecture or an active comparison plan.** The user chose [plain indexed SQLite FTS5 search, prefixes and bounded typo tolerance](../design/thoughtloom-search-retrieval.md), not a paragraph/character fuzzy engine. All contract interpretations and proposed fzf/nucleo/Rust/Go/native comparisons below belong to the abandoned attempt; do not resume them from this document. Source observations, citations and measurement limits remain useful historical facts, not a general rejection of those libraries or a gate on the authorized FTS fix.

## Key Findings

- The new product contract is passage-level retrieval: cover complete content using natural paragraphs and bounded overlapping windows for long paragraphs; return a useful ranked and capped set, not an exhaustive globally optimal arbitrary-gap match. The former design's whole-field rank objective is superseded where conflicting.
- Reject published `fzf-for-js` 0.5.2 **and current upstream `dev`** as unadapted Unicode matcher candidates. Both retain UTF-16 `split("")` as their rune conversion, so surrogate halves become matchable units. Their case-insensitive query and candidate transformations also differ: query lowercases as a string; haystack lowercases each rune and retains only the first output code point. That explains the reported `İ` self-match failure and allows cross-codepoint surrogate-half matches such as `😀` against `😃x🈀`. A newer dev ref did not fix these defects.
- Shortlist two proven codepoint matchers for a later controlled comparison: **nucleo-matcher 0.3.1** through a tiny separate Rust helper first, then **official fzf Go v0.74.5** through a Go helper if needed. Both avoid UTF-16-half matching, but neither is full-grapheme matching; offsets need mapping, and native helper distribution/maintenance is a real cost. No engine is selected or cleared for adoption.
- Preserve both SDK examples: query `sdk` matches “Software Development Kit” and “shoulD Know”. A typed space must match actual whitespace; ordinary fuzzy gaps between query characters remain allowed. Verify literal-space behavior, self-match, Unicode case behavior, surrogate safety and source highlights before scoring/performance comparisons.
- The reviewed repetitive fixture is not a capacity benchmark: dense query about 120 ms over 1,638 passages with roughly two-thirds matching; sparse query about 8 ms with two matches. Those timings are acceptable under the user's current target: normal search under one second is good. There is no 10k-original benchmark yet. Measure 10k originals plus ideas/items/titles, then evaluate reasonable 100k scale and 300k–1m passages with 1 KiB/4 KiB/64 KiB body strata; do not extrapolate linearly or promise 100k before measuring.
- Unicode matcher defects remain source-backed correctness facts, but emoji matching is lower product priority given visually similar emoji in screenshot use. The UTF-16-half issue alone does not justify urgent native integration; weigh actual 10k behavior and maintenance cost.

## Contract and decision boundary

The user's newer passage-level decision supersedes the older [Thoughtloom ordered fuzzy retrieval design](../design/thoughtloom-fuzzy-retrieval.md) where they conflict. That file remains historical context for canonical source safety, provenance, SDK examples and source offsets. Its whole-field exhaustive scan, exact minimum-gap ranking and global-optimum requirement are not binding for the new architecture. This research does not edit that design.

Keep canonical SQLite originals, ideas, versions, relationships and history authoritative. Search a separate versioned/rebuildable derived passage projection and hydrate/witness returned evidence against canonical rows. Keep complete body coverage with natural paragraphs plus overlapping bounded windows within long paragraphs. Return bounded, useful passage candidates, with truthful status if a cap/deadline prevents full search. No semantic model or typo correction is required. Token/FTS search cannot be a hard gate that misses character-subsequence examples.

Accent behavior (`cafe` matching `café`) and whole-grapheme versus codepoint matching remain policy choices; do not assume the old implementation's grapheme policy answers them. The surrogate-half behavior is a real implementation defect but lower priority than core retrieval and latency. Since emoji look visually similar in the screenshot use case, do not overstate its impact or let it alone justify native integration. Still test it, and ensure configured case behavior does not make ordinary query text fail to match itself.

## Current implementation and evidence boundary

`apps/daemon/src/fuzzy-matcher.ts` implements the old whole-field exact-span objective and original UTF-16 reconstruction. `fuzzy-retrieval.ts` exhaustively visits canonical projection targets before global top-K. These remain baselines/provenance examples, not presumptive passage architecture.

`fuzzy-search-work.ts` has a 5-second safety default and one-active-search behavior; neither is a user latency requirement. A foreground typeahead design should measure cancellation/replacement latency. The separate reviewed repeated-pattern fixture reported ~120 ms for a dense query and ~8 ms for a sparse query at only 1,638 passages. Neither it nor previous short-string synthetic data proves capacity at 10k originals, 100k originals, or realistic long-body tails. No experiment was run in this research task.

## Candidate assessment

### Rejected direct candidate: fzf-for-js 0.5.2 and upstream dev

The published release is v0.5.2, published 2023-04-25. The inspected `dev` head is [`cf3903255b6bba6143bfbed5a387f3cadfd6938a`](https://github.com/ajitid/fzf-for-js/commit/cf3903255b6bba6143bfbed5a387f3cadfd6938a), dated 2025-04-14; GitHub identifies it as a Dependabot-only dependency update. Both published tag and dev source contain `str.split("").map(s => s.codePointAt(0)!)`. This splits UTF-16 surrogate pairs into lone surrogate values rather than Unicode codepoints.

The case-insensitive mismatch is also source-visible. `buildPatternForBasicMatch` lowercases the complete query then calls `strToRunes`; the algorithm transforms non-ASCII candidate runes via `String.fromCodePoint(rune).toLowerCase().codePointAt(0)!`, retaining only the first codepoint of any multi-codepoint lowercase result. Thus query `İ` lowercases to `i` plus combining dot while candidate processing retains only `i`, so reported self-match failure follows from the code. Likewise surrogate halves are independent candidate/query units, allowing a match assembled from distinct Unicode characters. These are real core matcher defects, but their product impact is lower priority and does not alone warrant urgent replacement. Current dev has the same code; it is not evidence of an upstream fix.

The library's precomputed array, score limit and AsyncFzf cancellation APIs remain interesting only if the core is corrected upstream and a published release contains the fix. Do not use an adapter to hide these bugs or rely on an unpublished fork for production. Even a fixed release would still need testing for Bun compatibility, actual-whitespace semantics, normalized-index-to-original-offset mapping and array-scan scale.

Sources: [v0.5.2 `runes.ts`](https://github.com/ajitid/fzf-for-js/blob/v0.5.2/src/lib/runes.ts), [dev `runes.ts`](https://github.com/ajitid/fzf-for-js/blob/cf3903255b6bba6143bfbed5a387f3cadfd6938a/src/lib/runes.ts), [query compilation](https://github.com/ajitid/fzf-for-js/blob/v0.5.2/src/lib/pattern.ts), [case transform and matcher](https://github.com/ajitid/fzf-for-js/blob/v0.5.2/src/lib/algo.ts), [release](https://github.com/ajitid/fzf-for-js/releases/tag/v0.5.2). Source inspection supports the reported defects; they were not executed independently here.

### Candidate 1: nucleo-matcher 0.3.1 via separate Rust helper

The upstream repository's v0.4.0 tag contains the `nucleo-matcher` crate at published version 0.3.1. Its API accepts Unicode `char`/UTF-32 data, and with default `unicode-segmentation` it maps each grapheme to its first codepoint. This will not stitch UTF-16 halves. It is not full grapheme matching: matching the first scalar of a combining or compound-emoji grapheme can still be a partial-grapheme policy issue. The case-fold feature uses simple one-codepoint folding; explicitly test `İ` under the selected policy rather than extrapolating from full Unicode casefold expectations. `Pattern::new(..., AtomKind::Fuzzy)` is the literal-pattern API; test that a query space consumes actual whitespace while permitting ordinary fuzzy skips elsewhere.

The matcher exposes optimized scores/indices and reusable scratch; versioned docs describe ~135 KB scratch per Matcher and recommend reuse. No Bun-native JS binding was found/verified. A later bounded comparison could use a small separate Rust helper, one reused Matcher, generated passage fixtures, and an explicit request/response contract. This incurs native build, supported-platform distribution, cancellation and ongoing ownership costs. Do not install/build it in this research; measure total retrieval and integration cost before considering adoption.

Sources: [0.3.1 Matcher docs](https://docs.rs/nucleo-matcher/0.3.1/nucleo_matcher/struct.Matcher.html), [upstream matcher source](https://github.com/helix-editor/nucleo/blob/nucleo-v0.4.0/matcher/src/lib.rs), [Unicode character/grapheme source](https://github.com/helix-editor/nucleo/blob/nucleo-v0.4.0/matcher/src/chars.rs), [literal Pattern API](https://github.com/helix-editor/nucleo/blob/nucleo-v0.4.0/matcher/src/pattern.rs), [0.4.0 changelog](https://github.com/helix-editor/nucleo/releases/tag/nucleo-v0.4.0). The changelog mentions Unicode substring false-positive fixes; it does not establish our cases.

### Candidate 2: official fzf Go core v0.74.5 via Go helper

Official fzf v0.74.5 was published 2026-10-11. Its core represents input and query as Go `[]rune`; basic non-extended pattern compilation lowercases the query as a string and converts it to runes. This avoids UTF-16-half matching and differs from fzf-for-js's query/candidate conversion asymmetry. The source has mature V1 greedy and V2 optimal scoring, fast paths and reusable slabs. It remains codepoint-oriented, not grapheme-oriented; exercise the `İ` self-match case under Go's simple Unicode lowercasing, highlights, emoji boundaries, and policy choices before trusting output.

The algorithm is Go source, not a supported JS matcher API. Comparing it requires a small separate Go helper (or a CLI protocol with process/copy overhead), a versioned binary distribution, offset mapping and cancellation. This is the second option, not an assumption that the CLI is a ready-made daemon. No build or execution occurred.

Sources: [v0.74.5 algorithm](https://github.com/junegunn/fzf/blob/v0.74.5/src/algo/algo.go), [pattern compiler](https://github.com/junegunn/fzf/blob/v0.74.5/src/pattern.go), [character representation](https://github.com/junegunn/fzf/blob/v0.74.5/src/util/chars.go), [release](https://github.com/junegunn/fzf/releases/tag/v0.74.5).

## Smallest useful next comparison (not authorized here)

If a later session is authorized to prototype, compare nucleo and fzf Go using generated owned passage data only; native comparison is optional and must be justified by measured correctness impact, performance, and maintenance cost. Do not modify the production matcher or install dependencies as part of this research. For each candidate, test:

1. `sdk` matches both “Software Development Kit” and “shoulD Know”. A typed query space consumes actual whitespace, while skips between other query characters remain legal.
2. Case-insensitive self-match for `İ`; no self-match failure under declared normalization/casing.
3. `😀` does not match by combining surrogate halves from `😃x🈀`; test valid codepoint matching separately from the still-open partial-grapheme policy.
4. Original-source highlight mapping across Unicode and case/normalization; stable source/version provenance.
5. Representative sparse and dense passage queries; first measure 10k originals with ideas/titles and 1 KiB/4 KiB/64 KiB text. The user accepts normal search under one second; do not impose 100/150/400 ms gates. Only then assess 100k scale. Report latency, peak/resident memory, rebuild/update, cancellation and capped-result disclosure.

The repetitive 1,638-passage observation is only a fixture datum, not a 10k baseline; its 120 ms dense result is acceptable under the current sub-one-second target, not a failure requiring urgent optimization. A prepared candidate array is not a selective index; at 300k–1m passages compare memory and query cost against an indexed or SQLite-backed design if measured needs warrant it. Judge passage usefulness, not old whole-body global optimality. Do not promise 100k by linear extrapolation.

## Scope and provenance

Research checked official GitHub source/release metadata on 2026-11-01: fzf-for-js v0.5.2 (2023-04-25) and dev commit `cf3903255b6bba6143bfbed5a387f3cadfd6938a` (2025-04-14); nucleo crate 0.3.1 in repo tag v0.4.0; fzf v0.74.5 (2026-10-11). No source was downloaded to project files, no code was run, no dependency installed, and no private corpus/service or experiment-report document was accessed or changed. Native candidates are recommendations for a later bounded comparison, not engine selection or adoption approval.
