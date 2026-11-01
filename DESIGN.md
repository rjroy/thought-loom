---
name: Thoughtloom
description: A connected inquiry on Parchment, anchored by the unchanged original.
colors:
  night: "#031315"
  parchment: "#FEF6E1"
  lantern: "#EFB83F"
  horizon: "#5E8BD6"
  ai-surface: "color-mix(in srgb, #5E8BD6 24%, #FEF6E1)"
  user-surface: "color-mix(in srgb, #EFB83F 38%, #FEF6E1)"
  supporting: "color-mix(in srgb, #031315 76%, #FEF6E1)"
  line: "color-mix(in srgb, #031315 30%, #FEF6E1)"
typography:
  page-title-max:
    fontFamily: "Source Sans 3, sans-serif"
    fontSize: "36px"
    fontWeight: 600
    lineHeight: 1.15
    letterSpacing: "-0.025em"
  inquiry-title:
    fontFamily: "Source Sans 3, sans-serif"
    fontSize: "22px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "normal"
  phone-title:
    fontFamily: "Source Sans 3, sans-serif"
    fontSize: "30px"
    fontWeight: 600
    lineHeight: 1.15
    letterSpacing: "-0.025em"
  app-name:
    fontFamily: "Source Sans 3, sans-serif"
    fontSize: "25px"
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: "-0.025em"
  section-title:
    fontFamily: "Source Sans 3, sans-serif"
    fontSize: "21px"
    fontWeight: 600
    lineHeight: 1.3
  body:
    fontFamily: "Source Sans 3, sans-serif"
    fontSize: "18px"
    fontWeight: 400
    lineHeight: 1.5
  source-reading:
    fontFamily: "Source Sans 3, sans-serif"
    fontSize: "19px"
    fontWeight: 400
    lineHeight: 1.6
  capture-text:
    fontFamily: "Source Sans 3, sans-serif"
    fontSize: "20px"
    fontWeight: 400
    lineHeight: 1.6
  formulation:
    fontFamily: "Source Sans 3, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.45
  control:
    fontFamily: "Source Sans 3, sans-serif"
    fontSize: "18px"
    fontWeight: 600
    lineHeight: 1.25
  metadata:
    fontFamily: "Source Sans 3, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.5
  supporting-copy:
    fontFamily: "Source Sans 3, sans-serif"
    fontSize: "17px"
    fontWeight: 400
    lineHeight: 1.5
  field-help:
    fontFamily: "Source Sans 3, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.5
  history-meta:
    fontFamily: "Source Sans 3, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  original-focus:
    fontFamily: "Source Sans 3, sans-serif"
    fontSize: "26px"
    fontWeight: 400
    lineHeight: 1.35
  phone-inquiry-focus:
    fontFamily: "Source Sans 3, sans-serif"
    fontSize: "18px"
    fontWeight: 400
    lineHeight: 1.5
  source-document-phone:
    fontFamily: "Source Sans 3, sans-serif"
    fontSize: "23px"
    fontWeight: 400
    lineHeight: 1.35
  compact-source-control:
    fontFamily: "Source Sans 3, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.4
rounded:
  control: "6px"
  reading-surface: "6px"
  original-band: "6px"
  notice: "12px"
spacing:
  tight: "8px"
  compact: "12px"
  group: "16px"
  phone-gutter: "20px"
  section-inset: "24px"
  section-gap: "36px"
components:
  button-primary:
    backgroundColor: "{colors.lantern}"
    textColor: "{colors.night}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "11px 22px"
  button-primary-hover:
    backgroundColor: "{colors.night}"
    textColor: "{colors.parchment}"
  button-primary-active:
    backgroundColor: "{colors.horizon}"
    textColor: "{colors.night}"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.night}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "11px 22px"
  capture-field:
    backgroundColor: "{colors.parchment}"
    textColor: "{colors.night}"
    rounded: "{rounded.reading-surface}"
    padding: "24px"
  search-field:
    backgroundColor: "{colors.night}"
    textColor: "{colors.parchment}"
    rounded: "{rounded.control}"
    padding: "9px 12px"
  query-return:
    textColor: "{colors.supporting}"
    typography: "{typography.body}"
  source-disclosure:
    textColor: "{colors.parchment}"
    typography: "{typography.body}"
