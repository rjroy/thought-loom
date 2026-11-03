---
title: Evolve view
date: 2026-11-03
status: draft
tags: [thoughtloom, restart, product]
---

# Evolve

## Purpose

Develop thinking through dialogue. The user can challenge an interpretation, propose an alternative, explore a connection, sharpen a distinction, or follow an unexpected idea. Development adds immutable thoughts to a branching evolution tree, not revisions of existing notes.

## First appearance

Enter from a selected thought in [Idea](idea-view.md), including an earlier point in its evolution tree. Show enough of that thought and its attribution to make the starting context clear, with a way to open the full text and sources. Present a composer for the user's contribution.

This starts a new conversational workspace about the selected thought. Do not automatically resume an old opaque agent session or invent a greeting, response, or development merely because the view opened.

## As the conversation develops

Show the user's actual contributions and the AI's user-facing responses in chronological order. The conversation remains visible and coherent as replies accumulate, with the composer in a predictable location. Incoming text should not steal reading focus, jump the page, or discard a draft.

Display the response as it is being produced where possible, rather than waiting for repeated page refreshes. Distinguish an in-progress response from the final retained response. Raw tool calls, hidden reasoning, and execution logs are not the conversation's primary content.

The agent receives the selected thought, relevant source/connection context, and preceding discussion needed to understand the next reply. The intended execution approach is a fresh agent run with explicit context per reply, while the person experiences one continuous conversation. The precise context selection and limits need design; they must not be inferred from card layout.

## Conversation and durable development

Retain each user contribution as an immutable thought whose evolution parent is the selected continuation point. The agent can use bounded application operations to record new interpretations, developing ideas, or meaningful connections during the interaction. A recorded development has the user contribution as its one evolution parent. Supporting sources do not become additional parents.

Show what was actually recorded or changed, with attribution and access to the supporting material. Do not mistake an agent's statement that it saved something for proof that it did. The conversational explanation may be longer or different from a saved formulation.

An exchange can produce one or several recorded developments. The agent's conversational response is an addendum to its recorded developments, rather than a separate evolution node or an attachment to the user message. If several developments are produced, each links to the same retained full response. That response is available from any of them and remains searchable.

If the agent provides a response but records no separate development, attach the full response to the user contribution and treat that response as the developed idea. This includes clarifying questions. Preserve the chain rather than losing useful information because it is not an ideal formulation. A failed or still-uncertain run is not the same as a completed response with no separately recorded development.

## Continuing and branching

Default the next user contribution to the latest issued recorded development. If several developments exist, allow the user to select another with a simple UX; do not make selection a cumbersome required step on every turn.

The user can also select any earlier point as the starting idea for a new branch. Clearly distinguish the current continuation point from the action to explore from another point, using simple iconography rather than complicated workflow language. Do not silently retarget the current continuation point when the user merely inspects another thought.

When Search matches an agent-response addendum, open its associated recorded development with the full response available there. Earlier exchanges remain available through the thoughts and their history; branching from a selected point is not automatic resumption of an opaque old agent session.

When Search matches a response shared by several developments, open the latest associated development eligible under the current read scope, with the full reply available there. Do not add a mandatory selection step or duplicate the response.

## Actions

- Send a question, challenge, correction, or new thought.
- Read the developing response and continue the discussion.
- Open sources, recorded developments, or related thoughts.
- Inspect and challenge what the AI recorded through further development; keep user contributions distinct from AI conjectures.
- Leave for a selected thought's Idea view. Choosing Evolve there begins a new conversation about that thought rather than silently retargeting the current one.
- Stop active work, check an uncertain result, or retry a clearly failed operation without silently duplicating saved input or execution.

The daemon owns active work. Leaving the conversation or closing the browser does not stop the agent; returning observes the same run and its existing results. Cancellation requires an explicit Stop action.

Stopping prevents further work but retains the user's contribution and any developments already confirmed saved. Mark an unfinished reply as interrupted rather than treating it as a completed response. Do not undo or reject saved thoughts automatically. An uncertain timeout or disconnect calls for checking the existing run before offering a retry, not silently submitting a replacement.

Background findings can be offered separately for inspection. They must not silently replace the discussion's focus or appear as if the conversational agent just said them.

The mockup's repeated **Evolve this idea** button within Evolve is a mistake, not an additional action. That action belongs in Idea, where it opens a new conversation.

## Future functionality

Attachments are outside the scope of 1.0. The mockup's paperclip control represents possible future functionality and must not be included as an active 1.0 control. Attachment behavior and supported formats remain undefined.

## Boundaries

Thought content and ancestry remain immutable; title metadata follows its separately defined edit/fill rules. Neither agent may rewrite thought content, reject material, or restore it. Rejected notes and connections are excluded from AI retrieval, context, and reasoning; an active descendant does not authorize use of a rejected ancestor. A reply shared by several developments is unavailable to AI if any associated development is rejected. The agent cannot turn its suggestions into user-endorsed beliefs. User-visible response, durable knowledge additions, and execution status remain distinguishable; recovery must preserve confirmed work and avoid duplicate input or developments.
