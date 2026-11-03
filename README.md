# Thoughtloom

A daemon-first application for capturing and developing connected thoughts. Product decisions live in [`.lore/context/`](.lore/context/).

## Current implementation

The Bun/TypeScript foundation and Hono API provide:

- Immutable thoughts with single-parent evolution trees.
- Separate categorized connections and retained response addenda.
- User-only rejection and restoration of thoughts, connections, and evolution subtrees.
- Branch rejection previews and confirmation, with transactional state changes.
- Scoped reads that exclude rejected material from AI context while allowing deliberate user inspection.
- An authenticated, loopback-only HTTP daemon over those domain operations.

There is no visual client or real agent integration yet. Practical manual-test scripts are the next phase. Search and Markdown export are also not implemented yet.

## Setup and checks

Install [Bun](https://bun.sh), then run:

```sh
bun install --frozen-lockfile
bun test
bun run typecheck
```

Tests use controlled fixtures and isolated in-memory or temporary SQLite databases, not application data.

## Run the daemon

Set separate server-only credentials, each at least 32 characters, and a database path. For example, from the project root:

```sh
export THOUGHTLOOM_USER_TOKEN="$(bun -e 'console.log(crypto.randomUUID())')"
export THOUGHTLOOM_AI_TOKEN="$(bun -e 'console.log(crypto.randomUUID())')"
export THOUGHTLOOM_DB_PATH="$PWD/.data/thoughtloom.sqlite"
export THOUGHTLOOM_PORT=3001
bun run daemon
```

The tokens must be distinct. Keep them out of browser code, source control, and logs. HTTP callers authenticate with `Authorization: Bearer <token>`; the credential determines the caller's user or AI role. These are local service credentials, not a multiuser account system. Store them securely if you need them to persist between shell sessions.

The listener binds to `127.0.0.1`, not all network interfaces. The port defaults to `3001`; `0` selects an available ephemeral port. Readiness is reported as a structured startup event. Stop with Ctrl+C or SIGTERM for graceful listener/database shutdown.

User credentials permit rejection/restoration and explicit inspection of rejected history. AI credentials never grant those powers or access to rejected content. Future browser clients must call through the Next.js server, not send either credential to the browser or call this daemon directly.

## Boundaries

`src/domain/` holds the business rules and repository contracts. `src/storage/` implements SQLite persistence. They do not depend on Hono, Next.js, React, or screen layouts. `src/daemon/` handles Hono transport, authentication, configuration, and process lifecycle.

Raw storage reads are internal, not an AI-safe consumer interface. Future routes and agents must use the scoped rejection/visibility service so rejected content cannot leak through ancestry, sources, connections, or responses.

The eventual browser client will communicate through the Next.js server, never directly with the Hono daemon. Client work must stop for discussion if it requires missing daemon capabilities rather than silently changing the domain model.
