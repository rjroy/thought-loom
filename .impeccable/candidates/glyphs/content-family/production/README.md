# Nine production asset candidates

**All nine exact source artworks and prepared derivatives are user-approved. Idea/Explore/Evolve integration passed independent verification and was accepted in-app by the user.** Implementation followed the orchestrator's confirmed independent RED checks. See [controlled in-app evidence](../integration-review/README.md). The package contains exactly seven SVGs and two PNGs in [runtime/](runtime/). The rejected relationship SVGs are excluded.

## Review evidence

- [Full family on Quiet Night](review/family-dark.png): nine production candidates plus the unchanged accepted lantern/sprout as references, with **actual 16/20/24px** samples.
- [Light-ground inspection](review/family-light.png), not an approved light theme.
- [PNG source → prepared candidate, dark](review/raster-before-after-dark.png) and [light](review/raster-before-after-light.png).
- [Measured validation](review/statistics.json), [source/output identities and sizes](build-report.json), [approval/provenance](provenance.json).

All four boards and both full-resolution prepared PNGs were opened and inspected. The chain retains the approved over/under join, two open ring centers and smaller central opening. The source mark retains the plain page, gold arrow and full leaf as three separate forms. Cleanup removes free-floating alpha residue; projected-size dark/light comparisons show no visible background debris or new joins. Minor original edge-color variation and the **approved shading** remain; these are deliberately not flattened to SVG-like colors.

The chain is slightly larger within its canvas than the source pilot so it carries comparable weight to the existing family; the page/arrow/leaf is uniformly centered with safe padding. No nonuniform scaling, geometry redraw or vectorization occurred. Seven SVGs remain byte-identical, including their accepted differences in optical mass and proportions. **Used as source is still label-dependent at 16px**; 20/24px are clearer. This preparation does not promise new standalone recognition.

## Exact selected inventory

| Meaning | Approved packaged input | Production candidate | Bytes |
| --- | --- | --- | ---: |
| Original capture | [revised SVG](../revised/captured-original.svg) | [SVG](runtime/captured-original.svg) | 527 |
| Contribution | [revised SVG](../revised/user-contribution.svg) | [SVG](runtime/user-contribution.svg) | 371 |
| Interpretation | [original SVG](../ai-interpretation.svg) | [SVG](runtime/ai-interpretation.svg) | 398 |
| Developing idea | [original SVG](../developing-idea.svg) | [SVG](runtime/developing-idea.svg) | 644 |
| Imported source | [original SVG](../imported-original.svg) | [SVG](runtime/imported-original.svg) | 322 |
| Full reply | [original SVG](../full-reply.svg) | [SVG](runtime/full-reply.svg) | 653 |
| Evolution | [revised SVG](../revised/evolution.svg) | [SVG](runtime/evolution.svg) | 567 |
| Discovered connection | [approved PNG](../raster-relationships/connection.png) | [cleaned PNG](runtime/connection.png) | 288,419 |
| Used as source | [approved PNG](../raster-relationships/used-as-source.png) | [cleaned PNG](runtime/used-as-source.png) | 149,227 |

All SVGs retain square 1024 dimensions and `viewBox="0 0 1024 1024"`; PNGs are **1024×1024 RGBA**. Only one production file per asset is supplied, not separate per-size exports. Source/runtime hard byte budget remains **unknown**; the two full-resolution PNGs prioritize retained source detail. They are larger than tiny icon exports; no browser payload or performance approval is claimed. All exact SHA-256 values are in the linked build report and provenance.

The existing consumer hierarchy remains 20px leading material/record-role cues, 24px focused Idea, 16px relationship companions. Full reply is a record role, not a sixth material kind. Evolution ancestry, discovered connection and used-as-source provenance stay distinct, and visible accessible text labels remain necessary. No author icons, new actions or daemon classification changes.

## Approval record

The source records document the four selected keepers, the user's **“yes”** to **“Are the revised Original Capture, Contribution and Evolution glyphs approved too?”**, and **“those are good”** for the two exact PNGs. The user then answered **“yes”** to:

> All nine artwork selections are approved. Shall we prepare the runtime-ready assets next, including cleaning the two PNGs’ transparency, while keeping app integration separate?

That answer authorized reproducible production preparation, not integration at that point. Subsequently the user approved the exact prepared derivative set with **“go”**, then answered **“yes approved you can integrate”** to:

