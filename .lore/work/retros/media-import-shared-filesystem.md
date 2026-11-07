---
title: Media import and the shared-filesystem correction
date: 2026-11-07
status: completed
tags: [ai-development, architecture, scope-drift, overengineering, media-import, opencode]
modules: [daemon, agent, storage]
---

# Media import and the shared-filesystem correction

The user requested retained image and PDF imports. They said they were happy for the agent to open the file and wanted it told where imported files were stored. Original files were to remain outside SQLite; the AI interpretation would be a separate searchable thought.

The orchestrator introduced an assumption that the daemon and OpenCode might not share a filesystem. It did not ask whether that deployment needed support. Implementation proceeded toward inline attachment delivery rather than supplying the retained file path to normal OpenCode execution.

The resulting work included base64 transport, attachment fingerprints and manifests, submission attribution, observation tracking, media-specific terminal and history correlation, ordered conversation snapshots, additional SQL guards and a separate media-native port. Focused tests, independent runtime checks and specialist reviews repeatedly checked those components. Reviews found and corrected local defects, including copied-database cleanup authority and request-validation ordering. These checks did not establish that the transport architecture matched the user's intended deployment.

File retention, metadata and validation were committed separately. Additional admission and run-authority groundwork was committed as `e9a91a4`. Most subsequent delivery work under `thought-loom-dkx.5` was still uncommitted when the user asked whether OpenCode was simply being given the file's location. The orchestrator explained that it was sending inline attachments instead. The user then stated that the daemon and OpenCode must share a filesystem and pointed out that this had never been asked. The conversation contains no verified elapsed-time measurement.

The user instructed the agent to remove the machinery, retain the file and tell OpenCode about it so its tools could provide it to the model. They authorized deletion of obsolete code, tests and documentation, and changes to Beads. They also requested at most one file about this misstep, with all current implementation materials focused on the simple design. This is that file.

The correction uses normal Weave/Evolve execution and scoped reads to supply daemon-selected absolute paths from managed storage. Shared filesystem access is an explicit deployment requirement. The user additionally requested a final Beads task, `thought-loom-dkx.8`, requiring multiple refactor passes over the completed backend workflow.

The replacement removed the attachment runtime and its tests, including committed protocol groundwork. A refreshed test workspace removed 64 obsolete source/test copies. Seven focused shared-path cases verified initial instructions, normal interpretation publication, Weaver/Evolve reopening, rejection fencing, restricted roles and title-only regeneration. The full suite passed with 1,325 tests; both typechecks, the production web build and isolated desktop/narrow browser integration also passed. Independent correctness and engineering-quality reviews accepted the replacement. Current documentation was rewritten for the file-path design. Daemon import-route wiring and the final multi-pass refactor task remained separate backend work at this checkpoint.
