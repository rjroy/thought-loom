---
name: "Thoughtloom: Quiet Night"
description: A dark, text-first workspace for capturing and developing connected thinking.
colors:
  brand-color-0: "#031315"
  brand-color-1: "#d66b65"
  brand-color-2: "#83b88a"
  brand-color-3: "#efb83f"
  brand-color-4: "#5e8bd6"
  brand-color-5: "#8871c5"
  brand-color-6: "#248f91"
  brand-color-7: "#d5d3c5"
  brand-color-8: "#344548"
  brand-color-9: "#f18a83"
  brand-color-10: "#a5d5a5"
  brand-color-11: "#ffd477"
  brand-color-12: "#8eaef2"
  brand-color-13: "#b09ae5"
  brand-color-14: "#65c4c5"
  brand-color-15: "#fef6e1"
  color-muted: "#a5a8a0"
  color-control-line: "#7b837f"
  color-card: "#122224"
  color-input: "#0e1e20"
  color-caption: "#0a2c2e"
  color-selection: "#35557f"
typography:
  body:
    fontFamily: "Source Sans 3, system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Source Sans 3, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 600
  metadata:
    fontFamily: "Source Sans 3, system-ui, sans-serif"
    fontSize: "1rem"
rounded:
  badge: "4px"
  compact-control: "6px"
  control: "8px"
  surface: "12px"
---

# Design System: Thoughtloom

## Overview

**Quiet Night** is the approved working environment: dark teal ground, warm light text, gold primary actions, restrained borders and familiar controls. Thinking is the content, not an occasion for decoration. Thought text is focal; attribution, context and recovery information remain distinguishable and subordinate.

This is the implementation-derived design system for the `apps/web` workspace, not a new design proposal or accessibility certification. A small [selected reference set](../../.impeccable/README.md) and its [identity/palette manifest](../../.impeccable/selected-assets.json) preserve the approved direction. Current source and this document govern implemented detail rather than obsolete state screenshots. Product and transport contracts remain in the repository's context and API documentation.

The **Focused B conversational-search client is implemented** alongside ordinary Explore. Its [selected composition](../../.impeccable/mocks/agentic-search/focused.png) is reference-only, not an application asset. The route and behavior rules below document the implementation; a reference image is not runtime acceptance.

The **Focused Map Browse list and local map are implemented** from the [selected Browse composition](../../.impeccable/mocks/browse/selected.png), with the [approved click-to-expand revision](../../.impeccable/mocks/browse-expansion/README.md). List titles open the map, not the Idea reader. Activating a node inspects it and automatically reads its first direct-link page if unattempted; further pages, retries and Open Idea remain separate actions. The comps are reference compositions rather than runtime acceptance.

The values above are extracted from [global CSS](src/app/globals.css), [the shared layout](src/app/layout.tsx) and the screen CSS modules. They record existing values; they do not introduce a new token library or require a styling rewrite. The full sixteen-color palette remains available, without a requirement to use every color on each screen.

## Colors

| Role | Existing CSS variable or palette entry | Application |
| --- | --- | --- |
| Ground and shell | `--color-ground` → `brand-color-0` | Page, header and ordinary secondary controls |
| Focal text | `--color-text` → `brand-color-15` | Headings, original thought text, input values |
| Body text | `--color-body` → `brand-color-7` | Supporting copy and secondary labels |
| Muted text | `--color-muted` | Metadata and explanatory text, not unreadably dim body copy |
| Divider | `--color-line` → `brand-color-8` | Structural rules, card boundaries |
| Control boundary | `--color-control-line` | Input strokes and stronger outlined controls |
| Primary action | `brand-color-3`; hover `brand-color-11` | Save, Search, Evolve, Send, Create and Download; ground-colored text |
| Focus and selected navigation | `--color-focus` → `brand-color-12` | Separated keyboard outline, current navigation underline |
| Links | `--color-link` → `brand-color-14` | Underlined navigation within content and secondary text actions |
| User / AI attribution | `brand-color-2` (Browse list/map: lighter `brand-color-10`) / `brand-color-13` | Explicit You / AI labels; Browse's lighter green still denotes attribution, never success, agreement or confidence |
| Confirmed success | `brand-color-10`, with `brand-color-2` boundary where used | Saved and Report ready feedback |
| Error / destructive action | `brand-color-9` | Field errors, rejected labels and explicit reject confirmation |
| Uncertainty / warning | `brand-color-3` or `brand-color-11` | Worded uncertainty and observation warnings |
| Surfaces | `--color-card`, `--color-input`, `--color-caption` | Distinct reading containers, editable fields and subordinate context strips |
| Text selection | `--color-selection` with focal text | Actual browser text selection |

The six non-master colors in the frontmatter are the implemented rounded sRGB mixtures. Their source percentages live in the manifest; do not replace them with unrelated dark neutrals. The manifest also retains a `card-line` mixture that is **not** a separately declared runtime token in this client.

**Color never supplies the whole meaning.** You / AI, Rejected / Status unknown, errors, run status and confirmation labels remain textual. Focal heading links use the text color and underline on hover rather than making an entire title cyan.

## Typography

Source Sans 3 supplies both reading and display roles. It is bundled through `next/font/local` from [the variable font](public/fonts/SourceSans3-VariableFont_wght.ttf), weight range 200–900, with [its OFL license](public/fonts/OFL.txt). The browser's generated family alias is not a second typeface. No network font service or separate decorative display face is used.

The body is 18px with 27px line height at the default root size. Secondary copy and metadata are generally 16px. Weight 600–700, not uppercase decoration, establishes hierarchy. Settings uses the shared navigation link treatment; the confusing Reserved badge has been removed.

| Existing text role | Desktop | Narrow |
| --- | --- | --- |
| Capture / Evolve page heading | `2rem`, weight 700, line height 1.2 | Same |
| Idea title | `clamp(2rem, 2.75vw, 2.75rem)`, weight 700, line height 1.15 | `2rem` |
| Idea original words | `1.5rem`, line height 1.5, maximum 72ch | `1.25rem` |
| Explore result title | `1.5rem`, weight 650, line height 1.25 | Same; wraps naturally |
| Browse heading / thought title | `2.75rem`, weight 700 / `1.5rem`, weight 650 | Heading `2rem`; thought titles retain readable wrapping |
| Evolve contribution / reply | `1.375rem`, line height 1.5, maximum 72ch | `1.25rem` |
| Conversational-search session switcher / discovery title | `1.375rem`, weight 600, line height 1.35 / 1.25 | Same; wraps naturally |
| Conversational-search message | `1.25rem`, line height 1.5, maximum 72ch | Same |
| Exports / New export / Export / Simple export heading | `2rem`, weight 700, line height 1.2 | Same |
| Export request / status heading | Request text `1.25rem`, line height 1.5 / status `1.5rem`, line height 1.25 | Same |

