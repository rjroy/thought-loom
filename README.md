# Thoughtloom

A daemon-first application for capturing and developing connected thoughts. Product decisions live in [`.lore/context/`](.lore/context/).

## Current implementation

Phase 1 provides a Bun/TypeScript domain and SQLite storage foundation:

- Immutable thoughts with single-parent evolution trees.
- Separate categorized connections and retained response addenda.
- User-only rejection and restoration of thoughts, connections, and evolution subtrees.
- Branch rejection previews and confirmation, with transactional state changes.
- Scoped reads that exclude rejected material from AI context while allowing deliberate user inspection.

There is no HTTP daemon, visual client, or real agent integration yet. Hono routes and practical manual-test scripts are later phases. Search and Markdown export are also not implemented yet.

## Setup and checks

Install [Bun](https://bun.sh), then run:

```sh
bun install --frozen-lockfile
bun test
bun run typecheck
```

Tests use controlled fixtures and isolated in-memory or temporary SQLite databases, not application data.

## Boundaries

`src/domain/` holds the business rules and repository contracts. `src/storage/` implements SQLite persistence. They do not depend on Hono, Next.js, React, or screen layouts.

Raw storage reads are internal, not an AI-safe consumer interface. Future routes and agents must use the scoped rejection/visibility service so rejected content cannot leak through ancestry, sources, connections, or responses.

The eventual browser client will communicate through the Next.js server, never directly with the Hono daemon. Client work must stop for discussion if it requires missing daemon capabilities rather than silently changing the domain model.
