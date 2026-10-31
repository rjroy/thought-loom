---
title: Thoughtloom real-corpus experiment handoff
date: 2026-10-31
status: draft
tags: [thoughtloom, experiment, recovery, user-evaluation]
related: [PRODUCT.md, README.md, .lore/work/design/thoughtloom-mvp.md]
---

# Thoughtloom real-corpus experiment handoff

This is a preparation guide, not evidence that an experiment occurred. The
controlled test suite and isolated fake-provider witness do not establish useful
real-corpus results or compatibility with a particular live provider.

## Before any real data or provider use

1. The user chooses a small set of notes they are comfortable sending to a
   provider, the desired signs of a useful or surprising development, and what
   must not leave the machine. Do not select or inspect a personal corpus on the
   user's behalf. Capture only the selected notes normally in Thoughtloom; no
   automatic import, hidden seed or bulk ingestion is part of this procedure.
2. Identify the user's existing operator-managed service setup, agent, provider,
   model, permissions and the anticipated content, cost and latency boundaries.
   Agree on actual provider use before connecting or making paid/live calls.
   No current real service/model connection is asserted here. Follow README's
   explicit native setup only after that choice; do not alter a shared service or
   personal configuration silently. Keep both application services on loopback.
3. Use README's SQLite snapshot and new-path restore procedure on the selected
   application database before the experiment, and independently verify a
   restored copy. Application SQLite backup excludes external OpenCode state and
   credentials; unresolved active/uncertain jobs must not be blindly replayed.
   Preserve the original database and backup. No backup is implied by a runbook.

## User-led evaluation

1. Capture the chosen notes with accurate provenance. Reopen several originals
   and check exact text, dates and provenance after a restart. Observe saved,
   queued and actual run outcomes separately; an empty or failed run is a valid
   observation, not a reason to invent a connection.
2. Search for the originals and inspect several actual suggested connections,
   their direction, rationale, evidence and attribution. Ask whether each is
   non-obvious and useful rather than merely a shared word or an unsupported
   claim. Record useful *and* useless or misleading outcomes.
3. Challenge at least one real suggestion through its attached dialogue. Inspect
   confirmed changes separately from response prose. Reopen the interpretation
   or developing idea and its discussion derivation, earlier versions, evidence
   and unchanged original. Exercise a correction or reversal only when the user
   intends it; do not infer consent from the presence of a button.
4. Record observed latency and actual provider cost if available, explicitly
   marking unavailable measurements as unknown. Note source fidelity, rationale
   quality, failures/uncertainty, whether the challenge led to useful development,
   and any privacy or operational concerns. Avoid invented counts, percentages,
   model claims or blanket success guarantees.
5. Review the results with the user. If connections are mostly obvious lexical
   matches or unsupported, stop and reassess retrieval/agent behavior rather than
   declaring the experiment successful. User judgment determines usefulness;
   any real-corpus data or provider use requires the user's separate choices.

Record results only with the user's permission, in an appropriately private
location. Do not commit personal notes, credentials, prompts, or transcripts.
