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

The Bun/TypeScript foundation provides SQLite persistence, an authenticated Hono daemon, immutable evolution trees, editable title metadata, rejection/restoration, and manual test scripts.

The Next.js/React client, OpenCode-backed agents, search, and export are not implemented yet. In particular, titles are not automatically generated until the weaver is integrated.

Product intent and working agreements live in [`.lore/context/`](.lore/context/). The documents above describe the implementation that exists today.
