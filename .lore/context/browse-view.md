---
title: Browse view
date: 2026-11-09
status: approved
tags: [thoughtloom, product, browse]
---

# Browse

## Purpose and entry

Browse helps the user rediscover forgotten ideas without a search query or agent. It is a separate main-navigation destination alongside Explore and Capture. Explore remains search-focused. Remove the nonfunctional **Reserved** toolbar label; this does not authorize a Settings feature.

Direct entry opens a recent-ideas list. **Browse from here** on Idea opens a map centered initially on that selected thought, which need not be an evolution-tree root. These are approved designs, not yet implemented behavior.

## Chronological list

- Include user-authored and AI-recorded thoughts, not full conversational replies.
- Show titles, actual-text excerpts, authorship, material kind and creation date.
- Default to newest first; offer oldest first. No shuffle.
- Authorship filters apply to the starting list, not map neighbors.
- Selecting an idea opens its map and actual-text inspector. Returning restores list filters and position.

## Focused Map

The approved [Focused Map comp](../../.impeccable/mocks/browse/selected.png) places a substantial map beside a right-hand text inspector.

- Start with the selected thought and directly linked neighbors. Do not load the whole collection.
- Selecting a node inspects it without automatically expanding or recentering.
- **Show linked ideas** explicitly grows the accumulated map. Deduplicate nodes and preserve the explored layout.
- **Open Idea** separately opens the full reader; returning preserves map exploration state.
- Evolution ancestry uses solid directional lines. Conceptual connections use dashed lines with recorded categories, direction and proposer attribution. Provenance uses dotted lines labelled **Used as a source**. These roles remain distinct even when they link the same thoughts.
- User-created connections are conceptual connections, not a separate relationship type.

## Visibility, accessibility and scale

Hide rejected material by default. **Show rejected** includes it alongside active material in both list and map for deliberate user-only inspection. It never broadens AI access. Turning it off removes rejected material and explains if the inspected thought becomes hidden.

Use explicit bounded loading for list rows and neighborhood expansion. Preserve confirmed content if further loading fails. Empty libraries invite Capture; empty filters offer reset; disconnected thoughts remain readable.

On narrow screens the map precedes a normal-flow inspector. **Linked list** exposes the same explored neighborhood with keyboard-accessible inspect, expand and Open Idea actions. These responsive/accessibility decisions accompany the approved desktop composition; runtime validation is still required.

## Boundary and next steps

The current API lacks paginated query-free chronological reads and bounded complete direct-neighbor expansion. Discuss those read contracts before implementation. No schema change is currently identified or authorized by this design. Keep daemon and client implementation scopes separate under the [working agreement](architecture.md).
