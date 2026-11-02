---
title: Thoughtloom passage retrieval experiment — small results and revised acceptance criteria
date: 2026-11-01
status: archived
tags: [thoughtloom, passage-retrieval, experiment, fzf, compatibility, performance]
modules: [daemon, search]
related: [.lore/work/design/thoughtloom-passage-retrieval.md, .lore/work/research/thoughtloom-fuzzy-search-algorithms.md, .lore/work/design/thoughtloom-fuzzy-retrieval.md]
---

# Thoughtloom passage retrieval experiment — small results and revised acceptance criteria

> **ARCHIVED EXPERIMENT — canceled, not canonical search guidance.** The user has selected [indexed SQLite FTS5 search with prefixes and bounded typo tolerance](../design/thoughtloom-search-retrieval.md). The fuzzy/passage experiments and reboot reconstruction are not work to resume. The statements below about reopening, running larger profiles, installing candidates, strict matching policy or approval gates are historical; they do not override the current direction. Preserve actual observations and their limits, not an inference of general library unsuitability or an implementation plan. The unfinished reconstruction scaffolding under `attachments/thoughtloom-passage-experiment/` has been removed. The current FTS design records implementation verification and activation state; this historical experiment establishes neither.

The later [repo-owned comparison report](thoughtloom-passage-comparison-harness.md), its source artifacts and raw result snapshots are also archived. They are not an alternative continuation path or a prerequisite for the FTS fix; retirement is left to the parent, not performed by this documentation cleanup.

## Key Findings

- **LATEST USER CRITERION: latency under one second is good.** This supersedes the draft's engineering-selected 150/400 ms p95 adoption gates. The small run's approximately 105–109 ms medians and 164–179 ms p95 are acceptable by the user's latency judgment, not evidence of poor performance at 100 notes. They establish neither 10k/100k capacity nor its absence; actual larger measurements are still needed.
- **The existing experiment is reopened for updated safety review and the already approved informational 10k/100k comparison.** Independent review `ses_e659f7f27ffeO6JfIoNTh9hv5o` previously returned STOP ADOPTION and approved no large profiles under the earlier evaluation. Preserve that historical verdict, but do not turn the superseded latency gates into a permanent ban on measurement. No larger run or engine adoption is authorized by this documentation update itself.
- **BTR-01 records direct, unadapted Unicode behavior, not a settled product-policy veto.** Query `😀` matches `😃x🈀` at UTF-16 positions `[0,4]`, combining different characters' surrogate halves. Query `İ` fails against the identical literal candidate `İ` because query and candidate case folding differ. Those observations stand. The user sees the compared emoji as similar; whether such approximate retrieval is useful or should be excluded requires an explicit matching-policy decision rather than an automatic whole-grapheme veto.
- **The other compatibility disagreements depend on policy.** The producer's 30/36 count describes handpicked expectations under the draft's strict grapheme/case rules, not a global quality score. Base-letter/accent, partial-ZWJ and case false-positive expectations are product choices. Both required plain `sdk` examples passed; the experiment does not show that basic SDK retrieval failed.
- **Post-cap filtering loses recall under the strict whole-grapheme policy.** In that policy's 207-candidate case, 205 decorated-letter matches crowded both required plain SDK strings out of raw top 200. If decorated base-letter matches are accepted instead, they are not invalid hits; this fixture does not establish a policy-independent SDK failure.
- **Timings are credible for this repetitive fixture, not representative capacity.** The original repeat-query p95 remains 163.7 ms (sync) / 178.7 ms (async), with loop-delay maxima 270.1 / 223.7 ms. Repeated filler makes “decision ownership” match 1,092/1,638 passages and “bounded search” 1,170/1,638, versus 2/1,638 for “source fidelity.” Independent phase calibration confirms matcher cost dominates dense queries; it does not replace the original percentiles or justify a linear extrapolation to larger collections.
- Source/history, exact title/body attribution, paragraph/window coverage, original highlight offsets, a pinned old SQLite snapshot, stale hydration rejection, rollback and item/title/capture changes were exercised in a **controlled simulator**, not the production domain/tool boundary. Alias routing and production read witnesses were not implemented or measured here.

## Authority and boundaries

