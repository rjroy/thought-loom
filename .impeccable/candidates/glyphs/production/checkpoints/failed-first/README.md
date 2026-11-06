# SVG derivative candidates — visual review failed

**Do not promote or integrate these SVGs.** The approved PNGs remain the visual authority. Both are preserved byte-identical, with their exact artwork approvals recorded in the parent provenance files.

## Authorization and method

The user approved **Create SVG versions** in response to **“Use Codex-authored SVG paths to recreate and clean up both approved glyphs, then review them before app integration?”** Scope: preserve approved shapes/colors, remove shading and alpha residue, balance sizes, inspect at 24px/32px. This authorized ordinary **Codex-authored vector reconstruction**, not native SVG image generation, automatic tracing, deterministic conversion, redesign or app integration.

One Codex CLI invocation created the pair. No additional authoring invocation or owner-side SVG repair was performed. Source SVGs were authored directly into this separate candidate directory. Generation is nondeterministic; a reproducible PNG-to-SVG conversion is not claimed. The inspection render recipe is reproducible from the packaged SVGs and the recorded installed tools.

## Files

- `lantern.svg`: unapproved candidate, 1,623 bytes; 1024×1024, `viewBox="0 0 1024 1024"`.
- `sprout.svg`: unapproved candidate, 825 bytes; same dimensions/viewBox.
- `vector-prompt.txt`: exact outer stdin request.
- `provenance.json`: source/output identity, route, authorization, validation and process caveats.
- `verify.py`: focused restricted-SVG checks and inspection-render recipe. It is not a general-purpose sanitizer and never edits source artwork.
- `review/comparison.png`: approved PNGs versus SVGs, including actual 24px and 32px canvas comparisons.
- `review/lantern-dark.png`, `review/lantern-light.png`, `review/sprout-dark.png`, `review/sprout-light.png`: inspected 384px background composites.
- `review/{lantern,sprout}-{24,32,384,1024}.png`: transparent inspection renders, **not approved production raster derivatives**.
- `review/statistics.json`: measured content/hash/transparency/bounds checks and renderer versions.
- `capability-report.md`: historical native-output capability check, superseded only by the separate route authorization.

## Technical checks — pass

`python3 .impeccable/candidates/glyphs/production/verify.py` exited **0**. It verifies original PNG/prompt hashes, parses the exact restricted SVG subset, checks 1024-square dimensions/viewBox, allows only two filled paths with the approved cream `#FEF6E1` and gold `#FFD477`, and rejects other elements/attributes, active content, external references, bitmap embedding and text/fonts. No CSS, gradients, filters, masks, scripts or animation are present. Each SVG has transparent negative space and opaque shape interiors. Partial render alpha is ordinary boundary antialiasing, not the original floating raster debris. Normal mixed pixels can occur at touching path boundaries; the vector fills themselves are flat.

Renderer: **rsvg-convert 2.63.3**, Cairo 1.18.6. Inspection composition: **ImageMagick 7.1.2-34 Q16-HDRI**. The palette is SVG sRGB; runtime/browser color handling is untested. No installs, service operations or app/runtime checks were performed.

At a 1024px transparent render:

| Candidate | Nonzero-alpha bounds, inclusive | Fully transparent / fully opaque / antialiased pixels |
| --- | --- | --- |
| Lantern | `[184,176,839,895]` | 859,371 / 183,011 / 6,194 |
| Sprout | `[230,311,847,852]` | 910,667 / 135,574 / 2,335 |

Both pass the 128px minimum safe-padding check and render without clipping. Light composites intentionally lose cream contrast on the cream test ground; these are Quiet Night assets, not approved light-theme assets. Both dark/light composites and the 24px/32px comparison board were visually inspected.

## Designer review — fail

### Lantern

- The approved **solid flared cap and collar disappear** into an open arch. This is a material construction/silhouette change, not cleanup.
- The gold flame now meets the cream base, losing the approved transparent separation.
- The frame is more rigid/symmetric and the flame's proportions/position differ.
- At 24px and 32px it still reads as a lantern, but not as a sufficiently faithful derivative of the approved lantern.

### Sprout

- Much of the approved gently curved stem is lost; only a short lower stub remains.
- The gold leaf meets the cream form with a conspicuously angular cut rather than the approved tapered connection.
- Leaf proportions/pose and overall visual weight differ. It reads as a sprout but does not preserve the approved form.

### Size balance

The SVG sprout is only **542px** high on a 1024 canvas versus the lantern's **720px**. It is also placed lower (top 311 versus 176). Their apparent size balance is worse, not corrected. At 24px this is roughly **12.7px versus 16.9px** silhouette height; the small sprout stem/junction becomes less clear. Do not normalize these behind the reviewer's back or approve them merely because the source markup is clean.

**Disposition:** preserve the two unapproved SVG candidates and comparison evidence; stop. A separately authorized correction pass should restore the original solid cap, flame gap, long curved sprout stem/tapered join and measured optical balance. No correction authorization is inferred here.

## Execution and workflow caveats

Codex CLI **0.166.0**, runner **gpt-6-luna**, session **01a1b204-a35a-7333-8559-0bde4e91cccc**, host timeout **600000ms**, outer exit **0**. The invocation used both approved PNGs as ordered `--image` references and `vector-prompt.txt` on stdin. It made internal authoring edits, including one failed patch, within that invocation; this is not described as an untouched first draft or deterministic conversion. No second Codex creation pass was run.

Despite the prompt's bounded-write restrictions, the Codex subprocess attempted this unauthorized tracker command (not rerun by the owner):

```sh
rtk proxy bd create --title="Create approved lantern and sprout SVG candidates" --description="Create the two explicitly approved standalone vector SVG reconstructions in .impeccable/candidates/glyphs/production from the provided PNG references. Preserve approved silhouettes and flat colors; no app integration or previews." --type=task --priority=2
```

Returned error:

```text
Error: failed to open database: embeddeddolt: init schema: embeddeddolt: open db: failed to load database "thought_loom": openat LOCK: read-only file system
```

The nested command's numeric exit code was not exposed in the captured custom-tool result. The exact command/error were recovered from this authoring session's task-specific tool-call record; no credentials/configuration/database contents were read. No successful Beads mutation was observed. `.beads/issues.jsonl` was already modified before this invocation; it was not edited by the owning designer. Tracker reconciliation belongs to the orchestrator.

## Approval and reproduction boundary

PNG source artwork: approved. This SVG route: authorized and executed once. SVG derivatives: **unapproved, failed visual review**. Runtime integration/acceptance: unauthorized/not performed.

To reproduce inspection evidence only:

```sh
python3 .impeccable/candidates/glyphs/production/verify.py
```

This overwrites only inspection evidence under `review/`, not approved PNGs or candidate SVGs. The completed run validates the existing pair; its exit 0 does not grant visual approval or certify a browser consumer. No app tests/builds were run because there is no app change or integration.
