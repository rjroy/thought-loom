# Lantern pilot — silhouette approved

**Current status, 2026-11-06:** the user approved both exact corrected SVGs, explicitly including the separated gold leaf, then authorized integration into Explore and Capture. The approved source SVGs and original PNGs remain unchanged. Byte-identical runtime copies occupy only the agreed 24px decorative heading placements. The user accepted the runtime previews: **“works for me ... what's the next glyphs you are thinking of?”** See [integration evidence and acceptance boundary](integration-review/README.md). Earlier failed fidelity/connectivity findings remain historical evidence, not authority to override the user's accepted artwork. No additional glyphs are authorized.

## Authority and scope

The user approved **Generate lantern pilot** for **“Cream cut-paper lantern with a pale-gold flame, transparent background, simple enough for 24px display.”** This authorized one generated lantern candidate only. The intended consumer is a decorative glyph beside Explore's existing initial-state heading, “Find your recorded thinking”; not a control or status indicator. No sprout, runtime derivatives, integration, code changes or service operations were authorized or performed.

The proposed description requested a front-facing lantern, broad cap, simple handle, sturdy supports/base, open center, one flame, cream `#FEF6E1` and pale gold `#FFD477`, native transparent PNG, 1024×1024 canvas, 12.5% safe padding, and projected 24px/32px display. File-size budget remains unknown. The authorized reference is [brand-imagery.webp](../../../.lore/context/brand-imagery.webp).

## Maintained files

- `lantern.png`: byte-identical copy of the actual native generated source. **Not resized, cleaned, recolored or optimized.**
- `lantern-prompt.txt`: exact outer request sent on stdin to Codex. The internal image-tool prompt/model were not exposed by this invocation.
- `lantern-provenance.json`: approval scope, route, source identity, reference hash, measured image properties and review findings.

The native original remains at the absolute path recorded in provenance. No approved incumbent asset was overwritten. Generation is not claimed to be byte-reproducible.

## Verification and visual assessment

Generated and inspected on 2026-11-06 UTC. Both native image and durable copy decode and were opened for visual inspection; SHA-256 hashes match. The original is **1254×1254**, RGBA PNG, 8-bit channels, sRGB, **455,587 bytes**. This differs from the requested 1024×1024; it was preserved without correction.

Real alpha was verified from decoded pixels: 1,173,358 fully transparent, 3,186 fully opaque and 395,972 partially transparent pixels. Both exterior and interior have transparent areas. Much of the solid-looking art has alpha 254 rather than 255; some very low-alpha residue extends beyond the principal silhouette. This is not an opaque image containing a painted checkerboard. No background removal or alpha repair was performed.

Dark (`#031315`) and light (`#FEF6E1`) inspection composites were opened. The dark composite reads cleanly at ordinary scale without a visible broad matte or glow; faint edge/interior residue is visible in the original at close inspection. Cream intentionally has poor contrast on the light test ground: this art is proposed only for Quiet Night, not as a light-theme asset. Color handling is source sRGB, with no runtime pipeline or integration verified.

At an untrimmed **24px canvas**, the silhouette is recognizably a lantern, although the handle and flame are small and soft. **32px is clearer.** The 24px/32px inspection uses the entire original canvas, including its padding; no compensating crop was applied. These are image-only previews, not browser, accessibility or runtime acceptance checks.

### Deviations to retain in the approval decision

- Source dimensions differ from the request.
- The main silhouette is slightly vertically off-center and its bottom padding is about 10%, rather than the requested 12.5% minimum.
- Cream and gold have subtle shading/color variation, not exact flat brand-color fills.
- Low-alpha residue is present outside/inside the main silhouette; the original has not been silently cleaned.

**Designer recommendation:** a useful silhouette pilot, not a fully conforming production-ready asset. User review must acknowledge these deviations or request a separately authorized revision. Do not generate another image automatically.

## Inspection-only previews

These temporary files are verification evidence, **not approved production derivatives** and not runtime assets:

- `/tmp/opencode/thoughtloom-lantern-01a1b1e8-review/dark.png` — 384px preview on Quiet Night ground.
- `/tmp/opencode/thoughtloom-lantern-01a1b1e8-review/light.png` — 384px preview on cream ground.
- `/tmp/opencode/thoughtloom-lantern-01a1b1e8-review/sizes.png` — 24px/32px actual-size samples and an explicitly enlarged 24px sample.

Recreate a background preview with ImageMagick 7.1.2-34 (inspection only):

```sh
magick lantern.png -resize 384x384 -background '#031315' -alpha remove -alpha off /tmp/opencode/lantern-dark-review.png
magick identify -verbose lantern.png
sha256sum lantern.png
```

## Approval gates

The user responded **“looks good”** after viewing the generated pilot and being asked whether the silhouette felt right. This approves the silhouette direction. It does not authorize cleanup, another generation, derivatives or integration; the production-readiness caveats above remain.

Description: approved. One pilot generation: authorized and executed. Exact-version artwork: **pending user approval**. Production derivatives: **not authorized**. Runtime integration and runtime acceptance: **not authorized/not performed**. No application behavior changed, so API, testing and runtime design-system contracts were not changed.

