---
title: Evolve view
date: 2026-11-03
status: draft
tags: [thoughtloom, restart, product]
---

# Evolve

## Purpose

Develop thinking through dialogue. The user can challenge an interpretation, propose an alternative, explore a connection, sharpen a distinction, or follow an unexpected idea. The value is the thinking retained afterward, not simply another chat transcript.

## First appearance

Enter from a selected thought in [Idea](idea-view.md). Show enough of that thought and its attribution to make the starting context clear, with a way to open the full text and sources. Present a composer for the user's contribution.

This starts a new conversational workspace about the selected thought. Do not automatically resume an old opaque agent session or invent a greeting, response, or development merely because the view opened.

## As the conversation develops

Show the user's actual contributions and the AI's user-facing responses in chronological order. The conversation remains visible and coherent as replies accumulate, with the composer in a predictable location. Incoming text should not steal reading focus, jump the page, or discard a draft.

Display the response as it is being produced where possible, rather than waiting for repeated page refreshes. Distinguish an in-progress response from the final retained response. Raw tool calls, hidden reasoning, and execution logs are not the conversation's primary content.

The agent receives the selected thought, relevant source/connection context, and preceding discussion needed to understand the next reply. The intended execution approach is a fresh agent run with explicit context per reply, while the person experiences one continuous conversation. The precise context selection and limits need design; they must not be inferred from card layout.

## Conversation and durable development

Retain the user's contributions as source material. The agent can use bounded application operations to record interpretations, revised formulations, new developing ideas, or meaningful connections during the interaction. Such results should survive the conversation and be discoverable later.

Show what was actually recorded or changed, with attribution and access to the supporting material. Do not mistake an agent's statement that it saved something for proof that it did. The conversational explanation may be longer or different from a saved formulation.

A normal exchange often produces one useful development, but it may produce none or several. Do not fabricate a note to fill a gap or force a routine internal-model choice on the user. No recorded development is different from a failed or still-uncertain run.

**Unresolved for the restart:** how successive contributions are associated with earlier developments, especially when several exist. This description does not choose a single primary development, nomination tool, ownership hierarchy, or authoritative parent protocol. Conversation context and knowledge provenance must be considered separately before deciding whether any such mechanism is needed.

## Actions

- Send a question, challenge, correction, or new thought.
- Read the developing response and continue the discussion.
- Open sources, recorded developments, or related thoughts.
- Inspect and challenge what the AI recorded; keep user contributions distinct from AI conjectures.
- Leave for a selected thought's Idea view. Choosing Evolve there begins a new conversation about that thought rather than silently retargeting the current one.
- Stop active work, check an uncertain result, or retry a clearly failed operation without silently duplicating saved input or execution.

Background findings can be offered separately for inspection. They must not silently replace the discussion's focus or appear as if the conversational agent just said them.

## Boundaries

Original notes remain intact. The agent cannot silently rewrite user history or turn its suggestions into user-endorsed beliefs. User-visible response, durable knowledge changes, and execution status remain distinguishable. Detailed recovery mechanics and the authority to revise user-corrected material need explicit design, not assumptions hidden inside the UX implementation.
