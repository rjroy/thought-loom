---
title: Lossless Markdown import schema and API
date: 2026-11-05
status: approved
tags: [markdown, import, schema, api, provenance, rejection]
modules: [domain, storage, daemon, agent]
related: [.lore/work/research/lossless-markdown-import.md, .lore/context/data-model.md, .lore/context/architecture.md]
---

# Lossless Markdown import schema and API

## Recommendation

Add a **user-only source-document artifact, an immutable byte-range map to imported thoughts, and per-file import admission on the existing durable run machinery**. Imported thoughts are independent roots, not an evolution chain. Source membership is not a conceptual connection and does not use `Thought.sourceIds`.

The daemon accepts submitted Markdown bytes, selects complete-block candidates, asks the initial import agent for boundary IDs, validates the entire selection, and slices the original itself. On an identified AI failure or invalid selection it uses a conservative structural partition automatically. A file's original, complete mapping, thoughts, and ordinary weaving admissions commit together. Bulk work continues independently per file. No preview/approval is required per file.

This is the approved design, **not a description of existing endpoints**. Following independent review and the product confirmations below, the user authorized daemon-first implementation. It requires real schema, domain, protocol, and consumer changes. Current `docs/` contracts remain unchanged until implementation. A separate designer-led, Impeccable comp-led pass will design the Capture **Import button below the textarea** and the new flow before any UI implementation.

### Authority and evidence

`bd show thought-loom-txg` supplies the current agreements: exact wording; structure plus AI grouping; automatic structural fallback for AI failure, not preservation failure; user-only retained original with an initial-segmentation exception; identical skip; changed-known-file report and skip; per-file atomicity; normal post-commit weaving; imported-source attribution; and source metadata rather than new connection categories. It supersedes the research document's optional per-file preview, undecided membership/access, and earlier chaining assumptions.

The following current code was inspected, not assumed:

| Existing boundary | Design consequence |
| --- | --- |
| `src/domain/thought.ts:3–35`, `creation.ts:37–67`, `connection.ts:3–23` | Authors are currently only user/AI; original capture implies user input. `sourceIds` references thoughts. Import needs honest attribution and its own creation command; capture cannot be repurposed by supplying fields. |
| `src/storage/sqlite.ts:32–73,184–208` | Base thoughts and supporting sources are immutable/sealed; titles are separate. There is no source document, original-byte artifact, or import position. |
| `src/domain/rejection.ts:63–68,205–259`, `src/storage/run-aggregate.ts:153–196`, `src/storage/capability.ts:59–81` | Raw storage is not a consumer boundary. Existing AI projections redact rejected references and track exposures; a source-document join must not accidentally enter them. |
| `src/domain/run.ts:8–27`, `src/storage/run-schema.ts`, `src/agent/worker.ts`, `src/storage/run-worker.ts` | Native identities, exact prompts, claims, uncertainty, Stop and recovery already exist. Reuse them; import is not an Evolve contribution or a second native execution journal. |
| `src/agent/opencode-adapter.ts:48,179–206`, `src/agent/history.ts:31–70`, `src/agent/opencode-client.ts:29–38` | Today's observation union has no terminal-failure outcome; errored/unsuccessful turns and completed empty output become `uncertain`. Automatic import fallback therefore requires an explicit import-only terminal observation path, not unchanged reuse or exception-message guessing. |
| `src/domain/weave-scheduling.ts:8–10`, `src/storage/weave-admission.ts:11–35` | Capture's trigger deliberately excludes imports. Add an explicit import trigger, using the same transactional, deduplicated weave admission. |
| `src/daemon/app.ts`, `src/domain/search.ts`, `src/storage/search.ts`, `src/domain/{simple-export,agentic-export}.ts` | Strict fields, roles, search counts, attribution validators and export citations need deliberate extensions. Existing collection routes are unpaginated; proposed pagination below applies only to new import collections. |

Also inspected the relevant domain, SQLite, API, scheduling and worker tests; README; architecture/model context; and the research's parser/losslessness evidence. `.lore/reference/` and `.lore/learned/` are absent. Related local client plans reinforce the existing user-inspection/AI boundary but are historical context, not new authorization.

## 1. Source bytes, partition and grouping

### Byte contract

- Accept actual file bytes, not Markdown embedded in JSON. V1 supports **well-formed UTF-8, with an optional UTF-8 BOM**. Reject invalid UTF-8, UTF-16/other encodings and NUL with a reported unsupported-content error; never replace invalid sequences or guess an encoding. Supporting more encodings later needs an explicit exact-bytes/decoded-text mapping.
- Preserve BOM, CRLF/LF/mixed endings, tabs, spaces, escapes and all original spelling. Do not normalize Unicode, trim thought text, serialize an AST, or use model-repeated text.
- Compute **SHA-256 over the complete submitted bytes**, including BOM/frontmatter/whitespace. Store a 32-byte digest and byte length; expose lowercase hexadecimal only on user-only import/source routes. Compare actual bytes when a digest/length matches. A differing byte string with the same digest/length is a preservation failure (`digest-collision`), not an identical skip.
- Persist ranges as **zero-based UTF-8 byte offsets, half-open `[startByte,endByte)`**, into that exact original BLOB. Integers must be nonnegative safe integers at HTTP/TypeScript boundaries. SQLite checks bounds against the document length. Every boundary must be a Unicode scalar boundary; never split a multibyte character, surrogate pair or complete Markdown block.
- Parsers often report UTF-16 offsets. Build and test a mapping against the unchanged decoded input, accounting for the optional three-byte BOM. Never persist an undocumented parser offset or calculate byte offsets on a newline-normalized copy. Decoding each thought's slice must round-trip to the identical bytes.

### Declared structure and dependency policy

Recommend CommonMark 0.31.2 plus GFM tables, task lists, strikethrough and autolinks, with an opaque leading YAML-frontmatter block. Use one pinned, position-preserving parser configuration; record its version/configuration identifier as `parserVersion`. A suitable implementation is the mdast/micromark source-position approach investigated in the research; package selection and lockfile changes belong to implementation, not this artifact. Do not claim universal Markdown support.

Candidate atoms are complete top-level blocks or complete containers. Lists including nested lists, block quotes, fenced/indented code, tables and HTML blocks are indivisible. Heading labels alone are not IDs. Attach a heading and any immediately following heading-only sequence to their following content; do not create a dangling heading thought. A document-ending heading stays with the preceding group, or is the whole body if it is all the content. Paragraphs are candidates, not a one-paragraph/one-idea rule.

Before offering boundaries, close **document-wide syntax dependencies**:

1. Resolve reference-style links/images against the parser's actual definitions. Every definition and all its uses must remain in one segment. Remove candidate cuts throughout the interval from the earliest participating block to the latest; take the transitive closure when intervals intersect. This can conservatively merge an entire document.
2. An unused definition is not a separate idea: attach its block to an adjacent content block without changing order. Do not append copied definitions to multiple thoughts.
3. V1 does not resolve Obsidian/wiki links, local files, images or URLs. They remain literal wording. Recognized extension syntax whose cross-block dependencies cannot be proved safe (including possible footnotes outside code in this dialect) makes the **whole body indivisible**. This is a conservative structural choice after successful parsing, not permission to recover from a parser exception by ignoring it.

Do not make a shared AI-readable “document context” containing definitions, frontmatter, headings or excerpts: it would bypass segment rejection. Dependency closure keeps necessary exact syntax in the same thought instead. It preserves source syntax, not a guarantee that every fragment has independent semantic context; the initial AI can merge more, never split an unsafe atom.

### Selection and fallback

The daemon issues a manifest of ordered, dependency-safe atoms and cut IDs: `b0` before the first atom through `bN` after the last. IDs belong to this immutable parser manifest, not to model text or global storage identities. The import prompt contains the submitted decoded document and its manifest. The only accepted model completion is, for example:

```json
{"version":1,"kind":"segmentation","cuts":["b0","b3","b7"]}
```

The ordered adjacent cut pairs define contiguous groups. Require exact keys, unique known IDs in strictly increasing order, both endpoints, complete coverage, at least one atom per group, and no unsafe cut. Reject duplicate JSON keys, prose, invented offsets, noncontiguous/reordered selections, titles, replacement text, thought IDs, authorship or additional operations. The model never supplies slices to save. The daemon independently checks final ranges and extracts original slices after validating the *whole* proposal.

