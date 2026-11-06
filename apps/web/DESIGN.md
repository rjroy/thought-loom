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

This is an implementation-derived handoff for the `apps/web` workspace, not a replacement design proposal or an accessibility certification. The [approved screen/state handoff](../../.impeccable/README.md) and its [selection/palette manifest](../../.impeccable/selected-assets.json) retain visual authority, including explicit raster exceptions. Product and transport contracts remain in the repository's context and API documentation.

The **Focused B conversational-search client is implemented** alongside ordinary Explore. Its [selected reference handoff](../../.impeccable/mocks/agentic-search/README.md) remains the composition and behavior target; the generated PNGs are reference-only and are not imported into the application. This document records the implemented visual system, not final controller correctness or runtime acceptance.

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
| User / AI attribution | `brand-color-2` / `brand-color-13` | Explicit You / AI labels; never agreement or confidence |
| Confirmed success | `brand-color-10`, with `brand-color-2` boundary where used | Saved and Report ready feedback |
| Error / destructive action | `brand-color-9` | Field errors, rejected labels and explicit reject confirmation |
| Uncertainty / warning | `brand-color-3` or `brand-color-11` | Worded uncertainty and observation warnings |
| Surfaces | `--color-card`, `--color-input`, `--color-caption` | Distinct reading containers, editable fields and subordinate context strips |
| Text selection | `--color-selection` with focal text | Actual browser text selection |

The six non-master colors in the frontmatter are the implemented rounded sRGB mixtures. Their source percentages live in the manifest; do not replace them with unrelated dark neutrals. The manifest also retains a `card-line` mixture that is **not** a separately declared runtime token in this client.

**Color never supplies the whole meaning.** You / AI, Rejected / Status unknown, errors, run status and confirmation labels remain textual. Focal heading links use the text color and underline on hover rather than making an entire title cyan.

## Typography

Source Sans 3 supplies both reading and display roles. It is bundled through `next/font/local` from [the variable font](public/fonts/SourceSans3-VariableFont_wght.ttf), weight range 200–900, with [its OFL license](public/fonts/OFL.txt). The browser's generated family alias is not a second typeface. No network font service or separate decorative display face is used.

The body is 18px with 27px line height at the default root size. Secondary copy and metadata are generally 16px. Weight 600–700, not uppercase decoration, establishes hierarchy. Reserved is a small 12px noninteractive badge.

| Existing text role | Desktop | Narrow |
| --- | --- | --- |
| Capture / Evolve page heading | `2rem`, weight 700, line height 1.2 | Same |
| Idea title | `clamp(2rem, 2.75vw, 2.75rem)`, weight 700, line height 1.15 | `2rem` |
| Idea original words | `1.5rem`, line height 1.5, maximum 72ch | `1.25rem` |
| Explore result title | `1.5rem`, weight 650, line height 1.25 | Same; wraps naturally |
| Evolve contribution / reply | `1.375rem`, line height 1.5, maximum 72ch | `1.25rem` |
| Conversational-search session switcher / discovery title | `1.375rem`, weight 600, line height 1.35 / 1.25 | Same; wraps naturally |
| Conversational-search message | `1.25rem`, line height 1.5, maximum 72ch | Same |
| Export page heading | `2.75rem`, weight 700, line height 1.15 | `2.25rem` |
| Export method heading | `2rem`, line height 1.2 | `1.75rem` |

Explore has a visually hidden page heading and a visible search label on narrow screens. Most heading tracking is −0.02em; Export uses −0.025em for its page title. Thought text preserves whitespace and wraps long words rather than acquiring formatting from the generated comps. Counts use tabular numerals. Markdown code uses the browser's monospace fallback, not an additional brand font.

## Layout

The shell uses `--page-inset: clamp(1.25rem, 3.125vw, 3rem)`. Main content has 2rem top and 4rem bottom padding; narrow top padding is 1.75rem. Shared grouping gaps repeatedly use 0.5rem, 0.75rem, 1rem, 1.5rem and 2rem; these are existing literals, not a declared global spacing scale.

The desktop header has a minimum height of 4.625rem. At `max-width: 48rem`, the wordmark/tagline stack above the visible navigation row. Explore alone keeps the shared header sticky and adds scroll margins for its controls. There is no added hamburger destination or permanently fixed composer.

