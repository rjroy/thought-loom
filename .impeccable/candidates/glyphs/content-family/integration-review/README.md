# Nine glyphs — controlled in-app integration evidence

**Implemented with approved production bytes; independent verification and technical review pass; user accepted the in-app placements.** This is actual Next.js production UI over owned deterministic HTTP fixtures, not a generated comp or operator-service session.

After the Idea/Explore/Evolve runtime previews, the user answered **“yup”** to **“Do these in-app placements work for you?”** This accepts the nine-glyph integration, separately from the earlier artwork, derivative and integration authorizations.

## Independent verification and review

The read-only tester verified all 131 checkout/fixture input identities and all nine approved/public asset identities, then reran 197 unit tests (669 assertions), web typecheck, and a fresh production build plus focused Explore/Idea/Evolve browser checks at 1440px and 375px, including the existing heading glyph smoke. All exited 0. Logs: `/tmp/opencode/thoughtloom-glyph-independent-green-{unit,typecheck,runtime}.log`; independent screenshots: `/tmp/opencode/thoughtloom-glyph-independent-current-AKqr5l/`. No owned processes remained.

Independent correctness review accepted the implementation with no material findings; separate engineering-quality assessment found the shared presentation component proportionate. The two relationship PNGs total 437,646 bytes; cold-cache performance was not measured. Smaller derivatives are a future measurement-led option, not an authorized appearance change. Unknown-kind behavior was not separately exercised; unavailable context was visually checked. Full older browser walkthroughs and the full suite were not run. Existing decoders reject unsupported kinds.

## Before / after

| Surface | Desktop1440px | Narrow375px |
| --- | --- | --- |
| Explore: five material kinds, Full reply and contextual relationships | [before](content-before-explore-1440.png) · [after](content-after-explore-1440.png) | [before](content-before-explore-375.png) · [after](content-after-explore-375.png) |
| Idea: focused kind, retained reply, overlapping evolution/source/connection context | [before](content-before-idea-1440.png) · [after](content-after-idea-1440.png) | [before](content-before-idea-375.png) · [after](content-after-idea-375.png) |
| Evolve: starting thought, confirmed contribution, full reply and saved development | [before](content-before-evolve-1440.png) · [after](content-after-evolve-1440.png) | [before](content-before-evolve-375.png) · [after](content-after-evolve-375.png) |
| Imported focused Idea,24px | [after](content-after-idea-imported-1440.png) | [after](content-after-idea-imported-375.png) |

[Measured DOM sizes/labels](content-after-metrics.json), [baseline measurements](content-before-metrics.json), [execution and source/asset identities](receipt.json).

These are full-page captures: desktop viewport1440×1000, narrow375×812. Actual image canvases are20px list/material/record cues,24px focused Idea and16px persisted relationships. Browser assertions check exact source bytes, loaded images and CSS dimensions. Text and immutable thought wording remain visible. Before/after Idea captures open different existing rationale disclosures (baseline source connection versus current interpretation connection), so these are visual evidence, **not pixel-identical regression goldens**.

The rendered set was inspected across both widths. Byline centers, text wrapping, narrow disclosure flow, context strips, retained reply panels and Send beside the composer remain coherent, without page overflow or clipped glyphs. Full reply gets one record-role cue, not an extra competing material icon. No kind is fabricated for unavailable context; known relationship wording/marks can remain. Source→leaf remains label-dependent at16px. Existing lantern/sprout24px heading gaps and empty/hidden image semantics received a short smoke check, not a repeat of their full prior acceptance walkthrough.

## Implementation scope

- Exact nine assets copied from [approved production outputs](../production/runtime/) to `apps/web/public/glyphs/`; rejected relationship SVGs never promoted. Seven SVGs and two PNGs remain byte-identical to approved outputs. Lantern/sprout and all earlier artwork are unchanged.
- Shared `content-glyph.tsx`/CSS maps existing presentation kinds/record roles/relations to those exact files. Explicit16/20/24px sizes,8px material gaps,6px relationship gaps, empty alternatives, `aria-hidden`, no focus target or pointer interaction. Unoptimized/eager loading preserves source identity and avoids late glyphs on long narrow lists; artwork is not rewritten.
- Idea: focused actual kind24px; known context kinds and Full reply panel20px; existing parent/child ancestry, discovered connections and provenance16px.
- Explore: actual result kind **or** Full reply20px; actual predecessor/connection context16px. Existing words, authorship, date, direction and rationale retained. No new search facets.
- Evolve: known starting thought, admitted contribution, actual saved development and retained Full reply20px. Contribution/reply now explicitly name their material/record role beside attribution. Drafts, run state, action controls and merely future **Continuing from** choice receive no invented semantic glyph.
- Both isolated browser source-copy allowlists include the nine files and shared component/CSS. Existing test assertions were preserved; the only test-harness production edit is necessary input plumbing.

