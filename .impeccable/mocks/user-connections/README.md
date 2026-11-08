# User-created connections: selected guided composition

Status: **Design handoff finalized. B, Guided inline flow, is selected.** The user also approved mounted-Idea-only drafts with discard warnings and readonly, copyable uncertain-save recovery without automatic retry. Implementation belongs to **thought-loom-rry**. This artifact update makes no production changes and does not approve all state-board visuals.

The user selected **Idea page** as the creation entry and **Include** optional supporting thoughts, then chose B: **“In that case this the guided option will be fine.”** They subsequently answered **Yes** to each bounded behavior decision: mounted-Idea-page-only drafts, warning before Cancel/navigation discards entered work, no reload restoration; and an uncertain save retaining a copyable readonly submitted snapshot, warning that the connection may already exist, with no automatic retry. These approvals do not select A/C, approve every state-board pixel or certify runtime behavior. No unresolved design choice blocks the bounded implementation handoff.

## Selection and exact references

The selected references are unchanged:

| Reference | Dimensions | Packaged SHA-256 |
| --- | --- | --- |
| [Guided desktop](guided-desktop.png) | 1487 × 1058 | `63f05357648be89ba35915e6eae602dd5cc5f3fc8dd3832ae6c481810d283112` |
| [Guided phone](guided-phone.png) | 887 × 1774 | `b5e46e467f3a3180b6009f180f6f4ad10256db2053c0f054c91de064317c8893` |

Only these two sidecars carry scoped composition approval. The subsequent draft/discard and uncertainty approvals are recorded separately in the manifest. A/C and both state boards remain unselected/unapproved. PNGs and embedded generation prompts are historical evidence and have not been repainted, regenerated or relabelled. The previous gallery detector and image-verification results remain historical at their stated scope; recording approvals does not establish runtime behavior.

### Required supporting-thought copy correction

The user found **“Keep the original words”** ambiguous because it reads as a preservation setting. It is an unfortunate illustrative thought title, not a system behavior, checkbox option or toggle. Supporting thoughts are additional existing thought records supplied as `sourceIds`; they do not control preservation, and their source attribution is not endorsement.

Implement clearer identity wording within B's selected layout: title, authorship/material attribution and actual-word preview, with a plainly worded **Remove supporting thought** action. Additional sources record material informing the connection, not verified evidence. Do not present adding/removing a source as enabling/disabling a preservation setting, automatically rename real thoughts, or change saved thought text. This is an implementation copy correction, not another asset-generation or approval gate. The designer checks the actual client for clear thought identity during implementation review. No new visual layout is requested or approved.

## Brief and authority

Extend Thoughtloom's Quiet Night working environment from `apps/web/DESIGN.md`, current Idea/Explore source, and `.impeccable/README.md`. Use Source Sans 3, the existing dark teal/warm text palette, gold primary actions, cyan underlined secondary actions, readable real text and familiar controls. Preserve the shared navigation, contextual header return and Idea's existing Evolve action. Do not introduce imagery, a graph or a new brand system.

The authorized generation route is `codex exec --skip-git-repo-check`, with reference images and the exact prompt on stdin. Generated screens are exploratory compositions only. Raster controls and words are not runtime assets. All sample thoughts are illustrative, not personal data. Actual output dimensions and limits are recorded after inspection; intended desktop frame is 1440px wide and phone frame is 390px wide with natural vertical scrolling.

## Contract boundary

The explorer's verified contract is `POST /connections` with `fromId`, `toId`, one of `supports|contradicts|extends|related`, nonempty `explanation`, and optional `sourceIds` defaulting to `[]`. All endpoints and supporting thoughts must be normally visible. Invalid input returns 400; missing/rejected references return 404. Identity and user authorship are server-derived. There is no creation proxy/UI yet and no established daemon gap.