| Surface | Implemented composition | Narrow behavior |
| --- | --- | --- |
| Explore Compact | Full-width search above 15.875rem filter sidebar and fluid result column; 2rem column gap; close-spaced result cards with subordinate context strips | One column at 48rem; explicit Filters control with selected-value count, headed inline panel and Close filters; sort wraps above readable results |
| Capture Wide / Roomy | Left-aligned form at 87% of workspace width; generous writing field, secondary optional title; Save at the far right | Full width at 48rem; writing field minimum 15rem; full-width Save below title |
| Idea Rows | Focal thought with Evolve beside it and a separate visible immediate-parent title link when applicable; direct context rows group children, provenance and connection neighbors by thought ID; columns are title/author, actual text/relationships, Open idea | Single column at 48rem; full-width Evolve; parent link wraps; context and connection-specific actions flow below each thought |
| Evolve Rail | Starting-thought rail at `minmax(13rem, 24%)`, 2rem gap, chronological exchange column; saved developments in two columns; composer follows the conversation with Send beside the textarea | Starting context becomes a disclosure at 48rem; development rows stack; textarea and compact Send remain side by side |
| Conversational search: Focused B | Maximum 100rem workspace; contextual session switcher/actions above conversation left and discoveries right; `1.08fr / 1fr` columns with 1.75rem gap and a thin divider; no permanent session rail or forced blank conversation height | One column at 48rem; visible session title, explicit Session actions disclosure, conversation and inline composer followed by Discovered ideas disclosure; the contextual session sheet reuses saved-search rows |
| Export Columns | Equal method columns, 1.5rem gap, shared maximum width 100rem; run view uses a narrower request column and wider status/preview column | Methods and run views stack at 760px; primary actions fill the width; an additional 360px rule reduces container padding |

Reading containers generally stop at 65–75ch; original text and retained replies wrap rather than create horizontal page scrolling. The page may be substantially taller than a phone comp. Narrow comps were approximate hierarchy studies, not literal viewport or keyboard canvases. Native form controls and clear labels take precedence over shrinking the raster's contents into one frame.

## Elevation & Depth

Depth comes from tonal surfaces and thin boundaries, not decorative shadows, textures or glass. Cards use the card mixture; fields recede to the input mixture; recorded relationships use the caption mixture. The native Idea confirmation dialog uses a ground-colored panel and an 80%-opaque ground-colored backdrop.

The global keyboard ring is a 3px solid focus outline, separated by 5px. Header navigation brings the outline inward by 6px so it remains visible against the viewport edge. Focus is not a glow or a persistent selected state. There are no authored entrance animations or animated progress effects in this implementation; do not document them as existing behavior.

## Shapes

Reading surfaces, details and dialogs use gently rounded 12px corners. Most Capture/Explore/Idea/Evolve controls use 8px; compact fields and Export controls use 6px. Badges use 4px. Borders are 1px. These are deliberate local variants in current CSS, not a single shared button component API.

Search, back and disclosure icons are simple SVG geometry, with a consistent thin stroke where authored. Native details markers remain native. The approved cream/gold glyph family in `public/glyphs/` includes the exact lantern/sprout pair from the [approved SVG source packet](../../.impeccable/candidates/glyphs/production/corrected/README.md) and the [nine approved content/relationship assets](../../.impeccable/candidates/glyphs/content-family/production/README.md). All runtime files are byte-identical copies of their approved production sources. The sprout's separated gold leaf is explicitly accepted; do not redraw or reconnect it. The two approved relationship PNGs retain their accepted shading; do not substitute the rejected relationship SVG attempts.

The lantern and sprout occupy 24px squares with 8px heading gaps and no extra row. The lantern precedes **Find your recorded thinking** only in Explore's unvalidated initial state; it is absent during query validation, invalid links, loading, results, no results and read errors. The sprout precedes the existing **Capture** heading across its states, with Import still at the right. Their accepted behavior remains unchanged.

Content glyphs accompany existing material words, not You/AI attribution: Original capture, Contribution, Interpretation, Developing idea and Imported source use their actual recorded kind. List/context/Evolve records use 20px squares with 8px label gaps; the focused Idea uses 24px. A Full reply record uses its own 20px cue instead of a competing material icon, retaining material wording where already present. Evolve's confirmed contribution and retained reply now explicitly name their material/record role beside unchanged attribution. Unknown/unavailable records receive no invented kind.

