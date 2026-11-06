---
title: Markdown import
date: 2026-11-05
status: draft
tags: [thoughtloom, product, import]
---

# Markdown import

## Agreed behavior

Import preserves the exact original wording. Markdown structure establishes safe block boundaries; AI groups those blocks into coherent thoughts without supplying replacement text. Paragraphs and headings are signals, not guarantees of one idea. If AI segmentation fails or returns invalid boundaries, use conservative structural grouping automatically and report that fallback. Do not require per-file preview or approval, including future bulk imports.

Imported thoughts are immutable originals attributed as **Imported source**, not automatically to the importing user or AI. Import does not establish endorsement or infer the original author. Each thought identifies its source document and position through separate source metadata. Document order and adjacency are neither evolution ancestry nor proof of a conceptual connection. Imports create independent roots; normal weaving can later discover meaningful relationships.

Retain the exact original document for deliberate user inspection. Agents cannot retrieve that artifact, even when every imported thought is active. The initial segmentation agent may read the submitted document for that operation; this does not authorize later weaving, Evolve or Agentic export to read the retained original. Those agents use eligible imported thoughts through ordinary scoped services. Source filenames, frontmatter and whole-document context must not bypass rejection.

## Completion and repeat imports

- Each file imports completely or leaves no partial canonical document or thoughts. Bulk processing continues with other files and reports failures.
- After successful import, queue normal weaving for titles, interpretations and warranted conceptual connections. Later weaving failure does not undo import.
- Retain empty or metadata-only files as source artifacts with zero thoughts and no AI processing or weaving.
- Skip identical source bytes across the library, including other filenames, before additional AI work or duplicate thoughts. Never restore rejected thoughts as a side effect.
- Ordinary file selections have no reliable directory identity: their filenames are metadata, so different bytes import independently even with the same name. Report and skip changed contents only at a reliable known locator in a non-loose source namespace, leaving its existing import untouched. Reliable rename tracking is not implemented.
- Initial thought titles are absent. Normal title generation and user edit/clear authority apply; source metadata is not copied into every thought title.

## View integration

The agreed entry point is an **Import** action to the right of the [Capture](capture-view.md) page heading, outside the thought/title form, opening a separate import flow. This replaces the earlier below-textarea placement. The user selected the Import Workspace composition and approved the revised entry in the designer-led Impeccable comp-led pass. The client uses only existing daemon capabilities; discuss any gap rather than silently changing the daemon to fit the screen. See the [workflow and bookmark guidance](../../docs/server-startup.md#markdown-import-workflow).

The daemon HTTP workflow and separate web import workspace are implemented. Browser integration keeps the browser → Next.js server → Hono daemon boundary; imported thoughts also open in the existing client views.

URL, media and Obsidian-style vault import remain separate future work. This flow does not authorize filesystem crawling, media attachments or inferred cross-file connections.

## Current contracts

See the [daemon API](../../docs/daemon-api.md#markdown-import-and-source-inspection), [database schema](../../docs/database-schema.md), and [testing concepts](../../docs/testing.md). Request-size and concurrency bounds are technical safeguards, not model-effort or total-file-count quotas; a file-byte limit is not a parser memory guarantee.