Every category records explicit directed endpoints, including Related. A direction change changes the sentence's subject/object, never evolution ancestry. Supporting thoughts are additional source references informing the connection, not verified evidence, more endpoints or parents. No connection editing, new categories, automatic restoration, AI generation, duplicate prevention, exactly-once guarantee, reliable retry or reconciliation lookup is proposed.

## Composition alternatives

- **A. In-place workspace:** the focused Idea remains above a two-column inline workspace, with selection/preview left and relationship/rationale right. Lowest navigation cost, but a wider form.
- **B. Guided inline flow:** choose a thought, describe the relationship, then review within a single column beneath Idea. Lower simultaneous density, but more step movement.
- **C. Focused connection workspace:** a contextual work surface entered from Idea, with a starting-thought rail and a focused creation column. Best for longer examination, but introduces a contextual destination.

Phone studies keep each option's sequence without squeezing desktop columns into a narrow canvas. Shared state studies cover validation, saving, confirmed success, known reference failure and unknown outcome. They are alternatives, not simultaneous messages in the application.

The generated desktop candidates are composition evidence, not an alternative design system. Current Source Sans 3, flat palette tokens, blue Explore selection, inactive Settings Reserved and cyan-underlined existing Idea tools override incidental raster drift such as new boxed tools/icons, gradients, teal emphasis and a generated Capture selection. No new decorative symbols or runtime illustration are approved. The initial `inline-desktop.png` has a mislabelled Starting thought and is superseded by the separately named corrected candidate; it is retained as unapproved revision evidence, not a choice to implement.

## Selected flow and implementation defaults

1. Entry is a visible secondary **Connect to another thought…** action. Evolve remains primary on ordinary Idea.
2. Query-first selection shows actual thought wording, authorship and an explicit Choose action. Full-reply hits resolve to their associated thought before it can be chosen. The starting thought cannot be its own second endpoint. Normal visibility is not silently broadened.
3. Four category options have no default. Explicit direction and a live sentence keep subject/object clear. The rationale is required. Optional supporting thoughts use an expandable query/preview/add picker with removal before submission.
4. A visible pre-submit summary repeats both thought titles, direction/category, the written explanation and supporting thoughts. Create connection is the only submission; no extra confirmation modal.
5. Pending locks the submitted snapshot against repeat sending. Confirmed creation alone shows **Connection created · Proposed by You** and a normal recorded relationship. No automatic navigation is needed.
6. Validation retains all unrelated inputs. A 404 says a connected or supporting thought is unavailable, without guessing whether rejected or missing or naming a particular record without evidence. Reselection preserves the rationale. An unconfirmed outcome retains a readonly submitted snapshot, warns that creation may have completed and offers navigation/copy only, not a reliable Check or Retry action. Ordinary reads are browsing, not proof this request failed.
7. The approved draft lifetime is the mounted Idea page only, with warnings before Cancel/navigation discards entered work and no reload restoration. Ordinary keyboard/search details below are implementation defaults to verify, not further user decisions. These images do not promise autosave, physical-device or accessibility certification.

The same illustrative starting thought applies across desktop and phone. Its complete wording is “A useful connection should help me ask a better question, not tell me what I believe.” A shorter phone depiction is an excerpt, not edited saved wording; an implementation must show the complete text or an explicit expansion affordance. “Remember the question” has the illustrative words “I often remember the question before I remember the note.” “Keep the original words” is unsuitable example-title copy to replace in implementation fixtures, not reject as a domain thought or regenerate in these images; the unchanged PNG still contains it. Search/preview must use actual recorded wording, never a generated summary.

## Review scope

B's desktop/phone composition and the two separately recorded behavior decisions settle the design handoff. State-board visuals are reference-only, not wholesale visual approval. The source-identity copy correction and ordinary defaults are verified in actual implementation, not sent through another asset-approval loop. Separate implementation scope and controlled/domain/transport/browser/documentation coverage are captured in **thought-loom-rry**; this design-record invocation does not execute that work.

## Candidate views

[Open the static image review gallery](index.html). It displays the exact PNG candidates only; it is not a connection-creation prototype and sends no requests.

