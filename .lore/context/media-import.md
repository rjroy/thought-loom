---
title: Retained media import
date: 2026-11-06
status: approved
tags: [thoughtloom, media-import, product]
---

# Retained media import

This is the approved product agreement for `thought-loom-dkx`. The [backend design](../work/design/media-import.md) defines the architecture and remaining daemon contracts. Internal metadata persistence and atomic initial source/run/attempt admission, backend thought/search/scoped/investigative/saved-search/export projections, a private file-store service with injected validation, and [bounded format-validation helpers](../../docs/server-startup.md#internal-media-validation) are implemented; see the [current storage contract](../../docs/database-schema.md#media-source-storage-foundation). The validator is not wired into the file service or daemon.

The internal groundwork also includes original-part manifests, ordinary Weaver/Evolve submission intent, title-only purpose enforcement, untouched queued-attempt Stop seals, immediate source-rejection fences and generic media-root interpretation denial. Historical children remain readable and preserved by migration, not adopted as proof of a confirmed initial interpretation. This is partial lifecycle/safety support, not an available media-import workflow or successful media publication.

The [execution activation gate](../../docs/database-schema.md#media-execution-activation-gate) still requires mapped preparation/authorization, prepared/authorized all-step Stop/failure/rejection seals, actual held-flight joining, trusted binary observation and atomic interpretation publication before delivery opens; reconciliation/settlement and deliberate retry remain later work. Daemon file-retention wiring, media upload/download/retry endpoints and startup/file configuration are also unimplemented. Initial admission is not execution authority. The existing Next.js client remains text-only; client design and implementation are separate work. Requirements below describe the complete agreed direction, not a claim that these remaining capabilities are available.

## Source and interpretation

- Initially accept one local image or PDF per import. Audio and video remain future possibilities; URL fetching and bulk media import are not part of this flow.
- Retain the exact original file outside SQLite in a private daemon-managed directory. SQLite retains metadata and relationships. Backups must include both.
- Each file creates an immutable, source-authored `media-original` root with null thought text. File authorship is unverified. Optional exact user clarification is separately attributed metadata, not invented file content or user-authored placeholder text.
- With no clarification, request a source-grounded summary. Save the AI interpretation as a separate searchable child thought. Do not create thoughts from extracted PDF text.
- File bytes, clarification and the source relationship are immutable. Changed instructions use Evolve; changed bytes require a new import.
- Without an editable title, use the filename as the display label. Search indexes clarification and titles, plus recorded interpretations and replies, not binary content or temporary extraction output.

## Agent access and failures

- Weave and Evolve must discover eligible retained media and be able to reopen it. Reading source metadata is not the same as reading the file.
- The existing trusted-tool policy applies: content may be sent to the configured model and processed using trusted tools without separate per-file confirmation. Permissive tools remain an accepted non-sandbox boundary.
- Temporary extraction or conversion is allowed when direct model input is unavailable. Do not persist extracted-text thoughts or silently switch models. Preserve the original and disclose processing limitations.
- Search, Agentic Export and Markdown segmentation gain no media-open or native-tool access. Markdown's retained whole-document artifact remains user-only.
- Rejection excludes the source's metadata and bytes from application-mediated AI access, including through an active interpretation. Rejection is not file deletion. Previously transmitted content cannot be withdrawn.
- On interpretation failure, retain the file and source, show the failure and permit a deliberate safe retry without reupload. Unknown native outcomes must be reconciled rather than automatically duplicated. A saved initial interpretation is not recreated by retry, title clearing or later rejection; use Evolve for further development.
