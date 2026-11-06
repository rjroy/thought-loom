# Relationship PNG alternatives — two actual generated candidates

**Both exact PNG artworks are user approved:** the user responded **“those are good”** to the two-candidate review. The returned PNGs still need technical cleanup before production; artwork approval does not authorize cleanup or integration. These are exact unmodified generated originals. No integration, automatic retry, tracing, alpha cleanup or palette repair occurred.

## Review

- [Two candidates on Quiet Night, with actual 16/20/24px samples](review/board-dark.png)
- [Light-ground inspection](review/board-light.png)
- [Whole-family comparison: seven unchanged SVG candidates plus these PNG alternatives](review/family-comparison.png)
- [Decoded measurements](review/statistics.json), [provenance and hashes](provenance.json), [exact request](prompt.txt)

| Meaning | Exact original PNG | Assessment |
| --- | --- | --- |
| Discovered connection | [connection.png](connection.png), [dark preview](review/connection-dark.png) | Two unmistakably interlocking rounded links, one cream and one gold. Far clearer than the broken SVG loops, with visible open centers and a genuine over/under join. Recognizable as a chain at 16px; gold is somewhat stronger/warmer than the existing family. Recommend the silhouette for user review. |
| Used as source | [used-as-source.png](used-as-source.png), [dark preview](review/used-as-source-dark.png) | Plain page → short gold arrow → one full leaf, with no folded corner or unwanted leaf fragment. Clearer enlarged and at 20/24px. At 16px the three-part cue is very small and the page is effectively a small block; its visible text label remains essential. Recommend reviewing this composition, not claiming independently obvious meaning at 16px. |

The native originals, dark/light boards, family board and magnified actual 16px samples were opened and inspected. Enlargements reveal the generator's subtle shading and alpha debris; normal-scale dark previews look cleaner, but do not remove those defects. Light previews inspect edges/transparency, not an approved light theme. The new images are slightly softer and less precisely colored than the flat SVG family.

The family board preserves the four user-selected keepers unchanged (Interpretation, Developing idea, Imported source, Full reply) and shows the existing revised Original capture, Contribution and Evolution without implying new acceptance of those three. All seven, both older relationship SVG attempts, earlier art/evidence, accepted lantern/sprout, runtime glyphs and brand reference remain byte-identical. The passive tracker export fingerprint also stayed unchanged.

## Actual delivery and limitations

Both native images decode as **1254×1254 sRGB RGBA PNGs**, not the requested 1024×1024. No resizing was applied to the sources. Native and durable copy hashes match.

- Connection: **354,362 bytes**, SHA-256 `84eb7314de1c95008eb9455cf24336f3284462dd4b4c766ebe51ffd6552df147`.
- Used as source: **274,635 bytes**, SHA-256 `6fa474193e0521da8e45917e7e567fee60aaea0398e4e7350c544160c1aecaac`.
- **Real alpha confirmed**, not painted checkerboard: connection has 1,309,087 fully transparent pixels and 1,563 fully opaque pixels; source has 1,336,194 fully transparent and 1,678 fully opaque pixels. Much of the apparently solid artwork has near-opaque rather than exactly 255 alpha.
- **Strict clean padding fails on both.** Low-alpha debris reaches x0 on connection; source has only 54px clear at right. Connection's principal alpha>127 silhouette fits the requested margin, but its invisible/near-invisible residue does not. Source's principal shape itself has only 147px right clear margin (11.7%, below 12.5%).
- **Exact flat palette fails on both.** Near-opaque pixels contain 1,690 distinct RGB values for connection and 745 for source, with subtle shading instead of only `#FEF6E1`/`#FFD477`. This is not a clean two-color source.
- Source/runtime byte budget remains **unknown**. No browser, app placement, runtime color handling or performance assessment was performed.

Do not silently key out residue, recolor, crop, vectorize or integrate these. User acceptance of the pictured silhouettes and authorization for any production cleanup are separate next decisions.

## Authorized route and execution

The user said: **“Neither ‘discovered connection’ nor ‘used as source’ look quite right. Try those again maybe as PNG.”** This authorized one actual raster generation for each of these two previously approved concepts, no other glyphs or integration.

One bounded Codex invocation, **two image-generation tool calls**, no retries. CLI **0.166.0**, runner **gpt-6-luna**, provider **openai**, session **01a1b292-7e9f-7440-81b6-dcd959dff85c**. Worker reports tool **`image_gen__imagegen`**; the internal image model identifier and exact internal image-tool prompts were not exposed. This is actual raster generation, not SVG rasterization or a web-render substitute.

From repository root, host timeout **600000ms**, exit **0**:

```sh
codex exec --skip-git-repo-check --image '.lore/context/brand-imagery.webp' --image '.impeccable/candidates/glyphs/content-family/revised/review/board-dark.png' --image '.impeccable/candidates/glyphs/production/corrected/review/sprout-dark.png' - < '.impeccable/candidates/glyphs/content-family/raster-relationships/prompt.txt'
```

The returned `/generated_images/...` virtual paths do not exist on this host. The actual originals were recovered from the established native staging directory `/home/rjroy/.codex/generated_images/01a1b292-7e9f-7440-81b6-dcd959dff85c/` and retained there. Exact per-image native paths and matching copy hashes are recorded in provenance. No duplicate generation was launched. No visible worker shell or tracker commands occurred; two tool-call pairs and their reported paths were returned.

## Focused verification

```sh
python3 -B .impeccable/candidates/glyphs/content-family/raster-relationships/verify.py
```

Exit **2**, honestly reporting delivered dimensions, strict alpha padding and flat-palette mismatches on both. Passing checks: PNG decode, real alpha, native/copy identity and **213 prior artwork/evidence/reference/runtime/passive-tracker fingerprints** unchanged. ImageMagick **7.1.2-34 Q16-HDRI** creates inspection previews; existing SVG companions render with **rsvg-convert 2.63.3**, Cairo **1.18.6**. `verify.py` does not alter originals and reproduces inspection only; generative authorship is not claimed deterministic.

Evidence includes `review/NAME-{16,20,24,320}.png`, `review/NAME-{dark,light}.png` and nearest-neighbor `review/NAME-16-magnified.png`. All generated preview PNGs are **inspection evidence, not production derivatives**. No tool installation, service operation, app edits, tracker mutation or commit was performed. Approval, cleanup/derivatives, integration and runtime acceptance remain separate gates.