| Option | Desktop | Phone | Tradeoff |
| --- | --- | --- | --- |
| A. In-place workspace | [Revised desktop](inline-desktop-revised.png) | [Phone](inline-phone.png) | Search and relationship stay visible together; highest simultaneous density. |
| **B. Guided inline flow, selected** | [Desktop](guided-desktop.png) | [Phone](guided-phone.png) | One-column reading order and explicit sentence-based direction; longer vertical flow. |
| C. Focused workspace | [Desktop](focused-desktop.png) | [Phone](focused-phone.png) | More focused examination with a starting-thought rail; adds a contextual destination. |
| Shared state treatment | [Desktop specimens](states-desktop.png) | [Phone specimens](states-phone.png) | Validation, pending, confirmed success, unavailable references and uncertainty are alternatives. |

**Selected: B.** It preserves Idea context, makes the error-prone direction choice a readable sentence and adapts without a separate task route. Its sequence is a progressive inline form, not a requirement for three separate submissions. A/C are retained comparison evidence, not implementation alternatives to choose without another user decision.

The desktop state board also sketches search results, empty results and a retryable search read. A search retry is not a connection-creation retry. Supporting-thought search uses the same actual-text preview pattern as second-thought selection, with **Add supporting thought** instead of **Choose this thought**. Existing submitted supporting IDs must remain visible in the frozen pending/uncertain summary even where a compact specimen omits them.

## Visual review findings and boundaries

- Native images were decoded and individually inspected before handoff; exact dimensions, hashes, references, prompts, scoped selection/approval status and source paths belong to `manifest.json` and image sidecars. Prompt embedding changed PNG metadata only, not the decoded artwork. No PNG changed when B was selected.
- The revised A fixes the erroneous Starting thought label. Its generator omitted the existing Idea tool row; that omission is not a removal proposal. Ordinary Idea retains its current Evolve and Edit title / Full reply when present / About / More actions controls, with the new secondary Connect action. Existing controls may not be silently removed from implementation.
- B's desktop raster incorrectly selects Capture. Retain the current Idea/Explore navigation behavior and blue selection, as shown in its phone study. The generated step headings do not authorize gold navigation decoration or multiple writes.
- C's second in-content Return to idea is a concept affordance, not authorization to duplicate the current header-return convention. Preserve one contextual header return when implementing the selected design.
- Teal-filled secondary actions, new checkmark/eye/link decoration, glow/gradient surfaces, incidental italic wording and new boxes around existing tools are not approved system changes. Use incumbent CSS tokens and button/link treatments. Selected category and chosen-thought state must remain worded and distinguishable from creation success.
- Images are approximate composition studies, not 1440/390 CSS-viewport screenshots. In particular, the portrait images do not establish readable font sizes or 44px targets after proportional reduction to a phone. Implementation must flow at the existing body/metadata sizes and may be substantially taller. Do not scale the whole image into one screen.
- State boards are labelled specimens, not a page displaying every result together. Some generated specimen text looks like an input; final status text remains static text, while only retained editable input stays editable. Pending/uncertain snapshots are readonly and copyable. The rationale must keep a real persistent label, not only the placeholder shown in a compact specimen.
- Source/copy identity and image checks are design-artifact validation only. No app runtime, physical-device, software-keyboard, focus, screen-reader, contrast or browser-test result is claimed. The scoped Impeccable detector on the static image gallery returned `[]`; this is not an application UI verdict.

**Design is settled for this scope: B plus the explicit draft/discard and uncertainty approvals.** No production build phase is advanced by this documentation update. The historical Impeccable comp scaffold is not an unresolved design decision or a reason to reopen asset generation. State-board visual approval and actual-client/runtime acceptance remain distinct from the completed design handoff.

## Bounded behavior handoff

The first two lifecycle rules and uncertainty rule contain the user's explicit approvals. Other rows are bounded implementation defaults and contract constraints, not claims that the user voted on each keyboard detail. Verify them under **thought-loom-rry**; do not turn ordinary implementation details into further design interviews.