The user explicitly approved the bounded experiment, including temporary exact-version package installation and synthetic 10k/100k-original collections with ideas/titles. The replacement design received fresh independent acceptance in session `ses_e65d81b58ffeIVwNC9UJP6lClI` (provided review evidence). The producer invocation was further bounded to setup, harness preparation and a small compatibility/calibration run, with large runs gated on independent review. That review returned **STOP ADOPTION of this pinned configuration; no large profiles** at that stage. The user's subsequent direction makes sub-one-second latency acceptable and challenges both the stricter engineering gates and the interpretation of similar emoji. The active next step is an **updated safety review** before the already approved informational larger comparison, not automatic rejection or immediate execution. The reviewed design remains `draft`; no matching-policy choice, production implementation or adoption is inferred.

### Latest user threshold supersedes draft performance gates

The 150 ms p95 target at 10k originals and 400 ms p95 target at 100k were self-imposed engineering proposals, not user requirements. They no longer control latency acceptance. The user's stated expectation is **under one second is good**; do not silently replace that with another unagreed percentile requirement. The draft design has not been edited in this report-finalization task, so its old latency table is historical on this point and must not override the newer user direction.

The earlier characterization of roughly 100 ms at 100 originals as inherently poor was too strong. The measured medians and p95 satisfy the user's expressed latency judgment in this fixture. An array scan visits candidates, but that implementation fact does not prove a linear wall-clock scaling curve: text lengths, query density, preparation, caching, allocation and runtime behavior all matter. Measure 10k/100k originals plus their ideas/titles under reviewed resource limits rather than predicting their latency by multiplying the small result. Loop delay and capture/read responsiveness remain useful observations to investigate, not a back door for retaining the superseded latency rejection.

Owned workspace:

`/tmp/opencode/thoughtloom-passage-experiment-p816medg`

Final small-run evidence:

`/tmp/opencode/thoughtloom-passage-experiment-p816medg/runs/smoke-wt_etlaj`

No project package, lockfile, implementation, application database or server was changed. No project tests/builds, private corpus, native/WASM package, model/provider operation, live port, reset, commit, push or remote sync was used. Registry/tarball and official release-source downloads were the only package/research network operations. All fixture databases are beneath the new owned workspace. Earlier inherited worktree changes remain unrelated.

Tracking: `thought-loom-8r5.28.6` is reopened as `open/agentic` for updated safety review and the existing informational comparison scope; it is not marked running or adopted. Parent `.28` remains open and routes that review/experiment scope as agentic. Old phase `.28.5` remains paused/escalated and not accepted; phases `.1`–`.4` remain historical closed work. The independent connection discussion `thought-loom-3xp` is unchanged. Research into Unicode handling or upstream fixes may inform a later adoption decision, but replacing the candidate is not a prerequisite imposed solely by the six strict-policy fixtures. Any different candidate installation still requires separate permission.

## Package and runtime provenance

