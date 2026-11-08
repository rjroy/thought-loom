# Approved root arrival

The user approved the exact 2.4-second motion study and chose **“Approve and implement.”** The immutable [study](study.html) preserves the supplied embedded artwork, reveal geometry and approved timing; [provenance](provenance.json) records source identity. No new art, tracing, encoder or resampling is involved.

## Retained source and production files

`study.html` has SHA-256 `4bf00c2ef8d646535449b2ff6e424126258c26b470aad21ac1147376d4780fec`. It loads the retained [Explore desktop](../explore-clearing/review/runtime-desktop.png) and [phone](../explore-clearing/review/runtime-phone.png) references beneath the dissolve. Those two captures are required study inputs, not a general screenshot gallery. The study's Explore controls are static references; the application reveals real Explore instead.

| Exact extracted payload | SHA-256 |
| --- | --- |
| [Landscape](production/splash-landscape.webp) | `1ce48ed5c1ec9547fc8c6167818a666a3ffe00ca4c4501ef9e0d8b516f8a6192` |
| [Completed scene](production/splash-complete.webp) | `ec9d6e81e99fc90695aa5e5787a896f5fd3300729122520e08991dc455cf52e8` |

Both are opaque 1536 × 1024 scenes. [Reveal geometry](production/reveal.svg) and the [extraction receipt](production/receipt.json) preserve masks and assembly. Public WebPs are byte-identical. Do not substitute the separate heavy SVG tracing or ship the study as runtime UI.

## Implemented behavior

Only an explicit `/` visit plays the arrival; direct Explore and deep links bypass it. Landscape appears immediately, peripheral connections form from 0.15–1.35s, the center forms from 1.15–1.65s, the completed scene holds until 1.95s, then dissolves through 2.4s. No zoom, loops, sound or progress meaning is implied.

Skip is immediately available; Escape skips. Reduced motion bypasses animation. Without scripting, a visible Open Explore link remains available, including under reduced motion. Shared content stays inert/hidden until handoff; a Fragment preserves the existing sticky-header layout. The underlying real Explore snapshots remembered state read-only, then the destination owns URL/search restoration after history replacement. Failed artwork falls through rather than trapping entry. Current implementation details belong to [DESIGN.md](../../../apps/web/DESIGN.md).

## Reproduce and verify

The standard-library recipe extracts existing payload bytes and normalizes a redundant duplicate SVG attribute in memory only; it never changes the approved study. Controlled helper tests distinguish extraction logic from actual-art identity checks.

```sh
python3 -B .impeccable/candidates/root-splash/build.py --verify
python3 -B -m unittest discover -s .impeccable/candidates/root-splash -p 'test_build.py' -v
```

Current browser checks cover entry, history handoff, warm navigation, Skip/Escape, direct-route bypass and reduced-motion/no-script behavior. See [testing concepts](../../../docs/testing.md). Removed historical captures and review scripts are not current verification dependencies or accessibility certification.
