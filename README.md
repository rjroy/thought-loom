# Thoughtloom

*Where ideas take shape.*

Thoughtloom explores a question: can AI help someone discover and develop thinking they would otherwise have missed?

The goal is to capture rough thoughts without ceremony, find meaningful connections, and develop ideas through dialogue. The thinking should remain useful outside the application, not become another chat transcript to reread.

## Principles

- Preserve original thinking. Development adds new thoughts to a branching chain rather than rewriting the past.
- Keep titles editable, separate from immutable thought content and ancestry.
- Attribute AI contributions. Reading a suggestion does not mean agreeing with it.
- Give users control. Rejected material stays available for deliberate inspection but is excluded from AI use.
- Keep business rules independent of screens. The daemon comes first; visual changes must not silently reshape the domain model.

## Start here

| Document | What it covers |
| --- | --- |
| [Server startup](docs/server-startup.md) | Install, configure, start, and stop the daemon; diagnose startup failures. |
| [Testing concepts](docs/testing.md) | Automated test boundaries, isolated fixtures, the walkthrough, and manual testing. |
| [Daemon API](docs/daemon-api.md) | Authentication, request and response shapes, routes, and examples. |
| [Database schema](docs/database-schema.md) | SQLite tables, relationships, constraints, and migrations. |

## Current state

The Bun/TypeScript daemon provides SQLite persistence, immutable evolution trees, editable titles, rejection/restoration, FTS5 search with spellfix1 typo handling, both Markdown export modes, and manual test scripts. Configured OpenCode integration supports background weaving, conversational development, and read-only report investigation through scoped application capabilities.

The Next.js/React client is not implemented yet. Without agent configuration, capture, search and Simple export remain usable; weaving jobs stay queued and titles use the display fallback. Evolve and Agentic export require explicit server-side agent configuration.

Product intent and working agreements live in [`.lore/context/`](.lore/context/). The documents above describe the implementation that exists today.
