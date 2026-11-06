# Production cleanup: native SVG route not verified

Recorded 2026-11-06 UTC. Status: **blocked before generation**. This directory contains route evidence only, not production artwork or approved derivatives.

**Historical route check:** the user later explicitly approved Codex-authored SVG markup. That distinct route was executed once; candidates and the failed visual review are documented in [README.md](README.md). The original capability finding below is retained as history, not the current production status.

## Approval and scope

User: **“you might be able to get codex to generate an SVG (it was added recently) But yes both are approved.”**

Both exact PNG sources are approved. Bounded cleanup of transparency/shading and optical size for both glyphs is authorized; no redesign, app integration or runtime acceptance is authorized. Original source PNGs and generation prompts remain unchanged. Native SVG capability must be established before choosing the proposed native route; ordinary assistant-written SVG is a different route requiring confirmation, not a silent fallback.

Approved source SHA-256:

- Lantern: `78ae83089be7edeac1e1da15e16c6171a8127c3f7be57083b676c0caeadd362e`
- Sprout: `50f27c40f676dc0c379534a4f3bcfbd400dc8238714fd31c510cdac73f3380c2`

## Installed CLI checks

Commands: `codex --version`, `codex --help`, `codex exec --help`. Each completed successfully, exit **0**. Installed version: **codex-cli 0.166.0**. Help exposes image-reference attachment (`--image`) and ordinary agent execution, but no standalone SVG-generation command or SVG output-format switch. CLI help alone does not establish the internal image tool's capabilities.

The existing `mise` wrapper reported zero newly installed tools; no install, upgrade or configuration operation was requested or performed.

## Capability-only inspection

Command: `codex exec --skip-git-repo-check -`, with the exact request below on stdin. Host timeout **600000ms**, exit **0**, runner **gpt-6-luna**, provider **openai**, session **01a1b202-223d-71c1-bc56-d44588d52bbe**. No generation tool was invoked; no image or SVG was produced. No capability retry was made.

Exact request:

```text
Capability inspection only; DO NOT generate artwork or write any files. The user has approved two existing raster glyphs and suggests that native SVG image generation was recently added. Before any generation, inspect the tool schemas/descriptions actually exposed to you in this Codex session and report whether native image/SVG generation supports producing standalone SVG vector paths/shapes from image references. Distinguish a native SVG-generation tool or native SVG output format from ordinary assistant-written SVG code, tracing scripts, raster embedding, or conversion of PNG files. Do not invoke an image-generation tool just to test it; do not install, upgrade, change configuration, inspect credentials, start services, or read unrelated files. Report the exact relevant tool name and supported format/options from the visible schema if present; otherwise say what is absent and that support is unverified. No speculative claims. This call authorizes capability reporting only, not artwork creation.
```

Returned capability report (verbatim):

> **Native SVG generation is absent from the visible tools in this session, so support is unverified.** I found no tool explicitly described as an SVG or vector generator, and no SVG output format in the visible image-generation schema.
>
> The relevant image tool is `image_gen__imagegen`. Its schema accepts `prompt`, optional image references (`referenced_image_paths` or `num_last_images_to_include`), and `transparent_background`; it returns `image_url` and optional `output_hint`. It does not declare SVG output or vector path/shape options. Image references are supported for editing, but the schema does not specify that they produce standalone SVG vectors.
>
> That is distinct from writing SVG code in a response, tracing an image with a script, embedding a raster in SVG, or converting a PNG. I did not invoke the tool.

This is the Codex session's report of its visible schema, not an independently exported schema or a native SVG test. It establishes no advertised native route in this installed session; it does not establish universal or future Codex support. No external documentation was needed for this bounded installed-capability check, and none was claimed as evidence.

## Next decision

Recommended: explicitly authorize **Codex-authored standalone SVG vector reconstruction** using both approved PNGs as references. This would be generative cleanup/reconstruction, not a claim of native SVG image-generator support and not a reproducible deterministic PNG-to-SVG conversion. It must preserve silhouettes, remove unintended shading and alpha residue, use exact flat cream/gold, optically balance 24px/32px display, and be reviewed before derivative promotion. Do not embed raster data, add scripts/external resources/fonts/text or invent new shapes.

Alternative: the user can provide the documented native SVG entry point they have seen; verify that route before generation. No software upgrade, alternative provider, hand-drawing or tracing route is implicitly authorized by this report.

## Validation status

- CLI help/version: exit **0**.
- Capability-only Codex inspection: exit **0**.
- Source/prompt hash and approval metadata checks: recorded in task handoff after the focused check.
- Derivative generation: **not attempted**.
- SVG parse/safety, rendering, palette, optical-size and dark/light/24px/32px checks: **not run; no SVG exists**.
- App/runtime validation and integration: **not authorized/not performed**.