---

# Design System: Thoughtloom

## Overview

**Creative North Star: "A thought, challenged and developed."**

A Parchment thinking surface framed by compact Night navigation and an unchanged-original band. Actual formulations, your contributions, canonical responses and confirmed developing ideas lead; operational explanation recedes. Directed connectors express stored relationships and derivation, not an invented graph.

This records the current web presentation correction for capture, retrieval, contextual dialogue, protected revisions, background follow-up and agent status. Independent behavior and visual review are still required. The three retained inquiry-flow mockups guide composition and hierarchy, not raster coordinates or invented data. Agent execution still requires operator setup.

**Key Characteristics:**
- Flat, high-contrast reading surfaces.
- One task-oriented font family.
- Original words distinct from attributed hypotheses.
- Temporary search results and connected reading, not permanent note management.

## Colors

Primary action: **Lantern**, also used for text selection. **Parchment** is the dominant thinking surface with **Night** text. Original words use **Night** with Parchment ink; AI readings use a 24% Horizon/Parchment tint; user contributions and user-authored formulations use a 38% Lantern/Parchment tint; AI developing ideas use solid **Horizon** with Night ink. Agent response stays on Parchment with a conversational heading and hairline, rather than masquerading as another saved thought. Supporting text mixes each surface's own ink and fill. The exact pinned author controls a selected formulation's color, not a newer revision's author. **Horizon** also marks keyboard focus. No extra brand hues are introduced.

**The Source Distinction Rule.** Keep original text distinct from tentative AI formulations; color never replaces the author or status label.

These two surface tints are role colors, not an additional general-purpose tonal scale.

## Typography

Use Source Sans 3 throughout, including headings. The upright variable font is self-hosted with `next/font/local`; its [license and copy provenance](apps/web/app/fonts/README.md) are part of the project. No identity display face or emblem is adopted.

Frontmatter records reused roles, not an exhaustive scale. Search headings are (36px), reducing to (30px) on phones; capture starts directly with its text field, without a visible heading or introductory assurance. Thoughts share a left-aligned family, with hierarchy following placement rather than author. Compact cards are title-led: a prominent (20px semibold) stored title, otherwise the first up to five whitespace-normalized words of the represented body, preserving punctuation. This fallback is display-only, never a persisted or AI-authored title. An optional one-line body preview is subordinate (16px); attribution and contextual controls use (13px) text with existing touch targets. Inquiry focal and overview cards use the same title-led order at (22px semibold), above un-clamped (18px) reading text; exact long text retains its existing disclosure. The unchanged standalone source-document body scale is (26px/23px). The actual pinned formulation remains the semantic inquiry heading. Metadata stays sentence case; timestamps use tabular numerals where styled.

## Layout

Capture and search use centered reading widths (820px maximum). A full-width Night header provides search and explicit Capture. Inquiry uses up to (1440px), with (32px) desktop gutters. The original is a compact, title-led Night anchor above the thinking area, not a sidebar. It omits the repeated body preview; the exact original, provenance and date remain available through native disclosure and the source URL.

Capture has one temporary springboard below the form: up to two recent and two random thoughts, in two columns on desktop and one on phones. Each real link has a prominent one-line stored title, otherwise a five-word excerpt fallback; its accessible name includes the full display label. Stored titles reveal their complete text on keyboard focus and hover, with Escape dismissal and viewport-aware CSS anchoring. Actual source/formulation authorship determines the existing role fill independently of title authorship; Recent and Random are factual sampling labels. No arrows imply relationships between sampled cards, and unknown legacy dates are not displayed as invented dates. One combined batch loads once per visit, disappears on nonempty input, and returns unchanged on clear; saving or an acknowledged navigation keeps it hidden. Scarce collections show fewer cards without duplicates; empty results omit the group. A compact retry handles unavailable reads independently of capture. Item links carry the sampled formulation version and focus its exact discussion target, including historical versions beyond the ordinary neighborhood window.