Explore has a visually hidden page heading and a visible search label on narrow screens. Most heading tracking is −0.02em, including Export. Full thought bodies use the shared Markdown reading treatment approved on 2026-11-11, within the existing Quiet Night layouts and body sizes. Single source newlines remain visible breaks; blank lines separate paragraphs. Bounded excerpts remain plain text rather than parsing truncated Markdown. Counts use tabular numerals. Markdown code uses the browser's monospace fallback, not an additional brand font.

### Markdown thought reading

The shared treatment supports headings, paragraphs, emphasis, nested lists, quotations, inline and fenced code, and GFM tables. Content headings sit below their surrounding title and stop at H6. Underlined cyan HTTP(S) links have visible keyboard focus and an accessible new-tab indication; they open a new tab with safe `rel` attributes. Long links wrap; code and tables scroll inside their own containers without widening the page.

Raw HTML is skipped, non-HTTP(S) links are inert, and images display alternative text without fetching remote content. Rendering never rewrites stored text. Copy, downloads and original-source inspection retain their existing source contracts. Export previews keep their separate, deliberately inert body-link policy.

## Layout

The document has a fixed `320px` minimum inline size, independent of the root text size. Enlarging text must not turn this viewport floor into a wider page; typography and spacing retain their existing relative units. This is a minimum-width rule, not a guarantee that every screen or content state reflows without overflow.

The shell uses `--page-inset: clamp(1.25rem, 3.125vw, 3rem)`. Main content has 2rem top and 4rem bottom padding; narrow top padding is 1.75rem. Shared grouping gaps repeatedly use 0.5rem, 0.75rem, 1rem, 1.5rem and 2rem; these are existing literals, not a declared global spacing scale.

The desktop header has a minimum height of 4.625rem. Its identity and navigation can wrap when their combined content needs more width; navigation itself also wraps instead of overflowing enlarged text. At `max-width: 48rem`, the wordmark/tagline stack above the visible navigation row. Explore alone keeps the shared header sticky and adds scroll margins for its controls. There is no added hamburger destination or permanently fixed composer.

| Surface | Implemented composition | Narrow behavior |
| --- | --- | --- |
| Explore Compact | Full-width search above 15.875rem filter sidebar and fluid result column; 2rem column gap; close-spaced result cards with subordinate context strips | One column at 48rem; explicit Filters control with selected-value count, headed inline panel and Close filters; sort wraps above readable results |
| Browse Focused list | Heading with Refresh list and Sort above a 15.875rem authorship/inspection sidebar and fluid chronological cards; 2rem column gap; maximum 100rem workspace | One column at 48rem; visible wrapping filters above cards, no concealed controls or reduced type |
| Browse Focused map | Native SVG relationships behind HTML thought buttons; fluid map and a right-hand actual-text inspector in `1.8fr / minmax(20rem, 1fr)` columns; explicit camera tools and written relationship legend | One column at 48rem; 24rem map followed by the inspector; Linked list offers the same inspection and expansion without spatial interaction |
| Capture Wide / Roomy | Left-aligned form at 87% of workspace width; generous writing field, secondary optional title; Save at the far right; saving, known not-saved and uncertain forms use an 8rem field minimum at either width | Full width at 48rem; ordinary editing field minimum 15rem, recovery minimum 8rem; full-width Save below title |
| Markdown import workspace | Selection or batch report beside an open 19rem explanation rail with a 2.5rem gap; at 48.001–68rem the rail is 16rem with a 1.5rem gap; Recent imports replaces this grid with a wrapping list capped at 75rem | One column at 48rem; How import works becomes a disclosure below the main content; report filenames span the status/action columns, file sizes are hidden, and the Import action fills the width |
| Idea Rows | Focal thought with Evolve beside it and a separate visible immediate-parent title link when applicable; direct context rows group children, provenance and connection neighbors by thought ID; columns are title/author, actual text/relationships, Open idea | Single column at 48rem; full-width Evolve; parent link wraps; context and connection-specific actions flow below each thought |
| Evolve Rail | Starting-thought rail at `minmax(13rem, 24%)`, 2rem gap, chronological exchange column; saved developments in two columns; composer follows the conversation with Send beside the textarea | Starting context becomes a disclosure at 48rem; development rows stack; textarea and compact Send remain side by side |
| Conversational search: Focused B | Maximum 100rem workspace; contextual session switcher/actions above conversation left and discoveries right; `1.08fr / 1fr` columns with 1.75rem gap and a thin divider; no permanent session rail or forced blank conversation height | One column at 48rem; visible session title, explicit Session actions disclosure, conversation and inline composer followed by Discovered ideas disclosure; the contextual session sheet reuses saved-search rows |
| Explore Exports | Maximum 100rem workspace; 65rem catalog with Active exports above History; separate 75ch Request/Effort form; detail uses a narrower request rail beside status/report with a 2rem gap | Catalog rows and detail stack at 48rem; form and download primary actions fill the width; no permanent export rail or hidden request text |
| Simple-only Idea Export | Left-aligned 52rem maximum form with starting idea, maximum count and traversal; confirmed preview follows setup | Full width at 48rem; fields and primary action fill the available width; preview padding reduces again at 360px |

Reading containers generally stop at 65–75ch; original text and retained replies wrap rather than create horizontal page scrolling. The page may be substantially taller than a phone comp. Narrow comps were approximate hierarchy studies, not literal viewport or keyboard canvases. Native form controls and clear labels take precedence over shrinking the raster's contents into one frame.

## Elevation & Depth

Depth comes from tonal surfaces and thin boundaries, not decorative shadows, textures or glass. Cards use the card mixture; fields recede to the input mixture; recorded relationships use the caption mixture. The native Idea confirmation dialog uses a ground-colored panel and an 80%-opaque ground-colored backdrop.

The global keyboard ring is a 3px solid focus outline, separated by 5px. Header navigation brings the outline inward by 6px so it remains visible against the viewport edge. Focus is not a glow or a persistent selected state. Working screens have no authored entrance animations or animated progress effects. The separately approved root arrival below is the bounded entrance-animation exception, not a progress effect or permission to animate working screens.

## Shapes

Reading surfaces, details and dialogs use gently rounded 12px corners. Most Capture/Explore/Idea/Evolve and Explore Exports controls use 8px; compact fields and Simple export controls use 6px. Badges use 4px. Borders are 1px. These are deliberate local variants in current CSS, not a single shared button component API.

