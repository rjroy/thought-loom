# Selected Thoughtloom designs

This packet contains the selected visual direction and two selected desktop comps, with their source, approval, and provenance notes. It is not a production client or a completed design system.

| Selection | Artifact | Approval |
| --- | --- | --- |
| **Quiet Night / Collection labels** | [Direction image](design-review/evidence/dark/dark-quiet.png) · [self-contained HTML source](mocks/decision/dark-quiet.html) | “A - quiet night. works.” — shared visual direction only |
| **Explore — Compact excerpts** | [Selected comp](mocks/explore/compact.png) · [screen notes](surfaces/impeccable-mocks-explore-compact-png.md) | “compact” — shown resting desktop composition only |
| **Capture — Wide working pad** | [Selected comp](mocks/capture/wide.png) · [screen notes](surfaces/impeccable-mocks-capture-wide-png.md) | “wide” — shown resting desktop draft composition only |

[Selected assets and hashes](selected-assets.json) records the approval chain. The direction image is a **browser-rendered study**; Explore and Capture are **generated UI comps**. The approved PNGs are preserved unchanged.

## Shared visual direction

Quiet Night uses all-dark working and reading surfaces, Source Sans 3, and the personal brand's **full 16-color functional palette plus documented mixtures**. Gold identifies the primary action, blue selection/focus, cyan contextual links, and worded green/purple bylines distinguish user/AI authorship—not agreement or acceptance.

See [selected brand guidance](brand/BRAND.md), [exact palette roles and mixtures](brand/ui-palette.json), and [source provenance](brand/SOURCE.md). The font and its license are bundled. No personal-brand artwork or external font service is required.

## Current scope

The overall design gate remains open. These selections do not approve mobile/responsive layouts, unseen interaction/recovery states, other screens, shipping raster controls, or Next.js/daemon implementation. Settings remains reserved and undefined.

- **Explore still needs:** initial/empty/loading/error views; expanded and long text; selected filters/counts, custom dates, open sorting, Show rejected; focus/mobile; and state-preserving return.
- **Capture still needs:** phone, empty/long drafts, saving/saved/error/uncertain outcomes, optional-title behavior, focus, and draft-preserving recovery. A saved thought and background weaving are separate facts; no weaving status/retry control is specified.
- **Illustrative content:** the selected Explore image's predecessor title also matches its query, so the pictured count is not a validated closed search fixture. Do not reuse the demo as executable data. No approved image is repainted to conceal this.
- **Response discovery:** the daemon now exposes scoped `GET /thoughts/:id/responses` for associated retained replies, alongside direct-child and incident-connection reads. See the daemon API contract before designing the on-demand states. No new screen state is approved by this API addition.

## Provenance and reproduction

Each generated comp has an adjacent `.png.json` containing its exact approved-image hash, approval scope, native output identity, input reference, and exact CLI request. The selected requests are retained at [Explore prompt](design-review/explore-prompts/compact.txt) and [Capture prompt](design-review/capture-prompts/wide.txt).

The authorized generation route is `codex exec --skip-git-repo-check --image <recorded-reference> - < recorded-prompt`, using a 600000 ms host timeout and normal native staging. This records how the selected images were produced; it is not permission to generate replacements. New outputs must not overwrite these approved PNGs, and AI regeneration is not promised to be byte-identical. Internal image-model/tool-prompt details not exposed by the runner are left unknown.

The direction HTML is self-contained and retains the exact embedded Source Sans 3 font. Its rendering command and browser version are recorded in the manifest. Machine-local source/native paths in provenance are historical identifiers, not runtime dependencies. Durable selected files and all required palette/font resources are inside this packet.

Current product and transport constraints remain in the [architecture agreement](../.lore/context/architecture.md) and [daemon API](../docs/daemon-api.md). The selected packet does not depend on `PRODUCT.md`.