> Production assets approved. Shall I now integrate all nine across Idea, Explore and Evolve at the agreed placements?

Derivative approval binds the nine output paths and SHA-256 identities in [provenance](provenance.json) and [build report](build-report.json). After the Idea/Explore/Evolve runtime previews, the user answered **“yup”** to **“Do these in-app placements work for you?”** Independent verification and review are recorded in the integration evidence. These approvals do not authorize new artwork, redesign or use of rejected relationship SVGs. Older failure reports and preparation receipts are retained as history; earlier pending-approval/cleanup-not-yet-authorized fields describe their earlier gate, not the latest authorization here.

## Reproducible recipe

Installed **ImageMagick 7.1.2-34 Q16-HDRI** is explicitly version-checked by the recipe. It reads immutable package inputs and checks their pinned hashes. No new tools, provider calls or Codex runs are needed.

Seven SVGs: byte-for-byte copy only, no optimization or framing transforms. Two PNGs:

1. Decode unassociated 8-bit RGBA from the original approved 1254×1254 PNG.
2. Find 8-connected components at alpha ≥128. Keep components of at least `ceil(width*height*0.005)` = **7,863 pixels**. These exact sources have one qualifying chain component and three qualifying page/arrow/leaf components; no substantial core pixel is removed.
3. Retain source alpha/RGB within a one-native-pixel envelope of those components; zero all other pixels, including hidden RGB. Stabilize near-opaque alpha ≥250 to255. Retained foreground RGB remains **exactly unchanged before resampling**, preserving approved shading. Ordinary antialiased edge alpha is kept, not thresholded into a jagged binary silhouette.
4. Trim only transparent space, add four transparent pixels around the crop, uniformly fit to a **760×760 maximum box**, and center on transparent **1024×1024**. Use Lanczos, 8-bit RGBA PNG, stripped metadata, excluded date/time chunks, lossless compression level9. No palette quantization or WebP conversion.

`build.py` performs **two complete passes, reloading every original source**, compares all nine output byte strings and reports, then writes the candidates. Both passes matched exactly. It writes only its owned runtime outputs and build receipt; authoring inputs are never changed.

From repository root, all commands exited **0**:

```sh
python3 -B -m unittest discover -s .impeccable/candidates/glyphs/content-family/production -p 'test_build.py' -v
python3 -B .impeccable/candidates/glyphs/content-family/production/build.py
python3 -B .impeccable/candidates/glyphs/content-family/production/verify.py
```

Five tests use **controlled synthetic pixels**, not live artwork: ring holes/shaded RGB/antialiased edges and isolated noise; three separate components; diagonal connectivity and canvas bounds; repeatability and immutable input; invalid/empty input fails closed. The actual-source integration checks are separate.

## Measured validation and limits

- **268 prior artwork/evidence/reference/runtime/passive-tracker fingerprints unchanged**, including approved sources, rejected SVGs, existing lantern/sprout and both runtime SVGs.
- Seven copied SVGs pass restricted standalone-vector safety: no scripts/events, raster embedding, external dependencies, text/fonts, CSS, gradients, masks or animation. Exact cream/gold fills retained; only the already-approved Evolution translation is present.
- All nine decode/render with real transparent and fully opaque pixels and **at least128px fully clear padding**. Connection's nonzero-alpha bounds are `[136,140,887,883]`; Used as source `[133,356,890,667]`.
- Connection has **222,648 fully opaque pixels** (source1,563), Used as source **133,021** (source1,678). Antialiasing remains at legitimate edges. Main thresholded chain topology remains one connected foreground with three interior negative spaces; page/arrow/leaf remain three disconnected foreground components. Component evidence is retained in `review/*-components.txt`.
- Review SVG renderer: **rsvg-convert 2.63.3**, Cairo **1.18.6**. RGB is source sRGB; no unapproved palette flattening. Runtime browser checks were subsequently performed as recorded in the integration evidence; performance remains unmeasured.

The deterministic recipe and focused validation are reproducible with the recorded installed versions; original generative artwork creation is not claimed reproducible. Review PNGs are inspection evidence only. No source overwrites, new image generation, installs, app edits, services, Beads mutations or commits occurred in preparation. **Prepared derivatives and subsequent independently verified in-app integration are accepted.**
