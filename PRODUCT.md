# Product

<!-- impeccable:product-schema 1 -->

## Status

Useful design experiments; no selected production design. An MVP boundary has been discussed and recorded in `.lore/work/design/thoughtloom-mvp.md`; experiment criteria and implementation details remain open. Implementation is not authorized. The screens remain experiments, not permission to build them.

## Platform

Desktop is for deep work; phone is for quick thoughts and exploration. The MVP starting direction is a Next.js web UX backed by a Hono daemon and an OpenCode-backed agent. SQLite is the starting storage choice under a single-user-daemon assumption. Deployment, phone connectivity, and the concrete agent integration remain open. The desktop mockups are experiments, not a production UI contract.

## Users

The user is exploring a personal knowledge-development experience. A broader commercial audience is not established.

## Product Purpose

Thoughtloom helps generate, explore, and evolve ideas, not merely retrieve or organize notes. The system takes user input and AI generates possible connections and interpretations. The user searches for notes, reviews the note together with AI notes (connections and interpretations), then discusses them to challenge suggestions, propose ideas based on connections, and tease out new thinking. Dialogue is the generative center of this loop, not an optional companion to a note manager. The weaver must not silently rewrite history or decide what the user believes.

## Positioning

Original dated source material, evolving interpretations, and revisable relationship hypotheses stay distinct. The initial experiment should let the user challenge a useful relationship and inspect the changed interpretation without losing its source or history.

## Operating Context

The coherent loop is capture → AI connections and possible interpretations → search → review source and AI notes together → dialogue → development of ideas. These are complementary capabilities, not competing product directions. Users may revisit any part of the loop; it is not a mandatory wizard.

Desktop supports sustained thinking; phone supports quick capture and exploration. Search must reach original inputs. Whether search itself is agentic remains open. A stable local neighborhood may help explain connections but must not replace source review or dialogue, and the entire graph need not be rendered.

## Capabilities and Constraints

These are concept hypotheses, not existing application capabilities. Preserve original material and provenance; distinguish user claims from AI interpretations; make meaningful automated changes inspectable and reversible. Avoid gamified growth scores and equating recency, attention, or semantic similarity with value.

The MVP discussion establishes non-interactive capture-time weaving, useful basic search without requiring agentic search, contextual dialogue through constrained domain tools, and targeted follow-up weaving after discussion. Periodic aging and resurfacing are deferred. Open: idea identity/splitting/merging, precise AI revision authority and protection of user corrections, relationship semantics, conversation attachment, exact follow-up trigger scope and retry mechanics, cost bounds, deployment and access protection, accessibility target, concrete OpenCode integration, SQL schema, search implementation, and Memory Loop integration. See `.lore/work/design/thoughtloom-mvp.md`; concept images alone do not settle these decisions.

## Brand Commitments

Take inspiration from `/home/rjroy/Projects/personal-brand/brand/BRAND.md`: Night/Parchment dominance, purposeful Lantern/Horizon accents, Source Sans 3 task typography, clear standard controls, guidance without control, and clarity without false certainty. No adoption or recreation of The Guide emblem; no new logo. No literal textile or fantasy ornament.

## Experience Commitments

The user explicitly rejects a familiar notes workspace, including a conventional note-manager fallback. Its absence should create productive discomfort: encourage a new way of generating, exploring, and evolving ideas rather than returning to filing and browsing. This does not authorize poor usability, hidden provenance, inaccessible controls, forced AI acceptance, or withholding original notes. Familiar buttons, text inputs, reading conventions, and accessible navigation can serve an unfamiliar inquiry-centered organization.

Do not present reading sources, connection exploration, and dialogue as alternatives that exclude one another. Do not satisfy this request with a cosmetic reskin of a notes list plus chat sidebar. Any future structural alternatives must preserve the complete loop and differ in how it unfolds.

## Evidence on Hand

Concept source: `.lore/work/concept/thoughtloom-concept.md`, including the agent-disagreement and intent-preservation example. Additional demonstration material must be labelled illustrative. The personal-brand specification and component reference are guidance, not a Thoughtloom incumbent interface. Three retained experiments and their provenance are in `.impeccable/mocks/inquiry-flow/`; they are neither production visual authority nor a specification.

## Exploration Record and Current Boundary

The user confirmed the integrated-inquiry exploration description with “yes”: find the original thought and AI notes; develop through claim-attached dialogue; follow an emerging idea with intact derivation. The three desktop mockups illustrate successive moments of one experience, not competing features. Phone behavior was described, not image-rendered.

The user subsequently authorized cleanup while retaining these useful experiments and minimal provenance, then discussed and requested documentation of an MVP boundary. See `.lore/work/design/thoughtloom-mvp.md` for that discussion, including the Hono/Next.js/OpenCode direction, SQLite starting choice, non-interactive weaving, useful basic search, contextual dialogue, and targeted follow-up weaving. This does not select a production design or authorize application implementation, integration, or an implementation plan.