Persisted relationship words use 16px companions with 6px internal gaps: Evolution for existing Developed from parent/child labels; the linked pair for discovered connections; page→arrow→leaf for Used as a source. Written category, direction and rationale remain authoritative. A known relationship may remain visible when its other thought is unavailable; no material kind is fabricated for it. Evolve's future **Continuing from** choice is not decorated as already-recorded ancestry. At 16px the source cue remains label-dependent.

All glyphs are noninteractive images with empty alternatives and `aria-hidden`, no focus stop or new accessible name. `content-glyph.tsx` restricts asset/size choices and serves exact unoptimized URLs, eagerly loading these repeated small cues rather than leaving off-screen rows without their visual hints. Layouts, controls, palette and state colors remain intact. “Restrained” describes the simple graphic appearance, not a sparse-usage ceiling. This approved vocabulary does not authorize unrelated artwork, author/status icons or decoration in navigation, Export, Import or feedback. Illustrations, graphs and avatars remain excluded. [Controlled in-app evidence](../../.impeccable/candidates/glyphs/content-family/integration-review/README.md) records independent verification, review and user runtime acceptance.

## Components

### Shared navigation and keyboard access

- A visible-on-focus Skip to content link targets the focusable main landmark. Main navigation is labelled; Explore remains selected for its `/explore/ask` subtree, and Capture includes its contextual Import route. No search destination is added to global navigation.
- Settings Reserved is disabled, noninteractive text, not a defined settings screen. Idea, Evolve, Export and conversational search remain contextual routes; none is a third primary navigation link.
- Contextual route return is a single left-arrow link beside the wordmark, with a 44px target, blue keyboard focus and a destination-named hover/focus tooltip. It uses the existing header row rather than a separate content row on desktop or narrow screens. Idea prefers the known previous viewed thought, otherwise its validated Explore or search-session/history return destination; this is not blind browser Back. Conversational-search entry/catalog/session views return to the known Explore destination (otherwise `/explore`), and search History returns to its session. Evolve returns to its selected Idea (or Explore for an invalid link); Export returns only when its root is known. Ordinary Explore and Capture have no contextual arrow. Route-owned registration is cleared on unmount without clearing a newer route's entry. Immediate-parent navigation remains separate, and Export's Back to setup remains a content-stage action.
- Links are ordinary links, including encoded canonical Idea IDs. Explore search/filter/sort/scope parameters support fresh bookmarks; valid result-return links preserve exploration intent. Evolve and Export roots use `thoughtId` in the URL.
- Main action targets are generally 44–48px or taller. Narrow filter labels are 44px high; primary navigation links are at least 56px high, while the contextual Back arrow has its own 44px target. Text is not made smaller to force controls onto one line.

### Buttons, fields and disclosures

Gold marks the principal action; dark outlined controls are secondary; cyan underlined text actions open details or navigate. Destructive confirmation uses the error accent **and** an explicit Reject label. Disabled treatments differ locally: muted filled controls in Capture/Export, opacity in Idea/Evolve. They must not be mistaken for confirmed success.

Fields keep real labels, input text colors and visible focus. Errors sit beside their field and use `aria-invalid` / `aria-describedby` where implemented. Textareas resize vertically. Pending or uncertain submissions retain copyable words; readonly and disabled controls are not interchangeable.

By explicit user choice, Evolve's labelled multiline contribution field and Send share one row at desktop and narrow widths, rather than the older comps' stacked narrow arrangement. Send aligns with the bottom of the textarea without stretching to its height; keyboard order is textarea then Send. Empty or whitespace-only drafts keep Send disabled without the redundant enable-Send instruction. Genuine submitted-snapshot, paused-run and nonempty-draft guidance appears below the row and remains associated with the field when present.

Conversational search follows the same inline shape with a persistent **Your message** label, vertically resizable textarea (7rem minimum height), bottom-aligned Send and no enable-Send helper. Its labelled **Effort** select offers Quick / Standard / Thorough, with Standard as default. Empty/whitespace-only drafts disable Send. Search buttons use the existing gold/outlined/disabled treatments; Edit title, Copy link and History are underlined text actions, while Delete and Remove from search use worded coral text. Session title and message text are not reduced to fit the narrow raster.