Search, back and disclosure icons are simple SVG geometry, with a consistent thin stroke where authored. Native details markers remain native. The approved cream/gold glyph family in `public/glyphs/` includes the exact lantern/sprout pair from the [approved SVG source packet](../../.impeccable/candidates/glyphs/content-family/README.md) and the [nine approved content/relationship assets](../../.impeccable/candidates/glyphs/content-family/README.md). All runtime files are byte-identical copies of their approved production sources. The sprout's separated gold leaf is explicitly accepted; do not redraw or reconnect it. The two approved relationship PNGs retain their accepted shading; do not substitute the rejected relationship SVG attempts.

The lantern and sprout occupy 24px squares with 8px heading gaps and no extra row. The lantern precedes **Find your recorded thinking** only in Explore's unvalidated initial state; it is absent during query validation, invalid links, loading, results, no results and read errors. The sprout precedes the existing **Capture** heading across its states, with Import still at the right. Their accepted behavior remains unchanged.

Content glyphs accompany existing material words, not You/AI attribution: Original capture, Contribution, Interpretation, Developing idea and Imported source use their actual recorded kind. List/context/Evolve records use 20px squares with 8px label gaps; the focused Idea uses 24px. A Full reply record uses its own 20px cue instead of a competing material icon, retaining material wording where already present. Evolve's confirmed contribution and retained reply now explicitly name their material/record role beside unchanged attribution. Unknown/unavailable records receive no invented kind.

Persisted relationship words use 16px companions with 6px internal gaps: Evolution for existing Developed from parent/child labels; the linked pair for discovered connections; page→arrow→leaf for Used as a source. Written category, direction and rationale remain authoritative. A known relationship may remain visible when its other thought is unavailable; no material kind is fabricated for it. Evolve's future **Continuing from** choice is not decorated as already-recorded ancestry. At 16px the source cue remains label-dependent.

All glyphs are noninteractive images with empty alternatives and `aria-hidden`, no focus stop or new accessible name. `content-glyph.tsx` restricts asset/size choices and serves exact unoptimized URLs, eagerly loading these repeated small cues rather than leaving off-screen rows without their visual hints. Layouts, controls, palette and state colors remain intact. “Restrained” describes the simple graphic appearance, not a sparse-usage ceiling. This approved vocabulary does not authorize unrelated artwork, author/status icons or decoration in navigation, Export, Import or feedback. Decorative graph artwork, avatars and unrelated illustrations remain excluded; Browse's separately approved map uses native SVG/HTML, not a generated asset. The separately approved Explore clearing, Capture canopy, Browse cat and Settings notebook below are narrow exceptions. [Controlled in-app evidence](../../.impeccable/candidates/glyphs/content-family/README.md) records independent verification, review and user runtime acceptance of the glyphs.

**Approved Explore background:** the user selected and approved the exact wider lantern-and-cat clearing and desktop/phone placement, then authorized implementation. The [source-preserving production package](../../.impeccable/candidates/explore-clearing/README.md) owns the immutable approved PNG, reproducible color-derived alpha matte, source/derivative hashes and pre-promotion visual review. The 1122 × 374 transparent derivative is copied byte-identically to `public/backgrounds/explore-clearing.png`; it removes the opaque teal sky seam without repainting the scene. The separately approved Capture canopy and root arrival do not change the clearing.

The background is mounted only when ordinary Explore has `phase === "initial"` and no validation. It is absent during blank-query validation, invalid links, loading, results, no results and errors, and does not appear on other routes. Its noninteractive, `aria-hidden` frame and empty-alternative image add no accessible name or focus stop; both ignore pointer events and the image cannot be dragged. The exact unoptimized PNG loads eagerly without a preload, animation, invented status or daemon call. The existing 24px heading lantern, controls, links and reading order remain unchanged.

The frame is anchored to the actual results area, never the viewport. It is at most 560px wide, clipped to the results-column width, and 168px high on desktop; the image stays 560px wide with its original 3:1 ratio and left/bottom alignment. At 48rem and below, the frame is 116px high, retaining the same image scale rather than shrinking the lantern and cat. The result-relative top offset is 25.5625rem on desktop and 14.125rem on narrow screens, with a minimum clearance of 2rem after the results area's content to protect wrapping/enlarged text. Expanded narrow Filters moves the results area and scene together. A frame-level edge fade tapers the landscape endpoints; alpha preparation is not repeated in CSS. The whole frame is omitted at widths below 360px or heights below 700px. These rules do not certify physical-device/software-keyboard behavior; independent runtime verification and user runtime acceptance remain separate from concept/derivative approval.

