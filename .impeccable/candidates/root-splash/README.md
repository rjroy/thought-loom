# Root splash motion study

**Exact motion comp approved; source-preserving preparation and runtime integration implemented. Artwork/motion visual review passed on the initial integration; the shared-header regression is corrected, and final-review R1's no-script/reduced-motion repair awaits independent verification. User runtime acceptance remains separate.** The user first authorized this study with **“Make the motion study,”** then selected **“Approve and implement”** for its exact 2.4-second rhythm, desktop/phone framing, dissolve, root-only navigation and bypass controls. The approved `study.html` and user originals remain immutable. No new generation is authorized or used.

Open [the desktop/phone review page](index.html), then use **Replay both previews**, or [play the standalone study](study.html) at the actual window size. No server or installation is needed. The review controls are outside the proposed splash. The splash itself contains only the supplied scene and **Skip intro**.

## Approved study brief

- **0–0.15s:** landscape present immediately, no empty opening.
- **0.15–1.35s:** existing sprouts/connections appear in overlapping groups, not a frantic literal speed-up.
- **1.15–1.65s:** central plant appears last.
- **1.65–1.95s:** brief completed-constellation hold.
- **1.95–2.4s:** whole scene dissolves into unchanged Explore, including its approved clearing. No zoom, parallax, sound, loops or invented progress meaning.

The intended consumer is only an explicit `/` arrival. Direct `/explore` and deep links remain uninterrupted. The preserved standalone study does not implement route/history/revisit behavior. The application consumes only the promoted WebPs and matching inline reveal geometry, not the review page, screenshots or provenance.

Skip is available immediately outside the illustration; Escape also skips. Underlying reference content is inert and hidden from accessibility APIs while the splash is active. Reduced motion bypasses the intro without an imposed hold, and no-script mode shows the reference. The phone contains the full 3:2 composition centered on dark ground rather than cutting away the writer or constellation. Portrait negative space is intentional; no new mobile art was created.

## Supplied artwork and current Explore truth

`study.html` preserves the **exact two embedded WebP payloads and SVG reveal geometry** from the user's `tmp/brand-imagery-demo.html`. Its masks expose the original constellation above a supplied clean landscape plate. Study assembly added a redundant identical initial mask attribute on the original-art image; the original already supplied one. Browsers accept the duplicate and the approved study remains byte-unchanged. Strict XML extraction normalizes that redundancy in memory only, with a controlled regression test. Timing and presentation are authored separately in the study script. The user source HTML, SVG and build script were not modified, and the source rebuild script was not run.

The separate `tmp/brand-imagery.svg` is a 5.8MB static tracing with 14,089 paths and is not used. This package creates no new artwork, matte, alpha cleanup, raster encoding or generation. [Provenance](provenance.json) pins the supplied files and embedded image payloads.

Explore beneath the dissolve references the existing [desktop](../explore-clearing/review/runtime-desktop.png) and [phone](../explore-clearing/review/runtime-phone.png) actual production-client captures, with test-owned state. They show current navigation, search links/controls and the approved clearing. Comparison from `f04f2fa` to current `de0e7d6` confirms that intervening visual changes touched only Capture's canopy, not Explore/global/header inputs. No screenshots or fonts are duplicated into this package.

**The preserved study's Explore surface is a screenshot, not working controls.** At the exact study viewports it preserves the reference appearance; other widths scale the nearest screenshot, rather than reconstruct the app's responsive behavior. The separately authorized runtime must instead reveal one real Explore presentation, then replace `/` with `/explore`. Study evidence does not establish real navigation, history, focus or physical-device performance.

## Selected visual evidence

Desktop, 1440 × 900:
[opening](review/desktop-0ms.png) · [forming at 0.9s](review/desktop-900ms.png) · [complete at 1.65s](review/desktop-1650ms.png) · [mid-dissolve at 2.175s](review/desktop-2175ms.png) · [Explore at 2.4s](review/desktop-2400ms.png).

Phone, 390 × 844:
[complete](review/phone-1650ms.png) · [mid-dissolve](review/phone-2175ms.png) · [Explore](review/phone-2400ms.png).

Designer opened all eight exact screenshots. The still landscape and authored constellation retain the original character; center-last remains readable in the shorter sequence. The 450ms dissolve intentionally overlaps picture and UI briefly; the Explore interface is not meant to be read until the fade finishes. Desktop/phone compositions keep the whole scene, Skip clear of art, and no horizontal overflow.

## Validation

With the already installed Playwright and `/usr/bin/chromium`, from repository root:

```sh
bun --no-env-file .impeccable/candidates/root-splash/review/capture.mjs
```