Explore Filters, Idea More actions and Evolve Change are nonmodal disclosures using ordinary controls, not ARIA menus. Escape handling is scoped to the open disclosure; focus returns to its trigger. Idea More actions dismisses on outside pointer interaction without taking focus away from the clicked control. Native Idea confirmation dialogs focus Cancel, contain the modal interaction, and return focus to the stable trigger when closed. Pending writes cannot be cancelled by merely closing a dialog.

Idea's **About** button shares the existing Edit title / Full reply / More actions row, with a minimum 44px target and visible keyboard focus. Enter or Space toggles its expanded state while focus stays on the button. Its controlled metadata block appears below the action row and contains only Created (UTC), Origin, Title by and Idea ID. When closed it occupies no separate content row; the actions may wrap on narrow screens.

The four Idea action-row buttons use cyan `--color-link` text with a 1px underline at rest. Enabled hover changes to cream `--color-text` with a 2px underline; pressing uses the same cream with a 3px underline. These treatments do not change dimensions or spacing. The existing blue keyboard focus ring remains, and disabled controls keep their existing reduced opacity without hover or pressed enhancement. Evolve retains its gold primary treatment.

### Screen patterns and states

| Surface | Current states and interaction pattern |
| --- | --- |
| Capture | Editing/required-text validation → Saving with retained readonly snapshot → canonical Saved receipt, Open idea and Capture another thought. Known not-saved retains editable fields for Retry save. Unknown outcome retains its original readonly snapshot, warns of duplication and requires deliberate Save another copy. No cross-reload or autosave promise. |
| Explore | Query-first initial, loading with unknown facet counts, successful results, no results and request error with Retry search. Author/kind facets use server counts; selected Filters count counts chosen values, not matches. Actual matching text expands in place; a retained-response hit is labelled Full reply. Inclusive rejected inspection distinguishes Rejected, active and Status unknown without guessing. Search remains available while a read is pending so a newer submitted query can supersede it. |
| Idea | Loading, read failure/unavailable, ordinary view and explicitly labelled user inspection. Edit/Clear changes title metadata only. The immediate parent's current title or first-five-word fallback is a visible link, never a History disclosure or ancestor walk. Direct children (including AI interpretations), provenance sources and discovered connection neighbors appear immediately in Surrounding context, without an overlapping Sources panel. Full reply, About and each connection's Why connected remain on demand. Individual/branch/connection actions remain separate. Branch confirmation uses the server preview count; a stale preview invalidates confirmation and requires a fresh explicit decision. |
| Evolve | Fresh workspace without a greeting; frozen admission, known-run statuses, observation warning, interrupted/failed/completed exchanges and preserved next draft. Only canonical contributions, replies and saved developments are presented as recorded. Continuation and Open idea are different actions; latest eligible issued work is the default, with deliberate Change when applicable. Unknown observation retains last-confirmed display without silently retaining unconfirmed eligibility. |
| Conversational search | Entry and saved catalog; unopened session with explicit Resume; focused normal conversation/discoveries and separate user-only History. The UI includes labelled request-status, local submitted-snapshot, blocked-draft, unavailable-content and Delete-confirmation treatments. The selected handoff owns their contract-driven behavior; this row is not a final recovery/concurrency verification claim. |
| Export | Independent method validation, pending Simple export, actual Markdown preview/download, not-started Agentic request, unconfirmed admission, known run/status, interrupted/failed without invented output, report-not-yet-readable and Report ready. Completed status alone is insufficient. Back to setup retains inputs and a known run reference without resubmission. |

Simple's current preview follows the setup methods in document order. A newly confirmed Simple submission announces that Markdown is ready and focuses its programmatically focusable preview heading, scrolling it into view. Cached return, failed requests and Agentic observations do not trigger that focus movement; an intervening action outside the Simple form is respected. Its snapshot caption identifies the request associated with the retained artifact separately from later field edits. Both export previews use the shared safe Markdown renderer: raw HTML is skipped, body links/images are inert, and separately resolved normal-scope source identities supply actual Idea links. Downloads preserve the returned bytes rather than recreating text or submitting another export. The user-facing copy is **Request** and **Report ready**.

