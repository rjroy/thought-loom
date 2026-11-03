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

There is no visual client or real agent integration yet. The manual-test scripts below exercise the foundation without either. Search and Markdown export are also not implemented yet.

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

## Try the isolated walkthrough

```sh
bun run demo
```

This starts its own temporary daemon and SQLite database with generated credentials. It creates a small evolution tree and separate connection, demonstrates rejection and partial restoration, and checks what an AI caller can see. AI-authored thoughts are simulated through HTTP; no model or OpenCode service is called. The script reports each step and removes its listener and temporary data afterward, including on failure. It does not attach to your configured daemon.

## Make manual API requests

**These commands modify the daemon you select. Use a disposable database for experiments.** Start the daemon as above, then use the same tokens in the shell running the helper:

```sh
export THOUGHTLOOM_DAEMON_URL=http://127.0.0.1:3001
bun run api --role user GET /thoughts
```

The format is `bun run api --role user|ai METHOD /path [JSON]`. Output includes the HTTP status and readable JSON; errors return a nonzero exit code. Only loopback daemon URLs are accepted, and redirects are not followed. The helper selects `THOUGHTLOOM_USER_TOKEN` or `THOUGHTLOOM_AI_TOKEN` from the role; it does not print the credential.

For a small manual tree, use fresh IDs if you repeat the example. The timestamps below are example test data. Do not send `author`; the daemon derives it from your credential.

```sh
bun run api --role user POST /thoughts '{"id":"manual-root","text":"An idea to explore","title":null,"kind":"developing-idea","createdAt":"2026-01-01T00:00:00Z","origin":"manual","parentId":null,"sourceIds":[]}'
bun run api --role user POST /thoughts '{"id":"manual-child","text":"A development of that idea","title":null,"kind":"developing-idea","createdAt":"2026-01-01T00:00:00Z","origin":"manual","parentId":"manual-root","sourceIds":["manual-root"]}'
bun run api --role user POST /connections '{"id":"manual-link","fromId":"manual-root","toId":"manual-child","category":"related","explanation":"Related ideas","sourceIds":[]}'

# Rejecting only the root leaves the child active.
bun run api --role user POST /thoughts/manual-root/reject
bun run api --role ai GET /thoughts
bun run api --role user GET '/thoughts?scope=show-rejected'
bun run api --role user GET '/thoughts?scope=history'

# Preview all descendants before confirming branch rejection.
bun run api --role user GET /thoughts/manual-root/branch/preview
```

To confirm, POST the exact current preview JSON body (`rootId`, `branchIds`, `affectedIds`, `count`) to `/thoughts/manual-root/branch/reject` using the helper's optional JSON argument. Copy only the JSON body, not the printed HTTP status. A stale or changed preview is rejected.

```sh
# Restore only the later subtree, leaving its rejected ancestor unchanged.
bun run api --role user POST /thoughts/manual-child/branch/restore

# Explicit connection rejection remains independent of idea restoration.
bun run api --role user POST /connections/manual-link/reject
bun run api --role user POST /thoughts/manual-root/branch/restore
bun run api --role user GET /connections
```

## Boundaries

`src/domain/` holds the business rules and repository contracts. `src/storage/` implements SQLite persistence. They do not depend on Hono, Next.js, React, or screen layouts. `src/daemon/` handles Hono transport, authentication, configuration, and process lifecycle.

Raw storage reads are internal, not an AI-safe consumer interface. Future routes and agents must use the scoped rejection/visibility service so rejected content cannot leak through ancestry, sources, connections, or responses.

The eventual browser client will communicate through the Next.js server, never directly with the Hono daemon. Client work must stop for discussion if it requires missing daemon capabilities rather than silently changing the domain model.
