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

Use useful basic text retrieval rather than exact-string-only matching: search words and titles, and support prefixes and modest typo tolerance.

Acronym expansion and alternate-terminology/alias matching are future enhancements, not V1 requirements. Do not let their efficiency or implementation complexity impede V1. For example, finding “software development kit” from “SDK” is not a V1 acceptance criterion. Aliases, if added later, aid retrieval and are not evidence of a conceptual relationship.

Use SQLite **FTS5** as the full-text search foundation. Prefix matching and modest bounded typo handling remain the described behavior; FTS5 alone does not provide typo tolerance, so that needs complementary handling. Do not rebuild a custom full-text engine or require acronym/alias infrastructure for V1. Ordinary search is not required to invoke an agent or understand an unrestricted natural-language request.

Start the typo-tolerance work from SQLite **spellfix1**, the user's reference point from the previous search implementation that worked reasonably well. Evaluate FTS5 plus spellfix1 before introducing a different approach. Verify extension availability and Bun/SQLite integration when implementing search; spellfix1 must not be assumed built in. The final integration details are implementation choices, not a reason to recreate search from scratch.

Search should reach original captures, user discussion contributions, retained AI interpretations/developing ideas, every agent response, and effective titles. Full responses remain searchable even when they are addenda rather than evolution nodes. If an addendum matches, open its associated recorded development with the full response available there. There are no historical note revisions; earlier thoughts remain distinct searchable material unless rejected. Searching every relationship explanation is not assumed.

Retrieval finds candidates. The agent's separate job is to examine material and establish whether a meaningful connection exists. A good textual match is not semantic confidence or proof of a connection.

## Filters and sorting

Include the mockup's filter sidebar and sort control in 1.0. These are approved search features, not incidental mockup decoration.

The sidebar offers authorship and kind-of-material filters, date presets and a custom date range, result counts beside filter options, and a Clear filters action. Use the [data model](data-model.md) to keep authorship and material kind distinct; the mockup's exact labels and choices are not a finalized taxonomy.

The sort options are **Relevance**, **Newest first**, and **Oldest first**. Date filters and chronological sorting use thought creation date, not a last-edited date. Recency must not be treated as a measure of an idea's value.

Selections within a filter group combine as **OR**; different filter groups combine as **AND**. For example, You or AI, and Developing idea, and created in the last 30 days. Each option's count shows how many matching results that option would include under the current query and other filter groups.

Add a **Show rejected** on/off toggle with no count. Off by default, it excludes rejected material from ordinary search processing, not merely from client-side display. Enabling it adds rejected thoughts alongside active results, rather than showing only rejected thoughts. Do not run an additional rejected-material count query merely to populate this toggle. User access to rejected material never makes it available to AI agents.

## Result presentation

Show a readable vertical list of compact cards. Each card has:

- A prominent title, or the first five words when no title exists.
- One or two lines of the actual note text, not a newly generated summary.
- Clear, restrained authorship.
- Useful recorded context, when available, subordinate to the matching note.

Where text is truncated, a clickable `…` expands the complete text in place. Opening the thought goes to [Idea](idea-view.md). Back restores the query and the person's place in the results.

For contextual material, prefer an eligible directly connected thought that also matches the query. Otherwise, the immediate recorded predecessor can explain where the thought developed from. If neither is suitable, omit context. Do not replace the result with its neighbor, display the whole ancestry, or manufacture an explanation.

When several directly connected thoughts qualify, choose the best search-relevance match, independently of the selected result sort. Use a stable tie-breaker for equally relevant candidates. This selection belongs to the daemon, not the client.

Rejected notes and connections are not ordinary surrounding context. They remain available for deliberate user inspection through Show rejected and explicit Idea inspection, not an automatically broadened context read.

Use recorded relationship rationale or provenance wording to explain that context. Ordinary search must not generate new AI interpretations on each query. Search ranking, connection confidence, and provenance are different things.

## Actions and empty results

Search, change the query, filter and sort results, clear filters, expand text, open a result or its connected thought, and return without losing the query, filters, sort selection, or place. Searching or reading does not accept, promote, or modify an AI interpretation.

If nothing matches, say so plainly and allow another query. Do not fabricate content or silently substitute unrelated recent notes.

## Still to decide

Final relevance ranking and tie-breakers, and any further connection-eligibility rules beyond the recorded-context and rejection boundaries above. [Conversational agentic search](agentic-search.md) is now being designed as a separate planned workflow, not a silent change to ordinary Explore. Agentic export remains a different, approved workflow.