On invalid/failed AI output, partition at safe section boundaries, keeping each entire section and the pre-heading introduction intact; merge wherever heading attachment or dependencies require it. Headingless content falls back to one whole-body thought. When uncertain about a cut, keep the whole body. Do not use token-sized durable chunks, overlap, content truncation or an automatic split inside a large block. Report `segmentation.method: "structural"` and a stable reason such as `ai-unconfigured`, `ai-unavailable`, `ai-failed`, `ai-invalid` or `ai-context-unavailable`. This includes an **owned, correlated terminal failure or completed-invalid output, including empty output**, through the import-specific observation contract in section 4. A proven inability to accept the full initial context is an AI failure eligible for fallback, not permission to submit a truncated document; a transport exception after submission intent alone is not that proof.

A parser exception, inconsistent source positions, failed round trip, unclassified non-whitespace bytes, or storage failure fails the file. It is not an AI fallback. Empty/whitespace/frontmatter-only files are recommended to succeed as retained source artifacts with **zero thoughts**, `method: "not-needed"`, and no AI/weaving. This edge-case behavior is a recommendation for approval, not a previously agreed product rule.

### Complete coverage without pretending metadata is thought prose

Keep a single ordered part map over the original:

- `thought`: one exact contiguous range, its thought ID and zero-based thought ordinal.
- `separator`: whitespace between/outside thought ranges; never unclassified prose.
- `frontmatter`: the leading YAML block, including its delimiters and original line endings. Preserve it opaquely; do not execute YAML tags or infer trustworthy authors/dates/titles from it.
- `bom`: the optional leading UTF-8 BOM.

The parts partition `[0,byteLength)` exactly once, with no gaps or overlaps. Within a multi-block thought, original separators remain inside its range. Between thoughts they are separator parts. Reference definitions remain in thought ranges under dependency closure. Concatenating *all parts' original byte slices*, not the thought texts alone, reconstructs the file exactly. An empty file has an empty part list. There is no additional copied “original thought.”

Keep original frontmatter title/date/author and the path user-only. Do not seed thought titles from a document title, filename or heading outside that thought's own range; those strings could contain subsequently rejected material. Initially every imported thought has `title: null, titleAuthor: null`. Normal weaving may fill it from eligible context; user edits/clear and late-fill authority remain unchanged. `createdAt` is import creation time, never a frontmatter date.

## 2. Identity and attribution

### Document identity is not a path

Recommend one canonical retained document per exact byte string **across this daemon's single knowledge library**, even across paths/namespaces. Its ID is daemon-generated and permanent, not the hash or a caller-selected ID. A source namespace identifies a persistent upload collection/future vault, not a filesystem root, request, batch, provider session or browser tab. V1 provides one daemon-created `loose-markdown` namespace, reused on every visit. Future vault namespaces get distinct daemon-owned IDs; choosing one is a reference, not authority to walk a directory.

The initial file locator is `(namespaceId, relativePath)` and is bound on a successful novel import. Paths use literal, case-sensitive Unicode segments separated by `/`; no Unicode or case folding. Reject absolute/drive/UNC paths, backslashes, NUL/control characters, empty/`.`/`..` segments and encoded-path tricks at the actual JSON-value boundary. Percent characters in the JSON value are literal, not URL-decoded a second time. Do not “repair” ambiguous paths. The original label is this validated value; it is never opened by the daemon. Identical basenames from different folders/vaults require different relative paths/namespaces.

Apply these checks in order, before AI or new source/thought writes:

| Condition | Result |
| --- | --- |
| Known locator, identical bytes | `skipped-identical`, reference existing document; no segmentation, thoughts, weaving, title changes or restoration. |
| Known locator, different bytes | `skipped-changed`, reference existing document; do not overwrite, duplicate, re-segment, reject or restore anything. This wins even if the new bytes match a different known document. |
| Unknown locator, bytes identical to any retained document | `skipped-identical` across paths/namespaces; no canonical source/thought changes or AI. |
| Unknown locator and unknown bytes | Reserve admission and process a novel file. |

Only operational admission/report receipts are written for skips. **Do not silently add a new canonical path alias on a cross-path duplicate skip.** This honors skip-before-import-writes and avoids treating byte equality as proof that two external files are one changing file. The report retains the submitted locator and existing document ID, but that observation does not establish future changed-file identity.

The locator table below leaves a small extension seam: a future explicitly authorized rename/alias operation can bind another locator to the existing immutable document ID without changing its bytes, thoughts or original label. No rename endpoint, alias creation on skip, external inode identity or vault-link resolver is included in v1. Consequently, an **edited file at a new, unknown path cannot reliably be recognized as a rename**. Do not claim otherwise or infer identity from similar wording. Supporting changed-after-rename detection requires a future stable external identity/explicit association agreement. This is a material limitation to discuss alongside the recommended dedupe policy, not an AI heuristic to invent later.

### Minimal honest authorship extension

Recommend these narrow additions, rather than storing the importer as the author or adding a general authors/endorsements system:

```text
Actor / TitleAuthor / Connection.proposedBy = user | ai       (unchanged)
ThoughtAuthor                              = user | ai | source
MaterialKind                               += imported-original
Imported thought defaults                  = author: source
                                             kind: imported-original
                                             origin: markdown-import
                                             parentId: null
                                             sourceIds: []
```

`source` means **imported wording; original author unverified**, not a person called “Source,” AI authorship, a user belief or endorsement. Label it “Imported source” in user views. A separate material kind avoids silently redefining today's user-entered `captured-original`. Import action is user-authorized, but that does not make its text user-authored. No real-author inference from frontmatter, filesystem ownership, account identity or model guesses; explicit author claims can later become separately attributed, user-only source metadata after product design.

Split today's shared `Author` type where necessary. Widen only thought authorship, search thought/candidate attribution and export thought attribution. Do **not** accidentally permit `source` as a credential actor, title author, connection proposer or model-selected creation authority. New imported-original records must have the defaults above and an import mapping; ordinary capture/contribute/develop/interpret commands cannot manufacture them. Other existing author/kind combinations remain unchanged.

## 3. Recommended persistence contract

Names below are proposed. All fields are `NOT NULL` unless `?`; IDs are daemon-generated `TEXT`, UTC times daemon-generated ISO text, byte buffers `BLOB`, counters SQLite integers. Every FK uses `NO ACTION` (no cascade deletion). Canonical artifacts are not execution jobs. Operational item rows contain no second claim/native-status journal: `runs` remains authoritative for execution once an item owns a run.

### Canonical source metadata

| Table | Keys and fields | Constraints / ownership |
| --- | --- | --- |
| `import_namespaces` | `id PK`, `kind`, `label`, `created_at` | V1 has exactly one bootstrap `kind='loose-markdown'` row, enforced by a partial unique index for that kind only. Fixed non-content label. Its ID is returned by the API, not guessed by clients. Future vault namespace creation is separate work. |
| `import_documents` | `sequence INTEGER PRIMARY KEY AUTOINCREMENT`, `id UNIQUE` **and deferred FK to `import_document_seals(document_id)`**, `original_bytes BLOB`, `sha256 BLOB`, `byte_length`, `encoding='utf-8'`, `original_namespace_id FK import_namespaces(id)`, `original_path`, `created_at`, `parser_version`, `segmentation_method`, `segmentation_reason?` | `UNIQUE(sha256,byte_length)`; `length(sha256)=32`; `byte_length>=0 AND length(original_bytes)=byte_length`; methods `ai`, `structural`, `not-needed`; reason required only for structural. The document's own ID must have its matching seal at commit, **even with zero thoughts**. Original namespace/path are immutable source attribution, not the latest filename. |
| `import_locations` | `(namespace_id FK import_namespaces(id), relative_path) PK`, `document_id FK import_documents(id)` | Persistent locator bindings. V1 inserts only the original successful novel locator. Future additional locators are explicit associations, never rewritten document identities. Index `document_id`. |
| `import_document_parts` | `(document_id FK import_documents(id), position) PK`, `kind`, `start_byte`, `end_byte`, `thought_id? FK thoughts(id) UNIQUE`, `thought_ordinal?` | Kinds above; `position>=0`; `0<=start<end`; unique `(document_id,thought_ordinal)` for thought parts. `thought_id` and nonnegative ordinal present exactly for `kind='thought'`, otherwise both null. |
| `import_document_seals` | `document_id PK/FK import_documents(id)` | This FK is immediate; the reverse document→seal FK is deferred. Inserting the seal validates the complete file/map; insertions after sealing are blocked. Canonical domain reads also require a seal as defense in depth, not as a substitute for commit-time integrity. |

