---
title: URL-aware weaving
date: 2026-11-06
status: agreed product direction
tags: [thoughtloom, weaver, sources, urls]
---

# URL-aware weaving

Thoughtloom is also a general note store. Capturing a URL to obtain a useful summary is a primary use case, not necessarily a request to develop a new idea. Use ordinary capture and weaving, not a separate URL-ingestion endpoint.

## Follow the captured intent

- A URL-only capture automatically invites a source-grounded summary.
- With accompanying user thinking, interpret the entire thought. A pointer to an interesting passage may invite investigation; a cited URL may support a claim. These are examples, not fixed categories.
- A bare set of links calls for individual summaries. Each is a separately searchable AI interpretation with the original capture as its single parent: siblings, not a summary-to-summary chain.
- When the user's context relates several sources, produce a coherent interpretation rather than automatically summarizing each separately.

Preserve immutable captured wording. Put readable source links directly in interpretation text. No separate URL-reference type or source-metadata subsystem is required.

## Access and source changes

Weaver uses the operator-configured native and MCP tools permitted by its saved binding, including tools for authenticated documents or Slack threads. The [agent tool-access policy](architecture.md#agent-tool-access-policy) applies; this feature does not authorize configuring services or MCPs.

Read referenced sources afresh for each new capture, even when the URL appeared before. Prior summaries are not substitutes for current retrieval. Weaver may follow relevant links to understand the source or thought; it need not exhaustively crawl linked resources.

Do not archive retrieved pages, documents or threads as source snapshots. Retain the resulting interpretation and inline attribution instead.

## Partial results and feedback

If a source is inaccessible, disclose that limitation and interpret the supplied thought as best possible. Do not invent source content. For a link list, save successful summaries even if other sources fail; do not create fake summary thoughts for failures.

Retain a concise Weaver outcome as a Full reply associated with the original capture, using the existing response model. This provides visible partial-success and access-failure feedback without changing interpretation ancestry.

User-triggered reinterpretation lets a user weave any active thought afresh from Idea's More actions, without new text. New interpretations remain children of that subject alongside earlier output; nothing is overwritten or automatically rejected. Existing interpretation work is shown rather than duplicated, and rejected subjects require restoration first. See the [user workflow](../../docs/server-startup.md#reinterpret-an-idea), [API contract](../../docs/daemon-api.md#reinterpret-post-thoughtsidreinterpret), and [design rationale](../work/design/reinterpretation.md).

Markdown segmentation remains a separate restricted process; URL-aware weaving does not redefine how it partitions a file.
