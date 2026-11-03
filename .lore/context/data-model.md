---
title: Thoughtloom conceptual data model
date: 2026-11-03
status: draft
tags: [thoughtloom, restart, product]
---

# Notes and their connections

This describes the information Thoughtloom needs to retain, not its tables or implementation. The model must serve the thinking, not mirror the arrangement of cards on a screen.

## What is a note?

A note is a retained piece of thinking that can be read, attributed, found again, and connected to other thinking. It may contain an observation, question, argument, interpretation, or developing idea. Those subjects do not each require a different technical type or interface.

For product discussion, “note” is an umbrella term. Original source material and later interpretations must remain distinguishable underneath it.

## Kinds of material

- **Captured original:** what the user entered, with its date and provenance. This is a historical record, not text the AI may silently improve or replace.
- **User contribution during development:** a question, challenge, correction, or new thought entered in a discussion. Retain the user's actual words and the context in which they were contributed.
- **AI interpretation:** an attributed reading of existing material. It is a hypothesis about meaning, not a replacement original or an assertion that the user agrees.
- **Developing idea:** a retained formulation emerging from interpretation or dialogue. It may be AI-authored or user-authored; kind and authorship are separate facts. It can develop over time without erasing what came before.

A captured note can contain several ideas. Several notes can contribute to one developing idea. Not every capture needs a separate interpretation, and not every discussion message needs a new durable idea.

## Information retained about a note

Keep its identity, actual text, available title, authorship, relevant dates, and origin. For interpreted or developed material, retain the sources or contributions that informed it and meaningful revision history. A title labels the text; it does not replace it. Alternate names or acronyms can help retrieval but are not new notes or conceptual connections.

If a note has no title, its first five words provide the display label. Do not require a person to write a title before saving.

Original user wording remains recoverable after a correction or later development. AI suggestions and user-confirmed corrections remain distinguishable. Rejection is not the same as deleting the historical record.

## Connections

Two different questions must remain separate:

1. **Where did this come from?** Source and development links describe provenance: material interpreted, a contribution that prompted a formulation, or an earlier formulation that was revised.
2. **Why might these thoughts matter together?** A conceptual connection describes a meaningful relationship, with its rationale and supporting material. It is a revisable hypothesis, not proof.

Possible meanings include supporting, challenging, extending, depending on, or resembling another thought. These are examples, not a finalized exhaustive taxonomy. Direction matters when the meaning is directional; a supporting claim and the claim it supports are not interchangeable.

A connection should identify the thoughts involved, who proposed it, why it was proposed, and what supports it. Preserve meaningful corrections or rejection of that connection. Similar wording, a search match, a retrieval alias, or visual proximity does not by itself establish a connection.

## Discussion is related to knowledge, not identical to it

Retain the user/AI exchange and enough context to understand it. An AI conversational response is not automatically a saved interpretation or developing idea. The system must distinguish what the agent said from what it actually recorded or changed.

Conversation context and knowledge provenance serve different purposes. A conversation can use several relevant thoughts without requiring a single authoritative knowledge parent for every reply. This description does not require primary-development nominations, root ownership hierarchies, or a particular attachment protocol.

## Still to decide

Precise idea identity; when formulations become separate ideas; split/merge behavior; the final connection vocabulary; deletion and archival semantics; and authority over later AI revisions and user corrections. These need product decisions, not assumptions inferred from a mockup.