Use immutable update/delete triggers on documents, locations, parts and seals, including protection against `INSERT OR REPLACE`. Block late part inserts after sealing. A seal insertion must check the original locator binding, contiguous part positions, first start `0`, adjacent end/start equality, final end equal to byte length, correct BOM/frontmatter placement, contiguous thought ordinals, and every mapped thought's required import defaults, null initial title metadata and sealed empty supporting-source set. Empty byte strings allow no parts; zero-thought metadata-only files still require complete coverage. Check every mapped thought's `CAST(text AS BLOB)` equals `substr(original_bytes,start_byte+1,end_byte-start_byte)`. Application validation additionally enforces valid UTF-8/Markdown boundaries and that separator bytes are whitespace; SQL is not the Markdown parser.

Make mapping completeness enforceable at commit, not merely a promise by the writer:

- Declare `FOREIGN KEY (id) REFERENCES import_document_seals(document_id) DEFERRABLE INITIALLY DEFERRED` on **`import_documents` itself**, paired with the seal table's immediate FK back to that document ID. No nullable alternate seal ID or “sealed” flag is needed. Inserting a document incurs a deferred obligation to insert its validated seal in the same transaction. A document plus locator without a seal cannot commit, regardless of thought count; neither its digest nor locator can become an invisible permanent reservation. The locator's FK to the document inherits this guarantee at commit.
- Add internal nullable `thoughts.import_document_id`. Require it exactly for `kind='imported-original'`, together with `author='source'`, `origin='markdown-import'` and a null evolution parent. Non-import thoughts keep this column null. Preserve all other existing author/kind combinations.
- Declare its FK to `import_document_seals(document_id)` **DEFERRABLE INITIALLY DEFERRED**. Add `UNIQUE(import_document_id,id)` and make each thought part's `(document_id,thought_id)` a composite FK to that key. This binds a thought to the correct document, not just any thought ID. The standalone document FK still applies to every part.
- Insert the document, then its imported thoughts (both document/ thought seal obligations are temporarily deferred), their title/source metadata, the parts and original locator, and finally the document seal. Seal validation also checks that **every thought with this `import_document_id` has its unique thought part**, not just that every part has a thought, and that `(original_namespace_id,original_path)` is bound to this document. A missing/invalid seal fails the transaction, including for empty/metadata-only sources with no thought→seal FK to enforce it. A trigger forbids inserting another imported thought into an already sealed document; part insertion is already sealed. Together these prevent both unsealed imports and late membership additions.
- Reject supporting-source rows for an imported-original owner; imports start with sealed empty `sourceIds`. Ordinary `saveThought()` has no document argument and cannot manufacture imports. The dedicated import writer owns this column; it is not added to the ordinary Thought HTTP/AI DTO. User provenance reads resolve it through the scoped source service.

Test these guards against direct partial SQL writes as well as the supported command. In particular, document-only and document+locator transactions must fail commit for zero-byte, metadata-only and nonempty source bytes when no seal exists, whether or not any thoughts were inserted. A failed deferred-FK commit must be explicitly rolled back by the transaction owner before reporting failure/releasing the connection; filtering an orphan out of reads or leaving the failed transaction open is not recovery. Preserve title/source sealing inside the file transaction. The mapping does not apply to AI interpretations or later evolution children; their ancestry already identifies the thought they develop. Source membership must not extend branch rejection/restoration to sibling segments.

### Admission and staged inputs

| Table | Keys and fields | Constraints / ownership |
| --- | --- | --- |
| `markdown_imports` | `sequence INTEGER PRIMARY KEY AUTOINCREMENT`, `id UNIQUE`, `request_key UNIQUE`, `namespace_id FK import_namespaces(id)`, `created_at`, `sealed_at?` | Request key is an opaque caller retry key scoped to the authenticated user-role command, not a daemon entity ID. Namespace/creation/key immutable; seal timestamp set once. A batch has no rollback-the-library operation. |
| `markdown_import_files` | `id PK`, `import_id FK markdown_imports(id)`, `position`, `request_key`, `relative_path`, `sha256 BLOB`, `byte_length`, `created_at`, `run_id? UNIQUE FK runs(id)`, `waiting_on_file_id? FK markdown_import_files(id)`, `outcome?`, `document_id? FK import_documents(id)`, `reason_code?` | Unique `(import_id,position)` and `(import_id,request_key)`; nonnegative positions/length; 32-byte digest. Immutable admitted inputs; guarded operational changes only for binding/waiting/terminal result. Outcomes `imported`, `skipped-identical`, `skipped-changed`, `failed`, `interrupted`. Result document required exactly for the first three. Terminal outcomes and their reason/document never change. |
| `markdown_import_payloads` | `file_id PK/FK markdown_import_files(id)`, `bytes BLOB` | Private staging, not a source artifact/thought. Exact bytes immutable while present; length/digest match the file receipt. Delete only after terminal settlement; final import copies bytes to canonical document in the same transaction. Never serve this table through source or AI read routes. |

For indexed admission checks, store `namespace_id` on file rows as a constrained copy of their batch namespace (composite FK to a unique `(id,namespace_id)` batch key). Two **partial unique indexes over pending reservation holders** enforce one holder per `(namespace_id,relative_path)` and per `(sha256,byte_length)`. The predicate is `outcome IS NULL AND waiting_on_file_id IS NULL`. A holder must have a run; a waiter has no run. Admission inserts/binds both in one immediate transaction. When assigned, waiters point only to a pending holder with its own run, never themselves/another waiter. A holder can settle but never become a waiter, preventing cycles; the pointer may remain until the local scan observes that holder's terminal result. Terminal completion releases these reservations, not an HTTP disconnect or wall-clock expiry.

Checks/triggers enforce outcome/document combinations, input immutability, valid holder/waiter transitions, single-assignment run identity and no new file after batch seal. Batch file positions are assigned under the admission transaction, not accepted from callers. Batch sealing also uses that transaction, so an in-flight upload either admits before the seal or receives `409` without an item. A failed upload is not an admitted empty file. A client can resume an open batch after disconnect; it is never auto-sealed by a timeout.

`markdown_import_payloads` is allowed staging state under per-file atomicity: no unsealed/partial **canonical imported document or thought** survives failure. After failed/interrupted settlement discard staging bytes, retaining the safe receipt and private immutable native journal needed for reconciliation. Initial prompts necessarily contain submitted content in `run_steps.input`; these are execution-private, not a second AI-readable source store. Do not promise deletion of provider history or secure erasure of SQLite pages.

### Reuse and extend runs, not a parallel execution system

- Add `RunKind = "import"`, subordinate intent via the unique `markdown_import_files.run_id`, and a strict segmentation completion envelope. Preserve existing statuses/claims, native binding/identity rules, prepared exact prompts and cancellation bookkeeping. `input_thought_id` and weave fields remain null for import runs. An import run may have zero native submissions (structural/no-content path). When configured, use the server's standard agent model/variant and bind it immutably before dispatch; import clients do not select a model or effort budget.
- Add an import-only `observeImport` transport/worker branch with terminal failure and terminal completion evidence as defined below. Do not widen ordinary `observe` semantics by treating all native errors/empty text as failures, or pass new observation states into today's generic `NativePhase` transition callback.
- Do not admit import via the generic contribution path. The import service owns intent, reservations, bytes and result. Its finalizer is the sole authority that creates imported thoughts after validated extraction; segmentation itself has **no knowledge-write capabilities**.
- `run_issued_thoughts` currently means individually receipted AI developments, not a file partition. Do not fabricate development receipts for imported text. Extend the public run view as a discriminated union: import runs return `{id,kind:"import",status,importId,fileId}`; existing kinds retain their current `confirmedThoughtIds`/`responseId` shape. File status supplies a committed document ID/count, and part pages supply its thought IDs. No unbounded imported-ID array or segmentation response is embedded in a run/bulk admission response.
- Add explicit allowed-kind checks to **both read and write** capability dispatch and trusted run operations. Today several paths merely exclude `export` or assume “not weave means Evolve”; adding a union value alone would accidentally allow import connections or construct wrong context. Ordinary capabilities and generic completion/report envelopes must be rejected for import. Conversely no existing run can accept segmentation output or obtain submitted import bytes.