The [browser receipt](review/checks.json) records eight timeline samples, real uninterrupted completion on desktop/phone, Skip/Escape, reduced-motion/no-script bypasses, immediate-control geometry and contrast, unchanged original hashes, and zero external requests/script errors. The authoring samples pause the same animations at exact times; separate real-playback checks establish the elapsed duration. This is a local Chromium study, not physical-device, screen-reader or cross-browser certification. No full application build/test, operator service, provider or new dependency is needed or used.

The first bounded browser run passed: actual sequence completion **2408.9ms desktop / 2410.7ms phone**; Skip **56.3ms**, Escape **15.4ms** after animation start; reduced-motion imposed duration **0ms**. The review page was separately inspected at 1600px/390px: both correctly sized previews, Replay and no horizontal overflow passed. Impeccable's static detector returned **zero findings** for `study.html` and `index.html`. These are study-level results, not production readiness.

## Source-preserving production inputs

`build.py` extracts only the approved study's existing WebP bytes and reveal definitions; it uses Python's standard library, with no encoder, installation, new art or dependency on mutable user scratch. The source study is pinned at SHA-256 `4bf00c2ef8d646535449b2ff6e424126258c26b470aad21ac1147376d4780fec`.

| Input | Native dimensions | Bytes | SHA-256 |
| --- | --- | --- | --- |
| [Landscape](production/splash-landscape.webp) | 1536 × 1024 | 640,898 | `1ce48ed5c1ec9547fc8c6167818a666a3ffe00ca4c4501ef9e0d8b516f8a6192` |
| [Completed scene](production/splash-complete.webp) | 1536 × 1024 | 114,906 | `ec9d6e81e99fc90695aa5e5787a896f5fd3300729122520e08991dc455cf52e8` |

Both are **full opaque 3:2 scenes**, not transparent constellation sprites. Landscape stays below completed-scene artwork. [The reveal assembly reference](production/reveal.svg) retains the supplied masks, blur, center hold, 13 connections, 12 peripheral nodes and final central plant, with only timing attributes retargeted to the approved study. Inline matching definitions in the consumer; do not promote this defs-only SVG as a new illustration or rely on cross-document mask IDs. Remove the completed-scene mask at 1650ms, hold to 1950ms, then dissolve the entire opaque overlay through 2400ms. [The extraction receipt](production/receipt.json) records the exact assembly contract and hashes.

```sh
python3 -B .impeccable/candidates/root-splash/build.py
python3 -B .impeccable/candidates/root-splash/build.py --verify
python3 -B -m unittest discover -s .impeccable/candidates/root-splash -p 'test_build.py' -v
```

Extraction and read-only in-memory rebuild verification passed. All six controlled helper tests passed without reading the artwork or production timing as unit fixtures. The initial strict XML parse exposed the duplicate identical study attribute described above; it writes no output before normalization. Designer opened both extracted images, verified their native size with existing ImageMagick and checked byte identity against the exact approved embedded payloads. Byte identity also preserves decoded pixels; no resampling or source metadata rewrite occurred. At the approved display sizes—1218 × 812px in a 1440 × 900 viewport, 390 × 260px on the 390 × 844 phone—these are the same artwork already reviewed in the immutable motion comp. The two public WebPs are promoted byte-identically; no heavy tracing, screenshots or authoring files are shipped.

Independent runtime verification/review and user runtime acceptance follow integration. No additional permission question is needed for this already authorized work.

## Actual runtime handoff

The root page now mounts one real Explore presentation under the fixed scene. A route-aware shared-shell guard applies hidden/inert state directly to the existing skip link/header in server HTML, rather than hiding them only after hydration. It returns a Fragment, preserving their original body-level layout boxes and Explore's sticky-header containing block. The header becomes visually visible during the dissolve while remaining keyboard-isolated. Skip is the only active Tab stop; Escape skips. Completion/bypass replaces root history with `/explore`, allowing the ordinary destination to restore a remembered search URL when present. Direct Explore/deep links do not mount the intro.

The underlying presentation snapshots the existing shared Explore state or the ordinary initial state, without URL synchronization, shared-memory writes, scroll listeners or search execution. It aligns saved scroll once after fonts/layout settle under the opaque fixed overlay, without animating that movement. Destination initialization uses matching remembered content directly, retaining expansion/query and existing restoration/search ownership. No new persistence is introduced. Failed/stalled assets fall through rather than trapping entry; timers/animations/handlers are canceled on skip, completion or unmount. JavaScript-enabled reduced motion bypasses without the 2.4-second hold. With scripts disabled, a scoped noscript-only display rule retains the static fallback and keyboard-reachable Open Explore link under both motion preferences; it does not animate or affect the JavaScript-enabled bypass.

