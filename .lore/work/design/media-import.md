---
title: Retained media backend
date: 2026-11-07
status: approved
tags: [thoughtloom, media-import, shared-filesystem, backend]
---

# Retained media backend

The product agreement is [Retained media import](../../context/media-import.md). Current schema, API, startup and testing contracts are maintained in `docs/`.

## Storage

Accept one image or PDF per import. Retain its exact original bytes in private daemon-managed storage outside SQLite. SQLite records the immutable source metadata, optional separately attributed user clarification and thought relationships. Backups include the database and file directory.

A source is a `media-original` thought with source authorship and null text. Its filename supplies the display label when no title exists. The AI interpretation is a separate searchable child. Do not generate extracted-text thoughts or replace the original file during processing.

## Shared filesystem and agent execution

The daemon and OpenCode must share the filesystem. OpenCode must be able to read the retained absolute paths using its existing trusted tools. File ownership and directory access must support that deployment requirement.

Use normal Weave/Evolve execution. Initial source weaving receives the retained file path and exact clarification, or instructions to summarize the file when clarification is absent. OpenCode reads the file and makes its content available to the configured model. Thoughtloom does not transmit file bytes through a separate attachment protocol.

Scoped Weave/Evolve reads can supply a retained original's daemon-selected path when the source is eligible. Paths come from managed storage and source identity, never an arbitrary caller path. Reuse normal context, request validation, thought publication and run lifecycle controls. Do not require separate binary-observation receipts or media-specific conversation verification.

Search, Agentic Export and Markdown segmentation gain no file-opening capability. Their existing restricted tool policies remain unchanged. Trusted native filesystem tools are not a sandbox; the application controls which eligible source paths it supplies.

## Lifecycle

Retaining the source and admitting its normal weave must be coordinated so a failure does not lose the original or create an incomplete knowledge record. Keep file operations outside database transactions where appropriate and use the existing private file service and transactional metadata writer.

Stop, failure and rejection use existing run fencing. Rejection hides the source and its path from application-mediated AI access; it does not delete the retained file. Restoration does not revive stale callbacks.

Title clearing permits title regeneration, not another initial interpretation. A deliberate retry uses the retained file, preserves failure information and cannot duplicate an already confirmed initial interpretation. Do not automatically resend an unknown active outcome. Further development uses Evolve.

## Validation and boundaries

Use test-owned files, isolated SQLite and fake OpenCode execution. Check path delivery, clarification/default instructions, normal child publication, eligible reopening, rejection fences, title-only behavior and restricted roles. Preserve existing text and Markdown coverage. Do not use personal data or the operator service as fixtures.

Backend work does not authorize a visual-client implementation. The Capture import flow requires its own approved design. Do not install conversion tools, switch models or start/reconfigure OpenCode implicitly.
