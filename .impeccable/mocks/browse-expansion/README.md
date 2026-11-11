# Browse: click inspects and expands

**Design approved by the user on 2026-11-11.** Revised interaction for `thought-loom-dk2`. [Desktop comp](desktop.png) · [Phone comp](mobile.png) · [Responsive comp source](proposal.html). Its Map / Linked list switch changes the illustrative presentation only. No daemon, application state or private data is used. All thought text, dates, statuses and counts in the comp are illustrative. This records design approval, not completed implementation or runtime acceptance.

This is one bounded revision of the approved [Focused Map](../browse/selected.png), not another screen or a visual redesign. Keep Quiet Night, Source Sans 3, the current two-column map/inspector, existing positions and camera, typed directional relationships, Show rejected and separate Open Idea. Mode: Operate. The user settled the discovery decision, **Click inspects and expands**, and then explicitly approved the revised interaction for both Map and Linked list. The approval record is below.

## Approved interaction

- **Activate a node to inspect it immediately and load its first direct-link page automatically.** Do the same for each newly encountered node, so walking A → B → C grows the accumulated map. Merely focusing, hovering or panning does not load anything. Enter, Space and touch activation behave like a click. A node already read successfully selects without fetching again, including when its first page was loaded on entry. This avoids consuming another page every time the user rereads an idea. Pagination is deliberate: **Load more linked ideas** reads exactly one additional page for the selected idea. No recursive expansion, automatic page draining or whole-library graph.
- **Keep the map steady.** Existing node coordinates, zoom, pan, selected inspector and starting URL stay intact. Append newly discovered nodes near the expanded node without duplicates; add distinct relationships even when no new nodes appear. Late results for A must not replace B's selection or status. Keep other nodes, reading, presentation switching and Open Idea usable during a read; join duplicate pending reads. Fit map remains explicit, never a side effect of selection or a completed fetch.
- **Make the exploration boundary visible.** The persistent instruction says “Select an idea to read it and reveal its direct links.” Each node's existing metadata line includes a short exploration state beside author or Starting idea. The inspector owns fuller feedback and the one continuation/recovery action. “7 ideas shown” counts unique loaded thoughts, not all thoughts or all neighbors. The comp depicts two new nodes after one selection, with more relationship pages still available; it does not prescribe a smaller runtime page size.
- **Keep relationship meaning and user agency.** A neighborhood includes the evolution parent and children, incoming and outgoing provenance, and incoming and outgoing conceptual connections. Do not equate connection evidence IDs with adjacency. The solid cyan / dashed cream / dotted blue arrows and legend stay; written relationship rows name direction, connection category, proposer and rationale. Preserve parallel roles, repeated source occurrences and self-links. Read completeness is per selected thought and current visibility, not per entire graph. Rejection stays hidden by default. Show rejected remains deliberate user-only inspection, retaining rejection words and styles; it never broadens AI access. Reject/restore remains in the existing Idea reader reached through Open Idea, not a new map write action.

## Feedback and recovery

The node metadata uses the compact wording below. Full status is next to **Recorded relationships** and above its rows in the inspector. Preserve readable actual thought text and all confirmed graph content during pending and failed reads.

| State | Node wording | Inspector feedback and action |
| --- | --- | --- |
| Encountered, not read | Explore links | Activation selects and starts the first page. No separate Show linked ideas prerequisite. |
| First page or continuation pending | Loading links… | “Loading direct links…” or “Loading more direct links…”; a disabled pending action prevents duplicates. Retain previously loaded rows. |
| Successful page, continuation exists | More links | “More direct links are available. Parent, child, source or connection links may still be on later pages.” **Load more linked ideas**. List is explicitly partial, even when some endpoints were already visible. |
| Successful final page | Links shown | “All direct links in this view are shown.” No disabled gold success button. This is not a claim about the whole library or future live changes. |
| Final page, zero visible relationships | No visible links | “No direct links in this view.” Preserve the thought and Open Idea. Do not imply it has no rejected links or no possible future connections. |
| Read failure | Retry links | “Direct links could not be loaded. Your explored map is still here.” **Retry loading links** explicitly retries that first page or continuation. Selecting again only inspects; it does not silently retry. |
| Invalid, expired or stalled continuation | Restart needed | “This continuation is no longer available. Restart from the starting idea to continue; this clears the explored map.” **Restart map** is deliberate and resets the map. Do not retry the invalid cursor or silently widen scope. |
| Selected thought becomes unavailable | Remove unsafe node/edges | Preserve other confirmed content; inspect the starting idea with the existing unavailable-selection notice. If the starting thought is unavailable, show the existing unavailable state with deliberate Show rejected guidance. |

