# Selected design references and approved artwork

The client is implemented. [Client design system](../apps/web/DESIGN.md), [product context](../.lore/context/) and [API contracts](../docs/daemon-api.md) describe current behavior. These selected illustrative references preserve visual direction, not executable UI, test fixtures or an accessibility certification. Earlier comps and approval history remain in Git and Beads; they do not need duplicate state screenshots here.

## Selected references

| Reference | Selection and purpose |
| --- | --- |
| [Quiet Night](design-review/evidence/dark/dark-quiet.png) | “A - quiet night. works.” All-dark reading surfaces, full brand palette and compact hierarchy. |
| [Media workspace](mocks/media-import/b-selected-desktop.png) | Selected B: one Capture Import chooser, file details beside optional clarification; columns stack on phones. |
| [Media source Idea](mocks/media-import/next-source-ready-desktop.png) | Original file and user clarification remain distinct from the separately recorded AI interpretation in Surrounding context. |
| [Conversational search](mocks/agentic-search/focused.png) | “Approve B”: conversation beside accumulating discoveries, with a narrow disclosure rather than a permanent session rail. |
| [User connections](mocks/user-connections/README.md) | Selected guided desktop and phone references with their associated decisions. |
| [Browse / Focused Map](mocks/browse/README.md) | Approved chronological list and map with a right-hand inspector. Only the selected comp and its essential provenance/notes remain. |

[Selected identities and brand provenance](selected-assets.json) retain the original four reference hashes and the full sixteen-color palette, roles and mixtures. The newer reference packages above retain their own selection notes and any associated provenance. Media design approval is recorded in completed `thought-loom-1kx.1`; implementation and independent checks are recorded in `thought-loom-1kx.2`. Raster text, incidental chrome and older wording do not override current implemented contracts.

## Essential direction

- Quiet Night uses Source Sans 3, dark teal surfaces, cream text, gold primary actions, cyan underlined secondary actions and blue focus/selection. The brand's sixteen colors and their documented mixtures are available, not just four identity anchors.
- Preserve readable type, visible labels/focus, comfortable targets and natural narrow-screen wrapping. Send remains beside the contribution field. Contextual return is an arrow in the existing header; About shares Idea's action row.
- Media and Markdown remain separate choices behind one Import button. Selection sends nothing. Originals, exact clarification, editable title metadata, canonical interpretations and Full replies retain their distinct roles.
- Recovery distinguishes read-only checks from explicit same-key writes. Do not replay writes automatically, invent processing causes, promise cross-reload drafts or hide saved output after a later failure. Rejected content is unavailable to AI; broader user inspection is explicit.
- Search narrows toward existing thinking. Discoveries are existing thoughts; removing a discovery does not reject its thought. Sessions persist until user deletion. [Current conversational-search rules](../apps/web/DESIGN.md#conversational-search-routes-and-composition) and the API own details, not obsolete state boards.

## Approved runtime artwork

These packages retain actual production inputs, outputs and reproducible recipes, not general mockup galleries:

- [Glyph family](candidates/glyphs/content-family/README.md): approved sources, corrected lantern/sprout, nine material/relationship derivatives and byte-comparison fixtures.
- [Explore clearing](candidates/explore-clearing/README.md): immutable source, matte recipe and runtime PNG.
- [Capture canopy](candidates/capture-canopy/README.md): immutable source, resampling recipe and runtime PNG; desktop Capture only, omitted on phones.
- [Root arrival](candidates/root-splash/README.md): immutable approved motion study, exact WebP extraction and reveal geometry. Its two Explore reference captures remain only because the immutable study loads them.
- [Source Sans 3](brand/fonts/SourceSans3-VariableFont_wght.ttf) and [OFL license](brand/fonts/OFL.txt).

Public assets are byte-identical to their retained production sources. Do not regenerate, repaint or promote new art without authorization. Runtime byte comparisons and artwork build checks remain documented in [testing concepts](../docs/testing.md). Test evidence is not a reason to retain one screenshot per state or viewport; future temporary captures belong outside the repository unless explicitly needed.
