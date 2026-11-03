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

## Client and daemon boundary

The browser client must never access the daemon directly. Browser requests that need daemon functionality go through the Next.js server, which communicates with the daemon.

```text
Browser (React) → Next.js server → Hono daemon
```

The exact server-side interface and transport remain to be designed. This boundary applies regardless of those choices.

## Working agreement

Work on the daemon and the web client separately, in distinct implementation scopes. A client or visual task does not authorize changing the daemon to make it work.

If visual/client work is blocked because the daemon does not support what is needed, stop and discuss the missing capability with the user before proceeding. Do not silently expand the task into daemon work or bypass the server boundary to work around the gap.

These are the agreed starting constraints, not a complete architecture or implementation plan. Further architecture decisions remain open for discussion.
