---
title: Background weaver agent
date: 2026-11-03
status: draft
tags: [thoughtloom, restart, product]
---

# The weaver

## Purpose

The weaver is a non-interactive background agent that examines captured and developed material, records possible interpretations, and discovers meaningful connections. The user does not need to sit in a chat or answer questions for a capture to be processed.

Its task is not to organize every note into a predetermined taxonomy. It should help reveal relationships that ordinary note storage or textual search would miss.

## When it works

The baseline loop is capture followed by asynchronous weaving, and targeted follow-up weaving after meaningful discussion changes. The application schedules and deduplicates work and tracks its state; the agent does the interpretive work.

Exact scheduling, affected scope, and recovery from operational failures remain implementation decisions to design explicitly. Model effort or variants must not become application-imposed turn, token, cost, search-count or note-count quotas. A permanently running model, periodic full-corpus sweep, or scheduled aging process is not assumed.

## What a pass does

1. Read newly retained, non-rejected material and preserve its original wording and provenance.
2. Examine the fixed subject's claims, themes and implications, then actively search the existing collection for candidate notes and ideas, including conceptual relationships beyond lexical similarity.
3. Fully read promising candidate thoughts before asserting a connection. A search snippet is a discovery lead, not evidence; the subject in initial context is already fully read. Reading an existing connection does not read its endpoints.
4. Record a useful interpretation where warranted, clearly AI-authored.
5. Record warranted meaningful connections with correctly directed endpoints, a concrete explanation and supporting references to fully read thoughts, using the initial categories **supports**, **contradicts**, **extends**, and **related**. Store discovered connections separately from the single-parent evolution tree.
6. Generate a concise, clearly AI-authored title for untitled notes. Capture must not require the client or user to supply one; use the first-five-word display fallback until a title is available. Store the title as separate metadata, never a rewrite of the original thought text or ancestry. The user may edit or clear the title, and clearing invites regeneration. Only fill a title that is still absent when the result is saved; a late result must not overwrite a user-supplied title. Rejected notes remain excluded from all weaver work, including title generation.

Finding no useful connection is a valid outcome. Do not invent links, create an interpretation for every capture, or meet a quota of findings. A URL-only capture does invite a source-grounded summary; contextual links follow the captured intent instead. See [URL-aware weaving](url-weaving.md) for individual sibling summaries, inline attribution, source-access failures and the no-snapshot agreement.

These are instructions to a probabilistic model, not a guarantee of discovery or semantic correctness. Scoped reads and full-read witnesses enforce evidence access, not the quality of an explanation.

The weaver may record AI hypotheses without requiring an approval click for each one. That does not make them accepted user beliefs. They must remain inspectable and challengeable through [Idea](idea-view.md) and [Evolve](evolve-view.md).

## After dialogue

The conversational agent can make relevant knowledge changes during interaction. Background follow-up can then examine wider implications: connections to independent notes, tensions with earlier ideas, or another framing worth considering. It should not merely duplicate the immediate response or silently change the conversation's focus.

Evolve handles contribution title filling and warranted connection discovery within the conversational run. On completed Evolve work, an ordinary follow-up weave targets the latest issued development if one exists. A reply without a development remains associated with the contribution and does not schedule a separate contribution weave.

## Trust and visibility

Show simple processing state where useful: pending, working, finished, or failed. Successful capture remains successful even if weaving fails. Retry must not silently duplicate the same changes. Retain a concise completed Weaver outcome as a Full reply on the original capture, including useful partial-result or source-access limitations. A retained outcome does not require creating an interpretation when there is no useful finding.

Preserve attribution, sources, and evolution history. All thoughts, including AI interpretations, are immutable; further thinking creates new material rather than overwriting old material. Rejection and restoration belong only to the user. For the weaver, rejected notes and connections are effectively nonexistent: do not retrieve them, include them as context, or reason from them. An active descendant does not make a rejected ancestor available again. These rules also apply to the evolution agent and the read-only Agentic export agent.

## Future possibilities, not requirements yet

Acronym expansion and alternate-terminology/alias recording for retrieval are future enhancements, not V1 weaver responsibilities. An alias is not a conceptual connection.

Periodic revisiting could reveal neglected questions, emerging themes, or several old notes describing the same problem. Aging, autonomous gardening, resurfacing schedules, and synthesized cross-note ideas need further discussion. Inactivity or age alone must not weaken an idea, imply low value, or justify deletion.
