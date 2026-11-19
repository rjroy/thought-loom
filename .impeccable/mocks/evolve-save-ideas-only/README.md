# Evolve: Save ideas only

**Composition approved by the user on 2026-11-18.** [Open the exact approved comp](comp.html?state=start) in a local browser from this folder. The approval covers the design, not production implementation or runtime acceptance. The HTML is unchanged from review, including its historical “Unapproved design comp” banner. It uses the repository’s bundled Source Sans 3, Quiet Night tokens, current Evolve shell and original-capture glyph. The review bar and all example content are illustrative. No software service, external image generation, personal library, credentials or network access are needed. Nothing is sent or saved.

## Review the flow

| State | What to look for |
| --- | --- |
| [Start](comp.html?state=start) | Classic remains the default. The new unchecked **Save ideas only** option lives in the fresh Evolve workspace, not in Settings or in the global navigation. No choice dialog interrupts a Classic send. In the comp, opting in and sending any nonblank draft opens the fixed sample exchange. |
| [No saves](comp.html?state=zero) | The completed exchange says **No thoughts saved**. The authors’ words stay in the conversation, not the library, and **Continuing from** stays on the starting thought. A fixed mode label replaces the setup control. |
| [Saved ideas](comp.html?state=saves) | The transcript reads as dialogue. The teal **Saved ideas** section belongs to the exchange but lists only confirmed new thoughts. A user excerpt and an AI synthesis have separate author, selector and single-parent lines. **Change** chooses the next continuation; **Open idea** is an inspection link, not a branch choice. |
| [Keep a passage](comp.html?state=keep) | A blue highlight identifies the exact passage. The inline review identifies author, selector, proposed parent and unchanged next continuation before **Keep as thought**. The local demonstration adds one sample confirmation, not another turn. **Select passage** in the illustrated exchange also lets you select exact words from a readonly message for either speaker. |
| [Resume](comp.html?state=resume) | **Conversation link** identifies one saved conversation. Following it presents a deliberate **Resume**, which opens the recorded transcript and continuation without sending. **Start fresh instead** does not restore an old session. Try the link from the no-saves sample to see that resuming it still has no saved thoughts. No conversation catalog is proposed. |

## Intended boundaries

- Keep the existing Evolve Rail, shared header and Quiet Night reading roles. At 48rem the starting thought becomes a disclosure, saved rows stack and **Send** stays beside the named message field. No artwork, detachable chat panel, fixed composer or new global destination.
- Use the per-exchange save section to distinguish verified library additions from chat text. In the example the AI thought directly develops the saved user excerpt; independent saves would instead show the same parent. The latest confirmed automatic save is the default continuation. Opening a thought and keeping an older passage leave the current continuation alone.
- The manual flow requires finalized stored text and server confirmation, not just a browser selection. Selecting words is not approval to save until **Keep as thought** is activated. Author, selection source, exact passage and parent are distinct. The review demo does not implement eligibility, storage or arbitrary passage admission.
- Leave confirmed saves in place on interruption. Treat an uncertain send as an original-request check, not an error to replay; an unknown result is never labelled **No thoughts saved**. Keep resumed user-visible dialogue separate from eligible AI context. Recovery and access rules are in the [planned product agreement](../../../.lore/context/evolve-view.md#save-ideas-only), not promises about this local comp or current APIs.

**Approved scope:** Classic by default, the per-exchange **Saved ideas** section, inline **Keep as thought** with a parent preview, and explicit resume from the conversation link. The exact `comp.html` SHA-256 is `68877b03a41303c71a3bb5912eabf1547fc646e2f7a6e8e7b42a57050a3dba36`.

## Verification scope

Rendered the six illustrative states at 1440×900 and 390×844 with installed headless Chromium and inspected the output. Geometry checks at 1440, 768, 390 and 320px found no horizontal page overflow. The bundled font and glyph loaded, and no browser errors or non-file requests were observed. Twelve sampled text/background pairs ranged from 6.09:1 to 17.59:1. Local interaction checks covered opt-in, resuming a zero-save conversation, changing the next continuation, keeping an exact passage without retargeting, AI attribution and focus return.

These checks describe only the standalone comp. No production build, daemon, provider, application runtime test, physical-device test or accessibility certification was run.
