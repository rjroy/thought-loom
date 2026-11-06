---
title: Conversational agentic search
date: 2026-11-05
status: draft
tags: [thoughtloom, search, product]
---

# Conversational agentic search

## Purpose

Help the user find existing thinking, including ideas they cannot yet name precisely. Search narrows toward ideas already in the library; Weaver and Evolve expand ideas. This is a planned feature, not current ordinary Explore behavior.

The agent steers the investigation: interpret the request, choose searches, read candidates, follow eligible connections, change direction, and ask clarifying questions when useful. The user need not choose a strategy or translate their request into keywords.

Representative requests include topics from yesterday morning, a half-remembered investigation about ambition, and useful starting notes for exploring a proposition such as “Conflict is necessary.” These are examples of intent, not a fixed set of search modes. Relevant starting points may include complementary or contradictory thoughts.

## Library-only investigation

Search uses only the Thoughtloom library, not web searches or external sources. Broadening native/MCP tool access is a separate discussion for Weaver/Evolve, not permission to broaden Search.

Search may clarify what the user seeks and explain why existing thoughts are relevant. Its job is not to compose substitute ideas or turn search exchanges into library thoughts. A discovered idea references an existing database thought; it is not a new thought, conceptual connection, or evolution node.

## Conversation and discoveries

The search is conversational. An accumulated discovery list accompanies the conversation. The agent may add discoveries but cannot silently remove earlier ones. The user may remove an entry from the session without rejecting or changing the underlying thought. Removal is not a permanent suppression: a later agent discovery may add that thought back, and the user can remove it again. Replaying a previously issued command or refreshing the page must not undo a newer removal.

## Saved sessions

Support multiple saved, resumable search sessions. Refresh restores the saved conversation and discoveries, and the user can return to another session later. Retain sessions indefinitely until explicit manual deletion rather than automatic expiry. Start with a simple session list showing a title, last activity and Delete; folders and automatic cleanup are not required.

Deleting a session removes its conversation and discovery selections from Thoughtloom, never the underlying thoughts. Thoughtloom owns this local retention policy; OpenCode and providers retain their own policies. Their remote copies are outside this feature's retention scope, and no provider-side erasure is promised or required. The technical design must still fence active work and late results so deletion cannot recreate the local session.

## Time context

The web client sends its current time through the Next server to the daemon. The daemon supplies both user time and database/daemon time to the agent when that context has not yet been supplied, or when more than an hour has passed since the last update. This gives the agent an explicit clock reference for reasoning about requests such as yesterday morning; it must not assume an inherent live clock.

Record timestamps remain daemon-owned. Client time is context for interpreting user intent, not permission to assign SQL creation timestamps. The technical design must retain sufficient date/timezone information to distinguish local dates and offsets, define clock-update boundaries, and avoid silently changing an earlier request's relative-time meaning during recovery.

## Rejection and boundaries

Rejected material remains unavailable to the AI, including when resuming a saved conversation. Filtering the discovery list alone is insufficient if old assistant messages, tool results or native history still contain rejected thought text or derived provenance. The technical design must provide a credible rejection-safe context and recovery path.

Preserve the existing browser → Next.js server → Hono daemon boundary. Design the daemon model and API before client implementation, followed by a designer-led comp-led pass. Ordinary Explore must not silently invoke agents. Agentic export remains a separate read-only publication workflow.

Durable task and design-decision tracking belongs in Beads issue `thought-loom-mus`. This context records product direction, not implementation authorization or a completed technical contract.