| Concern | Agreed behavior, implementation default or contract constraint |
| --- | --- |
| Draft lifetime | **Approved:** keep one unsent draft only while its Idea page is mounted, through query changes, previews, category/direction changes and supporting-thought selection. Do not overwrite the rationale on reselection. Do not restore the draft after leaving/unmounting or reload. No autosave, local-storage or offline promise. |
| Cancel and navigation | **Approved:** warn before Cancel or navigation discards entered work. Declining discard keeps the draft and cancels that navigation; accepting closes/leaves without a POST. Empty Cancel needs no discard warning and returns focus to Connect. Use existing confirmation conventions for in-app navigation and native unload protection where the browser permits it; native warnings are not a persistence guarantee. Pending Cancel cannot cancel a sent write; leaving is not cancellation. Verify warning, retention and focus behavior in implementation. |
| Keyboard and focus | Use existing visible blue focus, native controls and document order. Opening creation focuses its first search field; opening the supporting picker focuses its query. Search Enter issues a read only; multiline Enter remains a newline. Only explicit Create activation writes. Choosing a result moves to the Describe heading; validation focuses the first invalid field and associates its error. A confirmed receipt may receive focus, but not a late result after the user has moved elsewhere. No focus trap or new modal for the ordinary form; apply existing dialog conventions to the approved discard warning. Verify these details in the actual client, not another comp round. |
| Category and direction | Offer exactly the four existing categories, no category default and an explicit sentence-based directional choice; the example's Extends selection is not a product default. Related still records directed endpoints. Preserve explanation/support selection when reversing direction, but require review of the resulting sentence before Create. |
| Search and preview | Explicit query-first search in normal scope, with no recent-thought feed, automatic rejected inspection or AI generation. Preserve ordinary Explore memory. Only the latest query may populate results. Empty/error/loading remain distinct; Retry search repeats only a read. Full-reply hits identify their associated thought, never a new response endpoint. Preview actual thought wording and metadata; any grouping of several hits for one thought must keep that distinction clear. No new daemon search/filter feature is assumed. |
| Supporting thoughts | Optional normal-scope existing thought identities, with search/preview/add and removal before submission. Empty selection uses the API's empty-source default. Identity wording must not read as a setting. Preserve every submitted supporting identity in the pending/uncertain snapshot. Do not invent endpoint-as-source or repeated-source rules without checking existing validation. |
| Confirmation and failure | The visible review summary is the confirmation, with one explicit Create submission. A canonical `201` connection response alone establishes created/proposed-by-You. Required explanation and invalid input remain field-associated; a `404` says referenced material is unavailable without guessing which record or why. Preserve valid selections and rationale. Apply incumbent status/error styles and verify final readable wording in the client; unchanged state boards are illustrative, not pixel approval. |
| Uncertainty | **Approved:** retain a readonly, copyable submitted snapshot and warn that the connection may already exist. Never automatically retry/replay the POST. Guard double activation. A transport error is not proof of non-creation; no Check/status lookup, duplicate prevention, exactly-once guarantee or reliable retry is assumed. Browsing current Idea records does not prove this request failed. Copy/navigation remain available; a deliberate second creation must not be disguised as a safe Retry. |

**No remaining user design decision blocks this handoff.** Actual-client copy clarity, keyboard/focus, responsive layout, discard guards, search concurrency and recovery are implementation checks under **thought-loom-rry**, not additional asset approvals. Stop for a real unsupported daemon capability or a material departure from selected B, not ordinary implementation of these defaults.

## Bounded implementation scopes and verification

Implementation follow-up is **thought-loom-rry**, inspected with `bd show thought-loom-rry`. Beads remains authoritative for its status and routing. The scopes below describe that bounded handoff, not work performed by this design-record invocation or a parallel task tracker.