## 4. Admission, execution and recovery

### Per-file lifecycle

1. **Receive.** Authenticate user role, reject unknown/repeated metadata fields, validate path/namespace and bounded upload transport, read all bytes, validate encoding, compute digest/length. Never accept a caller digest as evidence of content. No AI call occurs during HTTP admission.
2. **Admit in a short immediate transaction.** Check `(batch,requestKey)` first: same admitted path/byte fingerprint returns the same file ID and current result; different inputs conflict. Fingerprints are computed by the daemon from received bytes, never accepted from a caller. Compare actual bytes for canonical dedupe (and against staging while present); after terminal staging cleanup the cryptographic receipt fingerprint remains the idempotency comparison. For a new key, check the known locator, then global byte identity, then pending reservations. Persist a skip receipt immediately, or a waiter, or a novel holder plus exact staged bytes and a queued import run. Compare a pending matching digest's staged bytes too, rather than parking a detected collision as an ordinary duplicate. Dedupe also applies when every existing segment is rejected. Never restore or re-weave on a duplicate.
3. **Wait/recheck.** A same-path or same-bytes contender waits on the existing holder without submitting AI. A daemon-owned local scan wakes waiters when that holder settles, reruns the same ordered checks, and either skips or acquires both reservations and its own queued run. If the first file failed, another can proceed; if it committed, same bytes skip and changed known paths skip. This scan and structural import processing must run even with no configured agent; today's agent-only supervisor startup is insufficient. Use bounded concurrent file parsing/native dispatch with fair queue advancement, not today's unbounded all-runs fan-out for a large batch; this is service capacity, not a batch-size or processing-effort quota.
4. **Parse and prepare.** The holder parses the staged bytes and validates a conservative full partition. Use deterministic parser/version inputs, injected IDs/clocks in tests, and no SQL lock across parsing or native calls. Persist the exact manifest and prompt together before dispatch (in the existing immutable initial step input, with a versioned daemon-rendered job shape). Recheck holder/run ownership at every durable transition.
5. **Select.** With no agent configuration, select structural fallback immediately rather than leave the file queued indefinitely. Proven pre-dispatch unavailability, an owned/correlated terminal failure, proven inability to accept full context or terminal completion whose output fails segmentation validation selects fallback. Reach these terminal cases through `observeImport`, not the current correlator's `uncertain` result or the generic worker's error handler. Atomically retain terminal evidence and the chosen partition before local finalization; genuinely unknown dispatch/history remains observation-only. A valid selection creates no thought until finalization. There is no model turn, effort, token or cost quota added by this design.
6. **Finalize in one immediate transaction.** Revalidate current local finalization authority, reservation ownership, input bytes/digest, manifest and ranges; recheck locator/hash uniqueness as defense in depth. Allocate daemon document/thought IDs and time; insert document (incurring its deferred seal obligation), thoughts, null title metadata, empty supporting-source sets/seals, parts, original locator and validated document seal, **including a seal when thought count is zero**. Admit one normal weave per thought with stable trigger `import:<document-id>:<ordinal>` through the existing weave-admission path. Bind the file's terminal result, mark its import run completed and remove its staged payload. Commit everything together; any seal/deferred-FK/commit failure rolls back the file. Queue admission is not model execution; workers cannot see these rows before commit.
7. **Report.** HTTP polling sees the committed outcome; subsequent weaving can fail or remain queued without undoing import. No automatic adjacency/heading/support connections are inserted. Weaving may discover warranted existing semantic categories under ordinary full-read/rejection rules.

There is no crash window between saved thoughts and weave enqueue: the queued weave run rows are the durable outbox. A failure after the last weave insert still rolls back the entire canonical file. A crash after commit but before notification returns the same sealed document/result on replay, never a second set of thoughts or weave invitations. Do not rely on a process-local “already imported” set.

### Failure, retry, uncertainty and Stop

**Distinguish unknown from failed.** Once submission intent is durable, lost acknowledgement/restart recovers the same native session/prompt and observes it; never resend or create a replacement paid segmentation merely because history is temporarily empty. While native outcome is genuinely unresolved, status can be `uncertain`. That is not a failed segmentation requiring an immediate speculative second attempt. Long-running successful native execution alone is not a timeout-based product failure. Technical HTTP request timeouts may limit one transport call without being a model-runtime budget. Existing `Observation`/`correlateHistory` cannot establish the new fallback cases unchanged: they intentionally return `uncertain` for assistant errors, unsuccessful idle outcomes and completed empty output.

#### Import-only terminal observations

Recommend a separate, internal `observeImport(claim,binding,prompts)` entry on the existing adapter/worker transport, authorized against the **persisted run kind and file ownership**, not a caller/model-supplied mode. Its result is:

```text
ImportObservation = {state: pending | running | uncertain | quarantined}
                  | {state: terminal-failure, evidence: ImportTerminalEvidence}
                  | {state: terminal-completion, output: string,
                     evidence: ImportTerminalEvidence}
```

Here `output` includes the exact concatenated assistant text **even when empty or whitespace-only**. Native terminality and valid segmentation are separate facts. `ImportTerminalEvidence` is a private daemon-created witness identifying the bound session, current prompt and persisted-input hash, exact user/assistant (if present)/idle message IDs, native idle outcome, completion time/finish when present, and assistant/idle error-presence booleans. For terminal completion also retain output byte length/hash with the chosen result; do not store raw provider exceptions or promote error text to a reply. It is not a model completion envelope or an AI-readable response/artifact.

Share the existing ownership/history validation rather than weakening it or introducing an independent session journal. Before either terminal result:

1. Verify the saved binding and native session before and after the reads; fence the claim/current prompt/exact input before and after every async boundary. Consume complete ordered paginated history with cursor-progress checks. Require the recorded submission intent for this current prompt.
2. Require unique valid message IDs/timestamps, all user prompt identities/text in persisted order, no foreign/unsafe context, and the current user message present. No idle from an earlier prompt may settle the current one. A conflict/unsafe context quarantines; incomplete/missing evidence remains uncertain.
3. Require empty inbox and no active owned session, then narrowly correlate the tail after that current user message. Accept only `[assistant,idle]` or, for a failed/interrupted idle, `[idle]` (a provider failure before any assistant output). Multiple assistants/idle markers, missing terminal idle, or otherwise ambiguous tail stay uncertain. Native error flags without this owned terminal context are insufficient.

The installed SDK's `SessionMessageIdle.outcome` is `succeeded | failed | interrupted`; `opencode-client.ts` already projects it and assistant/idle error presence. Use those typed facts, not a string search in provider output or an arbitrary HTTP exception:

| Correlated native tail, after the gates above | Import result and action |
| --- | --- |
| Known idle `failed` or `interrupted`, with zero or one safe assistant | `terminal-failure`; automatically choose structural `ai-failed`. The idle is explicit terminal evidence even when the provider produced no assistant text/completion timestamp. A durable user Stop already fences this callback and remains an interrupted file, not a fallback. |
| Completed assistant plus idle `succeeded`, but assistant/idle has an explicit error or assistant finish is `error` | `terminal-failure`; structural `ai-failed`. Retain both reported facts rather than discard the assistant error or falsely accept success. |
| Completed, error-free assistant plus error-free idle `succeeded` | `terminal-completion` with exact text, including `""`. Accept AI grouping only if finish is `stop` **and** the entire strict segmentation envelope/manifest validates. Empty/whitespace/malformed output, non-stop finish or invalid cuts chooses structural `ai-invalid`; this is not unknown history. |
| Missing/incomplete completion evidence, unknown idle outcome, current input absent, outstanding inbox/active work, incomplete history or transport outage | `pending`, `running` or `uncertain` as appropriate; observation-only with the same identities. No failure inferred from absence, no fallback on an invented terminal event, and no replacement submission. |