[Scoped actual-client evidence](../../.impeccable/candidates/explore-clearing/README.md#review-and-acceptance) records designer inspection at 1440 × 900 and 390 × 844, plus intermediate-width, expanded-filter and enlarged-text specimens. Decoration-hidden comparisons in the same build retain identical control geometry; they are not historical before screenshots. The focused owned Explore browser walkthrough and typecheck/unit checks passed during implementation; the user separately accepted the runtime visual result.

**Approved Capture canopy:** the user chose persistent atmosphere “while I write,” approved the exact leaf artwork, desktop placement and phone omission, then said “please go” for production preparation and integration. The [lean production package](../../.impeccable/candidates/capture-canopy/README.md) retains the immutable source and provenance. A 392 × 588 RGBA derivative is copied byte-identically to `public/backgrounds/capture-canopy.png`. Production performs ordinary resampling only, preserving the approved soft alpha and color treatment; no halo cleanup, new matte, repainting or new generation is applied.

The Capture page owns a full-content-width relative wrapper around the unchanged 87%-width form section. Its absolute canopy frame extends through the outer page inset to the right edge and cancels the main area's 2rem top padding, placing the artwork below the real header rather than at a fixed viewport coordinate. Frame width is `min(196px, 13% of inner workspace + page inset - 1rem)`, leaving control/focus clearance. The portrait stays 196 × 294px, right/top aligned within that clipped frame; intermediate desktop gutters clip the image rather than narrow the form. At the existing `max-width: 48rem` breakpoint, where Capture becomes full width, the canopy is omitted. There is no separate phone or height cutoff and no sticky-on-scroll behavior.

The image sits outside the Capture form's save-state branches, retaining its asset, size and document-relative placement through empty/filled editing, required-text validation, saving, saved, not-saved and uncertain outcomes. It has no animation, state-dependent opacity or progress meaning. Empty alternatives, hidden decorative semantics, disabled dragging and pointer events, and no focus stop leave writing and keyboard order intact. The unoptimized PNG loads eagerly without preloading; omission on narrow screens is visual, not a promise that no asset bytes download. Import and all other routes contain no canopy. Existing sprout, labels, field geometry, action placement and save/recovery behavior are unchanged. Independent final verification and user runtime acceptance remain separate from source/derivative approval.

**Approved Browse cat:** the user approved the exact concept and then the exact [400 × 320 production PNG](../../.impeccable/candidates/browse-whimsy/README.md), explicitly authorizing integration. Its byte-identical runtime copy is `public/backgrounds/browse-cat.png`. The 200 × 160px image is centered in the existing 15.875rem list rail, outside and 1.5rem below the complete filter panel, including Clear filters. A minimal rail wrapper preserves the filter panel and result geometry. It follows normal document flow, persists across list read/filter states and is omitted at the existing 48rem stacked-layout breakpoint. The Browse map has no cat.

**Approved Settings notebook:** the user approved the exact concept and then the exact [320 × 180 production PNG](../../.impeccable/candidates/settings-whimsy/README.md), explicitly authorizing integration. Its byte-identical runtime copy is `public/backgrounds/settings-notebook.png`. The 160 × 90px image is top-aligned to the Additional agent instructions introduction, 2rem beyond its unchanged 75ch copy measure. The existing 70rem workspace is an inline-size query container; the image is absolutely positioned and displayed only when `75ch + 2rem + 160px` fits inside that workspace. Otherwise it is omitted rather than narrowing the copy or adding a row. Introductory text, form geometry and save/recovery behavior remain unchanged.

Both new decorations use empty alternatives, `aria-hidden`, no focus stop, disabled dragging, no pointer events and no animation or status meaning. They load as exact unoptimized PNGs, eagerly without preloading. CSS omission does not promise zero image downloads. Each source-preserving package records production approval, byte identities, retained actual built-Next desktop/mobile captures and historical before-and-after observations. Independent verification and review passed; after runtime previews the user accepted the delivered integration without additional live user testing.

## Components

### Root arrival

The user approved the exact [2.4-second constellation motion comp](../../.impeccable/candidates/root-splash/README.md), desktop containment, phone containment and dissolve, then authorized implementation. It is a bounded Experience arrival into the unchanged Operate workspace, not a new landing page or working-screen redesign. Only explicit `/` visits play it; direct Explore/deep links bypass it. The source-preserving package retains the immutable approved study and exact supplied WebPs. `public/backgrounds/splash-landscape.webp` and `splash-complete.webp` are byte-identical extractions, not regenerated art or the heavy static SVG tracing. Both are opaque full scenes, composed through the original lightweight inline reveal masks.

The landscape is present first; peripheral sprouts/connections overlap from 150–1350ms, central plant resolves from 1150–1650ms, completed constellation holds through 1950ms, and the whole scene dissolves over the final 450ms. There is no zoom, parallax, sound, loop or invented progress signal. The full-viewport overlay contains a centered 3:2 illustration, preserving the writer/constellation rather than cover-cropping. Its local `#04252d` canvas/Skip background comes from the supplied artwork and exact approved study; this is a root-art exception, not a replacement for the workspace's `#031315` ground. Native artwork is 1536 × 1024; approved display examples are 1218 × 812 at 1440 × 900 and 390 × 260 at 390 × 844. Skip sits outside the art with a 44px minimum target and safe-area-aware bottom padding; portrait negative space is intentional. Decorative SVG content is hidden from accessibility APIs.

The runtime reveals one real Explore presentation—not a screenshot—then replaces root history with `/explore`. Shared chrome is hidden and inert on the server before hydration, visually revealed during the dissolve, and remains keyboard-isolated until the handoff. Route-aware guard attributes apply directly to the existing skip link/header through a Fragment: adding a header-only normal-block wrapper would restrict Explore's sticky containing block and is not allowed. Their original body-level layout boxes and the existing sticky rule remain intact. The underlying Explore presentation is inert and read-only: it snapshots existing workspace memory when present, otherwise the ordinary initial view, without search execution, URL synchronization or memory writes. Saved scroll is aligned once after layout readiness under the opaque fixed overlay; the actual destination owns normal restoration and any resumed search. Ordinary Explore initializes matching remembered content directly so the handoff does not paint an empty intermediate workspace. No new persistence is introduced.

Skip intro is available immediately and Tab remains within that single control; Escape skips. With JavaScript, reduced motion hides the intro and bypasses the sequence with no imposed hold. Without JavaScript, a scoped noscript-only rule keeps the static fallback surface and normal Open Explore link visible and keyboard-reachable under either motion preference; no animation runs. This overrides reduced-motion overlay hiding only when scripts are disabled, not the JavaScript-enabled bypass. Failed or stalled artwork falls through rather than trapping entry; pending animations, timers and keyboard handlers are canceled on completion, skip or unmount. The approved standalone comp remains separate from independent runtime verification/review and user runtime acceptance.

### Shared navigation and keyboard access

- A visible-on-focus Skip to content link targets the focusable main landmark. Main navigation is labelled; Explore remains selected for its `/explore/ask` subtree, and Capture includes its contextual Import route. No search destination is added to global navigation.
- Explore, Browse, Capture and Settings are primary links. Browse remains selected for its own route subtree, not for Explore search. Explore also remains selected for `/exports` and its subtree; Exports is a contextual link beside Ask your library / Saved searches, not a primary destination. Settings opens the bookmarkable `/settings` page. Idea, Evolve, Simple export and conversational search remain contextual routes.
- Contextual route return is a single left-arrow link beside the wordmark, with a 44px target, blue keyboard focus and a destination-named hover/focus tooltip. It uses the existing header row rather than a separate content row on desktop or narrow screens. Idea prefers the known previous viewed thought, otherwise its validated Explore, Browse list/map or search-session/history return destination; Browse returns say Back to list or Back to map. This is not blind browser Back. Conversational-search entry/catalog/session views return to the known Explore destination (otherwise `/explore`), and search History returns to its session. Evolve returns to its selected Idea (or Explore for an invalid link); Simple export returns only when its root is known. The Exports catalog returns to remembered Explore (otherwise `/explore`); New export and export details return to `/exports`. Ordinary Explore and Capture have no contextual arrow. Route-owned registration is cleared on unmount without clearing a newer route's entry. Immediate-parent navigation remains separate.
- Links are ordinary links, including encoded canonical Idea IDs. Explore search/filter/sort/scope parameters support fresh bookmarks; valid result-return links preserve exploration intent. Evolve and Simple export roots use `thoughtId` in the URL; saved Agentic exports use `/exports/:runId`.
- Main action targets are generally 44–48px or taller. Narrow filter labels are 44px high; primary navigation links are at least 56px high, while the contextual Back arrow has its own 44px target. Text is not made smaller to force controls onto one line.

### Buttons, fields and disclosures

Gold marks the principal action; dark outlined controls are secondary; cyan underlined text actions open details or navigate. Destructive confirmation uses the error accent **and** an explicit Reject label. Disabled treatments differ locally: muted filled controls in Capture/Export, opacity in Idea/Evolve. They must not be mistaken for confirmed success.

Fields keep real labels, input text colors and visible focus. Errors sit beside their field and use `aria-invalid` / `aria-describedby` where implemented. Textareas resize vertically. Pending or uncertain submissions retain copyable words; readonly and disabled controls are not interchangeable.

By explicit user choice, Evolve's labelled multiline contribution field and Send share one row at desktop and narrow widths, rather than the older comps' stacked narrow arrangement. Send aligns with the bottom of the textarea without stretching to its height; keyboard order is textarea then Send. Empty or whitespace-only drafts keep Send disabled without the redundant enable-Send instruction. Genuine submitted-snapshot, paused-run and nonempty-draft guidance appears below the row and remains associated with the field when present.

Conversational search follows the same inline shape with a persistent **Your message** label, vertically resizable textarea (7rem minimum height), bottom-aligned Send and no enable-Send helper. Its labelled **Effort** select offers Quick / Standard / Thorough, with Standard as default. Empty/whitespace-only drafts disable Send. Search buttons use the existing gold/outlined/disabled treatments; Edit title, Copy link and History are underlined text actions, while Delete and Remove from search use worded coral text. Session title and message text are not reduced to fit the narrow raster.

Explore Filters, Idea More actions and Evolve Change are nonmodal disclosures using ordinary controls, not ARIA menus. Escape handling is scoped to the open disclosure; focus returns to its trigger. Idea More actions dismisses on outside pointer interaction without taking focus away from the clicked control. Native Idea confirmation dialogs focus Cancel, contain the modal interaction, and return focus to the stable trigger when closed. Pending writes cannot be cancelled by merely closing a dialog.

Idea's secondary tools row contains Edit title, About, Browse from here, Connect to another thought… and More actions, plus Full reply when retained replies exist and Download original for media sources. **About** has a minimum 44px target and visible keyboard focus. Enter or Space toggles its expanded state while focus stays on the button. Its controlled metadata block appears below the action row and contains only Created (UTC), Origin, Title by and Idea ID. When closed it occupies no separate content row; the actions may wrap on narrow screens.

Idea's secondary tools use cyan `--color-link` text with a 1px underline at rest. The button-only `:enabled` selectors change hover to cream `--color-text` with a 2px underline; pressing uses the same cream with a 3px underline. The Browse from here anchor keeps its cyan 1px underline rather than receiving these button enhancements. These treatments do not change dimensions or spacing. The existing blue keyboard focus ring remains, and disabled controls keep their existing reduced opacity without hover or pressed enhancement. Evolve retains its gold primary treatment.

Reinterpret lives inside More actions, not as another primary action or screen. It requires no text entry and keeps the selected Idea in place. One existing bordered status area above Surrounding Context presents progress, checking and Stop; media initial recovery and reinterpretation must not expose competing controls for the same run. Background publication preserves the current Full reply selection/open state and adds new direct children through the existing canonical Idea reader. Unknown admission separates Check request from explicit Send same request; an unconfirmed Stop is checked, never automatically repeated. Only minimal tab-session request identities are retained for reload recovery, with no thought text or credentials. This extends the approved Idea layout without new artwork or composition references.

The same status area offers **Retire this run…** for a freshly confirmed failed/interrupted interpretation blocker, not running, uncertain or completed work. Blocking work owns the displayed run and recovery target even when an earlier request receipt belongs to another run. Retirement reuses the native Idea dialog with a frozen subject/run identity, Cancel focus and an initially unchecked acknowledgment. The warning explicitly states that local inactivity cannot verify the old agent stopped: already-started tools may continue changing external files/services and overlap new work. Previously queued work may become able to proceed. Saved thoughts, interpretations and Full replies remain unchanged; retirement neither admits a new interpretation nor claims remote cancellation.

Opening confirmation refreshes eligibility. Changed blocking work invalidates the old confirmation rather than retargeting it. Pending retirement prevents repeat commands and dialog dismissal; closing after settlement returns focus to the original control or the stable Check control when that trigger disappears. An unconfirmed outcome retains the exact subject/run identity, offers **Check retirement**, and pauses new interpretation. Verified minimal tab-session storage is required before dispatch; reload performs same-run GET recovery without a write. A null retirement timestamp is not proof a delayed POST cannot still arrive. Confirmed retirement keeps remote status explicitly unknown and applies the returned overall eligibility: another blocker needs its own acknowledgment, queued/live work uses existing observation controls, and fresh **Reinterpret** remains a separate explicit action in More actions. No uncertain-write resend control is introduced. These are implementation rules, not a claim that the new recovery states have completed independent runtime, rendered-design or accessibility review.

### Screen patterns and states

| Surface | Current states and interaction pattern |
| --- | --- |
| Capture | Editing/required-text validation → Saving with retained readonly snapshot → canonical Saved receipt, Open idea and Capture another thought. Known not-saved retains editable fields for Retry save. Unknown outcome retains its original readonly snapshot, warns of duplication and requires deliberate Save another copy. No cross-reload or autosave promise. |
| Markdown import | File selection and local Not sent feedback precede explicit Import. Pending admission disables selection changes; uncertain admission shows its Frozen selection. Bookmarkable batch reports distinguish imported (including structural fallback), skipped-identical, skipped-changed, failed, interrupted and uncertain file outcomes. Check report / Check file are reads; Stop file addresses a known run. Report errors retain confirmed information; More files and Recent imports / More imports provide bounded continuation. Original inspection is deliberate, not additional AI context. |
| Explore | Query-first initial, loading with unknown facet counts, successful results, no results and request error with Retry search. Author/kind facets use server counts; selected Filters count counts chosen values, not matches. Actual matching text expands in place; a retained-response hit is labelled Full reply. Inclusive rejected inspection distinguishes Rejected, active and Status unknown without guessing. Search remains available while a read is pending so a newer submitted query can supersede it. |
| Browse list | Automatic bounded first read, chronological loaded rows, explicit Load more, Refresh list, first-read and continuation retries, expired/invalid continuation requiring refresh, empty library and filter-empty states. Filter changes supersede pending reads and clear the previous scope immediately. Failed continuation retains confirmed cards. Titles open their local maps; full-response rows remain excluded. |
| Browse map | One bounded starting neighborhood; node activation immediately inspects and automatically reads an unattempted first page. Explicit Load more linked ideas, Retry loading links and Restart map handle continuation/recovery. Pending, partial, final and no-visible-links states retain readable thoughts and confirmed graph content. Open Idea stays separate. Scope changes immediately clear graph/inspection/cursors. Map and Linked list share activation, selection and exploration-state wording. |
| Idea | Loading, read failure/unavailable, ordinary view and explicitly labelled user inspection. Edit/Clear changes title metadata only. The immediate parent's current title or first-five-word fallback is a visible link, never a History disclosure or ancestor walk. Direct children (including AI interpretations), provenance sources and discovered connection neighbors appear immediately in Surrounding context, without an overlapping Sources panel. Full reply, About and each connection's Why connected remain on demand. Individual/branch/connection actions remain separate. Branch confirmation uses the server preview count; a stale preview invalidates confirmation and requires a fresh explicit decision. |
| Evolve | Fresh workspace without a greeting; frozen admission, known-run statuses, observation warning, interrupted/failed/completed exchanges and preserved next draft. Only canonical contributions, replies and saved developments are presented as recorded. Continuation and Open idea are different actions; latest eligible issued work is the default, with deliberate Change when applicable. Unknown observation retains last-confirmed display without silently retaining unconfirmed eligibility. |
| Conversational search | Entry and saved catalog; unopened session with explicit Resume; focused normal conversation/discoveries and separate user-only History. The UI includes labelled request-status, local submitted-snapshot, blocked-draft, unavailable-content and Delete-confirmation treatments. The selected handoff owns their contract-driven behavior; this row is not a final recovery/concurrency verification claim. |
| Export | Simple-only contextual setup, pending request and exact-byte preview/download; separate Exports catalog, New export and bookmarkable report detail. Loading/empty/read errors, bounded continuation, frozen unknown admission, Stop/settling, restored local-discard acknowledgment and separate Delete confirmation remain distinct. Completed status alone is not Report ready, and terminal run status alone is not deletion readiness. |
| Settings | Four optional additional-instruction fields and one Save changes action. Loading/read failure disables editing; saves keep fields editable and retain newer edits. Success confirms the saved snapshot; errors preserve drafts. A conflicting revision requires deliberate reload, with copy-before-reload guidance. No autosave or browser-persisted drafts. |

The [approved Settings references](../../.impeccable/mocks/settings/README.md)
use the existing Quiet Night system: divided label/field rows on desktop,
stacked fields on narrow screens and a gold Save changes action. The separately
approved notebook above adds decoration only; Settings adds no model/effort
controls or tool-permission controls.

Simple's current preview follows setup in document order. A newly confirmed Simple submission announces that Markdown is ready and focuses its programmatically focusable preview heading, scrolling it into view. Cached return and failed requests do not trigger that focus movement; an intervening action outside the Simple form is respected. Its snapshot caption identifies the request associated with the retained artifact separately from later field edits. Both export previews use the shared safe Markdown renderer: raw HTML is skipped, body links/images are inert, and separately resolved normal-scope source identities supply actual Idea links. Downloads preserve the returned bytes rather than recreating text or submitting another export. The user-facing copy is **Request** and **Report ready**.

### Explore Exports routes and lifecycle

The [approved composition and decisions](../../.impeccable/mocks/explore-exports/README.md) establish `/exports` catalog, `/exports/new` request form and `/exports/:runId` detail, separate from Simple-only `/export?thoughtId=…`. The bundled font, Quiet Night tokens and shared shell are unchanged; no new artwork, global destination, title editing or automatic resubmission is introduced. Completed catalog rows say Completed and offer Open report; only a successfully read Markdown artifact receives Report ready and Download Markdown in detail.

The current [daemon contract](../../docs/daemon-api.md#agentic-export) is forwarded through fixed-purpose, guarded Next routes. History and metadata are validated and projected to public fields, with bounded pages and opaque continuation cursors. Catalog continuation failure retains loaded entries; invalid continuation offers a fresh read. Active live work and unsettled interruption remain above History. Known detail metadata is rechecked on entry and while live work/settlement remains active; read failures preserve confirmed display but withdraw unverified Stop/Delete eligibility. A missing record does not fabricate an artifact or a replacement export.

New export uses a labelled multiline Request and native Quick / Standard / Thorough selector, default Standard. Submission freezes exact request/effort. Known refusal retains editable inputs; an unconfirmed admission retains a readonly copy and warns that it may have started, without inventing a run ID, Stop or an automatic retry. Leaving during admission does not cancel the admitted work or force navigation back when its response arrives. Unsent drafts do not gain cross-reload persistence.

`deletionState`, never the run status alone, owns deletion eligibility. Live Stop fences observation, sends one explicit same-ID command and rereads metadata. Stop requested/settling retains Check status and omits Delete. Restored snapshots never reconnect to the old agent: Stop opens the inline unchecked acknowledgment, Confirm local discard sends local Stop, and only a metadata-confirmed ready state exposes a separate Delete. Its status and dialog explicitly retain unknown remote work and deny remote cancellation/erasure claims.

Delete uses a native modal that identifies the request, focuses Cancel, returns focus to its stable trigger and prevents dismissal while the write is pending. A known conflict rereads the same metadata; unknown deletion retains the same identity and offers explicit Check deletion rather than a repeated write or invented success. Confirmed deletion, or an explicit same-ID check confirming absence after an ambiguous deletion, returns to the catalog. Local report/history/export-specific execution removal does not remove thoughts, downloaded files or provider history. These interaction descriptions are implementation contracts, not independent runtime or accessibility certification.

One context row renders each referenced thought once, in first-occurrence order: direct children, then connection neighbors, then provenance sources. Its relationship strips preserve every applicable role. Each recorded connection has its own rationale and reject/restore controls beside that relationship; the row has one Open idea action. The immediate parent remains a separate reference even when also present as a source or connection neighbor. A root has no invented parent. An unavailable parent is labelled unavailable, with deliberate inspection available from normal view, never an automatic broader read.

### Guided connection creation

The [selected guided B references](../../.impeccable/mocks/user-connections/README.md) place a secondary Connect action on Idea and an inline, single-column creation flow beneath its existing tools. Normal-scope search and actual-text preview select the other thought. Four existing categories, sentence-based direction, required rationale and optional additional source thoughts lead to a visible review summary and one explicit Create action. Source identities are existing thoughts, not preservation settings or verified endorsements.

The editor reuses Quiet Night tokens, readable native controls and the existing Idea tools. Drafts stay intact between wizard steps; refresh or leaving clears them. Cancel confirms discarding entered work, but no history interception or browser-storage recovery is added. Pending submissions prevent repeat activation. Unconfirmed writes retain a readonly, copyable snapshot while mounted and warn that creation may have completed, without automatic retry. Runtime and actual-client review remain separate from approval of the composition references.

### Markdown import workspace

`/import` opens selection or the current batch report; `/import?batchId=…` reopens a known report without starting another import. The header arrow returns to Capture. Choose files sends nothing, and individual Remove actions precede one explicit Import action. Recent imports replaces the selection/report grid and offers Back to selection or Back to report. Unsent files are not saved across reload; leaving does not stop admitted work. How import works stays open beside selection/report on desktop and becomes a native disclosure below it on narrow screens.

Inspect source / Inspect original opens a native modal only after deliberate activation. It focuses the Inspect original heading, shows the retained original as plain source text with user-inspection and unverified-authorship wording, and returns focus to the available trigger when closed. Read errors offer Check original. A mapped thought must pass a separate normal-scope read before Open idea and the report's thought sample appear; retained-source inspection does not broaden Idea eligibility or AI context. These descriptions record existing implementation, not new composition approval or runtime acceptance.

### Retained media import and source presentation

The approved [media workspace reference](../../.impeccable/mocks/media-import/b-selected-desktop.png) extends the existing Quiet Night system, not its visual vocabulary. Capture has one anchored Import chooser for Image or PDF and Markdown, with Escape/focus return and retained Capture drafts. `/import/media` stays under Capture navigation and returns through the contextual header arrow. Selected B places file details beside optional clarification on desktop and stacks them at the existing narrow breakpoint. Capture's desktop canopy remains on Capture only; Import and Idea gain no atmosphere or new artwork.

File selection sends nothing. Explicit upload freezes file, exact nonblank clarification and request key. Recovery distinguishes readonly original-key checks from deliberate identical resends, without automatic writes or cross-reload persistence. Confirmed retention is separate from interpretation completion; local file references are released after receipt confirmation. Status and errors use the existing worded feedback and accessible controls.

Media source Ideas have null thought text, a filename title fallback, MIME/size and unverified original authorship. User clarification is separate attributed content, not file text. The original is downloaded privately; its AI interpretation is a separate canonical child in Surrounding context. The source status region observes the latest non-title weave and daemon retry eligibility. Check reads; retry and known-run Stop are explicit writes. Saved output remains visible after processing failure. Rejected content is unavailable to AI; broader user inspection is explicit and labelled, with no silent scope widening.

Canonical Idea content has one publication owner shared by foreground loads and background output reconciliation. Source observation owns status, not children or Full reply. Confirmed mutations resume scoped observation after canonical publication; overlapping title or connection changes cannot consume unfulfilled output refresh intent or strand the page in loading. Background reads retain confirmed context on failure and do not reopen a closed Full reply.

Existing views retain their approved layouts. Explore distinguishes Imported Markdown from Images and PDFs, with source/interpretation results remaining separate. Evolve shows source details beside the ordinary contribution flow; Ask previews use recorded descriptors and clarification. Export shows a read-only source descriptor and resolves documented media citations without changing downloaded Markdown. Search, Ask and Agentic Export do not open original files. Desktop/narrow controlled browser checks are implementation evidence, not physical-device or accessibility certification.

### Conversational-search routes and composition

The [location helpers](src/features/agentic-search/location.ts) define bookmarkable `/explore/ask` entry, `/explore/ask/saved` catalog, `/explore/ask/:id` session and `/explore/ask/:id/history` inspection routes. Ordinary Explore retains its keyword form and separate **Ask your library** / **Saved searches** links; neither link nor page rendering creates a session or admits a turn. New search and Resume are explicit user actions. Browser requests use the existing fixed-purpose Next server boundary, never direct daemon access.

The [workspace view](src/components/agentic-search-view.tsx), [saved-session components](src/components/agentic-search-sessions.tsx), [conversation/discovery components](src/components/agentic-search-content.tsx) and [local CSS module](src/components/agentic-search.module.css) reuse the shared shell, bundled font and current tokens. The title switcher opens a headed session sheet; the bookmarkable catalog uses the same title/activity/Resume/Delete rows. The active title stays visible on narrow screens, with Edit title / Copy link / History / Delete reachable through **Session actions**. Copy link identifies the canonical session URL, not a starred/saved flag. Title editing is an inline labelled form, and Delete uses a native confirmation dialog explaining that library ideas stay.

Messages retain worded You/AI attribution and wrap as plain original text. Discoveries show actual thought attribution/kind and Why relevant separately from Preview, Open idea and Remove from search. Narrow discoveries follow the composer in a headed disclosure; they are not compressed into a side column. History uses the same reading language with **History · User-only**, a return link and no composer/Send. The [daemon contract](../../docs/daemon-api.md#agentic-search-sessions) governs normal/history scope separation, context-change recovery, occurrence removal/rediscovery and admission/Check/Stop; these rules do not introduce new visual assets or capabilities.

### Scoped visual evidence

Four actual built-Next captures received visual acceptance for the inspected composition: desktop workspace at 1440×900; narrow workspace at a 390×844 viewport with a 390×1108 full-page image; expanded narrow Session actions at 390×1180; and narrow History at 390×902. The observed layouts retain the shared header/title, readable inline composer, discoveries and noncomposing History without shrinking to the generated board.

This acceptance does **not** visually establish the session sheet/catalog, Delete dialog, AI reply/multiple discoveries, preview, unknown-admission or context-changed specimens. It is not physical-device, software-keyboard, contrast or accessibility certification. UI presence and these four captures also do not establish final read-recovery, polling/preview/reading-position or Stop-concurrency correctness; those require separate source and runtime checks.

### Recovery and state lifetime

**Browse list:** `/browse` opens the query-free catalog with newest first, You + AI + Imported source and normal visibility. Bookmarks use `sort=newest|oldest`, repeated `author=user|ai|source` and `scope=normal|show-rejected`; exclusive `author=none` preserves all three boxes unchecked. Omitted authors default to all three; explicit selections, including older You/AI-only links, retain their subset. Empty authors are a local empty selection, never the daemon's all-authors default, with the guidance “Select at least one authorship filter to show ideas.” Clear filters restores all three authors and hides rejected material while retaining sort. The closed Sort control shows the selected order; there is no relevance or shuffle option, count facet, or page-number navigation.

Imported source follows You and AI in the existing native-checkbox fieldset, with unchanged typography, colors, focus and 44px minimum row targets. The longer group grows the desktop panel naturally and may wrap the inspection/reset controls below it on narrow screens; text is not reduced to hold two columns. The existing cat follows the complete panel with its unchanged spacing and narrow-screen omission. This bounded extension reuses the approved Browse composition and the explicitly authorized default-on checkbox, not a new screen or visual vocabulary. Authorship filters apply only to the starting list, not map neighbors. Imported-source attribution remains unverified and distinct from You or AI.

The list uses the existing card mixture, title hierarchy, 20px material glyphs, worded You/AI/Imported source attribution and UTC creation dates. Excerpts are the first 160 actual characters, not summaries; untitled text uses its first five words. Show rejected adds explicit user-inspection wording and Rejected labels. Titles link to safely encoded `/browse/:id` destinations with an allowlisted list return URL.

The browser reads only `/api/browse/thoughts`; the existing guarded Next server uses server-only credentials to call the fixed daemon catalog. One page is requested at a time, with the same effective query and limit on continuation. An invalidated continuation offers Refresh list rather than automatic replay. Loaded rows are deduplicated in server order. Bare Browse navigation resumes the current document's filters, loaded rows and reading position; explicit URL filters take precedence. Reload starts the bookmarked filters on a fresh live first page, with no persisted content/cursor or snapshot promise. The selected comp is illustrative composition evidence, not runtime, keyboard or physical-device certification.

Browse controls and rows reflect the controller's accepted synchronous query. Consecutive filter changes merge with that latest query before publishing their bookmark URL, including the last-author-to-empty transition. An explicit browser `popstate` listener handles every history traversal, including an out-and-back that leaves the router hook's observed value unchanged. Mount and Next navigation call the same actual-location reconciliation before paint; router parameters only wake that reader and never independently supply query, validity or matching state. Traversals apply filters without adding history entries; URL normalization only replaces the current entry. Authorship, sort and inspection controls remain usable while reads or URL transitions are pending.

**Browse map:** `/browse/:id` bookmarks the starting thought, with optional `scope=show-rejected` and a validated list-only `returnTo`. It need not be an evolution root. First entry reads one bounded neighborhood through `/api/browse/thoughts/:id/neighborhood`. Activating an encountered node immediately selects its actual-text inspector and automatically reads one first page only if that node has not been attempted. Revisiting loaded, pending or failed nodes does not consume another page or silently retry. Load more linked ideas and Retry loading links explicitly request one continuation or repeat the failed read. No recursive expansion or automatic page draining is introduced. Nodes deduplicate globally while evolution, conceptual connections and every provenance occurrence retain distinct edge identities. Connection evidence is recorded metadata, not additional adjacency.

Node metadata says Explore links, Loading links…, More links, Links shown, No visible links, Retry links or Restart needed. The inspector places fuller feedback beneath Recorded relationships: loading retains existing rows; partial results warn that parent, child, source or connection links can remain on later pages; a final page says All direct links in this view are shown or No direct links in this view. Completion is scoped to that thought and current visibility, never the whole graph. Final states are text, not disabled gold success buttons. An invalid or stalled continuation retains confirmed content and offers Restart map with an explicit warning that it clears exploration. Unknown totals and per-type counts are not invented.

The starting pathname does not follow inspection. Within the mounted document, returning from Open Idea to the same starting thought/scope retains accumulated graph, inspected thought, presentation and camera. Reload reconstructs only the starting thought and one live page, not a serialized graph. A changed starting thought or scope clears graph, cursors, positions and inspection before the next read. Unavailable normal-scope roots offer deliberate Show rejected, never automatic widening. Idea mutations invalidate Browse map and list memory before unsafe content can reappear on return. Back to list restores its existing filters, loaded pages and reading position.

Connection creation invalidates Browse reads on both attempt and settlement, including an uncertain outcome and settlement after the editor unmounts. Navigation stays available while the write is pending. A mounted Browse workspace rereads after invalidation; this is read recovery, not a write retry or proof of creation. The editor's saved receipt and confirmed Idea-context refresh still require its mounted UI.

Initial entry frames the first neighborhood once. New nodes receive deterministic free positions around the expanded thought without moving existing nodes; selection and expansion do not fit or recenter. Fit map and Zoom in/out are explicit, with a worded reminder that additions can fall outside the current view. Arrow keys pan only while the Idea map region itself has focus; background pointer dragging is optional. Native Inspect and explore buttons expose full titles and pressed selection in both Map and Linked list, with exploration state in their accessible description. Focus alone does not load data. One polite result region names the affected thought and reports added ideas/relationships without taking focus or replacing a newer inspection. On narrow layouts the inspector follows the map/list rather than covering it. Read selected idea jumps to that focusable section from above the narrow map or after the selected Linked list row. Its Selected idea section shows actual immutable text or media details, creation/author/kind and a separate Open Idea link. These implementation rules do not establish physical-device, screen-reader or final runtime acceptance.

Evolution is cyan and solid, conceptual connection cream and dashed, and Used as a source blue and dotted, consistently in map and legend. Directional arrows accompany the map; reciprocal edges use a common endpoint orientation for distinct parallel curves without changing their recorded direction. Inline edge captions are omitted rather than hidden beneath node cards. The legend and written Recorded relationships rows carry the meaning: Developed from/into, Used as a source for this idea / This idea was used as a source for, and directional conceptual category with proposer and rationale. Parallel roles and repeated source positions remain separate rows; self-links remain recorded. These descriptions do not establish browser, physical-device or screen-reader acceptance of this revision.

Status is worded, not a percentage, invented ETA or model stream. A read failure is not proof that a run failed. Stop addresses the known run and requests cancellation; it does not guarantee an instant native stop. Neither an unknown admission nor an observation error automatically replays a write or guesses an ID.

Explore memory, Evolve workspaces and confirmed Simple/export-detail read memory can survive in-app browsing in the current document. Saved Agentic requests/history/reports are daemon-owned and reopened from canonical metadata; reopening or reloading never admits another investigation. Reload/fresh-document draft policies remain explicit, not an autosave or automatic retry guarantee. Capture retains its submitted snapshot in the current form's recovery state, not in persistent storage. Confirmed records and unsent drafts remain visually distinct.

## Do's and Don'ts

- **Do** use the complete existing palette and its documented mixtures through the current CSS variables; preserve the local font and license.
- **Do** keep original words focal and use worded You / AI attribution. Keep source attribution separate from endorsement.
- **Do** preserve reading order, visible keyboard focus, input values and safe long-text wrapping across narrow layouts.
- **Do** show only canonical confirmed success and label uncertainty plainly; keep browsing, continuation and destructive scope distinct.
- **Don't** copy tiny raster text, incidental generated header differences, decorative texture or invented italic emphasis into CSS.
- **Don't** add unrelated feeds, whole-library graphs, editable thought bodies, model/budget settings, unapproved navigation or Settings contents as a styling improvement. Browse's approved list and growing local map are explicit product additions, not permission for those features.
- **Don't** promote stale cached text into confirmed eligibility, silently broaden to rejected history, fabricate output or turn a read recovery action into a write retry.
- **Don't** treat this system description, approximate comps or a passing browser probe as screen-reader, physical-device, software-keyboard or cross-browser certification.