No domain/storage/daemon changes, generation, asset editing, installs, operator services, tracker mutation or commit. New source colors, animation, controls and additional decoration are not part of this work.

## Focused validation

Prerequisite independent RED was supplied by the orchestrator: Explore missing captured-original on a visible controlled result, Idea missing imported-original on its visible focused imported record, and Evolve missing captured-original on the known starting context. Each was an expected missing-image failure, not a setup failure.

Author commands run with a cleared environment inside the verified existing fixture `/tmp/opencode/thoughtloom-glyph-author-EBTF60/workspace`, not the checkout. No dotenv files were present in fixture root/web; installed Next16.4.5 resolves inside that workspace. Relevant installed Image-component documentation and the Impeccable craft floor were read before UI edits. No new dependency installation occurred.

```sh
# From the fixture workspace:
env -i PATH="$PATH" HOME=/tmp/opencode/thoughtloom-glyph-author-EBTF60/home TMPDIR=/tmp/opencode/thoughtloom-glyph-author-EBTF60/tmp bun --no-env-file test tests/web-explore.test.ts tests/web-idea.test.ts tests/web-evolve.test.ts tests/web-evolve-read.test.ts
env -i PATH="$PATH" HOME=/tmp/opencode/thoughtloom-glyph-author-EBTF60/home TMPDIR=/tmp/opencode/thoughtloom-glyph-author-EBTF60/tmp bun --no-env-file run web:typecheck
# From fixture workspace/apps/web:
env -i PATH="$PATH" HOME=/tmp/opencode/thoughtloom-glyph-author-EBTF60/home TMPDIR=/tmp/opencode/thoughtloom-glyph-author-EBTF60/tmp bun --no-env-file tests/content-author.ts before
env -i PATH="$PATH" HOME=/tmp/opencode/thoughtloom-glyph-author-EBTF60/home TMPDIR=/tmp/opencode/thoughtloom-glyph-author-EBTF60/tmp bun --no-env-file tests/content-author.ts after
```

Final unit/typecheck commands and successful production baseline/after runs exited **0**. The owned author runner builds production Next afresh, starts only its loopback server and controlled daemons, invokes the unchanged `checkExploreGlyphs`, `checkIdeaGlyphs` and `checkEvolveGlyphs` at both widths, captures the UI and closes browser/listeners/process group in `finally`. It additionally checks no horizontal overflow, loaded decorative semantics without exposed image roles, About Enter/focus retention and no direct browser credential/daemon requests. It is not comprehensive keyboard/screen-reader certification.

Initial owned-runner attempts are retained in the receipt: development-mode baseline did not reach controlled search content; the first production runner build exposed a local runner TypeScript annotation error, corrected without app changes. A later genuine narrow loading failure led to explicit eager loading in the production glyph helper. No test assertion was weakened. Final production checks are green; no full suite or shared-record walkthrough is claimed.

## Independent reuse

The owned fixture is retained, with no running author processes. `content-inputs.json` lists131 current source/test/public/approved-reference inputs, and `content-source-hashes.json` maps each to SHA-256. Before reuse, verify every checkout file and fixture copy against that manifest; refresh only explicit allowlisted inputs if any differ. Also verify the fixture-only author runner hash from the receipt. Do not copy `.env`, databases or generated checkout build output. The author runner always builds its own Next artifacts; independent testing should likewise build afresh rather than treat `.next` as a fixture.

For the maintained focused bootstrap, use documented `THOUGHTLOOM_TEST_GLYPH_CASE=explore|idea|evolve` with `web:test:runtime`. It owns source copying and frozen dependency setup in a separate verified fixture. Independent GREEN, technical review and user acceptance are recorded above.
