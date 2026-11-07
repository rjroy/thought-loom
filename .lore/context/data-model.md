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
- **Imported original:** exact wording from an [imported source document](markdown-import.md), attributed as Imported source rather than automatically to the importer or AI. Original authorship is unverified; import does not imply endorsement.
- **Media original:** an approved [media-import source](media-import.md), with an image or PDF to be retained outside SQLite. Its root has null thought text and source attribution; optional exact user clarification is separate, user-attributed metadata. Backend representation and metadata persistence exist; file retention/import and client support remain planned. Never fabricate a textual original or claim that the importer authored the file.
- **User contribution during development:** a question, challenge, or new thought entered in a discussion. Retain the user's actual words and the context in which they were contributed. Disagreement or correction is expressed as a new thought, not an edit to an existing one.
- **AI interpretation:** an attributed reading of existing material. It is a hypothesis about meaning, not a replacement original or an assertion that the user agrees.
- **Developing idea:** a retained thought emerging from interpretation or dialogue. It may be AI-authored or user-authored; kind and authorship are separate facts. Further development creates new thoughts, not new versions of this one.

A captured note can contain several ideas. Other notes can provide supporting context without becoming additional evolution parents. Not every capture needs a separate interpretation.

## Immutable thoughts and evolution trees

Every recorded thought's content and evolution ancestry are immutable, whether authored by the user or AI, or retained from an imported source. There is no thought versioning, direct text-edit action, or in-place correction. The user can capture a new idea or evolve an existing one. A contradiction of an earlier thought is another thought in its own right. Editable title metadata is separate from this immutable record.

Each non-root thought has exactly one evolution parent. A typical path is:

```text
Original idea → user contribution → recorded development → next user contribution
```

Any point can be selected as the starting idea for further exploration, creating a branch without rewriting the existing path. Multiple recorded developments can branch from a user contribution. The latest issued development is the default continuation point; the user can select a different one with a simple control.

The agent's full conversational response is normally an addendum to its recorded development, not another step in the evolution chain or an attachment to the user contribution. When one reply produces several developments, each links to the same retained full response, making its explanation available from any of them without duplicating it. Search opens the latest associated development eligible under the current read scope, with the full reply available there, rather than requiring a selection step. If the agent records no separate development, retain the full response attached to the user contribution and treat that response as the developed idea, preserving the chain. Every agent response is searchable, including addenda. See [Evolve](evolve-view.md).

## Information retained about a note

Keep its identity, actual text, available title, authorship, creation date, and origin. Retain its evolution parent where applicable, supporting sources, and agent-response addenda. History is the tree of distinct thoughts and their provenance, not revisions of a single note. A title labels the text; it does not replace it. Alternate names or acronyms can help retrieval but are not new notes or conceptual connections.

The daemon generates the identity and creation timestamp when creating a thought and returns the created values in its response. Public callers must not need to generate these values.

Markdown imported originals additionally retain document membership and byte position as source metadata, not thought-supporting sources or evolution parents. Their retained whole-document artifacts are user-only. The initial segmentation agent may read the submitted document for that operation; later agents cannot retrieve the retained artifact or use its metadata to bypass individual thought rejection. The separately agreed media-source policy calls for Weave and Evolve to reopen eligible original media, without changing this Markdown exclusion; binary access is not yet implemented.

## Editable title metadata

Store titles separately from immutable thoughts, with one title-metadata record per thought rather than a general-purpose metadata system. Return the current title alongside the thought in the ordinary API response; clients should not need a separate request to assemble it.

Capture normally has no title, though a user-supplied title is allowed. The weaver generates a title when a note has none. Until a title is available, its first five words provide the display label. Do not require a person to write a title before saving.

A media-original has no thought text; its filename supplies the backend display fallback instead. Clearing its title must invite title-only regeneration, not another initial interpretation; media-specific execution guards remain planned.

The user can edit or clear a note's title without changing its text, identity, authorship, creation time, or evolution ancestry, and without creating an evolution step. Track whether the current title is user-authored or AI-authored separately from the thought's authorship.

Clearing a title invites the weaver to generate another; it does not opt out of title generation. The first-five-word fallback applies while regeneration is pending. A late weaver result must not overwrite a current user-supplied title: generation only fills a title that is still absent when the result is saved.

Rejection changes availability, not the recorded wording or evolution ancestry. It is not deletion of the historical record.

## Rejection and restoration

Only the user may reject or restore material. Neither the weaver nor the evolution agent may do so. Any note, including the user's own, and any connection can be rejected and restored.

- **Reject this idea:** reject only the selected thought. Descendants stay active; they may contradict or supersede the rejected thought.
- **Reject idea branch:** reject the selected thought and its evolution descendants. Show the affected idea count and ask for confirmation before applying this dangerous action, for example, “This will reject 101 ideas. Are you sure?”
- **Restore idea branch:** use the same evolution-tree walk from the selected point to restore that portion of the branch. The user can reject a large branch and later restore only a later subtree. Restoration is not limited to undoing an entire earlier action.

Branch operations never follow weaver-discovered connections. The one-parent rule makes evolution a tree, not a graph of shared evolution descendants.

Rejected material is hidden from ordinary views but remains inspectable through explicit Idea inspection and Search's **Show rejected** toggle. For every AI agent, rejected notes and connections are effectively nonexistent: exclude them from retrieval, context, and reasoning, even when the user is inspecting them. Active descendants of a rejected thought remain usable without supplying the rejected ancestor's content to the AI.

If a reply is shared by several developments and any of them is rejected, exclude that entire reply from AI access, even through another active development. Other active thoughts remain usable; users can still inspect the retained reply deliberately.

Connections associated with restored ideas become available again only when their participating thoughts are active. Connections explicitly rejected separately stay rejected until separately restored. Restoring one thought must not expose another still-rejected thought to the AI through a connection.

## Connections

Two different questions must remain separate:

1. **Where did this come from?** The evolution parent identifies the preceding thought in the chain. Additional source references explain supporting context without creating more evolution parents.
2. **Why might these thoughts matter together?** A separately stored conceptual connection describes a meaningful relationship, with its rationale and supporting material. It is a hypothesis, not proof.

The initial connection categories are **supports**, **contradicts**, **extends**, and **related**. Categories aid the UX; retain a plain-language explanation and supporting material as well. Direction matters when the meaning is directional; a supporting claim and the claim it supports are not interchangeable.

A connection should identify the thoughts involved, who proposed it, why it was proposed, and what supports it. Preserve its rejection/restoration state. Similar wording, a search match, a retrieval alias, or visual proximity does not by itself establish a connection.

## Discussion is related to knowledge, not identical to it

Retain the user/AI exchange and enough context to understand it. Distinguish the full conversational response from the recorded development it accompanies. When no separate development is recorded, the full response is the fallback development, not lost conversation content.

Conversation context and knowledge provenance serve different purposes. A conversation can use several relevant thoughts as context while each new thought still has only one evolution parent. No merge or multi-parent evolution behavior is specified.