After a page completes, announce its subject and changes, for example “Questions before conclusions: 2 ideas added. More direct links available.” If only relationships were added, say so; zero new nodes is not “No links.” Keep an unobtrusive map-level reminder: “New ideas may be outside the view. Use Fit map to see them.” Never move focus or pan the map to deliver that feedback. Global completion messages must identify their subject when another idea is now selected.

An initial first-read failure keeps the existing full-view retry, since no graph exists to retain. Scope changes keep their current immediate clear/reset behavior and rejection notice. Current mounted-document return memory and reload semantics remain unchanged.

## Linked list, keyboard and phone

The Linked list shows the same accumulated nodes, not a separately fetched graph. Its title buttons use the same activate-to-inspect-and-first-expand rule and show the same state words. Add a **Read selected idea** in-page link after the selected row, so a keyboard or phone user can reach the normal-flow inspector without traversing every later node. Switching presentations retains selection, expansions and camera. The inspector retains all typed written relationship rows and the same continuation/retry actions.

Tab navigates native controls; Enter/Space activates an idea, not focus alone. Selection uses `aria-pressed`; accessible names describe “Inspect and explore [full title]” and expose state without claiming an unknown link count. Preserve the existing blue focus ring and avoid stealing focus when nodes append. Arrow-key panning remains confined to the focused map region, not buttons or the page. One polite status region announces results, without rereading the thought body.

At the existing 48rem breakpoint, controls wrap and the 24rem map precedes the normal-flow inspector. Add a visible **Read selected idea** jump link above the map on narrow screens; no automatic scroll on selection. Do not shrink target sizes to fit a graph. Preserve 44px minimum controls, readable inspector type and vertical page scrolling outside the map. Linked list is the no-pan alternative, including when zoom makes spatial nodes small. The phone comp's framing is an illustrative existing camera, not permission to recenter on click or resize.

## Source alignment and validation

