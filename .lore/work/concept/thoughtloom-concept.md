# Thoughtloom

*Where ideas take shape.*

**Status:** Concept brief / brainstorming input  
**Purpose:** Preserve the concept and provide a starting point for local agent-assisted exploration.  
**Not:** An approved specification, architecture, or implementation plan.

## Vision

Thoughtloom is a living knowledge ecosystem, evolving from the Memory Loop 2.0 concept. Notes and ideas enter as dated source material: distinct threads whose connections can reveal patterns no single thread held. An asynchronous AI *weaver* places them in a network of related ideas, then helps develop that network as the user searches, explores, discusses, and revises their thinking.

The goal is not merely to remember what was captured. It is to help ideas develop, reveal unexpected connections, and revisit earlier thinking as new context emerges.

**Guiding principle:** The weaver helps develop knowledge; it does not silently rewrite the user's history or decide what the user believes.

## Proposed experience

1. **Capture.** The user records a note, observation, question, or idea. The original is preserved with its date and provenance, potentially in a dated file.
2. **Connect.** An agent wakes up, examines the new material, and finds where it belongs among existing ideas. Placement is based on meaningful relationships, not simply the next available slot or textual similarity.
3. **Explore.** The user searches for a concept, sees its local neighborhood, and follows relationships to nearby ideas.
4. **Develop.** The user amends or discusses an idea. That interaction may refine its interpretation, create new ideas, strengthen or weaken connections, or reveal contradictions.
5. **Revisit.** Background weaving may identify neglected ideas, emerging themes, unexpected connections, and questions worth resurfacing.

## Working conceptual model (hypotheses, not decisions)

- **Source note:** Immutable or revision-preserving historical input: what the user actually wrote or said, when, and in what context.
- **Idea:** A persistent, evolving interpretation or concept. One note may contain multiple ideas; multiple notes may contribute to one idea.
- **Relationship:** A typed, revisable hypothesis connecting ideas, potentially with rationale, evidence, and confidence. Candidate types: *supports, challenges, extends, depends on, resembles*.
- **Weaver:** An agent/process that proposes and maintains interpretations and relationships, both during interaction and asynchronously.
- **Neighborhood:** A contextual view of an idea and its meaningful nearby connections. Spatial layout is a presentation, not the authoritative knowledge model.

Keep **source**, **interpretation**, and **relationships** distinct. The weaver can be mistaken; its inferences must be inspectable and correctable without corrupting original notes.

## What “growth” might mean

Avoid a single gamified growth score. Consider separate dimensions:

- **Maturity:** Fragment → hypothesis → developed concept → actionable proposal (exact states undecided).
- **Connectedness:** Meaningful relationships with other ideas.
- **Confidence:** Strength of supporting and conflicting evidence.
- **Activity:** Recent attention or discussion.
- **Fertility:** New questions, experiments, or ideas generated from it.

Age and inactivity should not automatically imply low value. Dormancy, decay of relationship relevance, archival, and deletion need distinct semantics. Preserve history.

## Example

New note: *“Maybe AI agents should be allowed to disagree before committing to a design.”*

The weaver discovers connections to:

- *Adversarial reviews improve design quality* — **supports**.
- *Too many reviewers slow down decisions* — **challenges / tension**.
- *Trust requires clear decision ownership* — **depends on / related constraint**.

Later, the user says: *“The real issue isn't orchestration; it's preserving intent across context boundaries.”*

Rather than silently replacing the original note, the system could propose a revised interpretation, adjust relationships, and create a distinct idea about intent preservation. The user should be able to inspect what changed and why.

## Potential interaction and agent lifecycle

- **Capture-time:** Store source material; optionally identify preliminary candidate ideas and links.
- **Interaction-time:** Discuss, amend, challenge, split, or merge ideas; revisit nearby relationships.
- **Background:** Look for cross-cluster connections, contradictions, emergent themes, and neglected questions.

An intriguing proactive outcome: *“Three notes written over four months appear to describe the same underlying problem from different angles.”*

## UX direction to explore

A fabric of related concepts, with search as a primary entry point. The weaving metaphor describes how connections reveal patterns; it does not prescribe a literal textile interface. Open an idea to see its local neighborhood, original source notes, interpretation, relationship rationale, and conversation history. Explore outward without needing to render the entire knowledge graph.

**Caution:** A constantly rearranging force-directed map may destroy spatial memory. Preserve stable neighborhoods where practical; don't equate visual distance with semantic truth.

## Open questions — do not prematurely resolve

1. **Idea identity:** What qualifies as one idea? When should ideas split, merge, or remain separate?
2. **Agent autonomy:** Can the weaver create entirely new synthesized ideas, or only propose them for approval?
3. **Authority:** Which changes can occur automatically, and which require explicit user confirmation?
4. **Growth and aging:** What constitutes meaningful growth, dormancy, relationship decay, or resurfacing?
5. **Relationships:** How are relationship types, strength, direction, confidence, and provenance represented?
6. **Interaction:** Is conversation attached to notes, ideas, neighborhoods, or all three?
7. **Visualization:** Is a spatial constellation central to the experience, or one of several ways to explore?
8. **Storage:** How does this fit with Memory Loop's existing Obsidian-vault workflow and modes?
9. **Background work:** What triggers weaving, how much autonomy is appropriate, and how are costs bounded?
10. **Trust:** How can the user understand, undo, or reject an agent's interpretations and changes?

## Guardrails

- Preserve original user material and provenance.
- Distinguish user-authored claims from AI-generated interpretations.
- Do not treat semantic similarity as proof of a meaningful relationship.
- Make meaningful automated changes inspectable and reversible.
- Avoid rewarding attention or recency as though they were intrinsic value.
- Don't assume every note deserves an idea node, or every idea deserves a relationship.
- Avoid choosing a database, embedding model, graph engine, or UI framework before clarifying the behavior.

## Suggested next session with the local agent

**Start in brainstorm/discovery mode, not implementation mode.**

Ask the agent to:

1. Review this brief and inspect the existing Memory Loop project to establish current behavior and constraints.
2. Identify which concepts are already supported, which require changes, and which are genuinely new.
3. Walk through **three concrete user journeys**: capturing a new note, revisiting/challenging an old idea, and discovering an unexpected connection during background weaving.
4. Surface the consequential product decisions, especially idea identity and weaver autonomy.
5. Recommend a narrow experiment that tests whether evolving relationships provide value beyond conventional notes plus semantic search.

**Do not produce an implementation plan until the concept and key tradeoffs have been reviewed with the user.**

## Success criterion for an initial experiment

Given a small real collection of notes, the system should produce a few **useful, explainable, non-obvious relationships**; let the user challenge one; and update its interpretation without losing the original source or the history of the change.

The key question is not *“Can we draw a graph?”* It is *“Does this help the user discover and develop an idea they otherwise would have missed?”*
