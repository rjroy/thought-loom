---
title: Lossless Markdown import boundaries
date: 2026-11-04
status: draft
tags: [markdown, import, segmentation, provenance]
---

# Lossless Markdown import boundaries

## Key Findings

- Import must keep exact source wording. Treat Markdown parsing as a way to find safe structural boundaries, not as a transformation pipeline: retain source text and slice it by original offsets. AST serialization is a distinct operation and may normalize syntax, whitespace, escaping, delimiters, line endings, or list markers.
- A heading/section is a document-organization unit, not proof of a coherent idea. Paragraphs are useful conservative candidate units, but do not reliably define ideas. Semantic or LLM boundary proposals may help users, but are interpretations and must not silently become authored meaning.
- Adjacent imported pieces must not become evolution parent/child. If the product later models provenance, distinguish source-document membership/order from semantic relationships. Adjacency alone does not support a conceptual edge.
- Keep durable user-visible immutable thoughts distinct from retrieval chunks, which may be size-limited, overlapping, contextualized, and regenerated for indexing.
- Recommendation (unapproved): a lossless, structure-first proposal flow: retain source + exact ranges; propose candidates using heading hierarchy and complete blocks; let users review, merge/split, or import a whole section; create no evolution ancestry from import. Defer relationship/schema choices.

## What the sources establish

CommonMark defines documents as blocks and explicitly distinguishes containers (lists and block quotes) from leaf blocks. Its grammar includes headings, paragraphs, code blocks, link reference definitions, and other constructs; GFM adds tables, and frontmatter is an extension rather than core CommonMark. Parsing is context-sensitive: reference definitions can occur in containers and affect links elsewhere in the document. Thus line-oriented splitting at blank lines or heading-looking text can sever structure or misclassify code/list content. The CommonMark spec also emphasizes that Markdown implementations have diverged and that parsing rules are needed to resolve ambiguity.

The mdast specification represents Markdown as an abstract syntax tree, with nodes for headings, paragraphs, lists, quotes, code, definitions, GFM tables, and frontmatter. Its model is semantic/abstract, not a promise that serializing a tree reproduces the source byte-for-byte. A source-range strategy can use parser positions (where available) to slice the original string; it should not reconstruct content by stringifying the AST. Exact byte preservation requires retaining source bytes/encoding; JavaScript string offsets alone are UTF-16 code-unit offsets, so any persisted offset contract must state its unit and source encoding.

## Project model findings (verified locally)

- `src/domain/thought.ts` (lines 6–17) defines immutable `text`, a single `parentId`, and `sourceIds: readonly string[]`; those source IDs are thought references, not source-document identity or segment location. The domain shape contains no import-document ID, source position, or byte/range offsets.
- `src/domain/connection.ts` (lines 4–14) defines only conceptual categories `supports`, `contradicts`, `extends`, and `related`. These describe thinking relationships, not document membership/order. In particular, `related` is not a safe default for mere adjacency.
- `docs/database-schema.md` (lines 7–13, 47–55, 65–86) documents evolution ancestry separately from conceptual connections and source associations; source associations point to thoughts and preserve source-list order. The documented model has no source-document/segment-position relation.
- Rejection is separate state on immutable thoughts. A retained full-document copy stored as an ordinary AI-visible thought could expose wording from a rejected segment through that duplicate, depending on the consumer's filtering scope. User-facing source inspection and AI retrieval therefore need distinct authorization/filtering semantics: retaining original text for inspection must not mean making every rejected passage available for agent context. This is a risk implied by the model and must be resolved before product behavior is designed; this research does not prescribe a schema mechanism.

Consequently, importing source documents losslessly while independently rejecting individual segments appears to require some representation of source identity and segment membership/position, or another explicit, enforceable policy. Whether that should be new structure, existing metadata, or a constrained whole-document policy is undecided. No category or schema change is approved here.

## Segmentation tradeoffs

### Markdown structure

Best initial signal for authored organization, with low interpretation risk. Use heading hierarchy as context and keep each section's body intact initially; do not assume each heading section is one idea. Repeated heading text is ordinary and must be disambiguated by occurrence/range, not heading label. Headingless notes remain valid: identify top-level blocks and offer whole-note import or conservative block-level candidates.

Paragraphs can be candidate units because mdast describes a paragraph as a unit of discourse about a point or idea, but that is a format-level description, not a guarantee about user intent. A paragraph may contain dependent context, several claims, or an unfinished fragment; multiple paragraphs may jointly express one idea. Lists should normally remain whole list blocks (nested lists especially); tables remain whole tables; quotations preserve attribution/context; fenced/indented code remain indivisible code blocks by default. Definitions and footnotes may be document-wide dependencies: include them with the referencing material or retain source-level shared context rather than dropping them. Frontmatter is metadata, not thought prose, and should be preserved separately from body text.

### Semantic and LLM proposals

Semantic segmentation can suggest topic shifts where structure is absent, but similarity thresholds are heuristic and embeddings-based splitting is retrieval-oriented. LLMs can suggest boundaries and explain rationale, but their output is an interpretation, can omit dependencies, and must not rewrite the imported wording. Make proposals reviewable and label them as suggestions; never treat the model's summary/title or grouping as user-authored source. No provider calls are needed for this research or for a basic import path.