| Property | Verified value |
| --- | --- |
| Official registry release | [`fzf@0.5.2`](https://registry.npmjs.org/fzf/0.5.2) |
| Repository | `https://github.com/ajitid/fzf-for-js` |
| Registry `gitHead` | `357c8aedaeff3f1af190049fab1c8d03609e7aee` |
| Release-source confirmation | [package.json at that commit](https://raw.githubusercontent.com/ajitid/fzf-for-js/357c8aedaeff3f1af190049fab1c8d03609e7aee/package.json) declares `fzf` version `0.5.2` |
| Tarball | `https://registry.npmjs.org/fzf/-/fzf-0.5.2.tgz`, 21,133 bytes; 18 files |
| SHA-512 SRI | `sha512-Tt4kuxLXFKHy8KT40zwsUPUkg1CrsgY25FxA2U/j/0WgEDCk3ddc/zLTCCcbSHX9FcKtLuVaDGtGE/STWC+j3Q==` |
| Temporary Bun lock SHA-256 | `bbab880fb055542e28e916f69abb44c58efbb9f5b10e4d0b8f64d15d4cc710aa` |
| Installed ES bundle SHA-256 | `15ca63bc5ea4b2be409c74643056fd5f98b6b3b54b7ee0e908177ca8eea67b2e` |
| Execution runtime | Bun `1.4.3`, absolute binary `/home/rjroy/.local/share/mise/installs/bun/1.4.3/bin/bun` |
| Host Node | `v26.13.0`; not the matcher execution runtime |
| Bun's reported Node-compatibility version | `v26.3.0`; recorded separately, not confused with host Node |
| Host | Linux x86_64, AMD RYZEN AI MAX+ 395, 32 logical CPUs; full observation in `evidence/host.json` |

The downloaded tarball matched registry SHA-512 SRI and SHA-1. All 18 installed files were compared to its contents; installed `package.json` is identical too. Registry signatures were saved but **not cryptographically authenticated**: this is distribution-integrity/source-identity evidence, not a publisher-attestation claim. There are no runtime dependency packages. A narrow scan of the executed ES bundle found no fetch/HTTP, dynamic import, eval/Function or child-process calls.

The release is **not the newer dev commit** `cf3903255b6bba6143bfbed5a387f3cadfd6938a` inspected in earlier research. Its installed source says `strToRunes = str.split("")...` at `dist/fzf.es.js:232`: these are UTF-16 code units, despite the internal name. Its per-character case handling also takes only the first code point of a lowercase expansion (`:425–427`). Findings against this published release take precedence over assumptions from newer source.

Installation was confined to this workspace, with an empty owned HOME/cache/temp environment and lifecycle scripts disabled:

```sh
env -i HOME="$PWD/home" PATH=/usr/bin:/bin TMPDIR="$PWD/tmp" \
  /home/rjroy/.local/share/mise/installs/bun/1.4.3/bin/bun --no-env-file \
  install --ignore-scripts --exact --registry https://registry.npmjs.org \
  --cache-dir "$PWD/cache" --no-progress --network-concurrency 2
```

The owned `package.json` pins exactly `"fzf": "0.5.2"`; no global installation or project dependency edit occurred. Metadata, verified tarball, per-file manifest, release package source and provenance are retained in `evidence/`.

## Harness and adapter

| File in owned workspace | Purpose |
| --- | --- |
| `passages.ts` | Natural-paragraph segmentation; 1,024-grapheme / 256-overlap windows; 16,384-UTF-16 cap; coverage/oversized-grapheme accounting; NFC/whitespace preparation and reversible winning-passage position mapping. |
| `compat.ts` | 36 labeled admission cases, sync/async parity, strict-policy SDK crowding case, paragraph/Unicode/seam/coverage/display validation, finder-mutation probe and two-owner cancellation microfixture. |
| `store.ts` | Streaming synthetic canonical SQLite records and passage catalog; current body/title heads and retained versions; 30 ordinary-language body/title annotations; controlled capture/revision operations. **Not production domain replication.** |
| `worker.ts` | Separate seed/catalog/measurement stages; actual published finder construction and query reuse; bounded raw result hydration; loop-delay control; update/rebuild/snapshot probes. |
| `supervise.py` | New per-run directories, clean child environments, exact child ownership, wall/RSS/output/disk/operation guards and a mandatory independent-review gate before larger runs. |
| `README.md` | Reproduction, limits and explicit simulator omissions. |

Exact final harness manifest SHA-256:

`c6ef0c215d0a1d957622726346ce19dad5aec022942bed0cfdf2f3b072a3a640`

The final run's `manifest.json` covers the five executable harness sources, temporary package/lock and executed ES bundle. No harness source changed after that run.

Options actually exercised: `casing: "case-insensitive"`, `normalize: false`, `fuzzy: "v2"`, `sort: true`, `forward: true`, and explicit `basicMatch` / `asyncBasicMatch`, not extended query syntax. Compatibility/crowding limit is 200; ordinary measurement limit is 400 passage hits for 50 grouped entities, with three entities per root and stable title-then-binary ties. All queries are at most 512 input UTF-16 units.

The adapter normalizes each original grapheme to NFC on the scoring surface, coalesces actual Unicode whitespace runs to an ASCII space, and retains original case for library bonuses. A small linear grapheme-key admission oracle uses NFC/lowercase/NFC and exists only to diagnose discrepancies against the draft's strict policy. It does not rank, implement the retired DP, or filter the published library's shortlist. Position maps are reconstructed for selected original passages, included in timed hydration, and mapped to whole original grapheme ranges. Expanding a highlight to a grapheme does not establish eligibility under a strict whole-grapheme rule; whether base-letter matching should be eligible is a separate product choice, not resolved here.

The library still scans prepared arrays, caches a parallel array of character units, and accumulates match/score buckets before applying its final limit (`:1110–1151`, `:1178–1193`, `:1269–1274`, `:1329–1347`). A finite limit is **not** a bounded internal match allocation or a selective text index. Updating an input object's surface did not update the existing finder cache; reconstructing the finder did. Full finder reconstruction is therefore measured after each mutation rather than described as incremental support.

## Actual compatibility results

The final smoke's `compat.json` records all 36 cases and returned positions. Sync and async admission/results agreed on those small inputs. Thirty expectations agreed and six did not under the producer's strict whole-grapheme/case policy. That count is not a representative quality score, and policy-dependent disagreements must not be conflated with the independently reproduced direct library defects below.

Passed examples include query `sdk` against **both `SoftwareDevelopmentKit` and `shoulD Know`**, plus `Software Development Kit`; required query whitespace against tab/NBSP/runs; missing-whitespace and punctuation decoys; literal `*`, quotes, pipe, caret/dollar and backslash; repeats/reordering; decomposed NFC accents; sharp-S distinctions; non-Latin text; and source-offset mapping (`é` maps back to original `e` + combining mark).

| Query → candidate | Producer's strict-policy expectation | Published release with adapter |
| --- | --- | --- |
| `i` → `İ` | No match | Match: false positive |
| `İ` → `İ` | Match | No match: false negative |
| `q` → `q` + combining acute | No partial-grapheme match | Match |
| Combining acute → `q` + combining acute | No partial-grapheme match | Match |
| `👩` → `👩‍💻` | No partial-ZWJ-grapheme match | Match |
| `😀` → `😃x🈀` | No match | Match by stitching surrogate halves from different characters |

The crowded SDK case uses 205 passages containing `s`/`d`/`k` each decorated with a combining slash. Under the draft's strict whole-grapheme policy these are not the query's keys, but the package accepts and scores their base code units. All raw top-200 results were invalid **under that policy**; both plain SDK strings were omitted. This disproves a post-cap filter as a recall-preserving repair of that strict policy, not SDK matching under every possible policy. If decorated base-letter matches are accepted, their admission is not itself erroneous. No filter or complex custom matcher was added, and no product policy was changed.

The two-owner 2,200-small-candidate cancellation microfixture observed the first query reject with `"search cancelled"`, its same-instance replacement complete, and an independent finder owner's query complete. Total microfixture elapsed time was 19.9 ms. The public API does not expose general AbortSignal cancellation; replacement is per finder instance, and cancellation checks occur between batches of 1,000 (`:1210–1227`, `:1312–1319`). This does not establish production scheduling, hard-deadline interruption or worst-case cancellation latency.

## Small fixture and measured outcomes

Final invocation, from the owned workspace:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 supervise.py --profile smoke
```

The complete pipeline took **16.56 seconds**, below its 30-second ceiling. Fixture generation streamed into SQL in ten-original batches rather than retaining the corpus before indexing. Original bodies used the 80%/18%/2% 1/4/64 KiB mixture, with both paragraph-rich and unbroken long bodies. Current ideas used 1/2 KiB. Actual initial totals:

- 100 originals; 200 current ideas; 300 current titles; 200 retained historical item formulations.
- 286,720 original-body bytes and 307,200 current-item-body bytes, excluding title/history storage.
- 600 current searchable fields; **1,638 passages**; zero exceptional omissions in this collection.
- Seed child observed peak RSS 28.3 MiB; catalog child 55.2 MiB. The larger prepared generation is built only in the measurement child, where it is counted.

| Measurement, final fixture only | Fzf sync | AsyncFzf |
| --- | --- | --- |
| Surface preparation / initial finder construction | 53.6 / 10.7 ms | 49.4 / 11.2 ms |
| 30 repeat ordinary queries p50 / p95 / maximum, including hydration | 104.6 / 163.7 / 181.2 ms | 109.4 / 178.7 / 188.8 ms |
| Maximum measured loop delay across 60 first/repeat ordinary queries | 270.1 ms | 223.7 ms |
| SDK query elapsed / measured loop delay | 41.0 / 41.0 ms | 38.4 / 38.3 ms |
| 30 annotated entities found within first 20 | 30/30 | 30/30 |
| Expected original/idea/title/body field attribution | All 30 scenarios | All 30 scenarios |
| Item/title/capture mutation to reconstructed generation | 57.8–64.2 ms | 55.5–63.5 ms |
| Sequential canonical mutation writes, three samples | 0.22–0.69 ms | 0.19–0.61 ms |
| Observed process peak RSS across build/query/reconstruction | 158.1 MiB | 226.2 MiB |

The annotated queries are test-owned ordinary phrases such as “decision ownership,” “source fidelity” and “bounded search,” with source/idea distractors and four title-only scenarios. They are not live-corpus relevance judgments or evidence that weaving produces meaningful connections. Earlier producer calibrations used unique marker queries; their much lower timings are **not** the final ordinary-query results and must not replace the table above.

The event-loop monitor was primed and drained outside the query timer. A deliberately bounded 25 ms blocking control produced 24.7 / 25.1 ms measured loop delays, demonstrating that synchronous blocking was not reported as zero merely because no timer fired during the query. Detailed first/repeat samples, absent and maximum-length query probes, mappings and update allocations are retained in `measure-sync.json` / `measure-async.json`.

The recorded loop stalls exceed an engineering-proposed 50 ms maximum, and the repeat-query p95 exceeds the now-superseded 150 ms proposal. Those comparisons are not grounds to reject the measured query latency under the user's latest sub-one-second expectation. Retain the observations for responsiveness and safety review, but assess larger-collection performance from actual measurements rather than a presumed linear curve. No 10k/100k numerical result is established by this small run.

The simulator preserved an old SQLite snapshot across committed item/title/capture mutations, hydrated its represented version correctly, rejected old-generation hydration against newer heads, retained history, rolled back a deliberately failed mutation, and refused original-text updates. Each new prepared generation rebuilt the entire finder while old/new prepared state coexisted. This is not evidence of production atomic rebuild/catch-up, late-publication fencing, read witnesses or writer latency during active matching.

## Independent review and outcome

Independent session **`ses_e659f7f27ffeO6JfIoNTh9hv5o`** returned **STOP ADOPTION for pinned `fzf@0.5.2` with the tested configuration; no large profiles**. This is the historical verdict before the latest user clarification, not a new prohibition on the already approved informational comparison after updated safety review. This section records the supplied independent findings; finalization did not rerun them or alter the raw workspace.

**BTR-01: direct, unadapted Unicode observations.** The reviewer bypassed the producer adapter and verified that `😀` retrieves `😃x🈀` at positions `[0,4]`, a surrogate-half alignment rather than equality of the requested Unicode character. The identical-literal `İ` query/candidate pair also fails directly because query/candidate case transformations differ. These facts identify behavior and case-handling limitations to consider; they are not, without an agreed product policy, automatic reasons to cancel informational performance measurement. The user regards the compared emoji as similar, which must be considered when deciding desired fuzzy admission. Do not claim that code-unit stitching implements a principled emoji-similarity algorithm, but do not assume exact grapheme equality is the user's settled acceptance criterion either. The other policy-sensitive fixture expectations remain documented as such; “six failures” is not a global quality score or an automatic adoption veto. Adoption remains undecided.

**Density and phase calibration.** Repeated filler in `store.ts:67–70` makes this corpus highly repetitive, not a model of ordinary private notes. Independent diagnostic match counts were:

| Query | Matching passages / 1,638 | Warm matcher diagnostic | Mapping diagnostic |
| --- | --- | --- | --- |
| `decision ownership` | 1,092 | 119–124 ms | 2.8–4.4 ms |
| `bounded search` | 1,170 | 112–123 ms | 2.1–3.8 ms |
| `source fidelity` | 2 | 7.5–8.6 ms | approximately 0.1 ms |

These diagnostic ranges show that matching dominates the dense cases; mapping is not the main cause of their timings. They are not replacement p95 samples, a corrected real-corpus distribution, or a full-capacity result. The original producer timing table is unchanged. The review's tiny calibration took approximately **1.97 seconds / 190 MiB**, with no files written, dependencies installed or large profiles executed.

**Revised outcome and next boundary.** Reopen the existing experiment for updated safety review, using the user's sub-one-second expectation and retaining the already approved 10k/100k informational scope. That review must establish safe execution/resource bounds and truthful result labeling; it must not reject a larger measurement solely because the small run exceeded self-imposed 150/400 ms gates or a still-undecided whole-grapheme policy. Only after updated safety approval may the separate experiment invocation measure those collections. Retain the raw harness/evidence unchanged in this task. No new candidate, package installation, production change, engine adoption, old whole-field implementation resume or matching-policy revision is authorized here.

## Retained guards and remaining limits — updated safety approval pending

Only `smoke` was run. Attempts to invoke `10k` and `100k` without an independent review artifact were refused **before fixture creation**. Prepared profiles also include nominal 300k/1m-passage stress populations; actual counts must be reported, not forced by omitting text or inferred from the profile name.

The retained harness mechanically requires an artifact containing `reviewSession`, `harnessSha256` and `approvedProfiles` for larger runs, plus `--informational-incompatible-baseline` because its current strict-policy diagnostic sets an incompatibility flag. That flag's existing name does not decide product policy or adoption. The prior review approved no large profiles; an **updated** review is needed before using the user's existing approval to execute the informational comparison. Commands, guards and profile definitions remain unchanged in this task. This documentation update itself is not the execution approval artifact.

| Guard | Small run | Prepared larger profiles |
| --- | --- | --- |
| Overall wall clock, including seeding/copies | 30 seconds | 600 seconds |
| Process RSS/HWM ceiling | 512 MiB | 1 GiB at 10k / 3 GiB at 100k |
| Seed/catalog process ceiling | 256 MiB | 256 MiB |
| Owned run fixture-disk ceiling | 64 MiB | 4 GiB / 16 GiB |
| Aggregate result/log ceiling | 25 MiB | 25 MiB |
| Prepared generation construction | 5 seconds | 30 / 180 seconds |
| Timed query safeguard | 1,000 ms | 1,000 ms |

The supervisor reads only its exact child PID's RSS/HWM every approximately 20 ms, uses a clean environment, applies `RLIMIT_CPU` to **CPU time**, disables **core dumps** through `RLIMIT_CORE`, and kills only that Popen child on breach. There is no CPU-core-count restriction: the retained README's “CPU/core guards” shorthand must not be read that way. There is no kernel memory quota: sampling and operation enforcement can overshoot by polling/scheduling, with 50 ms operation tolerance explicitly recorded. Bun's large virtual reservation makes a small address-space limit unsuitable. File-copy disk capacity is checked before each engine fixture copy. No other PID, listener, service or process group is touched. Actual workspace size after the producer's small runs was approximately 23.4 MB, including retained earlier evidence.

Remaining gaps are explicit: no large scale/cold-restart capacity evidence; no alias fan-out measurement; no production scheduler/AbortSignal integration; no production domain/tool/read-witness integration; no concurrent writer-latency measurement during matching; no production atomic full rebuild/catch-up implementation. Native/WASM or another package was not installed. Unicode and case behavior require explicit evaluation against the user's desired retrieval, not automatic promotion of the six strict-policy fixtures into a veto. Informational timing can proceed after updated safety review without deciding adoption first. Any new candidate installation remains outside this task and requires separate permission.

## Producer corrections and verification record

- The first smoke stopped on a harness CRLF segmentation assertion: regexp backtracking treated one CRLF as two line breaks. The segmentation expression was corrected to keep CRLF indivisible; the final run passed CRLF, paragraph exclusion, late-body and seam coverage, Unicode window edges, 16k-unit cap, oversized-grapheme disclosure, display escaping and input validation checks. The failed run is retained as `runs/smoke-rkxy0n2_`, not called library evidence.
- Two successful intermediate calibrations are retained separately. Final ordinary-language annotations and final harness bytes are identified by the manifest and run path above; earlier marker-query timings are superseded, not combined with final percentiles.
- An initial provenance hypothesis that Bun added `type=module` was disproved by an explicit package JSON comparison: the verified tarball already has that property. The retained `provenance.json` corrects the record. All installed files match the archive.
- Project `package.json`, `bun.lock` and the reviewed passage design hashes matched the pre-experiment snapshot at producer handoff. No project test/build, large collection, adoption or capacity claim follows from that smoke. Subsequent independent rejection/closure is retained as history; the latest user direction reopens evaluation under sub-one-second latency acceptance, with updated safety review before already approved informational larger measurements.
- Finalization changed this report and Beads records only. It ran no tests, calibration, build, installation, large profile or application operation, and left the raw experiment workspace and draft design untouched.