“Completed assistant” requires a finite completion timestamp, as today's success check does. A completed-invalid result must reach the import validator **before** the generic worker's `parseEnvelope`/catch-to-`fail` path; otherwise empty/malformed completion would still fail the file rather than fall back. Ordinary `observe`, the legacy `Observation` union/classification, `NativePhase` handling and success/error behavior for weave/Evolve/export remain unchanged. Dispatch the import-only branch by saved `run.kind`; no other kind may request these observation semantics or initial import input. Do not pass `terminal-failure`/`terminal-completion` directly into today's `assertActive(..., observed.state)` callback. Unknown future native shapes require compatibility evidence before expanding the terminal classifier, not a blanket “not succeeded means failed” rule.

#### Durable choice and local finalization

One guarded import selection transaction retains the correlated evidence plus the daemon-validated chosen partition/method/reason as a private, write-once `run_steps.result_json` value with `type:"import-partition"`. It also fences the prior generation/any further native dispatch or advancement and establishes local-only finalization authority. Do not choose fallback in a generic exception handler. An unavailable **proven never-submitted** initial prompt may select a structural result with a `not-submitted` witness instead; after durable submission intent only correlated terminal evidence can establish a failed/completed-invalid result. A lost acknowledgement, empty history, HTTP `503`/timeout or failed history read is not such a witness.

Native state must reflect what was actually observed:

- For `terminal-completion`, record genuine `native_state='completed'` and step `state='completed'`, even when output is empty/invalid. Set `envelope_json` only for a fully valid segmentation envelope; invalid output leaves it null and its reason/evidence resides in the import result.
- For `terminal-failure`, retain the existing native-state vocabulary/last observation (`unknown`/`running`) and an uncertain step; the private terminal-failure witness records the explicit unsuccessful end. Do not pretend it is a successful native completion or add a global failed native state to existing kinds.
- For a `not-submitted` structural/no-content choice, keep the initial prepared/unknown state. Never forge a native output/envelope for a local decision.

**This requires changing today's step-result checks**, which currently require an envelope/completed native step, but only for a daemon-created import-partition result. A cross-table trigger must require an import run and its owning file; the repository validates the result/evidence discriminator and matching binding/prompt/manifest. Existing result immutability and all other kinds' checks remain intact. After choice, the import worker resumes pure local finalization from the saved result without discovery, another observe/submit, a successor model step or a repeated paid call. A crash before recording it observes the same native identities again; a crash afterward uses the immutable recorded choice. The finalizer revalidates source bytes/ranges rather than trusting stored JSON blindly.

If cleanup may still be needed, record cancellation pending atomically with the choice/fence, then finalize under local-only authority. A late native callback cannot replace the selected partition or publish text. Extend cancellation settlement to completed **import** runs with pending cancellation (the current worker only cancels interrupted/failed runs). Cancellation failure does not invalidate an already committed structural import. A protocol/ownership quarantine is not proof that stored source bytes are trustworthy: fail the file if binding/input ownership cannot be established safely rather than relabeling a local integrity error as an AI fallback. This is different from a fully owned terminal completion whose *segmentation output* is invalid.

Transport retries use the **same caller request key and exact inputs**, returning the existing file/result. They do not reopen terminal runs. Recoverable local commit failures can retry the chosen local partition while the owned run is active, with no repeated AI call. A terminal parse/preservation/persistence failure leaves no canonical import; report its safe code and let an explicit later admission with a **new request key** try again after the cause is addressed. It repeats dedupe checks first. There is no automatic “retry segmentation” endpoint and no reprocessing of an existing committed document to recover rejected content.

Existing user-only `POST /runs/:id/stop` applies to import runs too: before commit it fences the run, marks the file interrupted, releases reservations and leaves no canonical source/thoughts. It is not an AI-failure fallback. After commit it does not undo the file or stop its independent weave jobs. Native cancellation settlement remains separate. A batch has no invented all-files Stop/rollback policy; individual active runs can be stopped, and upload submission can cease/seal independently. Waiters eventually settle or acquire a run; they hold no native authority to cancel.

## 5. Access boundaries, including derived text

| Consumer | Permitted | Never permitted |
| --- | --- | --- |
| User, ordinary thought read/search | Active imported thought text, its thought title and honest attribution; a separate numeric/opaque import provenance lookup | Automatic original-file/context expansion or importing title/path/frontmatter into ordinary context |
| User, explicit source inspection | Source list/detail/raw bytes, complete part map and rejected segment links in history scope | Treating that inspection scope as authority to pass its contents into an agent |
| Initial import segmentation | Only its own submitted bytes/manifest, while its owning novel-file run/reservation is active | Other documents, library reads/search, retained-source endpoints, title/knowledge writes, rejection/restoration, shell/files/network tools, caller-chosen run/operation/entity IDs |
| Weaving, Evolve, Agentic export and ordinary AI-role HTTP | Eligible thought text and separately attributed titles through existing scoped services | Full original, source title/path/frontmatter/author claims, heading breadcrumbs, separator text, sibling expansion, batch receipts, source hashes, staging bytes or segmentation transcripts/results |
| Simple export | Existing scoped evolution traversal and thought attribution | Traversing document membership or implicitly attaching the original file |

The exception is a daemon-internal **initial-input capability**, not a new `ReadScope`, public AI route, `run_context` source kind or reusable read-original tool. Bind it to the owning file/run/generation; once a partition is chosen or the run settles, refuse further dispatch of that input. Historical prompt verification/reconciliation may inspect the private journal internally, but may not send a new prompt or re-expose it to a later run. A source becomes committed in the same transaction that ends this authority, so there is no interval in which an already-imported/rejected segment can be re-segmented as a novel file.

Use a fresh restricted native session per import, deny native tools as in configured workers, and treat document instructions as untrusted data. No ordinary retrieval capabilities are advertised or dispatchable. Segmentation's full-source exposure is not thought full-read evidence for later weaving or citations. New weave runs use fresh scoped context and cannot inherit the import native history. The application cannot retract bytes already transmitted to the operator-managed service/provider; its retained copies are nevertheless never an application retrieval source.

**Derived metadata is content too.** Keeping only raw bytes off AI routes is insufficient. Never join a document filename/title, YAML metadata, whole-document summary or heading path into `Thought`, `origin`, search snippets/vocabulary, cached capability results, run context or export source labels. Use constant `origin: "markdown-import"`. The user-only provenance route below is separate from `sourceIds`. New canonical source tables must not enter `RejectionSnapshot` or thought/response FTS. Current thought titles remain subject to thought rejection and the existing scoped machinery; no source-wide title is copied onto every segment.

Source access is user-only **even if all its thoughts are active**. Source membership does not exempt any segment from rejection, restore siblings, or make an active child authorize its rejected parent. Existing exposed-context revalidation continues fencing weaving/Evolve/export after rejection. No new global “source rejected” toggle is needed for this agreement.

## 6. Proposed daemon API

All new routes require the existing bearer authentication. Every new import/source route is user-only (`403` for AI credentials, regardless of `scope`); the internal initial-input capability is not HTTP. Browser uploads/reads go **browser → Next.js server → Hono**, with credentials remaining server-side. The Next boundary must forward the actual bytes without newline/encoding conversion, validate its own same-origin requests and transport bounds, and expose fixed-purpose operations rather than an arbitrary daemon proxy.

### Endpoint matrix

