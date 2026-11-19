---
title: Evolve view
date: 2026-11-03
status: implemented baseline
tags: [thoughtloom, restart, product]
---

# Evolve

## Purpose

Develop thinking through dialogue. The user can challenge an interpretation, propose an alternative, explore a connection, sharpen a distinction, or follow an unexpected idea. Development adds immutable thoughts to a branching evolution tree, not revisions of existing notes.

## Modes and status

- **Classic Evolve (implemented):** sending admits a user contribution as a library thought. The run may record AI developments and retain a **Full reply** under the existing rules below. Existing trees, retained replies and Classic behavior do not change.
- **Save ideas only (implemented):** opt in when starting Evolve from an idea. The mode is fixed for that conversation. Dialogue is retained separately for continuity; only selected ideas enter the library. This is not a global chat or a change to ordinary Search, Export or title editing. The user approved the [client comp](../../.impeccable/mocks/evolve-save-ideas-only/README.md) on 2026-11-18. See the [user guide](../../docs/user-guide.md#save-ideas-only) and [daemon API](../../docs/daemon-api.md#save-ideas-only-evolve) for current behavior.

## First appearance

Enter from a selected thought in [Idea](idea-view.md), including an earlier point in its evolution tree. Show enough of that thought and its attribution to make the starting context clear, with a way to open the full text and sources. Present a composer for the user's contribution.

This starts a new conversational workspace about the selected thought. Do not automatically resume an old opaque agent session or invent a greeting, response, or development merely because the view opened.

## As the conversation develops

Show the user's actual contributions and the AI's user-facing responses in chronological order. The conversation remains visible and coherent as replies accumulate, with the composer in a predictable location. Incoming text should not steal reading focus, jump the page, or discard a draft.

The current web client observes recorded output without requiring page refreshes; its status is not a stream of model text. Showing a reply as it is produced remains a design goal where supported. Distinguish an in-progress or interrupted response from the final retained response. Raw tool calls, hidden reasoning, and execution logs are not the conversation's primary content.

The agent receives the selected thought, relevant source/connection context, and preceding discussion needed to understand the next reply. The intended execution approach is a fresh agent run with explicit context per reply, while the person experiences one continuous conversation. The precise context selection and limits need design; they must not be inferred from card layout.

The durable development, continuation and recovery rules below describe **Classic** unless stated otherwise.

## Conversation and durable development

Retain each user contribution as an immutable thought whose evolution parent is the selected continuation point. The agent can use bounded application operations to record new interpretations, developing ideas, or meaningful connections during the interaction. A recorded development has the user contribution as its one evolution parent. Supporting sources do not become additional parents.

During the same run, Evolve can conditionally fill the admitted contribution's absent title and discover warranted connections using scoped full reads. A title fill cannot overwrite a current title. Do not create a development merely to restate the contribution. These changes share the run's fences and confirmed changes remain saved on Stop or failure.

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

The daemon owns active work. Leaving the conversation or closing the browser does not stop it. Returning to the known workspace in the same browser document observes its existing run and results. A full reload of Classic opens a fresh workspace and loses the local draft and run references; it does not cancel the run. See the [user guide](../../docs/user-guide.md#develop-an-idea-with-evolve) for current recovery.

**Stop** requests cancellation and fences further publication. It does not prove remote tools have stopped or undo their effects. The user's contribution and developments already confirmed saved remain. Mark an unfinished reply as interrupted, not completed. Do not undo or reject saved thoughts automatically. An uncertain timeout or disconnect is not a failure or permission to send again; check the original run if its identity is known.

Background findings can be offered separately for inspection. They must not silently replace the discussion's focus or appear as if the conversational agent just said them.

The mockup's repeated **Evolve this idea** button within Evolve is a mistake, not an additional action. That action belongs in Idea, where it opens a new conversation.

## Save ideas only

### What stays in the conversation

Keep original user and AI messages, each turn's selected parent and outcome, and links to any confirmed saves in a durable conversation anchored to the starting idea. Resume by explicit conversation identity, including after reload. Opening Evolve afresh opens a new workspace, not the last conversation. Resuming reads the recorded discussion and continuation without sending another message or launching another run. The client loads recent turns first and offers **Load earlier turns** and **Load more saved ideas** as needed. An older current parent can remain the continuation even when its save is outside the loaded window. Opening an idea for inspection and returning within the same browser document retains the draft; a full reload does not.

Instructions, questions, acknowledgments and exploratory chatter normally stay in the discussion. A completed turn with no saved thoughts is a valid outcome; it leaves the tree and continuation unchanged. Do not create a stand-in contribution, an addendum or a searchable fallback reply to satisfy the Classic contract. Library search and branch export must not indirectly expose unsaved dialogue; a thought saved from it is a distinct library record.

### What becomes a thought

- Save distinct insights from either speaker, not a quota. Text attributed to the user must be an exact, self-contained passage from that user's stored message. Record that the agent selected it. Do not strip away quoting or doubt to make someone else's claim look endorsed. An AI synthesis is AI-authored, even if it draws on the user's words.
- **“Remember this”** directs the agent to save an identifiable passage from the current exchange or from eligible prior dialogue supplied to the run. Ask which one if unclear or unavailable. Record the earlier source turn separately from the save's parent. **Keep as thought** explicitly saves a selected passage from either speaker without a new model run. Preserve the exact words and original authorship, with selection by the user recorded separately from authorship.
- Show confirmed saves separately from transcript text. A save links to its actual thought, identifies authorship and who selected it, and has exactly one evolution parent. `Open idea` inspects a saved thought without changing the conversation's continuation.
- Automatic saves normally use the turn's selected continuation as parent. An AI idea that directly develops a user insight just saved in that turn may be its child; independent ideas are siblings. Default the next turn to the latest confirmed save from the exchange and allow another eligible choice. For a passage from an earlier turn, show its proposed parent before confirming a manual save; that save must not silently move the conversation to a different point.

### Recovery and access

Each send and manual Keep has a stable request identity: check an uncertain request rather than running it again. A missing receipt does not prove that a delayed write cannot commit. The daemon validates passage and speaker against the stored message, uses finalized AI text for passages from replies, and saves the thought and its source receipt atomically and without replay duplicates. Only actual new thoughts receive ordinary per-thought follow-up. A read failure does not erase confirmed saves or establish that nothing was saved. An interrupted reply remains distinct from completed dialogue; **Stop** does not undo confirmed saves or prove remote cancellation.

An uncertain continuation change or stale continuation preserves the draft and pauses sending. The user checks the recorded selection and explicitly chooses **Use current thought**; a delayed change can still arrive after a read. Conditional writes prevent silently sending against a different current parent. Stop for a known active run remains available after a failed conversation refresh or an unconfirmed Keep, independently of recovering that request.

The agent runs afresh for a reply with bounded, scoped previous dialogue. Record what informed retained turns and check eligibility both on reads and before publishing. Subsequent AI context excludes dialogue that depends on now-ineligible material; when that cannot be separated safely, start with fresh eligible context instead. A user-visible retained conversation or save receipt is not authority to supply its text to AI or widen rejected-content access.

## Future functionality

Attachments are outside the scope of 1.0. The mockup's paperclip control represents possible future functionality and must not be included as an active 1.0 control. Attachment behavior and supported formats remain undefined.

## Boundaries

Thought content and ancestry remain immutable; title metadata follows its separately defined edit/fill rules. Neither agent may rewrite thought content, reject material, or restore it. Rejected notes and connections are excluded from AI retrieval, context, and reasoning; an active descendant does not authorize use of a rejected ancestor. A reply shared by several developments is unavailable to AI if any associated development is rejected. The agent cannot turn its suggestions into user-endorsed beliefs. User-visible response, durable knowledge additions, and execution status remain distinguishable; recovery must preserve confirmed work and avoid duplicate input or developments.