---

## Matching sprout pilot — shape and style approved

### Later authorization and files

After the lantern silhouette approval above, the user answered **“yes”** to **“Recorded the lantern direction as approved. Shall we generate the matching sprout next?”** This separately approved the previously proposed sprout description and authorized **one actual generated matching sprout pilot only**. The earlier no-sprout statement records the original lantern-only scope; this later authorization adds just this sprout pilot. It does not authorize production derivatives, integration or any change to the lantern or its approval status.

The sprout's intended consumer is decorative accompaniment immediately before the existing **Capture** heading, not a control, status or saved confirmation. Approved description: a single gently curved stem, two broad unequal leaves, lightly organic cut-paper silhouette, cream `#FEF6E1` and restrained pale gold `#FFD477`, transparent background, readable on 24px and 32px square canvases, requested 1024×1024 source with 12.5% clear safe padding. Budget remains unknown. References were supplied in order: brand imagery, then the existing silhouette-approved lantern; its shading/alpha defects were explicitly excluded in the request.

Added files:

- `sprout.png`: byte-identical, unmodified copy of the actual native generated source.
- `sprout-prompt.txt`: exact outer request sent to Codex on stdin.
- `sprout-provenance.json`: generation route, ordered references, hashes, measured source properties and review findings. The native original is retained at its recorded absolute path.

### Measured verification

Generated and inspected on 2026-11-06 UTC using the authorized Codex route, once, with a 600000ms host timeout and no retry. The CLI reported runner model `gpt-6-luna`; the internal image model/tool request were not exposed. **Although the generator reported 1024×1024, both native and durable PNG actually decode as 1254×1254**, 8-bit RGBA, sRGB, **298,088 bytes**. Both were opened for inspection, and their SHA-256 hashes match. No resizing, cropping, alpha cleanup, recoloring or optimization was applied to either source.

Decoded pixels confirm real transparency: **1,333,400 fully transparent**, **1,225 fully opaque**, **237,891 partially transparent**. Of these, 201,786 have alpha 254, including much of the solid-looking art. Exterior and between-leaf samples are fully transparent. No painted checkerboard or opaque background is present. Low-alpha edge/surrounding residue remains; transparency is genuine but is **not a clean production-alpha pass**.

Dark (`#031315`) and light (`#FEF6E1`) composites were opened and inspected. At ordinary preview scale the dark version has no broad matte, cast shadow or glow. Fine residue is visible on close native inspection. The cream form intentionally loses contrast on the light test ground, so this is not a light-theme asset. Source color space is sRGB; no runtime color pipeline was tested.

### Small-size and family assessment

The sprout reads clearly at **24px**, with more distinct stem and leaf separation at **32px**. It has exactly two broad unequal leaves: larger cream leaf, smaller gold leaf, connected by one gently curved cream stem. No extra scenery, badge, lettering or control was added.

The cream/gold balance and softly organic edges belong with the lantern. At equal untrimmed canvas size, however, the sprout is **lighter and shorter**: its principal silhouette is 825 source pixels high versus the lantern's 979 (alpha greater than 127). Its broad leaves remain legible, while the stem is visibly finer than the lantern's supporting frame. The comparison deliberately preserves original framing; it does not silently normalize optical scale.

### Deviations and recommendation

- Actual dimensions differ from both the request and generator's report.
- Subtle cream/gold shading and non-exact colors persist despite the explicitly flat-palette request.
- Low-alpha residue and alpha-254 interiors persist despite their explicit exclusion.
- The principal silhouette meets the requested 12.5% padding, but faint residue extends into that clear area.
- Optical size/weight differs from the lantern at equal canvas sizes.

**Designer assessment:** a useful matching silhouette pilot, not a fully conforming production-ready glyph. Review the exact candidate before deciding whether its direction is accepted or a separately authorized refinement is needed. No automatic retry or cleanup is authorized.

### Inspection-only evidence and approval boundary

Temporary previews, **not approved production derivatives**:

- `/tmp/opencode/thoughtloom-sprout-01a1b1fc-review/dark.png` — 384px dark-ground composite.
- `/tmp/opencode/thoughtloom-sprout-01a1b1fc-review/light.png` — 384px light-ground composite.
- `/tmp/opencode/thoughtloom-sprout-01a1b1fc-review/family-sizes.png` — equal-canvas lantern/sprout comparisons at 240px, 24px and 32px; enlarged 24px sprout explicitly marked.

Recreate a background inspection composite with the ImageMagick version recorded above:

```sh
magick sprout.png -resize 384x384 -background '#031315' -alpha remove -alpha off /tmp/opencode/sprout-dark-review.png
magick identify -verbose sprout.png
sha256sum sprout.png
```

The user responded **“that works”** to **“Approve the sprout’s shape and style?”** after viewing the generated family comparison. The sprout’s shape and style are approved; the production-readiness caveats above remain.

Sprout description: approved. Single generation: authorized and executed. Shape and style: **approved**. Production artwork readiness, derivatives, app integration and runtime acceptance remain pending or unauthorized/not performed. The lantern source, prompt and approval provenance were verified unchanged. No app or behavior changed; no runtime tests were run or claimed.

