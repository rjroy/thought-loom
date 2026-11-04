# Thoughtloom

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

People capturing and developing their own connected thinking. The first design checkpoint assumes individual use; this audience framing is provisional, not a new account or collaboration model.

## Product Purpose

Capture rough thoughts without ceremony, rediscover them, inspect meaningful connections, develop ideas through dialogue, and take useful thinking out as Markdown. A useful connection that survives examination matters more than a graph or a larger collection of AI text.

## Operating Context

Capture and Explore are the primary entry modes. Idea and Evolve are contextual views. Capture must work comfortably on a phone. Search begins with a query, not a recent-notes dashboard. No other device-use or lighting preference has been confirmed.

## Capabilities and Constraints

- The current daemon is the feature boundary; [Daemon API](docs/daemon-api.md) describes implementation. Product-context drafts are intent, not evidence of additional API support.
- Thoughts, authorship, creation time, and evolution ancestry are immutable. Editable titles are separate metadata. Missing titles display the first five words.
- Development creates distinct thoughts with one evolution parent. Discovered connections are separate. AI contributions stay attributed; reading is not agreement.
- Rejection/restoration are user-only. Rejected material remains deliberately inspectable by the user but is excluded from AI use.
- Search supports text retrieval, filters, sorting, and deliberate inclusion of rejected material. Simple export and read-only Agentic export produce Markdown.
- Saving a capture and background weaving are separate facts. Evolve and Agentic export require server-side agent configuration.
- Shared navigation is Explore, Capture, and a reserved Settings destination. Settings contents remain undecided.
- Attachments, Journal, notifications, profiles, an additional agentic Explore mode, and note-text editing are not authorized by the old mockups.
- Planned client: Next.js/React. Browser → Next.js server → Hono daemon; credentials stay server-side. This design phase does not implement that client or change the daemon.

## Brand Commitments

The user requires Ronald Roy's personal brand as the base color influence, including its existing 16-color functional palette. The authoritative guide is `/home/rjroy/Projects/personal-brand/brand/BRAND.md`; a dated local design snapshot and provenance belong with the design artifacts. Existing mockups establish starting layouts, not approved colors or imagery. Multiple visual options and explicit screen-comp approval are required before client implementation.

## Evidence on Hand

- [README](README.md), [architecture and working agreement](.lore/context/architecture.md), and screen-specific documents in `.lore/context/`.
- Existing layout references: `.lore/mockups/search-mockup.webp`, `idea-mockup.webp`, and `evolve-mockup.webp`.
- Current implementation contracts in `docs/daemon-api.md`; no production web client exists yet.
- Mock data used in design options must be labeled illustrative, not read from a personal database.

## Product Principles

1. Preserve original thinking and its provenance.
2. Keep user agency separate from AI interpretation.
3. Put the thought before the machinery around it.
4. Make recovery preserve drafts and confirmed work.
5. Do not add functionality to fill a screen.

## Record Status

Initial record distilled from the user's explicit brief and the agreed repository documents by a delegated designer. Individual-use framing and any unconfirmed details remain revisable. The user selected Quiet Night as the shared visual direction, Compact excerpts for Explore, and Wide working pad for Capture. Those screen approvals cover only the shown resting desktop compositions. Remaining screens and unseen states still require review under thought-loom-3sc.6; client implementation remains blocked.
