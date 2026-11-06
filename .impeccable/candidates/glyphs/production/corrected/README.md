# Corrected SVGs — user approved

## Final user decision

After reviewing the corrected comparison, the user stated **“I actually like the SVGs.”** Asked **“Do you approve both corrected SVGs as shown, including that separation?”**, the user answered **“yes..”**. Both exact SVGs identified below are approved, including the detached gold leaf as an intentional design choice. This supersedes the earlier fidelity-based recommendation to stop; the historical inspection findings and connectivity result below are preserved, not rewritten as passing checks. No further correction or tracing is needed. The user subsequently answered **“yes”** to **“Ready to integrate them into Explore and Capture?”**, authorizing the exact two heading placements, and accepted runtime previews: **“works for me ... what's the next glyphs you are thinking of?”** See [integration evidence](../../integration-review/README.md). No additional glyphs are authorized.

## Scope and preservation

User authorized **one correction pass** by selecting **Correct the SVGs (Recommended)** for **“Authorize one correction pass against the approved PNG silhouettes?”**, with **“Restore the missing shapes and balance sizes, then inspect both again. No app integration.”** This one pass is executed. No further pass or owner-side artwork repair is authorized or performed.

These are Codex-authored vector reconstructions, not native SVG image-generator output or deterministic PNG-to-SVG conversion. Actual approved PNGs were the ordered image references; the failed SVGs were not visual authority. Designer-provided source-plane landmarks explicitly described the solid cap/small handle, detached flame, long curved sprout stem, soft leaf neck and proportional placement. See [exact correction request](../correction-prompt.txt) and [attempt provenance](../provenance.json).

Both approved PNGs and original raster-generation prompts remain byte-identical, with exact artwork approvals intact. Before correction, **21 files** from the failed-first packet were copied and hash-verified under `../checkpoints/failed-first/`, including SVGs, prompt, provenance, original verifier and all review evidence. The previous root SVGs remain untouched too. New candidates were authored into this separate, previously absent directory.

## Candidate identity

| File | Bytes | SHA-256 |
| --- | --- | --- |
| `lantern.svg` | 2,106 | `24cda858b91c39e01711cf1a8692e5aaa6d7657dc6165ab40265bfc6a9dd7329` |
| `sprout.svg` | 903 | `585b9522651ab998079ff283af994ce12aca44792359d4dc4369ed56f997b4b1` |

Both are standalone 1024×1024 SVGs with `viewBox="0 0 1024 1024"`. Lantern uses six paths; sprout uses two. Flat opaque cream `#FEF6E1` and gold `#FFD477` fills only. Canvas/file-size budget beyond the agreed framing remains unknown. Output status: **user-approved SVG derivatives**.

## Focused checks and inspection

Command:

```sh
python3 .impeccable/candidates/glyphs/production/verify.py --candidate-dir corrected
```

Final exit: **2**, intentionally reporting sprout connectivity failure. The earlier content/render-only check exited 0; the check was then extended to verify the material attachment defect rather than reporting an overall pass. It does not change source artwork. The helper is checked with controlled diagonal-connected and separated tiny masks.

Passing checks: original PNG/prompt hashes; valid standalone XML/viewBox; restricted direct-path geometry; no raster embedding, scripts, events, external references, CSS, text/fonts, gradients, filters, masks or animation; approved vector fills; transparent negative space and opaque interiors; minimum 128px clear padding; 24px, 32px, 384px and 1024px rendering.

Renderer: **rsvg-convert 2.63.3**, Cairo 1.18.6. Composites: **ImageMagick 7.1.2-34 Q16-HDRI**. SVG colors are sRGB; browser/runtime rendering remains untested. Small antialiased edges are expected; there is no original-style floating raster alpha residue.

| Render | Nonzero-alpha bounds inclusive | Fully transparent / fully opaque / antialiased pixels |
| --- | --- | --- |
| Lantern, 1024px | `[217,140,804,885]` | 836,991 / 205,855 / 5,730 |
| Sprout, 1024px | `[137,154,883,871]` | 895,995 / 149,270 / 3,311 |

Dark and light composites plus the actual 24px/32px comparison board were opened and inspected. Light-ground cream contrast is intentionally poor: these remain intended for Quiet Night only, not an approved light-theme variant.

## Historical designer verdict, superseded by user approval

**Lantern — main requested corrections resolved; user review still required.** The cap is solid and broad, the small handle is distinct, and the flame has negative space above the base. The flat reconstruction remains an approximation of the PNG contours, not a pixel-identical trace; its softer flame lobes and base/support contours should remain visible to the user in the comparison rather than being presented as exact.

**Sprout — material failure remains.** The long stem returns, and the pair's scale is better balanced, but the gold leaf **does not touch the cream stem**. Its pointed neck ends in empty space. This is clearly visible in the 384px render and violates the approved connected sprout, even if antialiasing makes it subtle at 24px.

The attachment finding is independently supported by an 8-connected mask above alpha 127, ignoring components smaller than 64 source pixels: corrected sprout has **two** significant regions (cream form area 118,686px, gold leaf 32,247px), while the original approved PNG has **one** significant connected region (227,316px). Lantern correctly has two regions, frame and detached flame. This focused check is not a substitute for silhouette review.

**Size balance — improved.** Equal-canvas silhouette heights are **746px lantern / 718px sprout**, versus 720px / 542px in the failed first pair. No runtime scaling or hidden crop was used. The sprout is wider, matching its lighter organic form.

**Overall disposition: stop, do not approve/promote the pair.** Preserve this candidate and request user/orchestrator direction. The one correction budget is exhausted; no automatic second correction or hand-edit is implied.

## Render paths

- [Comparison board](review/comparison.png): original PNGs versus corrected SVGs, with actual 24px/32px samples.
- [Lantern dark](review/lantern-dark.png) / [light](review/lantern-light.png).
- [Sprout dark](review/sprout-dark.png) / [light](review/sprout-light.png).
- `review/{lantern,sprout}-{24,32,384,1024}.png`: transparent inspection renders.
- [Measured statistics](review/statistics.json).

These PNGs are **inspection evidence**, not approved production raster derivatives.

## Execution and boundaries

One correction invocation: Codex CLI **0.166.0**, runner **gpt-6-luna**, session **01a1b218-578c-70b2-a0e2-af832e3433a2**, host timeout **600000ms**, outer exit **0**. The subprocess made one successful file-authoring patch. Its only visible shell command was a target-directory listing, exiting 2 because the new directory did not yet exist. No tracker command appears in this correction's visible transcript. The passive `.beads/issues.jsonl` hash was unchanged before/after (`3b2d092d9ca4168545742058d596777531b8345c27b42c342203a0465180eda2`); no database content was inspected or mutation command run by the owner.

At the correction stage there were no app edits, integration, service changes, installs, commits or runtime tests. Subsequent integration and runtime acceptance are recorded above.
