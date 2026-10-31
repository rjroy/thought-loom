# Product

<!-- impeccable:product-schema 1 -->

## Status

The user authorized MVP implementation and continuation through its planned phases. Phases 1–5 (durable capture, retrieval, asynchronous weaving, contextual dialogue/development, and targeted follow-up) are implemented, independently verified and reviewed. This is not a release or real-corpus usefulness claim. Corpus selection and qualitative success criteria still need human evaluation; operator backup/restore guidance remains outstanding. The retained screen experiments are interaction guidelines, not pixel contracts or production visual authority; `DESIGN.md` records the built interface.

## Platform

Desktop is for deep work; phone is for quick thoughts and exploration. The local implementation uses a Next.js web UX backed by a Hono daemon and SQLite under a single-user-daemon assumption. Configured agent work uses the maintained server-side `@opencode/client` with an operator-managed OpenCode 2.2.2 service and owned run/tool scopes, not an embedded SDK or CLI chat. Both Thoughtloom services are hard-bound to loopback, with request Host/Origin/proxy-hint checks; these checks are not authentication. Responsive phone layouts are implemented and tested in browser emulation, but remote phone access is not enabled. Hosting/authentication remains an explicit escalated decision in `thought-loom-yj3`; do not expose services or add login without that decision. The desktop mockups remain experiments, not a production UI contract.

## Users

The user is exploring a personal knowledge-development experience. A broader commercial audience is not established.

## Product Purpose

Thoughtloom helps generate, explore, and evolve ideas, not merely retrieve or organize notes. The system takes user input and AI generates possible connections and interpretations. The user searches for notes, reviews the note together with AI notes (connections and interpretations), then discusses them to challenge suggestions, propose ideas based on connections, and tease out new thinking. Dialogue is the generative center of this loop, not an optional companion to a note manager. The weaver must not silently rewrite history or decide what the user believes.

## Positioning

Original dated source material, evolving interpretations, and revisable relationship hypotheses stay distinct. The initial experiment should let the user challenge a useful relationship and inspect the changed interpretation without losing its source or history.

## Operating Context

The coherent loop is capture → AI connections and possible interpretations → search → review source and AI notes together → dialogue → development of ideas. These are complementary capabilities, not competing product directions. Users may revisit any part of the loop; it is not a mandatory wizard.

Desktop supports sustained thinking; phone supports quick capture and exploration. Search must reach original inputs. Current MVP search is lexical; agentic search remains a possible later decision. A stable local neighborhood may help explain connections but must not replace source review or dialogue, and the entire graph need not be rendered.

## Capabilities and Constraints

The built local application preserves original text, provenance and dates; distinguishes user input from attributed AI interpretations; and exposes evidence, directed relationship rationale and append-only revision history. Capture and discussion input are durably retained before agent work. Basic FTS5/alias/prefix/typo search and query-preserving navigation are implemented; search is not agentic. The interface has no permanent notes list, chat sidebar or approval inbox. Avoid gamified growth scores and equating recency, attention, or semantic similarity with value.

Implemented agent paths include non-interactive capture-time weaving and contextual dialogue pinned to an original, item version or directed relationship revision. Canonical response text and confirmed developing ideas/derivations remain separate. Narrow trusted-user correction, reject and restore commands append attributed versions; AI writes cannot replace protected user corrections or erase original sources/history. Saved, queued, running, completed, failed, interrupted and uncertain states are distinct. Stop is best effort, not rollback. Unsaved drafts remain page-local and can be lost on reload or navigation away.

Phase 5 adds bounded, non-recursive follow-up after meaningful successful dialogue changes or trusted user revisions, with pending coalescing, explicit origins/affected versions, confirmed-change references, honest truncation and fenced retry. Prose alone, alias-only output and explicitly stopped dialogue do not establish that trigger. The UI stages background findings until an explicit View action rather than rearranging active reading, including changes from neighboring roots. Configured execution requires operator setup, model choice and responsibility for charges. No example notes or agent are automatically seeded into the normal database.

Still open or deferred: human evidence of useful/non-obvious connections and idea development; real-corpus cost/latency evaluation; remote hosting/authentication; broader idea identity/splitting/merging; periodic aging/resurfacing; and Memory Loop integration. The implemented MVP authority and relationship rules are bounded current behavior, not a permanent autonomy policy for future features. See `.lore/work/design/thoughtloom-mvp.md` and `.lore/local/plans/thoughtloom-mvp.md` for the originating scope/plan; older planning-only authorization statements there are historical, not a veto on the user's subsequent implementation authorization. Concept images alone do not settle future decisions.

## Brand Commitments

Take inspiration from `/home/rjroy/Projects/personal-brand/brand/BRAND.md`: Night/Parchment dominance, purposeful Lantern/Horizon accents, Source Sans 3 task typography, clear standard controls, guidance without control, and clarity without false certainty. No adoption or recreation of The Guide emblem; no new logo. No literal textile or fantasy ornament.

## Experience Commitments

The user explicitly rejects a familiar notes workspace, including a conventional note-manager fallback. Its absence should create productive discomfort: encourage a new way of generating, exploring, and evolving ideas rather than returning to filing and browsing. This does not authorize poor usability, hidden provenance, inaccessible controls, forced AI acceptance, or withholding original notes. Familiar buttons, text inputs, reading conventions, and accessible navigation can serve an unfamiliar inquiry-centered organization.

Do not present reading sources, connection exploration, and dialogue as alternatives that exclude one another. Do not satisfy this request with a cosmetic reskin of a notes list plus chat sidebar. Any future structural alternatives must preserve the complete loop and differ in how it unfolds.

## Evidence on Hand

Concept source: `.lore/work/concept/thoughtloom-concept.md`, including the agent-disagreement and intent-preservation example. Additional demonstration material must be labelled illustrative. The personal-brand specification and component reference are guidance, not a Thoughtloom incumbent interface. Three retained experiments and their provenance are in `.impeccable/mocks/inquiry-flow/`; they are neither production visual authority nor a specification.

## Exploration Record and Current Boundary

The user confirmed the integrated-inquiry exploration description with “yes”: find the original thought and AI notes; develop through claim-attached dialogue; follow an emerging idea with intact derivation. The three desktop mockups illustrate successive moments of one experience, not competing features. Phone behavior was described, not image-rendered.

The user subsequently authorized cleanup while retaining these useful experiments and minimal provenance, then documented an MVP boundary and requested `.lore/local/plans/thoughtloom-mvp.md`, using mockups as guidelines rather than pixel-perfect representations and reusing `.lore/work/research/opencode-2.2.2-validation.md`. The user then explicitly authorized implementation and continuation through the phases. Phases 1–5 have been independently verified and reviewed. Neither software checks nor retained mockups demonstrate that a real corpus produces useful development: that remains a human experiment. No remote exposure, login/hosting choice, arbitrary live-provider compatibility or production-art approval is inferred from implementation authorization.
