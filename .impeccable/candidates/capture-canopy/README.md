# Approved Capture canopy

**Status: exact source, desktop placement and phone omission approved; reviewed derivative promoted and Capture integration implemented, with runtime validation/review in progress.** The user said **“please go”**, explicitly authorizing production preparation and integration. The independent test author established behavior-test RED before implementation. No new generation or source change occurred.

The user chose **“while I write”**, then **“Approve and explore”** for the proposed brief and one comp-only Codex concept. The approved brief is persistent broad cropped foliage at Capture's upper-right/unused desktop margin, related to the brand reference and existing clearing, subordinate to writing and Save, with no form/layout change. It stays unchanged across editing/saving/success/error states; no animation or progress meaning. A smaller phone fragment is conditional on safe space; omission is permitted.

Open [the review page](index.html), [the immutable approved source](source.png), [approved desktop comp](review/desktop.png) and [approved phone omission](review/phone.png). [Provenance](provenance.json) records the generation, subsequent approvals and production handoff. The source's request metadata was embedded before exact-image approval; **neither source pixels nor source metadata have changed since approval**.

## Visual direction and findings

- The source supplies one coherent mature-leaf cluster with two gold leaves, cropped from the right. At the intended 196 × 294px desktop display it reads quietly alongside the filled editor; it does not compete with Save or touch Import/form/focus clearance.
- The **native artwork is softer and more halo-like than the original hard cut-paper brief**, although the small composited placement reads much flatter. This was disclosed before exact-image approval. The approved softness is preserved, not silently cleaned up or regenerated.
- The native runner guessed that the dark-looking image might be opaque. Independent inspection establishes real alpha: 1,189,413 fully transparent pixels, 383,451 partially transparent pixels, alpha range 0–254. It is not an opaque dark rectangle, but it does contain soft alpha around some leaves.
- The desktop frame uses the spare right margin below the existing header. Current Capture is 87% wide on desktop. At intermediate desktop widths the frame clips within that available margin instead of moving or narrowing the form.
- **Approved phone treatment: omit the canopy.** Capture is already full-width there; this avoids putting foliage behind text or inventing a new header treatment. The phone comp remains filled, showing the writing experience rather than an empty state.
- The same artwork, frame and treatment remain through editing, saving, saved and not-saved fixture states. It is atmosphere, not feedback. This is not a decision about sticky-on-scroll behavior or a live recovery implementation.

## Evidence and boundary

The original two selected PNGs are **browser captures of test-owned static HTML fixtures**, not actual Next-client integration. They use Capture/global CSS, the bundled font and approved sprout from commit `f04f2fac964dd05a5f587a9bec0f9cf0dea3483a`; historical source fingerprints are in provenance. The illustrative thought/title are test-owned. They remain the approved concept evidence; subsequent application changes do not silently replace these images or their original reference identities. The existing Explore clearing is unchanged.

`review/checks.json` records 12 probes: three viewport sizes × four fixture states, each compared with artwork hidden. All passed with unchanged UI geometry, no overlaps or horizontal overflow, decoded source/font, and a state-invariant desktop canopy frame. This does not establish real submit/recovery behavior, physical-device/keyboard, screen-reader or accessibility certification.

To recapture the static evidence using the already installed Playwright and `/usr/bin/chromium`, from repository root:

```sh
bun --no-env-file .impeccable/candidates/capture-canopy/review/capture.mjs
```

This makes no network calls or app/daemon/provider requests. Saved screenshots are the reviewed evidence; linked UI styles can change on future revisions, so compare the recorded fingerprints before claiming exact reproduction. The original image generation is not claimed byte-reproducible. Native source remains at the historical path recorded in provenance.

## Prepared derivative and reproduction

The [production candidate](production/capture-canopy.png) is **392 × 588 RGBA PNG, 119,427 bytes**, SHA-256 `9a6ea0dff1109922d32862a4b7150bbf846a49153823541a60d0e237b73e02c0`. This is exact 2:3 at 2× the approved 196 × 294px display. The source remains 1,015,545 bytes and SHA-256 `94f3beee00bc89baf7706844e95760608d279830df303fc55b75d31cee4c5ab4`.

The recipe performs **RGBA Lanczos resampling only** and adds mechanical-origin metadata to the derivative. There is no background replacement, new matte, alpha threshold, opacity normalization, halo cleanup, repainting, crop or recentering. Existing transparent space and soft alpha are interpolated along with the colors. Resampling changes pixel counts and can produce alpha 255 through interpolation/rounding; it is not a binary-alpha conversion. The immutable original source is never rewritten.

Requires existing Python 3 and the exact ImageMagick build recorded in the receipt (7.1.2-34 Q16-HDRI). No new dependencies, generation or runtime service is required:

