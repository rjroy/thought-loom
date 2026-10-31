---
name: Thoughtloom
description: Flat, source-preserving capture and inquiry reading.
colors:
  night: "#031315"
  parchment: "#FEF6E1"
  lantern: "#EFB83F"
  horizon: "#5E8BD6"
  supporting: "color-mix(in srgb, #FEF6E1 76%, #031315)"
  line: "color-mix(in srgb, #FEF6E1 30%, #031315)"
typography:
  page-title-max:
    fontFamily: "Source Sans 3, sans-serif"
    fontSize: "44px"
    fontWeight: 600
    lineHeight: 1.15
    letterSpacing: "-0.025em"
  inquiry-title:
    fontFamily: "Source Sans 3, sans-serif"
    fontSize: "38px"
    fontWeight: 600
    lineHeight: 1.15
    letterSpacing: "-0.025em"
  phone-title:
    fontFamily: "Source Sans 3, sans-serif"
    fontSize: "32px"
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
rounded:
  control: "6px"
  reading-surface: "12px"
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
    backgroundColor: "{colors.parchment}"
    textColor: "{colors.night}"
  button-primary-active:
    backgroundColor: "{colors.horizon}"
    textColor: "{colors.night}"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.parchment}"
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

**Creative North Star: "An original, kept intact."**

A restrained task interface: a dark working surface, warm light source text, and clear standard controls. Attribution and evidence carry the hierarchy; ornament does not.

This records the built capture, retrieval, and read-only inquiry views. Automated weaving and dialogue are future work. Mockups remain guidelines, not pixel authority.

**Key Characteristics:**
- Flat, high-contrast reading surfaces.
- One task-oriented font family.
- Original words distinct from attributed hypotheses.
- Temporary search results and connected reading, not permanent note management.

## Colors

Primary action: **Lantern**, also used for text selection and unconfirmed-save notices. Discovery and focus: **Horizon**, including match origin and tentative-state labels. Neutrals: **Night** for the workspace; **Parchment** for primary text and original-source surfaces. Supporting text and hairlines use the existing neutral mixtures, not additional brand hues.

**The Source Distinction Rule.** Keep original text distinct from tentative AI formulations; color never replaces the author or status label.

No extra tonal scale is established by the implementation.

## Typography

Use Source Sans 3 throughout, including headings. The upright variable font is self-hosted with `next/font/local`; its [license and copy provenance](apps/web/app/fonts/README.md) are part of the project. No identity display face or emblem is adopted.

Frontmatter records reused roles, not an exhaustive size scale. General capture/search headings currently use `clamp(32px, 4vw, 44px)`; inquiry titles use the recorded role, reducing to (32px) on phones. Formulations reduce to (21px) on phones. Metadata is sentence case; timestamps use tabular numerals where styled. Do not mistake the current fluid heading implementation for a new type-system mandate.

## Layout

Capture and retrieval use centered reading widths (820px maximum); the shell and inquiry use (1120px maximum). Desktop outer gutters are (48px). Inquiry has source/context columns in a (.78:1.22) ratio with a (56px) gap. At (800px) and below it stacks in source-first DOM order; at (600px) and below the shell search wraps and outer gutters become (20px).

Search results exist only for a query. Back links retain that query. The inquiry groups original source, interpretations, and directed relationships with rationale/evidence; it is not a graph canvas, permanent all-notes list, or chat sidebar. These describe the built surfaces, not a pixel template for future screens.

## Elevation & Depth

Flat surfaces, neutral hairlines, spacing, and type create separation. There are no shadows, gradients, or decorative textures. Buttons transition background/text color over (140ms), with `ease-out`; reduced-motion mode removes transitions.

## Shapes

Controls have the smaller recorded radius; source reading areas, capture fields, and notices use the larger one. Borders are thin (1px). Status icons are simple stroked SVGs, not identity marks. There is no chip/card-grid component system to invent or inherit.

## Components

- **Actions:** Lantern-filled primary actions; outlined secondary actions invert on hover. Standard buttons have a minimum height of (48px); compact shell controls use (46px). Disabled actions retain legible text and a neutral border. Capture becomes read-only while saving and keeps its draft on failure.
- **Fields:** visible labels and associated help. Capture text sits on Parchment; search stays on Night. Capture padding reduces to (18px) on phones. Search is a native GET form, not agentic search.
- **Focus and navigation:** a Horizon outline (3px, offset 5px), underlined links, and a keyboard-visible skip link. Do not add custom keyboard conventions. Query-return links remain real links.
- **Source and history:** native `details`/`summary` disclosures with explicit button roles and minimum (44px) summary targets. Expanding a source replaces its excerpt. Exact source whitespace is preserved. Histories show current/earlier versions, authors, evidence, and any truncation; no invented version dates.
- **Attribution and feedback:** distinguish your original, AI interpretations, user formulations, tentative/active hypotheses, and rejected relationships in text. Search match origin is not connection evidence. Saving/queued notices use status semantics; failures use alerts with recovery. Queued does not mean a worker is running. No pretend dialogue composer or approval inbox is present.

## Do's and Don'ts

- Do preserve the exact core palette and self-hosted task font.
- Do keep author, source, status, and evidence readable without spatial gestures.
- Do use familiar semantic controls within inquiry-centered navigation.
- Don't imply that saved, queued, tentative, active, and user-endorsed mean the same thing.
- Don't add a permanent notes list, chat sidebar, new logo, or literal textile/fantasy ornament.
- Don't claim weaving or dialogue is implemented, or turn experiment images into production layout authority.

Implementation references: [global styles](apps/web/app/globals.css), [shell](apps/web/app/layout.tsx), [reading components](apps/web/app/ui/knowledge-reading.tsx), and [inquiry view](apps/web/app/sources/[id]/inquiry/page.tsx). `.impeccable/design.json` holds only extension metadata and small documentation specimens; it is not application code.