Selected **actual owned production Next-client** evidence, using test-owned data/daemon, not the static fixture:

- [Desktop complete scene](review/runtime-desktop.png) and [desktop dissolve](review/runtime-desktop-dissolve.png)
- [Phone complete scene](review/runtime-phone.png) and [phone dissolve](review/runtime-phone-dissolve.png)
- [Visual geometry, fidelity, source hashes and validation/diagnosis receipt](review/runtime-checks.json)

Designer opened all eight actual opening/hold/dissolve/landing captures; four selected images remain here, with opening/landing and raw trace kept as ignored scratch. These captures predate the shell-containing-block correction below: they establish artwork/motion and cold-arrival composition, **not corrected sticky-header behavior**. Captured display geometry is exactly 1218 × 812px at desktop and 390 × 260px at phone. The completed-art crops match the immutable approved study with **zero differing pixels** in both cases. Captured header visibility/inert behavior matches the sequence at scroll zero, and the landing is real Explore with its existing clearing and controls, not a screenshot. The dissolve was sampled from real uninterrupted playback around 2.217s; it is not presented as the static study's exact 2.175s frame. The artwork, animation and CSS framing are unchanged by the shell correction; its verification remains pending.

### Validation status and corrected regression diagnosis

Final production `web:typecheck` passed; all 56 `tests/web-explore.test.ts` checks passed (148 assertions). The first focused `THOUGHTLOOM_TEST_ROOT_SPLASH=1 bun --no-env-file run web:test:runtime` run reached the warm-provider scroll assertion after ordinary root/history/Skip/Escape/direct-route probes, then exited 1: expected `abs(window.scrollY - savedScroll) <= 2`, received `742`. A second owned diagnostic captured actual visuals and reran the **unchanged warm block**, reproducing that failure and measuring the provider through the real React context.

The trace established the immediate mechanism: the test stored local scroll `742`, then Playwright scrolled the header into view before clicking Capture. The existing listener changed shared remembered scroll to `0` **before** navigating away; root/destination then preserved `0`. **Designer incorrectly classified this as a setup-only defect without checking the existing sticky-header baseline.** The initial programmatic-navigation workaround bypassed a real production regression rather than proving ordinary navigation was preserved.

The independent full foundation run subsequently passed root-splash scenarios on desktop/narrow screens, then failed the existing Explore assertion at `explore.runtime.ts:334`: Capture must remain fully in the viewport after scrolling. Source comparison against `de0e7d6` confirmed the new normal-block shell wrapper contained only the header (the skip link is absolutely positioned). It restricted the unchanged sticky header to a header-height containing block, causing it to scroll away. The minimal correction removes that extra layout box: `RootSplashShell` returns a Fragment and applies the root guard directly to the existing skip/header elements. The existing Explore sticky rule, ordinary navigation, scene, masks and animation are unchanged. The test author independently restores real-user warm navigation; this writer did not edit behavioral tests. Both the failure and earlier mistaken diagnosis remain recorded here.

At the shell-correction handoff, independent final full foundation execution and fresh read-only review were pending. Parent had reported both root-splash viewport scenarios passed before the existing Explore regression was reached; that report did not establish the corrected final tree. In-flight remembered-search resumption is not covered by the completed-search warm fixture. The detector found no primary issues; its two new literal-color advisories are the explicitly approved, documented `#04252d` source-art canvas, with other advisories in incumbent global CSS. No production builds were rerun while the test author repaired warm navigation. No physical-device, screen-reader or cross-browser certification is claimed.

### R1: no-script plus reduced-motion fallback

Final review found that the reduced-motion media rule hid the entire overlay, including its noscript Open Explore link. With scripts disabled, the normal bypass could not run and the inert/hidden underlying workspace provided no alternative. Independent expanded-test RED reproduced the missing visible link at `root-splash.runtime.ts:176`; log `/tmp/opencode/root-splash-nojs-reduced-red.log`. The first bounded repair adds a more-specific overlay display rule **inside noscript only**, retaining the existing static fallback surface/link when scripting is disabled. JavaScript-enabled reduced motion still hides the overlay and navigates immediately; artwork, animation, shell and history are unchanged. Author typecheck passed. An isolated browser sanity fixture using the actual CSS/authored noscript rule passed all four JavaScript/motion combinations, including Tab/Enter fallback navigation in both no-script cases; it is not Next runtime verification. Its scratch receipt is `.lore/local/whimsy-backgrounds/splash-runtime/r1-noscript-sanity.json`. Independent final focused regression/relevant checks and fresh reviewer confirmation remain pending. No actual application build or behavioral-test edit was performed by Designer for R1.