---

## Exact source approvals and production route check — 2026-11-06

The user said **“you might be able to get codex to generate an SVG (it was added recently) But yes both are approved.”** This explicitly approves the exact lantern and sprout PNG sources identified by their existing hashes. It follows **“Shall we clean up transparency and balance their sizes for production, keeping app integration separate?”** and authorizes that bounded cleanup for both. Earlier silhouette/style approvals and generation records remain preserved above and in each source's provenance.

Authorized cleanup: preserve the recognizable approved shapes, use flat cream/gold colors, remove alpha debris and unintended shading, and balance optical size for the decorative 24px/32px Quiet Night consumer. No redesign, new concepts, app integration or runtime acceptance is authorized. Original PNGs and generation prompts remain byte-identical; their provenance now records the exact source approval and production authorization.

### Native SVG capability remains unverified

Installed `codex-cli 0.166.0` help and a capability-only Codex session were inspected successfully (exit 0). The session reported `image_gen__imagegen` with prompt, image-reference and transparent-background inputs, returning `image_url` and optional `output_hint`, but no advertised SVG/vector output option or separate SVG tool. This is evidence about this session's exposed capabilities, **not proof that no newer or other Codex surface supports SVG**. No generation call was made during the check.

Full command, exact capability request, returned evidence, exit statuses and next-route recommendation are recorded in [production/capability-report.md](production/capability-report.md). No derivative SVG/PNG was generated; no tracing, assistant-drawn replacement or alternate image provider was silently substituted. Production remains blocked on the route decision, not on source approval.

**Recommended next option, requiring explicit approval:** let Codex author standalone SVG path-based reconstructions directly from the approved PNG references, clearly labeled as generative vector reconstruction rather than native SVG image generation or deterministic conversion. Keep the original art unchanged, restrict the work to the approved cleanup, then inspect silhouettes, flat palette, safe SVG content and 24px/32px renderings before derivative approval. Alternatively, provide the documented native SVG entry point available in the user's installation.

Approval state: both source artworks **approved**; bounded cleanup **authorized but blocked**; derivatives **not yet created/approved**; app integration/runtime acceptance **not authorized/not performed**. No derivative render/security checks or app/runtime tests were run because no derivative exists.

## Codex-authored SVG route approved; derivative visual review failed

The user subsequently selected **“Create SVG versions”** for **“Use Codex-authored SVG paths to recreate and clean up both approved glyphs, then review them before app integration?”**, with **“Preserve the approved shapes and colors, remove shading and transparency residue, and compare at 24px and 32px.”** This resolves the previous route blocker without claiming native SVG image-generator output.

One Codex authoring invocation created `production/lantern.svg` and `production/sprout.svg`. These are **generative vector reconstructions**, not deterministic conversions. The original PNGs and raster-generation prompts are unchanged. Both SVGs parse and render, have genuine vector paths, flat approved fills, transparent negative space, 1024-square viewBoxes and sufficient safe padding. They contain no raster embedding, scripts, external references, fonts or text. Focused verification exited 0.

**Designer verdict: do not approve these derivatives.** The lantern loses its solid cap and flame/base separation. The sprout loses much of its curved stem and gains an angular gold-leaf join. Its apparent size is even smaller relative to the lantern. This exceeds authorized cleanup. No silent correction or second pass was run. The orchestrator will review evidence and obtain any correction authorization.

See [production/README.md](production/README.md), [production/provenance.json](production/provenance.json) and [the comparison board](production/review/comparison.png) for exact findings, hashes, versions, commands and process caveats. In particular, the Codex subprocess attempted a Beads issue creation despite the bounded prompt; it failed on a read-only database lock. The exact attempted command and returned error are recorded, with no successful mutation observed. No Beads command was rerun by the owning designer.

## One correction pass authorized and executed — remaining sprout defect

The user selected **“Correct the SVGs (Recommended)”** for **“Authorize one correction pass against the approved PNG silhouettes?”**, with **“Restore the missing shapes and balance sizes, then inspect both again. No app integration.”** A byte-identical, 21-file failed-first checkpoint was retained before the one authorized Codex correction invocation. New candidates are under `production/corrected/`, without overwriting the approved PNGs or failed SVGs.

The corrected lantern restores the solid cap, small handle and separated flame. Comparable silhouette heights are now 746px/718px on equal 1024 canvases. However, the corrected sprout's gold leaf visibly floats beside the cream stem: its rendered silhouette has two significant connected components, while the approved PNG has one. **The family review still fails.** No owner-side artwork repair, automatic retry or further Codex pass was run.

See [corrected review](production/corrected/README.md), [current comparison](production/corrected/review/comparison.png) and [updated provenance](production/provenance.json). The restricted content, palette, transparency, padding and source-preservation checks pass; the combined check exits **2** for the meaningful connectivity failure. The correction subprocess did not run tracker commands in its visible transcript; the passive Beads export hash remained unchanged. Original source approvals remain intact; exact corrected SVG approval and app integration remain pending/not authorized.
