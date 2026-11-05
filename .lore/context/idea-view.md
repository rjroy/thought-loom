---
title: Idea view
date: 2026-11-03
status: draft
tags: [thoughtloom, restart, product]
---

# Idea

## Purpose

Read one thought, understand useful surrounding context, and decide whether to follow a connection or develop it through conversation. The selected thought can be an original capture, a user contribution, an AI interpretation, or a developing idea. It should not require a different navigation model for each kind.

## Appearance

The selected thought is the focal content: prominent title, actual text, and clear authorship. If the title is missing, use the first five words. Where text is abbreviated, make full-text expansion obvious and available in place.

Below or alongside it, **Surrounding Context** shows items directly linked to the selected thought: its immediate evolution children (including AI interpretations), discovered connections, and the thoughts recorded as provenance sources for the selected thought. Opening an original idea exposes its recorded AI interpretation here; opening that interpretation exposes the other thoughts it drew from. Explain each relationship in ordinary language using recorded material. Do not recursively walk ancestors or descendants, or generate fresh significance merely because the page was opened.

The underlying user source must not be confused with the AI's reading of it. Each thought is immutable and remains that exact thought. Later developments are separate thoughts in an evolution tree, not newer versions silently substituted for the selected thought.

The selected thought's immediate parent is a separate link using that parent's title, or the normal first-five-word fallback if untitled. Resolve it solely from the selected thought's evolution parent ID; a root has no parent. This replaces the catch-all **History** panel, not the immutable evolution relationships themselves. Creation details, agent-response addenda and the explanation/evidence behind a connection remain available on demand. Rejected material still requires deliberate user inspection; ordinary context and parent reads must not silently broaden scope. Do not require a graph, node taxonomy, ancestor chain, or relationship-management vocabulary to understand the content. Mockup references to versions or revision counts are not note versioning.

## Actions

- Read or expand the selected thought and contextual text.
- Edit or clear its title metadata. Clearing invites the weaver to generate another; show the first-five-word fallback in the meantime.
- Open a connected thought, making it the new focus.
- Follow the immediate parent or a directly linked development, connection or provenance thought; inspect attribution, creation details, retained replies or connection rationale as needed.
- Choose **Evolve this idea** to open a new [Evolve](evolve-view.md) conversation about this selected thought.
- Return to Search or the previous thought without losing the exploration path.
- Reject or restore any note, including the user's own, or any connection; inspect earlier material. These are user-only secondary actions rather than a mandatory approval inbox.
- Reject or restore an evolution branch from the selected point, following only evolution descendants. Branch rejection must show the affected idea count and request confirmation.

There is no edit or correction action on a saved thought's text. Title editing changes separate metadata, not the thought or its evolution chain. To express a different thought, capture a new idea or choose Evolve. Rejection is not deletion: **Reject this idea** leaves descendants active, while **Reject idea branch** includes them. Restoration can begin at a later point to recover only that subtree. A separately rejected connection stays rejected when its associated ideas are restored. See the [data model](data-model.md) for the shared rules.

## Reading is not agreement

Opening an idea, following its connection, or entering Evolve does not confirm an AI interpretation as the user's belief. AI conjecture stays attributed and expressed with appropriate uncertainty.

No extra “Explore further” agent mode is required just because a mockup contains another button. Following recorded connections already provides exploration; a separate action needs a distinct purpose.
