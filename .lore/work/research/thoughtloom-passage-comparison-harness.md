---
title: Repo-owned passage comparison harness preparation
date: 2026-11-01
status: archived
tags: [thoughtloom, experiment, reproducibility, passage-comparison, fzf]
related: [.lore/work/design/thoughtloom-search-retrieval.md]
---

# Repo-owned passage comparison harness preparation

> **ARCHIVED / SUPERSEDED — canceled experiment, not work to resume.** Current direction is [indexed SQLite FTS5 search with prefixes and bounded typo tolerance](../design/thoughtloom-search-retrieval.md). The abandoned executable harness and temporary package scaffolding have been removed; the paths and manifests below describe historical artifacts, not files to restore or commands to run. Small JSON observations remain only as historical evidence. The current FTS design records source verification separately from live activation; this experiment establishes neither.

## Key findings and scope

- This historical record describes the former repo-owned experiment source under `tests/performance/passage-comparison/`. That canceled source directory has been retired, not moved into the application.
- **Superseded artifact, not a pending review candidate.** The manifest below identifies historical bytes. No further comparison, installation, preparation or larger profile belongs to the current FTS fix. Only small smokes were recorded; no 10k/100k collection was executed in this preparation task.
- Eight regression groups passed. The final small synthetic collection contained 100 originals, 200 current ideas, 300 titles, 200 historical formulations, 600 indexed current fields and **1,615 passages**. It completed in **2.53 seconds**, without a resource guard breach or quota error.
- This isolated comparison does **not** change the [current FTS5/prefix/typo search direction](../design/thoughtloom-search-retrieval.md), adopt fzf, or establish production integration/capacity. Package Unicode observations are retained as information, not an automatic matching-policy veto.

## Durable inputs and evidence

Repo-owned files:

- `tests/performance/passage-comparison/harness.ts` — synthetic SQL generation, paragraph windows, NFC/whitespace preparation, published Fzf/AsyncFzf calls and original-offset hydration.
- `tests/performance/passage-comparison/regressions.ts` — explicitly invoked small regression checks, not part of ordinary application test discovery.
- `tests/performance/passage-comparison/worker.ts` — isolated stage entrypoint and representative query measurements.
- `tests/performance/passage-comparison/run.py` — pinned temporary setup, new-manifest review gate, owned-child limits, bounded recording and exact fixture cleanup.
- `tests/performance/passage-comparison/{package.json,bun.lock,package-pin.json,README.md}` — isolated manifest, published pin, provenance expectations and reproduction instructions. This nested package is outside the project's `apps/*` / `packages/*` workspace globs.

Historical temporary-workspace reference: `/tmp/opencode/passage-comparison-nf8svl5r`. Its existence and contents are not revalidated by this documentation cleanup.

Durable setup/provenance and full input hashes:
`.lore/work/research/passage-comparison-results/setup-passage-comparison-nf8svl5r.json`.

The small smoke observations below summarize two retired raw snapshots. Their detailed candidate and normalization dumps are no longer retained, so this is historical evidence rather than a complete reproducibility record:

| Original snapshot path | Bytes | Lines | Original SHA-256 | Elapsed |
| --- | ---: | ---: | --- | ---: |
| `.lore/work/research/passage-comparison-results/smoke-fp0t7y7x.json` | 987,222 | 35,875 | `587956e25d24399914b444adcef47ba69955da197458247a6789d9aa06e953d3` | 2.481057 seconds |
| `.lore/work/research/passage-comparison-results/smoke-tfr94zdf.json` | 987,288 | 35,875 | `cd58a7309434e64783844ed7ad136367c6ced5c8c280e6b5d84542676e1e444d` | 2.529381 seconds |

Both used the `smoke` profile in the historical workspace named above. The regression, seed, catalog, sync and async stages returned zero with no recorded guard breach. Both recorded `productionAdoption: false` and `scaleEstablished: false` and removal of their exact generated SQLite files after result writing. The timings are observations of synthetic input, not FTS performance or a capacity claim.

Review-gate refusal evidence:
`.lore/work/research/passage-comparison-results/guard-refusal.json`.

**Manifest SHA-256:** `d8173698e639e6a3303874f160f906d1bf7565262b4aa1e92ad744d832c551dc`.

The manifest covers all eight repo-owned input files and the executed published ES bundle. Source and staged hashes matched after the final smoke. Root application `package.json` and `bun.lock` also matched their pre-install hashes. No project runtime dependency or lockfile was changed; no source, test or service outside this experimental directory was changed by that task. The retired final source made partial/resource-limited outcomes exit 2 rather than false-success 0. No second package installation was needed.

## Published package and runtime

The temporary install is exactly `fzf@0.5.2`, repository `ajitid/fzf-for-js`, registry `gitHead` `357c8aedaeff3f1af190049fab1c8d03609e7aee`. Official-registry metadata, fixed SRI and all **18 installed tarball files** were verified. Lifecycle scripts were disabled and the isolated lockfile was frozen. No other dependency, global package, native helper or provider/model was used.

