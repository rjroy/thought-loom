---
title: Architecture and working agreement
date: 2026-11-03
status: agreed baseline
tags: [thoughtloom, restart, architecture, workflow]
---

# Architecture and working agreement

## Agreed technology

- **Website:** Next.js with React.
- **Daemon:** Hono.
- **Runtime and tooling:** Bun.
- **Storage:** SQLite through Bun's built-in `bun:sqlite`, selected for the Phase 1 foundation. Each non-root thought has one evolution parent; weaver-discovered connections are stored in a separate linking table, not as additional evolution parents.

## Client and daemon boundary

The browser client must never access the daemon directly. Browser requests that need daemon functionality go through the Next.js server, which communicates with the daemon.

```text
Browser (React) → Next.js server → Hono daemon
```

The exact server-side interface and transport remain to be designed. This boundary applies regardless of those choices.

## Working agreement

Work on the daemon and the web client separately, in distinct implementation scopes. A client or visual task does not authorize changing the daemon to make it work.

If visual/client work is blocked because the daemon does not support what is needed, stop and discuss the missing capability with the user before proceeding. Do not silently expand the task into daemon work or bypass the server boundary to work around the gap.

## Daemon-first development

Build and validate the daemon before the visual client. The first milestone establishes immutable thoughts, evolution trees, separate connections, and rejection/restoration through domain logic, SQL storage, and a Hono API, without real AI or UI work.

Provide practical Bun scripts so the user can exercise daemon behavior without a visual client. These scripts do not need a polished CLI experience. They complement, rather than replace, automated tests of the business rules.

Once the foundations work, add agent integration through the same domain operations, then build the Next.js client against the established contracts. Search and export must also be exercisable independently of the visual client.

The domain model describes thoughts and their behavior, not screen layouts or cards. A visual change may require a different query or response shape, but must not automatically trigger a domain-model rewrite. If it exposes a genuinely missing business capability, stop and discuss it under the working agreement above.

These are the agreed starting constraints and development direction, not a complete architecture or implementation plan. Further architecture decisions remain open for discussion.
