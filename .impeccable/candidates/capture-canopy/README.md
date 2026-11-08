# Approved Capture canopy

The user chose persistent atmosphere “while I write,” approved the exact source, desktop placement and phone omission, then said **“please go”** for preparation and integration. [Source](source.png), [generation request](request.txt) and [provenance](provenance.json) preserve the approved artwork. Soft alpha and the two gold leaves are intentional; do not repaint or regenerate them.

## Production asset

[The derivative](production/capture-canopy.png) is 392 × 588 RGBA PNG, SHA-256 `9a6ea0dff1109922d32862a4b7150bbf846a49153823541a60d0e237b73e02c0`. The immutable source hash is `94f3beee00bc89baf7706844e95760608d279830df303fc55b75d31cee4c5ab4`. The [build receipt](production/build-receipt.json) records the exact conversion environment.

The recipe performs RGBA Lanczos resampling only. No crop, new matte, halo cleanup, opacity normalization or source metadata change is authorized. The public copy at `apps/web/public/backgrounds/capture-canopy.png` is byte-identical to the derivative.

## Consumer and verification

Capture retains its 87%-width desktop form. The 196 × 294px image sits below the existing header, clipped to the unused right gutter with 1rem control clearance. At the existing 48rem full-width-form breakpoint it is omitted. It remains unchanged through all Capture states, follows document flow, and is decorative, noninteractive and hidden from assistive technology. Import and other routes do not use it. Current layout is documented in [DESIGN.md](../../../apps/web/DESIGN.md).

Requires Python 3 and recipe-pinned ImageMagick 7.1.2-34 Q16-HDRI. Verify without replacing approved output:

```sh
python3 -B .impeccable/candidates/capture-canopy/build.py --verify --output-dir .impeccable/candidates/capture-canopy/production
python3 -B -m unittest discover -s .impeccable/candidates/capture-canopy -p 'test_build.py' -v
```

The existing browser companion compares served bytes with this retained derivative and checks placement, clipping, state invariance and phone omission. Historical review captures are no longer needed; [testing concepts](../../../docs/testing.md) describes current controlled checks and their limits.