```sh
python3 -B .impeccable/candidates/capture-canopy/build.py --output-dir .impeccable/candidates/capture-canopy/production
python3 -B .impeccable/candidates/capture-canopy/build.py --verify --output-dir .impeccable/candidates/capture-canopy/production
python3 -B -m unittest discover -s .impeccable/candidates/capture-canopy -p 'test_build.py' -v
bun --no-env-file .impeccable/candidates/capture-canopy/review/capture.mjs --production
```

The build and read-only verifier each rebuilt twice from the packaged source: final PNG and receipts matched. An initial verification exposed Python-tuple versus JSON-list receipt comparison; the recipe now emits JSON-native lists and final verification passes. The independent Fixer passed all six controlled tests: four pure size/provenance tests and two explicitly marked ImageMagick integration tests using test-owned RGBA pixels. None reads the approved artwork or production tuning as a unit fixture.

Designer derivative review opened the transparent PNG, the [production desktop placement](review/production-desktop.png) and a paired source/derivative crop at the actual display size. Shape, two gold leaves, color balance, soft edges and transparent gaps remain perceptually consistent. The production-mode static visual probe has 12 passing cases, recorded separately in [production-checks.json](review/production-checks.json); original approved PNGs/checks remain intact. It confirms unchanged UI geometry, state-invariant desktop frame, intermediate clipping and phone omission, not actual app behavior. No duplicate phone PNG is retained because the approved omitted treatment is unchanged.

## Runtime integration

The public filename is [`apps/web/public/backgrounds/capture-canopy.png`](../../../apps/web/public/backgrounds/capture-canopy.png), copied byte-identically from the independently verified production derivative. Source/provenance stay in this package, outside `public/`. Both existing browser harness public-asset allowlists include the promoted PNG; the outer browser test compares it to this package without copying authoring files into the Next fixture.

Capture owns a full-content-width positioning wrapper outside the existing 87%-width form section, without added spacing or semantic regions. The right-edge frame sits below the real header; available width is `min(196px, 13% of inner workspace + page inset - 1rem clearance)`. The image stays 196 × 294px, right/top aligned within the clipped frame. Existing Capture becomes 100% wide at **48rem and below**, where the canopy is omitted. This threshold follows the actual form layout, not an invented phone or height cutoff. Intermediate gutters clip the frame rather than narrow the form. The image follows document flow rather than being pinned/sticky to the viewport. Actual built-client validation of these rules is separate from the static evidence above.

The canopy is unconditional within Capture, not keyed to the save state or disabled opacity. It retains the same asset and document-relative frame through blank/filled/validation, saving, saved, not-saved and uncertain states. It has empty alternatives, hidden decorative semantics, no focus stop/dragging and disabled pointer events. Import and all other routes contain no canopy. The parent coordinates independent final execution and the read-only `bun-typescript-reviewer` review; user runtime acceptance remains separate. No new permission, image generation, splash or adjacent design expansion is needed or authorized.

## Actual-client visual review and validation status

Selected captures come from an **owned production-built Next client**, with test-owned text and the foundation harness's controlled daemon, not the static concept fixture:

- [Desktop writing, 1440 × 900](review/runtime-desktop.png)
- [Phone omission, 390 × 844](review/runtime-phone.png)
- [Narrow desktop gutter, 769 × 900](review/runtime-edge.png)
- [125% root text, 900px viewport](review/runtime-large-text.png)
- [Not-saved state, 1440 × 900](review/runtime-error.png)
- [Geometry, source fingerprints, command outcomes and diagnostic receipt](review/runtime-checks.json)

Designer inspection also opened saving/saved and 900px intermediate captures; those remain ignored scratch rather than duplicate durable screenshots. The foliage keeps the approved appearance, stays subordinate to text/Save, clears Import and focus outlines, and remains unchanged through state transitions. The phone keeps its full-width writing room. The scratch `before-*` labels mean **before a contemplated positioning correction**, not before implementation: **no production positioning fix was made**.

Measured desktop frame/image left is 1244px and form right is 1219.5px: 24.5px clearance at a 16px root. At 769px the uncut image begins at 573px, but the clipped frame begins at 667.25px against form right 651.234375px: 16.015625px clearance. At 900px with a 20px root, the clipped frame begins at 782.203125px against form right 762.1875px: 20.015625px clearance. The visible clipped frame, not the unclipped image rectangle, determines overlap.

`web:typecheck` passed. The first full `web:test:runtime` run failed its new 1440px clearance assertion; the **exact unmodified Capture-test rerun then cleared all layout probes**, before failing because generic `getByRole("alert")` matches both the Capture field error and Next's route announcer. The separate owned-client visual harness completed successfully. The initial clearance failure did not reproduce; asynchronous measurement timing is suspected, not proven. The independent test author owns the field-specific selector and decoded-image/font-ready atomic measurement repair, without weakening the 1rem requirement. Designer did not edit those tests. **Independent final full-suite green, final code review and user runtime acceptance are pending; these images do not claim them.** No harness/build/test was rerun during the final documentation handoff.