Title editing is contextual to the represented original, reading or idea inside inquiry, never a capture field or card toolbar. The original band owns Edit original title even when an AI reading leads the overview. A short inline field uses Save title and Cancel; conflict and unconfirmed-save states retain its target and draft. Title authorship appears only while editing. Titles label cards, search headings and compact thought references without replacing immutable originals, pinned formulations, evidence or body attribution. User labels persist across formulation changes; generated labels are used only for the formulation they describe. This checkpoint supports manual labels and display of stored metadata, not new agent title generation.

The selected source, formulation or connection leads the thinking area. A saved contribution and canonical response form a connected pair; confirmed ideas branch beneath their originating contribution. On phones that contribution and its confirmed ideas precede the canonical reply, without a misleading idea-to-reply arrow. An opened developing idea shows its original, available pinned earlier formulation and discussion-input derivation immediately beneath it. Related readings precede the first desktop composer, then follow the working exchange once a discussion or derived idea is open. A sticky desktop composer remains attached to the thinking surface. At (800px) relationship/exchange columns stack; at (600px) phone gutters are (20px), the composer stays in normal flow, and related readings follow it. The phone is a sequential reader, not a small draggable graph.

Arrowheads make direction visible: typed relationships connect their actual From/To endpoints; source-to-reading routes require recorded source evidence; a discussion target connects to its saved contribution; contribution-to-idea branches require the exact matching dialogue, turn and input-source derivation. Opened-idea provenance converges from its recorded origins, never from one origin card into another. Source-to-reading arrows are omitted when an actionable worker-status block intervenes. SVG/CSS routes use the same semantic DOM layout anchors on desktop and phone, with no measurement layer or canvas. Connectors are decorative, non-focusable and pointer-transparent; endpoint text, relation labels, evidence and links remain the nonspatial interface. No arrows appear for an unannotated original.

Search results exist only for a query. Back links retain that query. The inquiry groups original source, interpretations, and directed relationships with rationale/evidence; it is not a graph canvas, permanent all-notes list, or chat sidebar. These describe the built surfaces, not a pixel template for future screens.

## Elevation & Depth

Flat surfaces, neutral hairlines, spacing, and type create separation. There are no shadows, gradients, or decorative textures. Buttons transition background/text color over (140ms), with `ease-out`; reduced-motion mode removes transitions.

## Shapes

Controls and claim nodes use restrained corners and thin (1px) borders. Filled claim surfaces distinguish actual content roles; they are not a dashboard-card system. Directed paths use Night strokes and visible arrowheads. Status icons are simple stroked SVGs, not identity marks. Notices retain their existing larger radius.

## Components

