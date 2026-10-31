---
name: Thoughtloom
description: A connected inquiry on Parchment, anchored by the unchanged original.
colors:
  night: "#031315"
  parchment: "#FEF6E1"
  lantern: "#EFB83F"
  horizon: "#5E8BD6"
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
    fontSize: "32px"
    fontWeight: 600
    lineHeight: 1.15
    letterSpacing: "-0.025em"
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
    fontSize: "23px"
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
    fontWeight: 600
    lineHeight: 1.2
  phone-inquiry-focus:
    fontFamily: "Source Sans 3, sans-serif"
    fontSize: "27px"
    fontWeight: 600
    lineHeight: 1.2
  compact-source-control:
    fontFamily: "Source Sans 3, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.4
rounded:
  control: "6px"
  reading-surface: "6px"
  original-band: "4px"
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

A Parchment thinking surface framed by compact Night navigation and an unchanged-original band. Actual formulations, your contributions, canonical responses and confirmed developing ideas lead; operational explanation recedes. Thin connectors express stored relationships and derivation, not an invented graph.

This records the current web presentation correction for capture, retrieval, contextual dialogue, protected revisions, background follow-up and agent status. Independent behavior and visual review are still required. The three retained inquiry-flow mockups guide composition and hierarchy, not raster coordinates or invented data. Agent execution still requires operator setup.

**Key Characteristics:**
- Flat, high-contrast reading surfaces.
- One task-oriented font family.
- Original words distinct from attributed hypotheses.
- Temporary search results and connected reading, not permanent note management.

## Colors

Primary action: **Lantern**, also used for the user-contribution outline and text selection. **Horizon** marks focus and AI claim outlines, not low-contrast small text. **Parchment** is the dominant thinking surface with **Night** text. The header and original band invert those neutrals and their supporting-text mixtures. No extra brand hues are introduced.

**The Source Distinction Rule.** Keep original text distinct from tentative AI formulations; color never replaces the author or status label.

No extra tonal scale is established by the implementation.

## Typography

Use Source Sans 3 throughout, including headings. The upright variable font is self-hosted with `next/font/local`; its [license and copy provenance](apps/web/app/fonts/README.md) are part of the project. No identity display face or emblem is adopted.

Frontmatter records reused roles, not an exhaustive scale. Capture/search headings are (36px), reducing to (30px) on phones. The actual pinned formulation is the inquiry heading, normally (32px), reducing to (27px) on phones. An original with existing readings uses a smaller (26px/23px) focal quote to leave room for those readings. Formulation nodes are (23px/21px). Metadata stays sentence case; timestamps use tabular numerals where styled.

## Layout

Capture and search use centered reading widths (820px maximum). A full-width Night header provides search and explicit Capture. Inquiry uses up to (1440px), with (32px) desktop gutters. The original is a horizontal Night anchor above the thinking area, not a sidebar. Its labelled excerpt is visually limited to two lines; the exact original, provenance and date remain available through native disclosure and the source URL.

The selected source, formulation or connection leads the thinking area. A saved contribution and canonical response form a connected pair; confirmed ideas branch beneath. An opened developing idea shows its original, available pinned earlier formulation and discussion-input derivation immediately beneath it. Related readings precede the first desktop composer, then follow the working exchange once a discussion or derived idea is open. A sticky desktop composer remains attached to the thinking surface. At (800px) relationship/exchange columns stack; at (600px) phone gutters are (20px), the composer stays in normal flow, and related readings follow it. The phone is a sequential reader, not a small draggable graph.

Search results exist only for a query. Back links retain that query. The inquiry groups original source, interpretations, and directed relationships with rationale/evidence; it is not a graph canvas, permanent all-notes list, or chat sidebar. These describe the built surfaces, not a pixel template for future screens.

## Elevation & Depth

Flat surfaces, neutral hairlines, spacing, and type create separation. There are no shadows, gradients, or decorative textures. Buttons transition background/text color over (140ms), with `ease-out`; reduced-motion mode removes transitions.

## Shapes

Controls and claim nodes use restrained corners and thin (1px) borders. Claim outlines distinguish actual content roles; they are not a dashboard-card system. Status icons are simple stroked SVGs, not identity marks. Notices retain their existing larger radius.

## Components

- **Actions:** Lantern-filled primary actions; outlined secondary actions invert on hover. Standard buttons have a minimum height of (48px); compact shell controls use (46px). Disabled actions retain legible text and a neutral border. Capture becomes read-only while saving and keeps its draft on failure.
- **Fields:** capture and composer have visible labels; compact shell search has a programmatic label and explicit Search button. Capture and dialogue text sit on Parchment; search stays on Night. Capture padding reduces to (18px) on phones. Search is a native GET form, not agentic search.
- **Focus and navigation:** a Horizon outline (3px, offset 5px), underlined links, and a keyboard-visible skip link. Do not add custom keyboard conventions. Query-return links remain real links.
- **Source and history:** native `details`/`summary` disclosures, exact source whitespace and stable source URLs. Evidence and version histories attach to claims; full connection endpoints are inspectable in context. Histories retain author, current/earlier versions, evidence, reversal controls and truncation. No invented version dates.
- **Attribution and feedback:** distinguish your original, AI interpretations, user formulations, tentative/active hypotheses, and rejected relationships in text. Search match origin is not connection evidence. Saving/queued notices use status semantics; failures use alerts with recovery. Queued does not mean a worker is running. There is no approval inbox.
- **Weaving status:** one shared, named region separates durable source saving, worker configuration/availability and job outcome. Quiet polling changes the status summary only when its content changes. Check status is read-only; retry appears only for eligible confirmed outcomes. Inquiry updates preserve source disclosures, stable reading keys and focus. The setup guide uses ordinary text, ordered steps and copyable commands, not a configuration editor.
- **Development:** the pinned formulation, your saved contribution, canonical AI reply and receipt-backed developing ideas form the working composition before the next composer. Empty exchange/idea reports are not rendered. Earlier exchanges use a native disclosure, not chat bubbles or a sidebar. AI prose alone never becomes an idea node. Long replies remain fully readable through expansion. Only deliberate target selection moves focus to the composer; polling never does. Stop requested is not a stopped/rolled-back claim. Correction/reversal remains beside the affected claim/history, with the same conflict behavior.
- **Background follow-up:** a subordinate status section follows the inquiry. Cause and exact affected versions use a disclosure; uncertainty, failure, eligible retry and explicit View findings remain visible. New findings enter the thinking area only through that View action. Command fencing, uncertainty handling, draft/focus preservation, truncation and zero-change completion are unchanged.

## Do's and Don'ts

- Do preserve the exact core palette and self-hosted task font.
- Do keep author, source, status, and evidence readable without spatial gestures.
- Do use familiar semantic controls within inquiry-centered navigation.
- Don't imply that saved, queued, tentative, active, and user-endorsed mean the same thing.
- Don't add a permanent notes list, chat sidebar, new logo, or literal textile/fantasy ornament.
- Don't imply an unconfigured worker is running or mistake agent prose for a durable change. Follow the retained mockups' composition without inventing their illustrative relationships, headlines or approval actions.

Implementation references: [global styles](apps/web/app/globals.css), [shell](apps/web/app/layout.tsx), [reading components](apps/web/app/ui/knowledge-reading.tsx), and [inquiry view](apps/web/app/sources/[id]/inquiry/page.tsx). `.impeccable/design.json` holds only extension metadata and small documentation specimens; it is not application code.
