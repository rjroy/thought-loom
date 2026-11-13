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

The Weaver/Evolve connection capability suppresses automated duplicates with the same directed endpoints and category. `already-present` preserves the eligible existing relation's identity, explanation and attribution; it is not a new creation or user endorsement. Opaque `not-created` returns no relation details and must not prompt reconstruction of unavailable material or an equivalent clone. A rejected matching relation suppresses creation without being exposed. Purpose, eligibility and all endpoint/supporting-source full reads still apply before either no-op. Receipts retain the original outcome through replay and restoration. Manual connections can still repeat deliberately; reversed directions and distinct categories remain separate.

Optional local System One screening nominates eligible text thoughts for creation-owned connection discovery. Ordinary captured/Markdown weaving owns that step; Evolve contributions and every generated development/interpretation have a dedicated connection-only Weaver owner, including siblings, media interpretations and new reinterpretation outputs. Original media descriptors/title-only work are excluded. Weaver receives full nominated thoughts as leads, independently assesses why/how a connection is warranted and its category/direction, and can still search beyond nominations. A score is not evidence. On unavailable or invalid screening the owner uses search-driven discovery, without presenting partial nominations as exhaustive. Connection-only authority permits scoped reads and fixed-subject connections, not interpretations/developments/titles; it retains an internal outcome without a public Full reply or recursive interpretation job. See [startup configuration](../../docs/server-startup.md#optional-connection-screening).

Screening progress belongs to the stable run/subject, not a claim generation. Completed pair judgments and fixed policy/membership survive ordinary restart; only unfinished read-only judgments may be recomputed. Known failure is durable fallback, and a changed policy/configuration before completion must not mix judgments. Nominees, full-read witnesses and exact prompt bytes commit together. This is not permission to replay uncertain native submissions or resume restored historical work.

Direct API contributions/developments also receive a connection-only owner atomically with their new text. They have an explicit direct-thought identity, not a fabricated creator run, and stay independent of unrelated Evolve Stop propagation. The same no-recursion, scoped-capability and internal-only outcome boundaries apply.

These are instructions to a probabilistic model, not a guarantee of discovery or semantic correctness. Scoped reads and full-read witnesses enforce evidence access, not the quality of an explanation.

The weaver may record AI hypotheses without requiring an approval click for each one. That does not make them accepted user beliefs. They must remain inspectable and challengeable through [Idea](idea-view.md) and [Evolve](evolve-view.md).

## After dialogue

The conversational agent can make relevant knowledge changes during interaction. Background follow-up can then examine wider implications: connections to independent notes, tensions with earlier ideas, or another framing worth considering. It should not merely duplicate the immediate response or silently change the conversation's focus.

Evolve retains contribution title filling and warranted connections within the conversational run. Its contribution and every saved development acquire independent durable connection-only owners at creation, not only after final reply. On completed Evolve work, an ordinary follow-up weave still targets the latest issued development for title/interpretation duties, without repeating creation screening/nominations. A reply without a development remains associated with the contribution; its separate discovery owner does not create a Full reply or interpretation. User Stop on Evolve also stops pending discovery for that run's saved contributions/developments, without undoing already-created connections or claiming native cancellation is settled.

## Trust and visibility

Show simple processing state where useful: pending, working, finished, or failed. Successful capture remains successful even if weaving fails. Retry must not silently duplicate the same changes. Retain a concise completed Weaver outcome as a Full reply on the original capture, including useful partial-result or source-access limitations. A retained outcome does not require creating an interpretation when there is no useful finding.

Preserve attribution, sources, and evolution history. All thoughts, including AI interpretations, are immutable; further thinking creates new material rather than overwriting old material. Rejection and restoration belong only to the user. For the weaver, rejected notes and connections are effectively nonexistent: do not retrieve them, include them as context, or reason from them. An active descendant does not make a rejected ancestor available again. These rules also apply to the evolution agent and the read-only Agentic export agent.

## Future possibilities, not requirements yet

Acronym expansion and alternate-terminology/alias recording for retrieval are future enhancements, not V1 weaver responsibilities. An alias is not a conceptual connection.

Periodic revisiting could reveal neglected questions, emerging themes, or several old notes describing the same problem. Aging, autonomous gardening, resurfacing schedules, and synthesized cross-note ideas need further discussion. Inactivity or age alone must not weaken an idea, imply low value, or justify deletion.