SRI: `sha512-Tt4kuxLXFKHy8KT40zwsUPUkg1CrsgY25FxA2U/j/0WgEDCk3ddc/zLTCCcbSHX9FcKtLuVaDGtGE/STWC+j3Q==`.

ES bundle SHA-256: `15ca63bc5ea4b2be409c74643056fd5f98b6b3b54b7ee0e908177ca8eea67b2e`.

Execution: Bun **1.4.3**; host Node **26.13.0**. Bun reports its separate Node compatibility version as `v26.3.0`. Registry signatures were not independently authenticated; the evidence is pinned distribution-integrity/payload verification, not publisher attestation.

## Actual small results

Regressions cover paragraph/CRLF boundaries, full coverage/seams, the 1,024-grapheme/256-overlap/16,384-unit window bounds, explicit oversized-grapheme omission, both plain SDK examples, actual query whitespace, literal punctuation, repeats, NFC original offsets, query validation, current-only catalog/history retention, a pinned SQLite read snapshot, cache reconstruction and instance-local async replacement. The primed/drained monitor detected a controlled 25 ms block at **25.59 ms**. These are fixture/simulator checks, not production domain, read-witness or migration tests.

The raw pinned library still matches `😀` against `😃x🈀` at code-unit positions `[0,4]`, and an `İ` query fails against literal `İ`. Those behaviors are recorded without adding a custom matcher or filtering results after a cap.

The fixture uses repetitive controlled prose, source body strata 80%/18%/2% at 1/4/64 KiB, and 1/2 KiB current ideas. Actual current body bytes: **593,920**. There were no exceptional omitted ranges in this collection. Query representatives are separated rather than averaged into a purported real-corpus p95:

| Repeat query, including hydration | Fzf sync | AsyncFzf |
| --- | --- | --- |
| `source fidelity` | 12.56 ms | 13.54 ms |
| `decision ownership` | 128.35 ms | 140.84 ms |
| `bounded search` | 110.84 ms | 123.92 ms |
| `sdk` | 39.45 ms | 43.85 ms |
| Absent literal query | 10.75 ms | 8.41 ms |

Sparse query returned three raw passage hits; the dense probes reached the configured 400-hit return cap. That capped count is **not** total match density. Full finder preparation/construction took 57.74 / 61.42 ms. Observed sync/async peak process RSS was **138.87 / 137.88 MiB**; seed/catalog peaks were **32.30 / 58.50 MiB**. All observed queries were under the user's one-second working guideline. No linear scale prediction, representative p95, selective-index claim, adoption decision or 10k capacity follows from these samples.

## Lifecycle and safety boundary

Setup capacity preflight reported `/tmp` total **16,626,835,456 bytes**, available **16,567,775,232 bytes**. This was a targeted capacity check, not a quota-cause investigation. No quota failure occurred.

The run reused one generated fixture DB for both read-only engine processes. After bounded results were written and flushed to the durable JSON, only the exact generated database/WAL/SHM paths listed in `cleanupTargets` were deleted; their absence was verified. No DB copies or large fixtures remain from this smoke. Package cache and bounded logs remain temporary; no databases, binaries or node_modules were added to the repo.

One cooperating run at a time; exact Popen-child-only observation/termination. Smoke: 30 seconds / 512 MiB process RSS / 64 MiB run disk. Prepared 10k: 600 seconds / 1 GiB process RSS / 4 GiB run disk; seed/catalog capped at 256 MiB, catalog/finder construction at 30 seconds, query operations at a one-second informational safety limit with 50 ms watcher tolerance. RSS is sampled, not a hard kernel quota. Logs are bounded at 25 MiB; durable summaries at 2 MiB with atomic replacement. CPU-time and core-dump limits do not restrict CPU-core count.

**Any quota/storage-full error means stop and tell the user to clear storage.** No cleanup, retry or quota-cause investigation follows such an error. Normal exact fixture cleanup occurs only after durable recording. The one-second timing safeguard is not a universal user acceptance requirement or the abandoned 150/400 ms gate.

## Canceled continuation and parent-owned retirement

The earlier preparation observed the 10k entrypoint refusing a request without a review artifact before creating a run directory or fixture. That historical observation is not a reason to seek a new review or continue the comparison. The former larger-run recipe and temporary-workspace preparation instructions are withdrawn from this report: **do not run them as part of the current work**.

The obsolete source files under `tests/performance/passage-comparison/` and `.lore/work/research/attachments/thoughtloom-passage-experiment/` have been retired, as have the two verbose raw smoke snapshots. The small setup and refusal records remain as historical evidence. Former internal flags or README instructions are not current task authority.

The archival cleanup did not rerun the experiment or establish live activation. The approved FTS direction and original product vision are unchanged.