| Method/path | Minimal input | Success / behavior |
| --- | --- | --- |
| `GET /import-namespaces` | None | `200 {items:[{id,kind,label}]}`; v1's one persistent loose-Markdown namespace. No creation/filesystem API. |
| `POST /imports/markdown` | JSON `{}` or `{namespaceId}`; required `Idempotency-Key` header | `201 {import}` for first admission; `200 {import}` for same-key replay; namespace defaults to the built-in namespace. Creates an open batch, not thoughts/native work. |
| `POST /imports/markdown/:id/files` | Multipart exactly `metadata` JSON `{relativePath}` and one `file` byte part; required `Idempotency-Key` | `202 {file}` for novel/waiting work, `200 {file}` for immediate skip or same-key replay. Do not trust multipart filename as identity. Daemon assigns file/run IDs, file order, digest, time and every thought/source default. |
| `POST /imports/markdown/:id/seal` | JSON `{}` | `200 {import}`; idempotently closes further file admission. Does not wait for jobs or approve their text. Same-key file replay remains readable after seal; a new key conflicts. |
| `GET /imports/markdown` | `cursor?`, `limit?` | `200 {items,nextCursor}` of batch summaries, finite membership pagination. |
| `GET /imports/markdown/:id` | None | `200 {import}` summary and counts, no embedded file/text array. |
| `GET /imports/markdown/:id/files` | `cursor?`, `limit?` | `200 {items,nextCursor}` of per-file report records, ordered by daemon admission position. |
| `GET /imports/markdown/:id/files/:fileId` | None | `200 {file}`; validates batch membership; no original bytes/model prose. |
| `GET /import-sources` | **Required `scope=history`**; `cursor?`, `limit?` | `200 {items,nextCursor}` of retained document summaries. Explicit inspection includes user-only path/source labels even after rejection. |
| `GET /import-sources/:id` | **Required `scope=history`** | `200 {source}` metadata: ID, original namespace/path, hash/length/encoding/import time, parser, segmentation, thought count. No inline raw content. |
| `GET /import-sources/:id/parts` | **Required `scope=history`**; `cursor?`, `limit?` | `200 {items,nextCursor}` with positions/kinds/ranges/ordinal/thought ID and current rejected flag for thought parts. Immutable membership, live rejection flags. No automatic thought text. |
| `GET /import-sources/:id/raw` | **Required `scope=history`** | `200` exact file bytes, `text/markdown; charset=utf-8`, attachment with constant safe filename, `nosniff`, private/no-store; never rendered HTML. No Range API in v1. |
| `GET /thoughts/:id/import-source` | Existing single `scope` with normal default | `200 {importSource:null}` for a visible non-import thought, or `{importSource:{documentId,ordinal,startByte,endByte}}`. Target thought must be visible in the same scope, else `404`; user history permits a rejected target. No original-derived text. AI always `403`. |
| Existing `GET /thoughts[/:id]`, relationship reads, `/search` and exports | Existing inputs; author/kind filters gain the new thought values | Existing scope rules and shapes, with honest new thought author/kind. No document IDs in `sourceIds`, no automatic source expansion. |
| Existing `GET /runs/:id`, `POST /runs/:id/stop` | Existing inputs | Import-only view `{id,kind:"import",status,importId,fileId}`; other kinds keep today's shape. Run status/Stop semantics above. Imported IDs are available through the committed file's part pages, never native prompts/full source. |

Unknown fields/parameters, duplicate singleton fields/parts/headers and an absent/blank/malformed request key are rejected. Commands accept no query parameters. Source endpoints require deliberate history scope rather than interpreting ordinary user-token possession as normal-source expansion. Missing history on a source endpoint is `400 inspection-scope-required`; wrong role is still `403`. The thought provenance endpoint accepts existing user inspection modes without broadening the following source read.

The upload's outer media type is `multipart/form-data` with a valid boundary. `metadata` is a bounded UTF-8 JSON text part; `file` is one binary part. Inner file MIME type/extension is advisory, never proof of encoding or a request to fetch/interpret a different media format. Plain prose is valid Markdown. Retain bytes as Markdown only; do not auto-dispatch to media/URL handlers.

`Idempotency-Key` is a caller-generated opaque request token; recommend 1–128 ASCII characters from `[A-Za-z0-9._:-]`, scoped to batch-create or that batch's file-admit command. It is **not** a document/file/run ID, timestamp, actor or classification. The daemon records and compares immutable admitted command inputs/fingerprints, not just the token. A retry must resend the same bytes/path/namespace; it cannot ask the daemon to trust an asserted hash. A timed-out HTTP response is not evidence of failed admission. Same-key replay returns the original daemon-owned identity and current result; different input under an admitted key returns `409 idempotency-conflict`. Batch-create replays compare the resolved namespace. No request key is ever sent to the model as authority.

### Response records and finite pagination

Batch summary `import`:

```text
id, namespaceId, createdAt, sealedAt,
state: open | processing | completed,
counts: {admitted,pending,imported,skippedIdentical,skippedChanged,failed,interrupted}
```

`open` means uploads may still arrive, even if every admitted file is terminal. After seal, any pending file means `processing`; otherwise `completed`. Completion is of the report, not an assertion that every file succeeded. An empty sealed batch completes normally. Weaving does not hold batch completion open.

Counts describe **admitted** files, not a browser's entire selection. Pre-admission transport/validation failures (for example `413` before receiving a valid multipart body) have no daemon file ID. A bulk caller reports those individual HTTP failures alongside the durable batch report and continues submitting the other files. It must not silently count a rejected upload as imported or assume a missing response means no admission; the same request key resolves that uncertainty. Persisting rejected/never-received browser selections as daemon jobs is not required by this API.

Per-file `file`:

```text
id, importId, position, relativePath, byteLength, createdAt,
state: waiting | queued | submitting | running | uncertain |
       imported | skipped-identical | skipped-changed | failed | interrupted,
runId: string | null, documentId: string | null,
thoughtCount: integer | null,
segmentation: {method: ai | structural | not-needed, reason: string | null} | null,
error: {code: string, retryable: boolean} | null
```

A queued/running file is not an imported file. Thought count/segmentation are present only for a successful new import, not an invented reconstruction on skips. `runId` is null for skips/waiters and set once for holders. An AI fallback is a successful `imported` outcome with a reason, not `error`. A failed/interrupted file never exposes partial thought IDs. A changed skip refers to the existing original without promising that the rejected submitted revision was retained as a new source.

Source summary/detail `source` has exactly `id`, `originalNamespaceId`, `originalPath`, `sha256` (64 lowercase hexadecimal characters), `byteLength`, `encoding:"utf-8"`, `createdAt`, `parserVersion`, `segmentation:{method,reason}` and `thoughtCount`. Source lists use that same bounded, text-free-of-document-body shape. A part has exactly `position`, `kind`, `startByte`, `endByte`, `thoughtId` and `ordinal`; only thought parts additionally have current `rejected:boolean`. `thoughtId`/`ordinal` are null on other parts. The raw original is obtained only from `/raw`, never hidden in a metadata field.

Only the new list routes use `{items,nextCursor}`. Recommend `limit=50` by default, maximum `200` items/page, as a response-size bound, not a maximum files/thoughts product quota. Use opaque versioned keyset cursors bound to route, parent ID, scope, limit, last position/sequence and the first page's high-water mark. Validate the cursor, including tampering/wrong parent/scope, before querying. Batches/documents sort by immutable increasing `sequence`; batch files and document parts by their immutable `position`. Do not use mutable status, wall-clock timestamps or offset pagination as cursor order.

Subsequent pages include only membership at or below that high-water mark, with `nextCursor: null` on exhaustion (including an empty terminal page). Later arrivals require a fresh listing, so an open batch or growing library cannot keep one pagination walk alive forever. Status/rejection fields reflect each request's current state; this is **stable finite membership**, not an across-request status snapshot. No server-held SQLite transaction remains open between pages. Use indexes for locator/digest checks and keyset pages, and avoid loading every source BLOB or the entire library to list/report.

### Example requests and outcomes

```http
POST /imports/markdown
Authorization: Bearer <user-token>
Idempotency-Key: capture-import-7
Content-Type: application/json

{}
```

```json
{"import":{"id":"imp-daemon-1","namespaceId":"ns-daemon-1","createdAt":"2026-11-05T12:00:00.000Z","sealedAt":null,"state":"open","counts":{"admitted":0,"pending":0,"imported":0,"skippedIdentical":0,"skippedChanged":0,"failed":0,"interrupted":0}}}
```

File admission sends multipart `metadata` containing `{"relativePath":"notes/example.md"}` and `file` containing the exact submitted bytes; its request key might be `file-7`. It sends no source/thought IDs, author, kind, timestamps, title, model, proposed ranges or filesystem root. Illustrative successful poll after committing `First.\n\nSecond.\n` (16 UTF-8 bytes):

```json
{"file":{"id":"file-daemon-1","importId":"imp-daemon-1","position":0,"relativePath":"notes/example.md","byteLength":16,"createdAt":"2026-11-05T12:00:01.000Z","state":"imported","runId":"run-daemon-1","documentId":"doc-daemon-1","thoughtCount":2,"segmentation":{"method":"ai","reason":null},"error":null}}
```

