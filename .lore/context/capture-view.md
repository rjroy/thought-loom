---
title: Capture view
date: 2026-11-03
status: draft
tags: [thoughtloom, restart, product]
---

# Capture

## Purpose

Get a rough thought into Thoughtloom quickly and trust that the original was saved. Capture is one of two primary entry modes, alongside [Search / Explore](search-view.md).

## First appearance

A text box and a clearly labeled Save button. The user can enter an observation, question, idea, or pasted passage. The view must work comfortably on a phone.

No required title, category, tags, relationship type, confidence score, or AI conversation. Do not make the user understand the internal model before recording a thought.

The quick-capture API accepts only the thought text and an optional title. The daemon assigns identity, creation timestamp, authenticated authorship, material kind, and origin, and returns the saved record. Clients do not supply internal classifications or fabricate storage fields to capture a thought.

## Actions

- Enter or paste text.
- Save the original wording.
- After saving, open the captured note in [Idea](idea-view.md), capture another thought, or switch to Search.
- If saving fails, keep the entered text and offer a clear retry.
- If background processing fails after the save, retry that processing without treating the note as unsaved or creating a duplicate capture.

## After Save

Make the successful save unambiguous. The daemon assigns the note's identity and creation timestamp and returns the created record; the client does not generate these values. Preserve the text, capture date, and provenance before depending on AI work. A short confirmation is enough; do not replace the simple capture surface with a status dashboard.

The [weaver](weaver-agent.md) examines the saved material asynchronously. Saving and weaving are separate facts: a note can be safely saved while its interpretation and connections are still pending, unavailable, or unsuccessful.

The user does not have to wait for the weaver before continuing. Most captures are quick, titleless entry; an optional user title is allowed. The weaver generates missing titles as separate, attributed metadata, not edits to the original text. If a title is absent, use the first five words as its display label. The user may later edit or clear the title; clearing invites regeneration. AI-authored interpretations and connections also must not silently alter the original text.

## Not required

Rich-text editing, attachments, folders, background folder watching, or a conversation before saving. These are not prerequisites for this view.

## Separate import entry

An **Import** action to the right of the Capture page heading opens a separate [Markdown import flow](markdown-import.md). Keep it outside the thought/title form so it cannot be mistaken for part of the thought. This replaces the earlier below-textarea placement. The user selected the Import Workspace composition and approved this heading-row entry through the designer-led comp-led pass. Import must not complicate or become a prerequisite for quick text capture.
