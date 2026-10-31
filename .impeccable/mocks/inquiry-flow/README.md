# Thoughtloom — inquiry experiments

**Useful experiments, not a selected production design. MVP undefined; implementation and integration unauthorized.** The user approved the exploration description, called the resulting screens good experiments, and authorized cleanup—not promotion to approved production artwork.

Three successive moments of one experience, not competing feature options:

| Experiment | Image | Provenance |
| --- | --- | --- |
| Find the original thought with AI interpretations and connections | [Open thought](open-thought.png) | [Exact prompt chain](open-thought.png.json) |
| Challenge an orchestration interpretation and develop visible offshoots | [Develop through dialogue](develop-through-dialogue.png) | [Exact prompt chain](develop-through-dialogue.png.json) |
| Follow an emerging idea with source and discussion derivation intact | [Follow the emerging idea](follow-emerging-idea.png) | [Exact prompt chain](follow-emerging-idea.png.json) |

All images are **1536 × 1024, opaque sRGB PNGs**. They remain byte-identical to the reviewed experiments:

```text
683f47396736a8efbaf37d301687f70d82677f08ae917dcfc563610dc882b502  open-thought.png
e46ceab1bb1f3ff31b84992bbe5cfdd1c363b0f7be68b37beb36d4013487b1eb  develop-through-dialogue.png
462bb1f277f0a26559cd1f433e0e432b7cf1627cf9dab94fb82a14daa4a5c9c9  follow-emerging-idea.png
```

Generated 2026-10-30 using **codex-cli 0.166.0**, native image generation/editing via `codex exec --skip-git-repo-check -`, exact prompts supplied through stdin, 600000 ms timeout per call. The image-model identifier was not exposed. Three original generations and one bounded correction per image; no automatic timeout retries. The sidecars contain self-contained original-generation and final-edit prompt chains, source snapshots, historical input/native paths and hashes, and validation records. Exact final-edit prompts are also embedded in the unchanged PNGs. Generation is nondeterministic; identical regeneration is not claimed.

Superseded inputs, native duplicates, review servers/pages, and screenshots were removed by explicit cleanup authorization after durable-copy verification. Sidecar entries marked `historical-deleted` are provenance records, not live dependencies. In particular, the third image used an earlier dialogue reference with hash `10dc94ce891284a44641161f4b35f4c56fa7b8b6e6225448688d656f7eb8fc7d`; that is **not** the retained final dialogue image's `e46ceab1…` hash.

Sources: [original concept](../../../.lore/work/concept/thoughtloom-concept.md), [product context](../../../PRODUCT.md), and `/home/rjroy/Projects/personal-brand/brand/BRAND.md` at revision `55dbe8766668cd409b16bddb437a6bceb7fb56f3` (clean at reference capture). Sidecars retain source SHA-256 values. Palette/type/agency principles were adapted; no logo, emblem, artwork, or font files were copied.

Limitations: generated typography/colors are approximate, blue is brighter than Horizon, slight shading/layout drift remains, and the last frame is denser. The notes, reasoning, relationships, and actions are illustrative; long dialogues, accessible nonspatial exploration, actual state/history behavior, agentic search, autonomy, platform, storage, and synchronization remain unresolved. These raster studies are not interactive or accessibility-certified. Phone capture/exploration would read sources and attached discussion/offshoots sequentially; phone application screens are not included.