```json
{"items":[{"position":0,"kind":"thought","startByte":0,"endByte":6,"thoughtId":"thought-daemon-1","ordinal":0,"rejected":false},{"position":1,"kind":"separator","startByte":6,"endByte":8,"thoughtId":null,"ordinal":null},{"position":2,"kind":"thought","startByte":8,"endByte":15,"thoughtId":"thought-daemon-2","ordinal":1,"rejected":true},{"position":3,"kind":"separator","startByte":15,"endByte":16,"thoughtId":null,"ordinal":null}],"nextCursor":null}
```

That parts response is user history inspection, not agent context. A normal AI read of `thought-daemon-1` can contain `First.` and `author:"source", kind:"imported-original", origin:"markdown-import"`; it cannot include the document's title, the second thought or the raw file. User `/raw?scope=history` still returns all 16 original bytes. Repeating the bytes under a new admission key reports `skipped-identical`; changing `notes/example.md` reports `skipped-changed`. Neither queues AI or restores the second thought.

For an alternative **first-import** outcome, owned `[user, assistant(error), idle(failed)]` or `[user, idle(failed)]` history produces an `imported` file with structural reason `ai-failed`. Owned `[user, assistant(completed, text=""), idle(succeeded)]` produces an `imported` file with structural reason `ai-invalid` (one whole-body thought for this headingless example). Empty/missing history after lost acknowledgement instead leaves the same file `uncertain`, with null document/segmentation and no new submission. These alternatives do not mutate an already committed example document or publish native evidence in the response.

### Errors and fallback versus failure

Propose sanitized import-route errors `{error:"Bad request",code:"invalid-import-request"}` with stable machine codes. This extends the error shape **on the new routes**, not a silent rewrite of every existing error contract. Retain existing authentication/error behavior elsewhere.

| HTTP / file result | Meaning |
| --- | --- |
| `400 invalid-import-request`, `invalid-cursor`, `inspection-scope-required` | Malformed fields, path, multipart, key or query; no admitted file. |
| `401` / `403` | Existing missing credential/wrong role, checked before access or mutation. |
| `404` | Missing batch/file/source/namespace or invisible target thought; file detail also checks its batch parent. |
| `409 import-sealed`, `idempotency-conflict` | Admission conflicts, not successful skip results. |
| `413 source-too-large` | Explicit configured upload/transport/parser-memory bound exceeded; never truncate. Report the failing file and let bulk submission continue. |
| `415 unsupported-media-type` | Not the declared multipart/file transport. A `.md` extension alone is not encoding validation. |
| `422 unsupported-source-encoding`, `unsupported-source-content` | Received bytes cannot satisfy the supported exact-text contract; do not substitute decoded text. |
| `500 import-admission-failed` | Unexpected pre-acknowledgement failure; caller must use its same key to establish whether admission committed. No raw exceptions/SQL/source excerpts. |
| `200` poll with `failed` and `parse-failed`, `preservation-failed`, `digest-collision`, `persistence-failed`, `ownership-conflict` | Asynchronous failure after admission; no canonical partial source/thoughts. `retryable` means an explicit new admission may be appropriate, not permission to automatically replay native work. |
| `200` poll with `imported` and structural reason | AI fallback succeeded, including correlated native terminal failure (`ai-failed`) or completed empty/invalid output (`ai-invalid`). No per-file preview or error approval needed; genuinely unknown history remains `uncertain`, not a fabricated fallback. |
| `200` poll with `skipped-identical` / `skipped-changed` | Expected report outcomes; existing knowledge/rejection/title state untouched. |

Deployment bounds must be explicit and consistent across Next, Hono, parser and storage. Choose/measure the maximum accepted source bytes and metadata lengths during implementation, document their actual configured values, and test just-below/above boundaries. Bounded individual requests/pages/concurrency are resource safeguards, **not** a cap on batch/vault file count, thought length, model turns or spend. No compression/archive extraction, server-side path walking, remote URL fetch or link/media resolution is part of these endpoints.

## 7. Migration and existing consumers

This is not an additive-tables-only change. `thoughts.author` and `thoughts.kind` CHECKs must widen, with the nullable internal `import_document_id`/deferred seal FK added; `runs.kind` must admit import; import-specific local step results/terminal evidence require a narrow schema/protocol extension, not new native states for other run kinds. New source tables must include the **document's own deferred ID→seal FK** and the seal's immediate FK back; the thought FK alone is insufficient. SQLite cannot widen the existing CHECKs with an ordinary column addition. Plan a **tested, transactional rebuild of the affected tables and their incoming FK closure**, not textual `sqlite_schema` editing, `INSERT OR REPLACE`, or a rename that leaves child FKs pointing at a discarded legacy parent.

Use the core `migrate()` ownership boundary with foreign keys enabled. Stage/copy the referencing closure under the transaction, recreate dependencies in valid order with the new definitions, and restore canonical triggers/indexes/seals and original rows. Create both sides of the new document/seal cycle before inserting source records; satisfy deferred obligations before commit rather than disabling FK checks. Preserve `rowid` where current run history/receipt ordering depends on it. Run `foreign_key_check` before commit and verify `foreign_keys=ON` afterward. Prove the chosen rebuild procedure on populated self-parenting thought trees, sources, run input/weave links, issued receipts, responses, rejection state and report artifacts before deploying it. The receipt-pair rebuild in `run-receipt-schema.ts` is evidence of existing preservation practice, not sufficient proof for rebuilding the larger thoughts/runs FK closure.

Do not backfill old records as imports, infer missing original bytes/paths/authors, change old authors/kinds/text/time/parent/source order, reset jobs, delete duplicate legacy weave history, regenerate titles, restore rejection, or call a model during migration. Create the default namespace once and preserve its ID on repeated migration. Old databases gain no source documents until an actual import commits. Existing canonical table contents, artifact bytes and private execution histories must compare equal before/after migration; index rebuilds remain derived data.

Concrete exhaustive consumers to update in later authorized scopes:

- **Domain/storage:** thought validation; SQL CHECKs/mappers; document→seal and thought→seal commit obligations plus complete-map/original-locator seal validation; search author/kind validation and zero-valued count maps (`domain/search.ts`, `storage/search.ts`); `Candidate` and replay decoding (`domain/capability.ts`); source attribution decoding/rendering (`domain/agentic-export.ts`); Simple export's labels; explicit import weave scheduling. Keep title authorship and `Connection.proposedBy` restricted to user/AI despite the shared type today.
- **Runs/agent:** run kind validation and schema; initial context union/rendering; envelope parser and import-partition/evidence result constraints; import-only terminal observation/correlation in adapter/history and worker handling before generic parsing; native binding/context authorization; read/write dispatch and trusted operation kind checks; worker completion/failure/Stop/cancellation; the import run-view variant in `storage/agent.ts`; runtime/supervisor processing when agents are absent. Preserve ordinary `Observation` semantics, old report/complete validation and result checks for other kinds, and observation-only recovery when dispatch/history is genuinely unknown.
- **HTTP/docs/manual consumers:** new import application services/strict routes, source inspection, pagination/error codes, role tests; search filter extension; eventual `docs/database-schema.md`, `docs/daemon-api.md`, affected startup/testing docs and README capability statement. Manual tooling may add an owned import walkthrough; existing JSON-only API helper is not a binary upload implementation.
- **Web compatibility, separately scoped:** `features/idea/validation.ts` currently rejects the new author/kind; `features/explore/{query,results}.ts` enumerate user/AI and four kinds; Idea/Explore/Evolve/Export bylines currently render any non-user author as AI; `features/export/sources.ts:15` parses an exhaustive citation suffix. These would reject/mislabel imports unless updated. Title authors/connection proposers must not widen with thought authors. The existing runtime/integration source-copy allowlists also need maintenance when implementation files change. These are future compatibility requirements, not permission to edit the web now.

Search/AI/export may use eligible imported thoughts without fetching source documents. Simple export still walks evolution only: exporting one imported root does **not** export every document segment. Downloading an exact original is the explicit user-only raw-source operation, not another AI export mode. Agentic export cites imported thought IDs with `source`/`imported-original` attribution, not a source file/title obtained through an artifact bypass. Historical reports remain immutable/user-only under current rules.

## 8. Validation required with implementation

