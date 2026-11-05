# Approved Markdown import design

**Selected: Import Workspace (option 1), with Import to the right of the Capture page heading.** The user confirmed **“Approve placement.”** Import is a separate cyan-underlined action outside the thought/title form and shared navigation; Save remains gold. This supersedes the earlier below-textarea entry. Thought and optional title remain contiguous.

This is the complete selected composition packet: **six unchanged approved PNGs and five supporting files**. It approves the shown entry, setup and mixed-report compositions plus the rules below. It does **not** authorize production implementation or certify application behavior, accessibility, physical-device layout or an import runtime. No further composition choice remains for this scope.

## Selected views

| View | Desktop | Narrow |
| --- | --- | --- |
| Capture entry | [1440px](entry-desktop.png) | [390px](entry-narrow.png) |
| Import setup | [1440px](option-1-ready-desktop.png) | [390px](option-1-ready-narrow.png) |
| Mixed processing/report | [1440px](option-1-mixed-desktop.png) | [390px](option-1-mixed-narrow.png) |

[Static preview](index.html). The six exact identities, actual dimensions and approval scope are in [manifest.json](manifest.json). Full-page height may exceed the 900px/844px browser viewport. Preserve readable CSS type and controls, not scaled raster text.

## Implementation-facing rules

- Inherit Quiet Night, Source Sans 3, the full sixteen-color functional palette and existing mixtures. The wide file list leads; explanation/recovery is subordinate. On a phone, **How import works** is a disclosure. Shared navigation remains Explore / Capture / inactive Settings Reserved.
- Choosing files is not upload. **Import 7 files** illustrates the explicit import action; real copy reflects the current eligible selection. Local file errors are **Not sent**, outside server-admitted counts. Do not freeze configurable size/concurrency safeguards into permanent product limits.
- Preserve exact wording. AI groups safe original blocks; structural fallback is automatic, successful import, not an algorithm choice or mandatory per-file preview. Imported originals are independent roots labelled **Imported source**, not You or AI, with unverified original authorship and no endorsement implied.
- Show actual admitted-file states and meaningful worded status, not percentages or invented ETAs. Selected local files are not admitted before receipts. Frozen bytes, locator and request identity belong to an admitted/submitting attempt; uncertainty must not automatically create another batch or upload.
- Queued/waiting/submitting/running are not imported. Uncertain means check the **same known file/run**, not failed or permission to resubmit. Stop is per active file with a known run ID, never batch Cancel/rollback or an instant native-kill promise. Leaving is not cancellation.
- Imported means confirmed canonical source and thought count. Empty/metadata-only files can correctly show **0 thoughts — original retained**. Background weaving is separate; do not delay the import receipt for it.
- **Skipped — identical** creates no duplicate thoughts or restoration. **Skipped — changed** keeps the existing import untouched. No force-import, overwrite, rename, reprocess or automatic retry is implied.
- Failed/interrupted files leave no partial canonical source/thoughts; other files continue. A deliberate new import is not Retry/Resume of an old run. Keep submitted identity and honest recovery guidance on transport/read failures.
- Batch reports can be bookmarked/reopened through Recent imports in this flow using existing reads. No folder watcher, retention-duration promise or persistence of unsent selections across reload.
- Original inspection is deliberate user-only history scope. The initial segmentation operation can read submitted bytes; later AI must not retrieve the retained source or use its metadata to bypass rejection. Ordinary eligible imported thoughts open Idea, not a fabricated evolution chain or generic source conversation.

## Illustrative data

The setup has seven Markdown files and one excluded `scan.pdf`. The mixed snapshot is a sealed/processing batch with **7 admitted = 2 imported + 2 skipped + 1 failed + 2 pending** (one running, one uncertain). Imported counts are 3 + 2 thoughts. Existing skipped documents add no new thoughts. File byte sizes are computed from the controlled UTF-8 strings in `study.html`; the copy is byte-identical to its original. Outcomes, IDs and thought mapping are illustrative assignments, not daemon execution or personal data.

The source sample and ordinary Idea link illustrate separately reading an eligible mapped thought. The retained original is not an extra AI-readable thought. Controls in the HTML are design affordances; they do not implement uploads or jobs.

## Reproduction and validation

`study.html` contains only the selected entry/setup/report flow and an embedded snapshot of the incumbent CSS. No rejected layouts are source or rendering dependencies. The original [font](../../brand/fonts/SourceSans3-VariableFont_wght.ttf) and [OFL](../../brand/fonts/OFL.txt) remain in the existing approved packet, without duplication. Palette provenance remains in the [brand manifest](../../selected-assets.json).

With the repository's existing browser tooling:

```sh
bun --no-env-file .impeccable/candidates/markdown-import/render.ts
```

The renderer uses allowlisted, fulfilled Chromium requests: no app server, daemon, provider, dependency install or actual network connection. It writes verification captures only to an owned `/tmp/opencode/` directory, compares all six dimensions and decoded pixel surfaces, checks local links/focus/overflow, and never overwrites the approved images. Pixel comparison permits at most one RGB channel level for native edge antialiasing and reports every difference; it does not promise byte-identical output across browser versions or test future import runtime code. Approved PNG identities are checked exactly.

Current daemon contracts: [Markdown import and source inspection](../../../docs/daemon-api.md#markdown-import-and-source-inspection). Production code, credentials, private configuration, databases, Beads and commits are outside this packet's write scope.
