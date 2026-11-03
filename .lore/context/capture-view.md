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

## Actions

- Enter or paste text.
- Save the original wording.
- After saving, open the captured note in [Idea](idea-view.md), capture another thought, or switch to Search.
- If saving fails, keep the entered text and offer a clear retry.
- If background processing fails after the save, retry that processing without treating the note as unsaved or creating a duplicate capture.

## After Save

Make the successful save unambiguous. Preserve the text, capture date, and provenance before depending on AI work. A short confirmation is enough; do not replace the simple capture surface with a status dashboard.

The [weaver](weaver-agent.md) examines the saved material asynchronously. Saving and weaving are separate facts: a note can be safely saved while its interpretation and connections are still pending, unavailable, or unsuccessful.

The user does not have to wait for the weaver before continuing. AI-authored titles, interpretations, or connections must not silently alter the original text. If a title is absent, use the first five words as its display label.

## Not required

Rich-text editing, attachments, folders, automatic import, or a conversation before saving. These can be discussed separately; they are not prerequisites for this view.
