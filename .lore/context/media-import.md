---
title: Retained media import
date: 2026-11-07
status: approved
tags: [thoughtloom, media-import, product]
---

# Retained media import

This is the product agreement for `thought-loom-dkx`. Current implementation contracts belong in `docs/`, not in this agreement.

## Shared-filesystem architecture

**The daemon and OpenCode must share a filesystem.** Retain the original file in daemon-managed storage, then tell OpenCode its accessible absolute path and the user's clarification or summary request. OpenCode's existing trusted tools read the file and make its content available to the configured model.

Reuse normal Weave/Evolve execution and its existing lifecycle controls. File contents are opened by OpenCode's trusted tools using the supplied path.

The [backend design](../work/design/media-import.md) describes the file-path integration. The implemented user-only upload, receipt, source inspection/download and retry contracts are in the [daemon API](../../docs/daemon-api.md#retained-media-import-and-source-inspection); [startup](../../docs/server-startup.md#retained-media-and-shared-filesystem) covers shared paths, limits and paired backups. Media UI remains separate.

## Source and interpretation

- Initially accept one local image or PDF per import. Audio and video remain future possibilities; URL fetching and bulk media import are not part of this flow.
- Retain the exact original file outside SQLite in a private daemon-managed directory. SQLite retains metadata and relationships. Backups must include both.
- Each file creates an immutable, source-authored `media-original` root with null thought text. File authorship is unverified. Optional exact user clarification is separately attributed metadata, not invented file content or user-authored placeholder text.
- With no clarification, request a source-grounded summary. Save the AI interpretation as a separate searchable child thought. Do not create thoughts from extracted PDF text.
- File bytes, clarification and the source relationship are immutable. Changed instructions use Evolve; changed bytes require a new import.
- Without an editable title, use the filename as the display label. Search indexes clarification and titles, plus recorded interpretations and replies, not binary content or temporary extraction output.

## Agent access and failures

- Weave and Evolve must discover eligible retained media and be able to reopen it through a scoped, daemon-selected file path. A caller does not choose an arbitrary filesystem path.
- The existing trusted-tool policy applies: content may be sent to the configured model and processed using trusted tools without separate per-file confirmation. Permissive tools remain an accepted non-sandbox boundary.
- Temporary extraction or conversion is allowed when direct model input is unavailable. Do not persist extracted-text thoughts or silently switch models. Preserve the original and disclose processing limitations.
- Search, Agentic Export and Markdown segmentation gain no media-open or native-tool access. Markdown's retained whole-document artifact remains user-only.
- Rejection excludes the source's metadata and file path from application-mediated AI access, including through an active interpretation. Rejection is not file deletion. Previously transmitted content cannot be withdrawn; permissive same-user filesystem tools are not a sandbox.
- On interpretation failure, retain the file and source, show the failure and permit a deliberate safe retry without reupload. Unknown native outcomes must be reconciled rather than automatically duplicated. A saved initial interpretation is not recreated by retry, title clearing or later rejection; use Evolve for further development.
- The Next.js client remains a separate scope. Media UI requires its own design and implementation work.
