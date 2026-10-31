---
title: Thoughtloom MVP boundary
date: 2026-10-30
status: draft
tags: [thoughtloom, mvp, architecture, knowledge-development]
related: [.lore/work/concept/thoughtloom-concept.md, PRODUCT.md]
---

# Thoughtloom MVP boundary

This records the MVP discussion accepted by the user with “Perfect,” followed by a request to document it. The scope below reflects that agreement; this newly written document has not received separate review or approval. It is not an implementation plan or authorization to build. The initial test corpus and concrete experiment criteria remain undecided.

## What we are testing

Can Thoughtloom help the user discover and develop an idea they otherwise would have missed?

The complete loop is **capture → asynchronous weaving → search → review source and AI notes → dialogue → development → targeted follow-up weaving**. Reading, connection exploration, and discussion are complementary parts of one experience, not competing product directions.

The three mockups in `.impeccable/mocks/inquiry-flow/` are useful experiments, not a selected production design. Avoid a conventional notes workspace with an AI chat sidebar. Productive unfamiliarity should encourage inquiry without sacrificing understandable controls or source access.

## MVP capabilities

### Capture

A text box and Save button preserve original text, capture date, and provenance. No rich-text editor or attachments are needed. Phone-friendly capture belongs in the MVP; polished mobile parity does not.

Saving and weaving have separate states. A failed AI operation must not make a successfully saved note appear lost. Show pending, running, failed, and completed processing, with a retry path.

### Non-interactive weaving

After capture, the weaver records possible interpretations and meaningful connections to existing material. Each relationship has an explanation and source references. It can find no useful connection; it must not manufacture links to fill a quota.

These records are AI hypotheses, not an approval inbox, edits to original text, or declarations of what the user believes. Do not add a mandatory approval gate for every interpretation or relationship. Exact authority over later revisions and user corrections remains to be specified.

### Useful basic search

Search reaches original notes and their AI annotations. It must support abbreviations and reasonable wording variation: for example, “SDK” should find “software development kit.” Include modest typo tolerance rather than exact-string-only retrieval.

The proposed approach is full-text retrieval with acronym/alias expansion. The weaver may record searchable aliases, supplemented by query expansion. Full-text search alone does not guarantee acronym matching. Retrieval aliases are not evidence of meaningful idea relationships. Agentic search is not required for MVP; implementation and quality checks remain open.

### Contextual dialogue and durable development

The user discusses original material, interpretations, and connected ideas together. They can challenge a claim, offer another framing, or follow an offshoot. Preserve user turns as source material and retain the exchange.

The conversational agent uses constrained domain tools to record revised AI hypotheses, connections, and emerging ideas. It does not have unrestricted authority to rewrite the knowledge store. A revised interpretation or new formulation persists beyond chat history, with its derivation visible and earlier material recoverable.

This combines discussion with source capture; it is not a choice between chat and merely saving replies as unrelated notes. Relevant changes happen during interaction rather than waiting for the ordinary capture-time pass. Targeted background weaving can subsequently examine wider implications.

### Follow-up maintenance

MVP triggers weaving on capture and targeted follow-up work after discussion. Programmatic logic schedules and deduplicates jobs and tracks changed inputs. Agentic work examines meaning, tensions, and possible relationships. Exact triggers and affected scopes remain to be designed.

Periodic aging, autonomous gardening, and scheduled resurfacing are deferred. Age or inactivity alone must not weaken an idea. Source preservation and revision history are application guarantees, not cleanup delegated to a later agent pass.

## Core architecture

- **Next.js UX:** presentation, capture, search, source/AI review, and contextual dialogue. The mockups guide experiments, not pixel-exact implementation.
- **Hono daemon:** owns persistence, application/domain operations, agent orchestration, and background-job lifecycle. The frontend is not a second authority for knowledge changes.
- **OpenCode-backed agent integration:** intended TypeScript integration. Verify the current library, API, runtime compatibility, and session lifecycle before choosing the concrete package or embedding arrangement.
- **SQLite:** starting storage choice under a single-user-daemon assumption. Structured records and transactions, not one giant JSON document. Deployment and concurrency assumptions need confirmation before final schema design.

Both conversational and asynchronous agents use the same domain operations and history rules. Agents propose changes through constrained operations; application code validates and persists them. The Thoughtloom database, not an agent session, owns durable knowledge.

### Information to keep distinct

These are conceptual record boundaries, not a final SQL schema:

| Information | Purpose |
| --- | --- |
| Sources | Original captured text and user discussion contributions, dates, provenance |
| Interpretations and revisions | Attributed, evolving AI readings without overwriting originals |
| Relationships | Connected entities, relationship type, rationale, supporting sources, revision history |
| Discussions and turns | Retained exchanges and their context |
| Developing ideas | Formulations emerging from discussion, linked to their derivation |
| Weaving jobs | Inputs, state, attempts, outcomes, and failure/retry information |

Small JSON fields may hold incidental metadata. The knowledge model must remain queryable as structured records. A graph-shaped UX does not require a graph database. Entity identity, relationship endpoints, merging/splitting, and precise revision semantics remain open.

## Trust and durability requirements

- Preserve original inputs and distinguish user statements from AI interpretations.
- Keep rationale and provenance inspectable; a connection is a revisable hypothesis, not proof.
- Retain meaningful revisions and make automated changes inspectable and reversible.
- Notes, annotations, relationships, conversations, and emerging ideas survive daemon restarts.
- Track background failures and retries without losing saved input or silently duplicating changes.
- Do not equate similarity, recency, attention, or age with intrinsic value.

## Outside this MVP

Full-graph visualization; maturity or gamified growth scores; periodic aging and scheduled resurfacing; multiple-agent orchestration; rich-text capture; attachments; extensive filing/organization; polished mobile parity; sophisticated split/merge workflows; agentic search as a prerequisite. Existing Memory Loop/Obsidian integration is not settled by this discussion.

## Decisions still needed before implementation planning

- Initial corpus: existing notes, fresh captures, or a mixture; whether import is necessary for the experiment.
- Concrete success/failure criteria for useful, explainable connections and subsequent idea development. The acronym example is a search requirement, not a complete evaluation protocol.
- Single-user hosting, phone connectivity, access protection, and runtime/deployment boundaries.
- Concrete OpenCode integration, SQL schema, search implementation, and job/retry mechanics.
- Idea identity, scope of discussions, AI revision authority, and protection of user corrections.
- Cost bounds, latency expectations, and verification strategy.

No database schema, SDK package/version, embedding model, autonomous maintenance policy, implementation sequence, or production UI has been approved by this document.
