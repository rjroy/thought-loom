# Five revisions — single authorized pass

**The three accent-repair SVGs are user approved:** Original Capture (`captured-original.svg`), Contribution (`user-contribution.svg`) and Evolution (`evolution.svg`). The user answered **“yes”** to their explicit approval question. Together with the four unchanged keepers and the two separately approved [PNG relationship alternatives](../raster-relationships/README.md), this settles the nine-glyph artwork selection. The revised relationship SVGs here remain unapproved and superseded by those PNGs. Production cleanup and integration are not authorized. No source repair or second generation was performed; no integration occurred.

## Review evidence

- [Current nine, dark](review/board-dark.png): five revised candidates plus the **four unchanged user-selected keepers**, with actual 16/20/24px samples.
- [Current nine, light inspection](review/board-light.png): alpha/edge inspection, not a proposed light theme.
- [Five before/after comparisons](review/five-before-after.png): originals left, revisions right; actual-size revised samples at far right.
- [Measured checks](review/statistics.json), [exact provenance and hashes](provenance.json), [approved production prompt](prompt.txt).

All boards and the five enlarged individual dark previews were opened and inspected. PNGs are real SVG renders for inspection, **not approved production derivatives**. Cream naturally disappears on the cream inspection ground; the intended consumer remains Quiet Night `#031315`.

| Meaning | New source | Focused assessment |
| --- | --- | --- |
| Original capture | [SVG](captured-original.svg), [preview](review/captured-original-dark.png) | Cream contour/open center preserved exactly. Gold follows the upper-right rim without crossing the opening; appropriately secondary at 16px. Suitable for user review. |
| Contribution | [SVG](user-contribution.svg), [preview](review/user-contribution-dark.png) | Existing tail is now gold and cleanly joins the cream body, rather than containing a floating triangle. Outer outline preserved. Suitable for user review. |
| Evolution | [SVG](evolution.svg), [preview](review/evolution-dark.png) | Original branching cream path translated left 84 units, restoring padding. Short gold vein is contained below the fork. Its center is 12 source units left of the requested center (0.19px at 16px), not a material visual deviation. Suitable for user review. |
| Discovered connection | [SVG](connection.svg), [preview](review/connection-dark.png) | **Fails visual brief.** Two cream subpaths use evenodd filling, cancelling overlapping areas into broken/slashed loops. A small gold patch does not form the requested second gold link. Still unclear at 16px; do not recommend acceptance. |
| Used as source | [SVG](used-as-source.svg), [preview](review/used-as-source-dark.png) | Page → arrow → leaf is clearer enlarged, but the page reads as a tall slab, and the leaf has an unnecessary angular opening/lower fragment. Crowded at 16px. Right clear padding is **96px, not 128px**. Do not recommend acceptance as-is. |

The four keepers are the original [Developing idea](../developing-idea.svg), [Imported source](../imported-original.svg), [Interpretation](../ai-interpretation.svg) and [Full reply](../full-reply.svg). Their bytes/hashes are unchanged; the user's selection supersedes earlier designer objections to the lightbulb, eye and boxed quotation forms. They are rendered directly from those original paths, not copied or reauthored.

## Authorization and method

The user selected **“Generate revisions”** for **“Generate these five revisions for another review?”**, approving **“Repair the three gold accents and replace the two unclear symbols, preserving the four keepers.”** This authorized one five-source pass, not integration or another correction loop.

Ordinary **Codex-authored SVG markup**, not native SVG image generation, tracing, raster embedding or deterministic conversion. CLI **0.166.0**, runner **gpt-6-luna**, provider **openai**, session **01a1b281-a4ad-7191-b948-0218eb0e2d7d**. One authoring patch, generation exit **0**, host timeout **600000ms**:

```sh
codex exec --skip-git-repo-check --image '.impeccable/candidates/glyphs/content-family/review/board-dark.png' --image '.impeccable/candidates/glyphs/production/corrected/review/lantern-dark.png' --image '.impeccable/candidates/glyphs/production/corrected/review/sprout-dark.png' - < '.impeccable/candidates/glyphs/content-family/revised/prompt.txt'
```

The worker also ran one read-only listing, `rtk ls .impeccable/candidates/glyphs/content-family` (exit **0**), despite the prompt requesting file authoring only. No visible tracker command occurred. The passive Beads export fingerprint stayed unchanged. No tools were installed, no services touched, no app files changed and no commits made.

## Focused verification

```sh
python3 .impeccable/candidates/glyphs/content-family/revised/verify.py
```

Exit **2**: Used as source fails safe padding; nonzero-alpha bounds `[132,218,927,805]` leave only 96 pixels clear at right. The other eight current glyphs meet 128px minimum clear padding. No crop/rescale hid the failure.

Passing checks: all nine initial source hashes, four selected keeper hashes, and accepted lantern/sprout source/runtime hashes unchanged; all current nine parse as restricted standalone vectors with `0 0 1024 1024` viewBoxes and square 1024 dimensions; exact opaque cream `#FEF6E1`/gold `#FFD477` only; no raster images, script/events, external references, text/fonts, CSS, filters, masks, gradients or animation. Evolution's explicitly allowed translation is checked. Every source renders with real transparent and opaque pixels at 16/20/24/256/1024px. The three repaired cream `d`/fill-rule values match their originals exactly; independently rendered gold masks contain **zero half-opaque gold pixels outside the cream**. These checks do not imply semantic or optical approval.

Renderer **rsvg-convert 2.63.3**, Cairo **1.18.6**; board composition **ImageMagick 7.1.2-34 Q16-HDRI**. SVG fills are sRGB. Source byte budget remains **unknown**. Browser/runtime performance and app placement were not assessed. Review files follow `review/NAME-{16,20,24,256,1024}.png`, `review/NAME-{dark,light}.png`; isolated cream/gold masks for the three repairs are inspection evidence too.

`verify.py` reproduces inspection with already-installed tools, never changes artwork, and is a package-specific check rather than a general SVG sanitizer. Generative authorship is not claimed byte-identically reproducible. Originals and this imperfect pass are retained separately. Further correction requires separate authorization; artwork approval, production derivatives and app integration remain distinct gates.