- **Thought reading:** `ThoughtContent` shares title/body/metadata/actions order without owning domain state, including inquiry focal targets and overview readings. Original sources, AI interpretations, saved user contributions and confirmed developed thoughts retain their existing semantic containers and exact identities. Titles lead both compact and focal cards; compact previews recede while focal formulations remain fully available. Five-word labels use the exact represented version, never a different pinned/current formulation; discussion-input labels do not create standalone title records. Focal source labels share the existing source title state without duplicating its original-band editor. Item editors keep their exact pinned target, commands and recovery state. Connections retain their relation rationale and endpoints without an invented thought title. Full source documents retain the complete body. Agent response remains a separate conversational surface, not a durable thought or a second idea feed.
- **Inline full text:** clipped compact readings, relationship endpoints, saved inputs and confirmed ideas offer Read full text / Show less in place, preserving their exact body, label and discussion target. The same keyboard-operable button keeps focus as it toggles; short, unclipped loaded text needs no control. Springboard disclosures sit outside the navigation link and reveal the full stored title and body without opening the thought. They fetch only the immutable source or exact sampled formulation on demand, retain successful text for that mounted card, and offer Loading text… / Full text unavailable. / Retry full text. Collapsing a pending read or leaving the card cancels it; late results cannot change another version. Disclosure reads never merge inquiry metadata or staged findings. Expanded cards do not stretch their collapsed neighbors. Search source excerpts, evidence references (including history and follow-up evidence), and originating-input references use the same exact-source read: the complete body replaces the excerpt rather than repeating it, while the existing navigation link remains separate and accessible. Search item formulations are already complete and need no additional read. This does not retrieve omitted records/history or recover shortened live previews.
- **Actions:** Lantern-filled primary actions; outlined secondary actions invert on hover. Standard buttons have a minimum height of (48px); compact shell controls use (46px). Disabled actions retain legible text and a neutral border. Capture becomes read-only while saving and keeps its draft on failure.
- **Fields:** capture has a programmatic Your thought label; the composer has a visible label. Capture keeps relevant draft/save/error feedback without redundant introductory copy. Compact shell search has a programmatic label and explicit Search button. Capture and dialogue text sit on Parchment; search stays on Night. Capture padding reduces to (18px) on phones. Search is a native GET form, not agentic search.
- **Focus and navigation:** a Horizon outline (3px, offset 5px), switching to Night for controls within colored claim surfaces; underlined links and a keyboard-visible skip link. Do not add custom keyboard conventions. Query-return links remain real links.
- **Source and history:** native `details`/`summary` disclosures, exact source whitespace and stable source URLs. Evidence and version histories attach to claims; full connection endpoints are inspectable in context. Histories retain author, current/earlier versions, evidence, reversal controls and truncation. No invented version dates.
- **Attribution and feedback:** distinguish your original, AI interpretations, user formulations, tentative/active hypotheses, and rejected relationships in text. Search match origin is not connection evidence. Saving/queued notices use status semantics; failures use alerts with recovery. Queued does not mean a worker is running. There is no approval inbox.
- **Weaving status:** one shared, named region separates durable source saving, worker configuration/availability and job outcome. Quiet polling changes the status summary only when its content changes. Check status is read-only; retry appears only for eligible confirmed outcomes. Inquiry updates preserve source disclosures, stable reading keys and focus. The setup guide uses ordinary text, ordered steps and copyable commands, not a configuration editor.
- **Development:** the pinned formulation, your saved contribution, canonical AI reply and receipt-backed developing ideas form the working composition before the next composer. Empty exchange/idea reports are not rendered. Earlier exchanges use a native disclosure, not chat bubbles or a sidebar. AI prose alone never becomes an idea node. Long replies remain fully readable through expansion. Only deliberate target selection moves focus to the composer; polling never does. Stop requested is not a stopped/rolled-back claim. Correction/reversal remains beside the affected claim/history, with the same conflict behavior.
- **Live response:** a saved turn has one stable Agent response surface. Ordinary live text is labelled Preview, with an explicit shortened indicator when bounded. Canonical text replaces that preview, including an empty final reply; transient text is not saved history. Progress and existing Stop/Check controls stay with the saved input before arriving ideas, with a manual View response anchor. No automatic scrolling or token-by-token live announcements; only state transitions use polite status semantics.
- **Background follow-up:** a subordinate status section follows the inquiry. Cause and exact affected versions use a disclosure; uncertainty, failure, eligible retry and explicit View findings remain visible. New findings enter the thinking area only through that View action. Command fencing, uncertainty handling, draft/focus preservation, truncation and zero-change completion are unchanged.

## Do's and Don'ts

- Do preserve the exact core palette and self-hosted task font.
- Do keep author, source, status, and evidence readable without spatial gestures.
- Do use familiar semantic controls within inquiry-centered navigation.
- Don't imply that saved, queued, tentative, active, and user-endorsed mean the same thing.
- Don't add a permanent notes list, chat sidebar, new logo, or literal textile/fantasy ornament.
- Don't imply an unconfigured worker is running or mistake agent prose for a durable change. Follow the retained mockups' composition without inventing their illustrative relationships, headlines or approval actions.

Implementation references: [global styles](apps/web/app/globals.css), [shell](apps/web/app/layout.tsx), [reading components](apps/web/app/ui/knowledge-reading.tsx), and [inquiry view](apps/web/app/sources/[id]/inquiry/page.tsx). `.impeccable/design.json` holds only extension metadata and small documentation specimens; it is not application code.
