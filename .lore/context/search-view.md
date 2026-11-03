---
title: Search and Explore view
date: 2026-11-03
status: draft
tags: [thoughtloom, restart, product]
---

# Search / Explore

## Purpose and entry

Search is the way back to recorded thinking. The entry surface is a search box and button, not a recent-notes feed, folder browser, random selection, or old-chat dashboard. Capture is the other primary entry mode.

The person searches for something they remember or want to investigate. Results may be recent or years old. Recency is not a measure of value.

## How retrieval works

Use useful basic text retrieval rather than exact-string-only matching: search words and titles, support prefixes and modest typo tolerance, and recognize recorded alternate terminology or acronym expansions. For example, “SDK” should be able to find “software development kit.”

Acronym matching requires an alternate-name/expansion mechanism; ordinary full-text matching does not magically supply it. Aliases aid retrieval and are not evidence of a conceptual relationship.

The previously chosen baseline was indexed full-text search with prefix and bounded typo handling. This preserves that level of behavior, not a requirement to rebuild a custom matcher or choose a particular search library. Ordinary search is not required to invoke an agent or understand an unrestricted natural-language request.

Search should reach original captures, user discussion contributions, retained AI interpretations/developing ideas, and their effective titles. Historical versions remain available through history; searching every historical revision or relationship explanation is not assumed.

Retrieval finds candidates. The agent's separate job is to examine material and establish whether a meaningful connection exists. A good textual match is not semantic confidence or proof of a connection.

## Result presentation

Show a readable vertical list of compact cards. Each card has:

- A prominent title, or the first five words when no title exists.
- One or two lines of the actual note text, not a newly generated summary.
- Clear, restrained authorship.
- Useful recorded context, when available, subordinate to the matching note.

Where text is truncated, a clickable `…` expands the complete text in place. Opening the thought goes to [Idea](idea-view.md). Back restores the query and the person's place in the results.

For contextual material, prefer an eligible directly connected thought that also matches the query. Otherwise, the immediate recorded predecessor can explain where the thought developed from. If neither is suitable, omit context. Do not replace the result with its neighbor, display the whole ancestry, or manufacture an explanation.

Use recorded relationship rationale or provenance wording to explain that context. Ordinary search must not generate new AI interpretations on each query. Search ranking, connection confidence, and provenance are different things.

## Actions and empty results

Search, change the query, expand text, open a result or its connected thought, and return without losing place. Searching or reading does not accept, promote, or modify an AI interpretation.

If nothing matches, say so plainly and allow another query. Do not fabricate content or silently substitute unrelated recent notes.

## Still to decide

Final ranking and tie-breakers, precise connection eligibility, and whether an explicitly separate agentic search mode is useful. Agentic search is not a prerequisite for the basic experience.
