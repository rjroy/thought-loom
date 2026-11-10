---
title: Additional agent instructions
date: 2026-11-09
status: agreed baseline
tags: [settings, agents, instructions]
---

# Additional agent instructions

Users may save global, server-side additional instructions for four agent types:

- Weaver
- Evolve
- Agentic Search
- Agentic Export

These are additions, not overrides. Built-in instructions remain in place, and
additional guidance does not change permissions, authorized writes, scoped
retrieval, rejection filtering, or data-protection rules. Import segmentation is
not configurable through this setting. Model, effort, and tool-access settings
are outside this feature.

## Settings view

The existing Settings navigation entry opens a page containing four optional
free-text fields and one **Save changes** button. An empty field means no
additional guidance for that agent. The settings apply across the installation,
not just one browser or conversation.

The approved desktop and phone references are in
[the Settings design directory](../../.impeccable/mocks/settings/README.md).

## When changes apply

Queued work reads the latest instructions when its initial prompt is prepared.
Once prepared, that run retains the same guidance through capability exchanges,
retries, and recovery. Saving settings does not rewrite an already-prepared
prompt or change an active turn.

The next turn in an existing conversation uses the latest saved instructions.
Changing settings does not erase conversation history or change the saved
permissions of an existing native session.

This document records the agreed behavior. Current implementation contracts and
validation boundaries belong in `docs/`.
