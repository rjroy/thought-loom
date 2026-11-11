---
title: Browse view
date: 2026-11-09
status: approved
tags: [thoughtloom, product, browse]
---

# Browse

## Purpose and entry

Browse helps the user rediscover forgotten ideas without a search query or agent. It is a separate main-navigation destination alongside Explore and Capture. Explore remains search-focused. Remove the nonfunctional **Reserved** toolbar label; this does not authorize a Settings feature.

Direct entry opens a recent-ideas list. **Browse from here** on Idea opens a map centered initially on that selected thought, which need not be an evolution-tree root. Both entry points are implemented.

## Chronological list

- Include user-authored and AI-recorded thoughts, not full conversational replies.
- Show titles, actual-text excerpts, authorship, material kind and creation date.
- Default to newest first; offer oldest first. No shuffle.
- Authorship filters apply to the starting list, not map neighbors.
- Selecting an idea opens its map and actual-text inspector. Returning restores list filters and position.

## Focused Map

The approved [Focused Map comp](../../.impeccable/mocks/browse/selected.png) places a substantial map beside a right-hand text inspector.

- Start with the selected thought and directly linked neighbors. Do not load the whole collection.
- Activating a node inspects it immediately and automatically loads its first direct-neighbor page if it has not been read. Repeat this along branches to grow the accumulated map. Selection never recenters the map; revisiting a read node does not load another page.
- **Load more linked ideas** explicitly reads the next page for the selected thought. Deduplicate nodes, preserve distinct relationship records and keep the explored layout. First-page and continuation failures require deliberate retry rather than retrying on selection.
- **Open Idea** separately opens the full reader; returning preserves map exploration state.
- Evolution ancestry uses solid directional lines. Conceptual connections use dashed lines with recorded categories, direction and proposer attribution. Provenance uses dotted lines labelled **Used as a source**. These roles remain distinct even when they link the same thoughts.
- User-created connections are conceptual connections, not a separate relationship type.

## Visibility, accessibility and scale

Hide rejected material by default. **Show rejected** includes it alongside active material in both list and map for deliberate user-only inspection. It never broadens AI access. Turning it off removes rejected material and explains if the inspected thought becomes hidden.

Use bounded loading for list rows and neighborhood expansion. The initial neighborhood and each newly activated node load one page, not a recursive or whole-library graph. A neighborhood includes the evolution parent and children and both incoming and outgoing provenance and conceptual connections; some relationships may be on later pages. Per-node states and inspector feedback distinguish unexplored, loading, partial, complete, empty and failed reads. Completeness applies only to that thought in the current visibility scope. Preserve confirmed content if further loading fails. Empty libraries invite Capture; empty filters offer reset; disconnected thoughts remain readable.

On narrow screens the map precedes a normal-flow inspector. **Linked list** exposes the same explored neighborhood with keyboard-accessible inspect, expand and Open Idea actions. Isolated browser walkthroughs validate these interactions at wide and narrow viewports; this is not a general accessibility certification or large-library performance guarantee.

## Boundary and next steps

The daemon provides paginated query-free chronological reads through `GET /browse/thoughts` and bounded complete direct-neighbor expansion through `GET /thoughts/:id/neighborhood`; see the [API contracts](../../docs/daemon-api.md). These read capabilities required no schema change. The chronological list, shared navigation, map entry, explicit expansion and Linked list alternative are implemented. Browser reads go through the Next.js server under the [working agreement](architecture.md).

Map URLs identify the starting thought and inspection scope, not every explored node or the current selection. Mounted document memory preserves list pages/position and map exploration/camera when returning. Reload reconstructs the bookmarked starting point with one bounded page; it does not retain the old graph or list pages across document lifetimes. Visibility-changing Idea actions invalidate Browse memory on both attempt and settlement so returning during a pending write cannot retain stale content after that write completes.