One context row renders each referenced thought once, in first-occurrence order: direct children, then connection neighbors, then provenance sources. Its relationship strips preserve every applicable role. Each recorded connection has its own rationale and reject/restore controls beside that relationship; the row has one Open idea action. The immediate parent remains a separate reference even when also present as a source or connection neighbor. A root has no invented parent. An unavailable parent is labelled unavailable, with deliberate inspection available from normal view, never an automatic broader read.

### Conversational-search routes and composition

The [location helpers](src/features/agentic-search/location.ts) define bookmarkable `/explore/ask` entry, `/explore/ask/saved` catalog, `/explore/ask/:id` session and `/explore/ask/:id/history` inspection routes. Ordinary Explore retains its keyword form and separate **Ask your library** / **Saved searches** links; neither link nor page rendering creates a session or admits a turn. New search and Resume are explicit user actions. Browser requests use the existing fixed-purpose Next server boundary, never direct daemon access.

The [workspace view](src/components/agentic-search-view.tsx), [saved-session components](src/components/agentic-search-sessions.tsx), [conversation/discovery components](src/components/agentic-search-content.tsx) and [local CSS module](src/components/agentic-search.module.css) reuse the shared shell, bundled font and current tokens. The title switcher opens a headed session sheet; the bookmarkable catalog uses the same title/activity/Resume/Delete rows. The active title stays visible on narrow screens, with Edit title / Copy link / History / Delete reachable through **Session actions**. Copy link identifies the canonical session URL, not a starred/saved flag. Title editing is an inline labelled form, and Delete uses a native confirmation dialog explaining that library ideas stay.

Messages retain worded You/AI attribution and wrap as plain original text. Discoveries show actual thought attribution/kind and Why relevant separately from Preview, Open idea and Remove from search. Narrow discoveries follow the composer in a headed disclosure; they are not compressed into a side column. History uses the same reading language with **History · User-only**, a return link and no composer/Send. The [approved behavior handoff](../../.impeccable/mocks/agentic-search/README.md#state-and-behavior-handoff) remains authoritative for normal/history scope separation, context-change recovery, occurrence removal/rediscovery and honest admission/Check/Stop states; those rules do not introduce new visual assets or capabilities.

### Scoped visual evidence

Four actual built-Next captures received visual acceptance for the inspected composition: desktop workspace at 1440×900; narrow workspace at a 390×844 viewport with a 390×1108 full-page image; expanded narrow Session actions at 390×1180; and narrow History at 390×902. The observed layouts retain the shared header/title, readable inline composer, discoveries and noncomposing History without shrinking to the generated board.

This acceptance does **not** visually establish the session sheet/catalog, Delete dialog, AI reply/multiple discoveries, preview, unknown-admission or context-changed specimens. It is not physical-device, software-keyboard, contrast or accessibility certification. UI presence and these four captures also do not establish final read-recovery, polling/preview/reading-position or Stop-concurrency correctness; those require separate source and runtime checks.

### Recovery and state lifetime

Status is worded, not a percentage, invented ETA or model stream. A read failure is not proof that a run failed. Stop addresses the known run and requests cancellation; it does not guarantee an instant native stop. Neither an unknown admission nor an observation error automatically replays a write or guesses an ID.

Explore memory and mounted Evolve/Export workspaces can survive in-app browsing in the current document. Reload/fresh-document policies are explicit; they are not persistence, automatic resume or background-queue guarantees. Capture retains its submitted snapshot in the current form's recovery state, not in persistent storage. Confirmed records and unsent drafts remain visually distinct.

## Do's and Don'ts

- **Do** use the complete existing palette and its documented mixtures through the current CSS variables; preserve the local font and license.
- **Do** keep original words focal and use worded You / AI attribution. Keep source attribution separate from endorsement.
- **Do** preserve reading order, visible keyboard focus, input values and safe long-text wrapping across narrow layouts.
- **Do** show only canonical confirmed success and label uncertainty plainly; keep browsing, continuation and destructive scope distinct.
- **Don't** copy tiny raster text, incidental generated header differences, decorative texture or invented italic emphasis into CSS.
- **Don't** add a feed, graph, editable thought body, model/budget settings, extra shared navigation or Settings contents as a styling improvement.
- **Don't** promote stale cached text into confirmed eligibility, silently broaden to rejected history, fabricate output or turn a read recovery action into a write retry.
- **Don't** treat this system description, approximate comps or a passing browser probe as screen-reader, physical-device, software-keyboard or cross-browser certification.