- **Next server boundary:** add only fixed-purpose user connection creation through browser → Next server → existing Hono `POST /connections`. Keep credentials server-side. Validate user intent using the exact supported fields; derive neither authorship nor connection identity in the browser. Reuse established origin/request guards and honest response classification; do not add reconciliation, retry or daemon work to make a screen convenient.
- **Client:** implement selected B within Idea using current styles, search/read boundary and existing connection presentation. Keep draft/confirmed records separate, inputs readable on narrow screens, source identity unambiguous and stale results unable to replace newer choices. Existing title/evolution/rejection actions remain separate. Any visual-layout change or unsupported capability returns to user review.
- **Controlled tests:** inspect existing connection-domain/HTTP coverage before extending it. Preserve tests for user-derived authorship/ID, all categories, nonempty explanation, normal visibility of endpoints/sources, default empty sources, `400`/`404` and immutable evolution boundaries. Add focused Next transport tests for exact forwarding, credential/origin protection and failure/unknown classification; client state tests for retained drafts/snapshots, direction/source review, late search responses and duplicate activation. Fixtures own their IDs/text/configuration and never use a personal database/provider.
- **Browser boundary:** extend the owned runtime fixture for selection/preview, both directions, required rationale, optional source add/remove, final summary, single POST, success, known `400`/`404` create-request failures, uncertain response and scoped no-replay behavior. Cover agreed Cancel/focus/draft lifetime at desktop/phone and maintain harness allowlists if new runtime files are added. A separate shared-record integration check may use the owned real Hono/SQLite fixture; neither harness may use the operator service.
- **Docs and review:** update `apps/web/DESIGN.md` for implemented UI, testing documentation for new coverage and API/startup docs only if their actual contracts change. Perform actual-client desktop/narrow, long-text, keyboard/focus and recovery review after authorization. Existing generated phone studies and gallery checks are not that acceptance.

## Artifact verification

Current record/link/hash verification is independent of browser dependencies:

```sh
python3 .impeccable/mocks/user-connections/verify-records.py
```

It checks the two exact selected references, separate Yes approvals, absence of remaining design decisions, all retained image/prompt identities, sidecar/manifest agreement and local links. It does not run the application. The image-generation and optional gallery-browser evidence below remains historical, not newly rerun runtime validation.

- The nine native PNGs (eight review images plus the superseded initial A) decode. Source/copy hashes matched before prompt embedding. Exact request text is embedded in every packaged PNG, and ImageMagick decoded-pixel comparisons with all native originals return zero changed pixels after embedding. `impeccable embed-prompt --scan .impeccable/mocks/user-connections` reports **9 rasters, 0 missing**.
- Every review PNG was opened from its final repository-relative path and inspected for composition, readable content at native size, identity/direction consistency, inputs, review summary and appropriate state distinctions. These inspections found the specific exceptions above, not an approved design or runtime pass.
- An initial verification wrapper expected a bare number from ImageMagick, which returned `0 (0)`. Its parser was corrected to read the first number; all nine image comparisons then passed. No image regeneration or pixel changes were used to make validation pass.
- `impeccable detect --json .impeccable/mocks/user-connections/index.html` returned **[]**.
- `bun --no-env-file .impeccable/mocks/user-connections/verify-gallery.ts` was attempted but is **blocked**: `Cannot find module '@playwright/test' from '.../apps/web/package.json'`. No dependency/browser installation or service startup was attempted. The gallery's browser loading, layout, keyboard checks and screenshot captures therefore remain unverified. The script uses an allowlisted, fulfilled-only browser context when prerequisites are present; it never starts the application/daemon or makes real network connections. Its intended captures are gallery evidence only, not app/phone validation.
- Static local image/font/document links and candidate hashes are checked separately. No production test suite, typecheck, build or app-browser harness was run for this design-only change.

Generation is not promised byte-reproducible. The retained PNGs and their exact packaged hashes are the review identities. Native staging paths in the manifest are provenance, not dependencies for viewing the portable local gallery.
