# Glyph integration — independently verified and runtime accepted

## Independent verification

A separate read-only tester confirmed all 97 recorded inputs match both checkout and isolated fixture (194 hash comparisons), plus byte-identical approved/runtime SVGs. Focused Capture/Explore tests passed (97 pass, 0 fail), web typecheck passed, and the desktop/narrow browser driver passed, each with exit 0. The tester inspected the screenshots and found no material implementation, accessibility or maintainability concern. Final screenshot hashes match the author evidence below. Logs are `/tmp/opencode/thoughtloom-glyph-final-{unit,typecheck,browser}.log`. No full suite or production build was run.

The user answered **“yes”** to **“Ready to integrate them into Explore and Capture?”** after approving both exact corrected SVGs, explicitly including the separated gold leaf. The user subsequently accepted runtime previews: **“works for me ... what's the next glyphs you are thinking of?”** These two are the currently implemented subset, not the full glyph-family goal. Further exploration awaits a designer-led brief and approval; no additional glyph generation or integration is authorized yet.

## Exact runtime copies

- `apps/web/public/glyphs/lantern.svg`: byte-identical to `production/corrected/lantern.svg`, SHA-256 `24cda858b91c39e01711cf1a8692e5aaa6d7657dc6165ab40265bfc6a9dd7329`.
- `apps/web/public/glyphs/sprout.svg`: byte-identical to `production/corrected/sprout.svg`, SHA-256 `585b9522651ab998079ff283af994ce12aca44792359d4dc4369ed56f997b4b1`.

Both occupy 24px squares with an 8px heading gap, empty alternatives, `aria-hidden` and no interaction. Explore's lantern precedes **Find your recorded thinking** only in its unvalidated initial state; query validation, invalid links, loading, results, empty results and read errors have no glyph. Capture's sprout remains beside **Capture** across states; Import stays at the right. Heading names, focus order and control targets are unchanged. Next's unoptimized local image path serves the original SVG bytes; no SVG optimization/configuration was enabled.

## Before/after screenshots

Actual Next application renders, not generated comps or recreated HTML. Capture contains a test-owned illustrative draft. All eight images were opened and inspected. Next's small development indicator is visible; it is not an added Thoughtloom control.

| Surface | Before | After |
| --- | --- | --- |
| Explore, 1440×900 | [before](before-explore-1440.png) | [after](after-explore-1440.png) |
| Explore, 375×812 | [before](before-explore-375.png) | [after](after-explore-375.png) |
| Capture, 1440×900 | [before](before-capture-1440.png) | [after](after-capture-1440.png) |
| Capture, 375×812 | [before](before-capture-375.png) | [after](after-capture-375.png) |

[Before metrics](before-metrics.json) and [after metrics](after-metrics.json) confirm identical search/form/Import rectangles and heading heights/Y positions at both widths. Only the intended inline footprint changes. No added row, form-spacing change or horizontal overflow was observed. One CSS correction after the first after-render batch restored Explore's original text baseline; the final batch passed. No UI edits followed final captures.

## Owned fixture and commands

Retained for independent reuse: `/tmp/opencode/thoughtloom-glyph-author-EBTF60/workspace`. The temporary driver is `apps/web/tests/glyph-author.ts` inside that fixture. It uses the existing foundation source allowlist, Capture/Search fake-daemon fixtures and browser companions. All 97 runtime/test inputs were refreshed after the last UI edit. Check [after source hashes](after-source-hashes.json) against checkout before reuse; [baseline hashes](baseline-source-hashes.json) intentionally predate implementation. No `.env*`, private launchers, personal databases or build artifacts were copied.

Dependency setup was authorized and executed only inside this explicitly verified owned source-copy workspace. No checkout/global install occurred. Installed Next public-folder and SVG/image docs were read there before coding. Versions: Bun 1.4.3, Next 16.4.5, Playwright 1.64.1, Chromium 155.0.8059.84.

Every fixture command used this cleared-environment prefix:

```sh
env -i PATH="$PATH" HOME=/tmp/opencode/thoughtloom-glyph-author-EBTF60/home TMPDIR=/tmp/opencode/thoughtloom-glyph-author-EBTF60/tmp
```

| Workdir | Command after prefix | Result |
| --- | --- | --- |
| Verified owned workspace | `NODE_ENV=test bun --no-env-file install --frozen-lockfile --ignore-scripts --prefer-offline --cache-dir /home/rjroy/.bun/install/cache --backend=copyfile` | Exit 0 |
| Owned `apps/web` | `bun --no-env-file tests/glyph-author.ts before` | Exit 0; baseline screenshots/metrics |
| Owned `apps/web` | `bun --no-env-file tests/glyph-author.ts after` | Exit 0; final screenshots, asset bytes/content type, decorative semantics/state exclusions, affected browser companions and unchanged geometry |
| Owned workspace | `bun --no-env-file test tests/web-capture.test.ts tests/web-explore.test.ts` | Exit 0; 97 pass, 0 fail |
| Owned workspace | `bun --no-env-file run web:typecheck` | Exit 0 |

In checkout, `/home/rjroy/.agents/skills/impeccable/scripts/impeccable detect --json apps/web/src/components/capture-form.tsx apps/web/src/components/capture.module.css apps/web/src/components/explore-view.tsx apps/web/src/components/explore.module.css` exited **0**. It reported five advisory font-ramp findings on existing unchanged Explore font sizes; no unrequested typography repairs were made.

The driver owns its loopback Next development process group, HTTP fake daemon and Chromium browser. Cleanup closes browser/pages, releases held responses, terminates the owned Next group and closes the HTTP listener. Both successful stages completed that cleanup; no preview process is intentionally retained. Fixture files remain available. No operator daemon, OpenCode service, provider or private credentials were used. Explore companion scroll checks passed: desktop 1042→1042; narrow 3819→3819.

## Maintained coverage, docs and limits

Existing Capture/Explore companions now check loaded 24px decorative images, 8px gaps, accessible heading names, no image focus stop and state-specific presence/absence. Both browser source-copy allowlists include the public SVGs; foundation HTTP checks compare served bytes with fixture originals. These are browser/DOM checks, not brittle source-string assertions or the superseded connected-leaf preference.

`apps/web/DESIGN.md` and `.impeccable/README.md` document exactly this two-glyph exception; other decoration remains excluded. `docs/testing.md` records coverage. Root README needs no change because no product capability/navigation contract changed. API/domain/daemon docs are unaffected.

No full suite, production build, full production runtime harness or shared-record walkthrough was run. Independent focused validation is recorded above. No physical-device, screen-reader, software-keyboard or cross-browser certification is claimed. No commits, Beads commands/mutations, source-art edits, operator-service changes or artifact deletion occurred during integration.
