# Approved glyph family

The user approved the corrected lantern and sprout (including the sprout’s separated gold leaf), their placements, four initial content keepers, revised capture/contribution/evolution, and the two PNG relationship artworks. The user approved production preparation, the exact nine derivatives with “go”, integration with “yes approved you can integrate”, and the in-app placements with “yup”. Integration received independent verification and review before acceptance. Rejected relationship SVGs are not approved. No new artwork or redesign is implied.

[Approved dark family board](production/review/family-dark.png) shows the eleven at actual 16/20/24px; [representative in-app Explore capture](integration-review/content-after-explore-1440.png) is evidence, not an accessibility or performance certification.

## Asset map

Paths are relative to this document. The public column is relative to `apps/web/public/glyphs/`.

| Meaning | Approved input | Production output / public filename |
| --- | --- | --- |
| Explore heading lantern | [SVG](../production/corrected/lantern.svg) | `lantern.svg` |
| Capture heading sprout | [SVG](../production/corrected/sprout.svg) | `sprout.svg` |
| Original capture | [SVG](revised/captured-original.svg) | [captured-original.svg](production/runtime/captured-original.svg) |
| Contribution | [SVG](revised/user-contribution.svg) | [user-contribution.svg](production/runtime/user-contribution.svg) |
| Interpretation | [SVG](ai-interpretation.svg) | [ai-interpretation.svg](production/runtime/ai-interpretation.svg) |
| Developing idea | [SVG](developing-idea.svg) | [developing-idea.svg](production/runtime/developing-idea.svg) |
| Imported source | [SVG](imported-original.svg) | [imported-original.svg](production/runtime/imported-original.svg) |
| Full reply record role | [SVG](full-reply.svg) | [full-reply.svg](production/runtime/full-reply.svg) |
| Evolution ancestry | [SVG](revised/evolution.svg) | [evolution.svg](production/runtime/evolution.svg) |
| Discovered connection | [PNG](raster-relationships/connection.png) | [connection.png](production/runtime/connection.png) |
| Used as source / provenance | [PNG](raster-relationships/used-as-source.png) | [used-as-source.png](production/runtime/used-as-source.png) |

The original [lantern](../lantern.png) and [sprout](../sprout.png) raster references are retained. The eleven public files are byte-identical to their approved production outputs; the seven content SVG outputs are byte-identical to their inputs. SVGs have 1024-square viewBoxes and flat cream `#FEF6E1` and gold `#FFD477` fills. The relationship outputs are 1024×1024 RGBA PNGs with real transparency and retained source shading. Content outputs have at least 128px clear padding. Use 20px for material/record cues, 24px for focused Idea and the decorative heading pair, and 16px for relationships. Labels and attribution remain explicit: Full reply is not a material kind, and used-as-source remains label-dependent at 16px. All glyphs are decorative to assistive technology.

## Reproduction and checks

Requires Python 3, installed `rsvg-convert`, and the recipe-pinned ImageMagick 7.1.2-34 Q16-HDRI (the exact version string is in `production/build.py`). From repository root, choose a fresh owned scratch directory outside this package:

```sh
python3 -B -m unittest discover -s .impeccable/candidates/glyphs/content-family/production -p 'test_build.py' -v
python3 -B .impeccable/candidates/glyphs/content-family/production/build.py --output-dir /tmp/opencode/glyph-build
python3 -B .impeccable/candidates/glyphs/content-family/production/verify.py
```

The build pins all nine input SHA-256s and compares two independent passes. It copies seven SVGs unchanged; for PNGs it removes isolated alpha debris, keeps substantial 8-connected cores and a one-pixel antialias envelope, preserves retained RGB before resampling, and uniformly centers the result on a transparent canvas. It writes only to the requested external output directory and prints a receipt. The verifier independently rebuilds twice, compares retained and public bytes, checks restricted SVG geometry/palette and rendered alpha/padding, and checks the existing pair’s pinned identities. Tests use controlled synthetic pixels; these checks do not confer visual approval. Original generative artwork is not claimed reproducible.