- Read the selected comp, [current Browse agreement](../../../.lore/context/browse-view.md), [architecture gate](../../../.lore/context/architecture.md#visual-client-design-gate), [design system](../../../apps/web/DESIGN.md), current map view/surface/CSS, layout and controller, and [neighborhood API](../../../docs/daemon-api.md#direct-neighborhood-get-thoughtsidneighborhood).
- At design review, `map-controller.ts` selection was fetch-free; `browse-map-view.tsx` exposed explicit first/more-page expansion. Those matched the previous agreement, not the user's newly chosen behavior. The approved design replaces that interaction rule. Current behavior documentation must change with implementation, not imply it already exists because the design was approved.
- Existing GET neighborhood supplies bounded typed direct relationships in both directions, with `nextCursor`, stable edge IDs and scoped endpoints. It supplies no total or per-type counts. Therefore the comp promises no totals, per-type completeness, priority ordering or “remaining N.” An unseen parent or incoming link has an explicit continuation path; do not claim absence before the selected walk is exhausted. No daemon changes or new endpoint are required by this design.
- The comp borrows current global CSS and the bundled font and carries its own development-only composition. It is not runtime UI, generated artwork or an application asset. Its compact state line is the only node addition; long full titles remain available in the selected inspector and accessible name.
- Assigned validation is visual proposal/source alignment only. Render review results are recorded below. No application runtime tests, physical-device, screen-reader, contrast certification or implementation verification are claimed. The existing approved comp is untouched; no alternatives or gallery were produced.

### Render review

Designer visual/source review completed on 2026-11-11, followed by explicit user design approval that day. Only the two essential Map views of this one proposal are retained. They preserve the exact reviewed pixels, including their historical “Unapproved design comp” banner; that banner describes their pre-approval capture time, not the current approval status. Only the HTML title/banner and this record were updated after approval, without changing the composition or behavior contract.

- `.impeccable/mocks/browse-expansion/desktop.png`: 1440 × 1000 viewport, 1440 × 1487 full-page PNG.
- `.impeccable/mocks/browse-expansion/mobile.png`: 390 × 844 viewport, 390 × 2740 full-page PNG.

**Performed commands and evidence:** `bun --no-env-file -e` loaded the already-installed `@playwright/test`, launched headless `/usr/bin/chromium`, and opened the actual `file:///home/rjroy/Projects/writing/thought-loom/.impeccable/mocks/browse-expansion/proposal.html?view=map` and `?view=list` at both viewport sizes. After awaiting `document.fonts.ready`, it captured full-page views and checked script errors, font readiness, image decoding, selected inspector title and document width. All four views reported no script errors, the bundled font ready, every image loaded, the expected selected thought and document width equal to viewport width. This establishes that the linked proposal file renders with its real local dependencies, not just that an image was drawn.

Opened and visually inspected all four final captures. The retained desktop comp shows seven nodes, directional line types, readable selected text and explicit partial-page continuation. The phone comp deliberately clips the spatial map while retaining its selected node, wrapping controls, jump link and normal-flow inspector. Linked list retained the same selection and state words with a selected-row jump link; its temporary captures stay outside the repository at `/tmp/opencode/thought-loom-dk2-design/desktop-list-final.png` and `mobile-list-final.png`. A first review caught a map-only Fit map reminder in Linked list; the final comp hides that reminder in list presentation. Existing approved reading/relationship glyphs are reused, not redrawn.

`/home/rjroy/.agents/skills/impeccable/scripts/impeccable detect --json .impeccable/mocks/browse-expansion/proposal.html` returned `[]`. `git diff --check` passed; a targeted Python check also verified this package's Markdown file-link targets exist and both text files have no trailing whitespace. `magick identify -format '%f %wx%h\n'` confirmed the retained dimensions above. `sha256sum` recorded the exact reviewed identities before the approval-label update:

```text
proposal.html (pre-approval labels) 44f6e851d1777d495ce975f4b9fe573472129518183b73ffff006330d0d93928
desktop.png   c5e89ae9a3d4b9a7731be4c240b4317d07e8d6ecb74349116c37d1a735811771
mobile.png    6f515cf805844a8218d0ec2dd8bbec33ccd2220e180881b96ea873f9abc769c2
```

These PNGs are Chromium screenshots of this development-only HTML, not generated art or runtime screenshots. The HTML references existing repository CSS, font and glyph files by relative path, so keep the package in this location or serve the repository root to preserve those dependencies. No service was started. Pending, error and terminal rules were checked against the source/API and the state table, not exercised as live prototype states. No app build, daemon request, runtime/browser regression suite, physical-device test, keyboard/screen-reader audit, enlarged-text test or independent review was run. No production files or current behavior agreements were changed.

## User approval record

On 2026-11-11 the user explicitly chose **Approve** in response to:

> Do you approve this revised Browse interaction, with the same click-to-expand behavior in Map and Linked list?

Approval covers the revised interaction and comp documented above, including automatic first-page exploration, deliberate continuation and a steady map. It does not claim implementation, runtime validation or runtime acceptance. This approval-record update is confined to this design-artifact directory; no production files were edited.

Approval-label validation: a targeted Python check passed for the exact user decision, approved README/HTML labels, removal of stale approval gates, unchanged retained screenshot hashes, existing local file links and clean trailing whitespace. No render or runtime tests were rerun for this label-only update.