One useful concrete mechanism appears in Chroma's retrieval study: asking a model to repeat source text with split markers produced altered text, so the researchers instead supplied indexed pieces and requested boundary indexes. For Thoughtloom, the analogous candidate is to expose parser-derived block IDs and have the model select boundaries between them; the daemon would validate those IDs and slice the original source itself. This constrains text preservation mechanically, but does not guarantee coherent ideas or adequate context. The study supports investigating the mechanism, not adopting its fixed token-sized pieces or claiming it solves durable thought segmentation.

### Fixed size, paragraphs, and retrieval chunks

Fixed-size/token chunks with overlap are useful for bounded retrieval context, not a durable thought model. Overlap intentionally duplicates text, and retrieval chunks can cross or ignore authored boundaries. They should carry provenance to source ranges and must not be imported as duplicate user thoughts. Long indivisible blocks exceeding a retrieval limit need a separate retrieval-only strategy (subchunking with offsets/context), while the durable imported item remains exact and whole unless the user explicitly chooses a split.

## Suggested minimal approach (draft recommendation)

1. Preserve the original document unchanged, including frontmatter, line endings, whitespace, and source ordering. Parse using a declared Markdown dialect and extensions; do not silently claim universal Markdown support.
2. Generate ranges from parser source positions against the original input. Keep exact source slices as content; retain heading path and source order as neutral document context. Ensure slices cover content without overlap or loss where the import contract promises partitioning; explicitly account for separators/definitions/frontmatter rather than dropping them.
3. Initially offer whole-document/section candidates and conservative complete-block candidates, not automatic atomization. A section is importable as one intact unit; long content can remain one durable item while retrieval indexing uses internal chunks.
4. For unstructured notes, propose complete paragraph/block groupings and a whole-note fallback. Avoid forced size splitting for user-visible import. If a block is too large for a selected system limit, report it and offer whole-block import or user-directed segmentation rather than silently rewriting or truncating.
5. Let the user choose merge/split boundaries. Any AI-proposed grouping or generated interpretation is explicitly marked as a proposal and kept distinct from the exact source text.
6. Do not infer evolution ancestry from document adjacency, heading nesting, or import order; do not use conceptual `related` for adjacency by default. If a later decision wants document membership/order and independent segment rejection, decide how source identity, segment position, user inspection, and AI rejection filtering interact. A full-document retained copy must not become an AI-context bypass for rejected segments. Whether to add structure, reuse metadata, or limit retention remains undecided and no schema change is authorized by this research.

This is a recommendation, not an approved product decision. In particular, whether document membership is represented as a new association or existing conceptual categories remains unresolved.

## Validation plan (for future implementation)

Use test-owned Markdown strings, not live vault files. Cover: repeated headings; headingless prose; heading inside fenced code; nested lists; block quotes; GFM table; fenced and indented code; reference-style link used before/after its definition; YAML frontmatter; CRLF, tabs, trailing spaces, Unicode/emoji; escaped syntax; and a single oversized code/table/list block. Assert exact equality of every stored source slice to the selected original range, correct range units, and lossless reconstruction of the document from ordered slices plus explicitly represented separators/metadata. Assert no range overlap or omitted bytes when full coverage is expected. Verify candidate grouping changes do not alter source text, and importing adjacent candidates creates no parent-child evolution. Test repeated headings by positional identity. Separately test retrieval chunking as lossy/overlapping internal projections that map back to exact source ranges and do not create durable thoughts.

## Sources

- CommonMark 0.31.2 specification (primary syntax specification): https://spec.commonmark.org/0.31.2/ — block/container model, parsing precedence, heading/code/link-definition rules, implementation divergence. It specifies CommonMark, not every Markdown dialect or extension.
- mdast specification (primary format specification): https://github.com/syntax-tree/mdast — AST node model, paragraph/list/heading/code/definition/table/frontmatter representations. It defines an abstract tree, not lossless round-trip guarantees.
- Unstructured chunking documentation (vendor documentation): https://docs.unstructured.io/concepts/chunking — describes combining consecutive text elements and chunking constraints; useful implementation example, not independent evidence that a particular chunking strategy best captures user ideas.
- Chroma, “Evaluating Chunking Strategies for Retrieval” (vendor-published empirical research): https://www.trychroma.com/research/evaluating-chunking — retrieval-oriented evaluation and strategy tradeoffs. Its benchmark/task setup does not establish boundaries for immutable, user-visible authored thoughts.
- LlamaIndex semantic chunking example (vendor documentation): https://developers.llamaindex.ai/python/examples/node_parsers/semantic_chunking/ — semantic splitter selects boundaries between sentences using embeddings. This documents one retrieval-oriented algorithm, not a general quality guarantee.
- remark discussion on preserving source while stringifying: https://github.com/orgs/remarkjs/discussions/1460 — community discussion illustrating the distinction between AST edits and source preservation; not a normative guarantee.

## Limitations

This research did not inspect a complete current import implementation or establish a product schema. Vendor chunking materials describe retrieval/indexing goals and should not be treated as independent validation of durable thought boundaries. No paid services, model calls, or runtime services were used.
