---
title: Export / Use
date: 2026-11-03
status: draft
tags: [thoughtloom, restart, product]
---

# Export / Use

Thoughtloom should help someone use their thinking outside the application. Both **Simple** and **Agentic** export are included in 1.0, and both produce Markdown.

## Simple export

The user chooses:

- A starting idea, which becomes the root of this export.
- A maximum number of thoughts to export.
- Breadth-first or depth-first traversal.

Walk the selected idea's evolution tree until the requested count is reached or there are no more eligible thoughts. Do not follow weaver-discovered connections.

Export the recorded thoughts, not their full agent-response addenda. When a full response was retained as the fallback development because no separate development was recorded, it is itself the thought's text and is included.

Skip rejected thoughts without cutting off traversal: active descendants beyond a rejected thought can still be exported. Rejected thoughts do not consume the exported-thought count.

## Agentic export

The user provides a question or request and an effort level. The agent investigates relevant, non-rejected material and builds a Markdown report that gathers and connects existing thinking. The purpose is export, not new idea development.

The effort levels are **Quick**, **Standard** (default), and **Thorough**. They request the model's effort/thoroughness and may map to a supported model effort setting or variant. They do not impose application-defined turn, token, cost, search-count, or note-count quotas. “Investigation budget” is not the intended contract. Normal transport failure detection and user-requested cancellation are separate from effort.

Effort is not a request for more speculative analysis or new developments. Exact supported model/variant mappings are deployment configuration rather than extra investigation limits.

Cite the source thoughts behind the report so the user can trace its claims back into Thoughtloom. Distinguish recorded material from the report's connective explanation; do not invent evidence or imply user endorsement of AI-authored claims.

This agent is strictly read-only. It must not create or change stored thoughts or connections, reject or restore material, or otherwise develop the knowledge base. Rejected notes and connections are excluded from its retrieval, context, and reasoning, just as for the other agents.

## Shared boundaries

Preserve authorship, provenance, and uncertainty sufficiently to understand the exported material. Export does not rewrite or remove stored material. A collector, additional formats, or publishing integrations are not prerequisites for these two workflows.

## Still to decide

The exact visual export entry points and preview/download UX remain for the client design phase. These do not reopen the agreed effort labels, Markdown format, tree-only Simple traversal, or read-only Agentic behavior.
