# Browse: selected Focused Map

[View the refined selected comp](selected.png).

**Status:** the user approved the refined Focused Map image on 2026-11-09, including removal of **Reserved** from the toolbar. Illustrative content only. Design approval is not runtime or daemon implementation authorization. Product decisions are recorded in [Browse context](../../../.lore/context/browse-view.md).

## Selected direction

- Comfortable chronological list cards lead into a growing local map with a substantial right-hand actual-text inspector. Browse is a separate navigation destination from search-focused Explore.
- List rows retain title, actual excerpt, author, material kind and creation date. Sorting offers Newest first and Oldest first only; the comp shows the closed Newest first control. Authorship filters apply to the starting list, not map neighbors. Full conversational replies are excluded.
- A row or Idea's **Browse from here** opens the selected thought's map, not necessarily an evolution root. Selection inspects without expanding or forcing recentering. **Show linked ideas** grows the accumulated neighborhood; **Open Idea** separately opens the full reader. Return preserves list position or explored map state.
- Evolution uses solid directional arrows; conceptual connections use dashed lines, category, recorded direction and You/AI proposer attribution; provenance uses round dots labelled **Used as a source**. User-created connections are attributed conceptual connections, not a fourth relationship type.
- **Show rejected** includes rejected material in deliberate user-only list/map inspection; normal browsing hides it. Browsing makes no agent call.
- On phones, controls wrap and the map precedes a normal-flow inspector. **Linked list** offers the same explored neighborhood with keyboard-accessible inspect, expand and Open Idea controls. Empty library invites Capture; empty filters offer reset; disconnected thoughts remain readable; larger collections expand in explicit bounded batches. These are interaction notes, not additional tested visual frames.

## Refinement and verification

The exact packaged PNG was visually inspected. **Reserved is absent from both navigation bars**, while Settings remains subdued. The source edge and its legend sample now use round dots; conceptual connections remain dashed and evolution arrows solid. The list, five-node accumulated map, exact-text inspector, gold expansion button, cyan Open Idea link and return controls remain present and readable. No new functionality or alternate composition was introduced.

The native image is **896 × 1754 opaque sRGB PNG**, copied without resizing. ImageMagick **7.1.2-34** verified decoding and unchanged RGB pixels after brief metadata embedding. The sidecar records the exact prompt, source/output paths and hashes. `codex-cli 0.167.0` used the authorized native image-edit route with the selected comp as input. No deterministic regeneration, physical-device, keyboard, contrast or runtime accessibility validation is claimed. Generated type metrics and incidental image styling do not supersede the [client design system](../../../apps/web/DESIGN.md).

Rejected Browse B/C and superseded packaged A images/sidecars were removed after verifying this replacement. Only this selected PNG, its essential sidecar and these notes remain in the Browse package. Other selected references and user assets are untouched. Exact-image approval closes the composition selection gate; responsive and keyboard behavior remains specified in notes, not validated by runtime testing.

## Implementation follow-up, not performed

- The real toolbar still renders `Reserved` beside disabled Settings in [primary-navigation.tsx](../../../apps/web/src/components/primary-navigation.tsx). Remove that badge under an authorized client implementation scope; do not infer a working Settings screen from its removal.
- Query-free chronological pagination and bounded complete direct-neighbor reads still lack API contracts. The comp does not claim those capabilities already exist. No daemon/client source, Beads or commits were changed here.