No application runtime suite or live-provider check was run for this design-only change. Author checks validated frontmatter/H1, related paths, JSON examples, example byte coverage and whitespace. An isolated in-memory SQLite **mechanism probe**, not the proposed full schema/migration, confirmed that document→seal deferred FKs reject document-only/document+locator commits for empty, metadata-only and prose fixtures, rollback frees their keys, and matching cyclic seals permit commit. The actual adapter/history/worker, SDK field projection/types and persistence constraints were inspected; the new observation behavior still needs implementation and the fake-history tests below.

Future tests must use test-owned bytes, IDs, clocks, databases and fake native transport, never a personal vault, operator service, `.env` file or live provider. Extend existing useful coverage rather than duplicate its entire matrix.

| Boundary | Required evidence |
| --- | --- |
| Exact bytes and partition | Controlled BOM, CRLF/mixed endings, trailing whitespace, Unicode/emoji/combining characters, tabs/escapes, empty/frontmatter-only files. Assert original BLOB/hash, scalar-safe byte offsets, exact thought-byte equality, all-parts reconstruction and no gap/overlap. Invalid UTF-8/NUL/other encoding rejects without replacement. |
| Structure/dependencies | Repeated/ending headings, heading-looking fenced content, nested lists/quotes, GFM tables/code/HTML, headingless prose, forward/backward reference definitions, intersecting dependency closures, unused definitions and conservative unknown footnotes. No unsafe split/duplicate definition; actual parser/position failure fails instead of silently importing a guessed partition. |
| AI contract/fallback | Fake valid boundary IDs; duplicate/foreign/reversed/omitted endpoints, extra prose/text/title/ID/authority fields, duplicate JSON keys, malformed output, unavailable config/service, definite AI failure and too-large native context. Assert automatic structural success/reason, original slices only, zero title/connection/knowledge writes before finalization. No repair conversation or per-file preview requirement. |
| Import terminal observation | Extend `tests/opencode-adapter.test.ts`'s fake paginated SDK-shaped history, not just a worker stub returning an invented failure. Exercise exact owned user→errored assistant→failed idle and user→failed idle, interrupted idle without local Stop, completed empty/whitespace assistant→successful idle, non-stop finish and malformed/nonempty segmentation. Assert `ai-failed` versus `ai-invalid`, durable terminal evidence/partition, no fabricated envelope/native success for failure, one canonical import and no extra paid submission. Include a controlled facade/HTTP projection case proving the actual SDK idle/error/completion fields survive `opencode-client.ts`. |
| Attribution/exhaustive contracts | Import cannot masquerade as user/AI authorship; all thought/search/candidate/export decoders accept only the intended extension. Actors/title authors/proposers remain restricted. Existing capture/Evolve defaults unchanged. Client compatibility tests prevent “non-user means AI” and citation-parser regressions. |
| Admission/races | Same request key concurrent/lost HTTP response; changed payload same key; same path same/different bytes; same bytes at different paths/namespaces; same path changed to another known file's bytes; waiter holder failure/Stop/commit; two database connections. Count paid submissions and canonical records. At most one holder per path/hash, no deadlock/wait cycle, duplicate skip before AI, no restoration or weave on skips. |
| Atomicity/crash/retry | Inject failure after document insert, each thought/title/source seal, mapping/seal, final weave insertion and result update. Reopen after pre-dispatch, lost ack, terminal observation before choice persistence, immutable choice before canonical commit and commit-before-response. Before choice, observe the same native identities; after choice, finalize locally without another observe/submit. No partial canonical file, no duplicate native submission/thoughts/weaves; committed import survives later weave failure. Same-key retry observes identity, explicit new retry rechecks dedupe. |
| Direct-SQL source completeness | With FKs on, attempt document-only and document+locator commits for zero-byte, metadata-only and nonempty sources **with no thoughts**, plus nonempty documents with inserted thoughts/parts but no seal. Every unsealed commit fails; rollback leaves no document/locator/digest reservation and a later valid same-path/same-bytes import succeeds. Reject a seal for the wrong document, missing locator/mapping/title/source seal, gaps/overlap or incomplete coverage; reject late membership and seal replacement/deletion. Positive controls commit correctly sealed zero-thought empty/metadata-only sources and a fully mapped nonzero-thought source. |
| Rejection and indirect leakage | Reject one segment and query every AI path: normal HTTP reads/search/spelling vocabulary, cached capabilities, initial weave/Evolve context, Agentic export/citations, responses and stale callbacks. Seed distinctive secrets in rejected text **and** filename/frontmatter/title/breadcrumbs. No source/artifact leakage even when all segments active. User explicit raw inspection remains exact. Sibling segments stay independent roots and branch reject/restore never follows membership. |
| Worker authority/cleanup | Import cannot search/read library or call any knowledge/rejection/native tool capability; ordinary runs cannot use initial import bytes/segmentation completion or `observeImport`. Old generation/late terminal evidence fenced; completed-fallback cancellation settlement; Stop before/after commit and Stop racing a failed idle; pause/drain/restart; no-agent structural processing and durable queued weaving. No model effort quotas hidden in harness loops. |
| Unknown history / existing-kind regression | Lost acknowledgement followed by empty/partial history, a lone assistant error without correlated idle, an earlier prompt's failed idle, repeated cursors, missing current user, unknown idle outcome, active/inbox work and transport timeout must not trigger fallback or replacement submission. Foreign input/unsafe tools quarantine instead. Resume the same import only when owned terminal history arrives. Run the same failed/empty-completion histories through ordinary `observe` for weave/Evolve/export and assert today's `uncertain` behavior and generic protocol/failure handling remain unchanged. |
| API/bulk/pagination | Binary bytes survive the Next/daemon boundary; unknown/duplicate fields, wrong role/scope, path traversal strings, unauthenticated reads, size/media errors, same-key replay after seal. One failed/oversized file does not block others. Stable high-water pagination during new admissions/status changes, wrong-parent/tampered cursor rejection, empty terminal pages, no source bytes in summaries. |
| Migration | Populated current and isolated legacy title/response/run/receipt fixtures; real FK closure/self references; unchanged canonical content/history/rejection/title attribution; repeated/reopened migration; rollback injection; new CHECK acceptance plus old invalid authors; all immutability/seal/direct-partial-write guards restored. No model/native dependency. |

Log boundary **attempts and outcomes** through the shared leveled logger: admission, dedupe/wait decision, native submit/observe/cancel, validated AI/structural selection, atomic commit and weave admission, and failure settlement. Use daemon IDs, generation, byte/part/count totals, duration and stable reason/status only. Routine polls/reads are Verbose; successful imports/state changes Info; fallback/recoverable failure Warning; terminal preservation/persistence failures Error. Never log bytes/text, paths/namespaces' user labels, frontmatter, titles, raw exceptions, digests/request keys, multipart bodies, native prompts/output or credentials. Add sanitized route templates to `safePath`; generic error handling must not echo parser/provider excerpts.

## Product decisions confirmed, and boundaries to retain

Following independent design review, the user confirmed these three product decisions and then authorized beginning daemon-first implementation. The later import visual flow still requires its separate design pass.

1. **Identity policy:** library-wide exact-byte dedupe, including across filenames, is approved. The user accepted that a renamed and edited file at an unknown locator is treated as new because identity cannot reliably be established. The stable loose-file namespace, literal case-sensitive relative paths, changed-known-locator precedence, and no automatic alias write on a cross-path skip remain the concrete technical recommendations above. Future vault namespace/rename/external-identity behavior remains separate work.
2. **Vocabulary/attribution:** the user approved “Imported source” attribution, thought author `source` and material kind `imported-original`, including necessary schema and affected API-consumer extensions. This does not widen credential actors, title authors or connection proposers beyond user/AI. It is not a zero-schema-impact metadata trick.
3. **Non-prose edge case:** the user approved retaining empty/metadata-only sources successfully with zero thoughts and no AI processing or weaving, rather than rejecting/dropping them or manufacturing ideas.

Other recommendations (byte units, seals, strict manifest validation, transaction/outbox ownership, user-only metadata projections and finite pagination) implement the agreed safety boundaries rather than introduce a new product workflow. No automatic changed-source import, restoration, adjacency connections, filesystem permission model, vault-link resolver, media/URL importer, generalized metadata framework, processing quota or bulk rollback feature is implied. Independent design review accepted the corrected proposal; implementation remains a separate next step, with the agreed designer-led visual pass before UI work.
