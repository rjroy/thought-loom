# Approved Explore clearing

The exact user-approved wider lantern-and-cat scene is preserved in [source.png](source.png), with its original generation request embedded. [Source provenance](source-provenance.json) records its identity and approval progression. The user approved the exact scene and desktop/phone placement, then said **“please implement”**, authorizing mechanical production preparation and integration. No generation, repainting or silhouette redesign occurred during production.

The transparent derivative was independently verified and visually reviewed before promotion. Its SHA-256 is `8e1d4900bb7f0b465d4d80c63be61352556cccbfcdc4df4c122bf8e05490abfd`; the [production derivative](production/lantern-clearing.png) and [runtime PNG](../../../apps/web/public/backgrounds/explore-clearing.png) are byte-identical. The build receipt's candidate status describes preparation, not current integration. After integration and actual-client review, the user separately accepted the runtime result: **“looks good”**.

## Conversion contract

- Source: 2172 × 724 opaque PNG, SHA-256 pinned in `build.py` and provenance.
- Separate the near-uniform teal backdrop with a color-derived alpha matte. Source dark ink matching that backdrop takes the consumer's ground; cream/gold outlines, lantern, plants and blue hills retain their recorded RGB before resampling. No hand-drawn shape mask or reconstructed silhouette.
- Matte distance is maximum per-channel sRGB distance from `(2, 30, 35)`: transparent through 12, opaque from 36, smoothstep between. These are conversion settings, not product logic.
- Lanczos downsample to **1122 × 374**, preserving exact 3:1 and at least 2× the approved 560px display width. No cropping, recentering or additional composition change is baked into the derivative.
- Output PNG has real alpha. The approved desktop/narrow crop and frame-edge fade remain the consumer's presentation; do not bake them again or stretch the source.
- Consumer: initial ordinary Explore only; fixed 560px image scale, 560 × 168 desktop frame, narrow available-width × 116 left/bottom crop. Decoration is omitted below 360px width or 700px viewport height. These are approved study rules, not physical-keyboard certification.

## Reproduce and verify

Requires Python 3 and installed ImageMagick **7.1.2-34 Q16-HDRI**, exact build checked by the recipe. No installation, provider or daemon is involved. Use an owned, empty candidate directory outside `public/`:

```sh
python3 -B -m unittest discover -s .impeccable/candidates/explore-clearing -p 'test_build.py' -v
python3 -B .impeccable/candidates/explore-clearing/build.py --output-dir /tmp/opencode/explore-clearing-build
python3 -B .impeccable/candidates/explore-clearing/verify.py --candidate-dir /tmp/opencode/explore-clearing-build
```

`build.py` performs two independent passes, writes the PNG and `build-receipt.json`, and refuses `public/` output. `verify.py` independently rebuilds twice, compares candidate bytes and checks real transparent sky, mixed alpha and embedded source provenance. Unit tests use controlled synthetic pixels and explicit tuning; artwork identity/rebuild checks are separate integration validation. Both browser harness asset allowlists include the promoted runtime PNG, not this authoring package. The outer Explore browser test reads the packaged derivative for a served-byte comparison.

## Review and acceptance

The derivative review inspected the source, transparent output, dark/light composites and static desktop/phone placements. The matte removes the teal sky panel without repainting; cat, lantern, plants and hills remain recognizable at intended sizes. The existing frame fade is still needed for hill endpoints, especially the narrow crop. Light-ground inspection checked edges only; light-theme use was not approved. Eight controlled unit tests and four static browser probes passed; build and independent verification each produced two matching passes. Static probes reported unchanged UI geometry/document height, no overlaps or horizontal overflow and compact/short art omission.

The subsequent actual isolated production Next client review used a test-owned fake daemon, not an operator service or personal data. Selected captures: [desktop](review/runtime-desktop.png), 1440 × 900 viewport with a 560 × 168 frame; [phone](review/runtime-phone.png), 390 × 844 viewport with a 350 × 116 frame. The designer also inspected an 800px intermediate width, expanded narrow Filters and doubled root-font specimen. Same-build decoration-hidden comparisons retained identical control geometry; they were not historical before screenshots. The scene retained the approved crops and removed the teal seam.

The focused Explore browser walkthrough, web typecheck and 56 `web-explore` unit tests passed during implementation. This scoped evidence does not establish physical-device, software-keyboard, screen-reader or cross-browser certification. The user separately accepted the actual runtime appearance. No canopy, splash, additional art generation or adjacent UI redesign is authorized by this approval.
