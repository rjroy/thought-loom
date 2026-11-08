# User-created connections: selected design

**Selected: B, Guided inline flow**, starting on Idea with optional supporting thoughts. User: “In that case this the guided option will be fine.” Design decisions are settled; implementation follow-up is **thought-loom-rry**.

## Selected references

- [Desktop](guided-desktop.png), 1487 × 1058. SHA-256: `63f05357648be89ba35915e6eae602dd5cc5f3fc8dd3832ae6c481810d283112`.
- [Phone](guided-phone.png), 887 × 1774. SHA-256: `b5e46e467f3a3180b6009f180f6f4ad10256db2053c0f054c91de064317c8893`.

These unchanged Codex-generated composition references retain their embedded generation prompts. Content is illustrative. Phone framing is approximate, not a CSS viewport or accessibility certification. Preserve readable text and targets rather than scaling the raster. Selection does not imply blanket approval of discarded state-board visuals or runtime acceptance.

## Agreed flow

- A secondary **Connect to another thought…** action opens the guided inline flow below Idea. Search/preview actual, normally visible thought wording, then explicitly choose the second thought. Full-reply hits identify their associated thought, not a separate endpoint.
- Offer **Supports, Contradicts, Extends, Related**, without a category default. Use explicit sentence-based direction, including for Related, a required rationale, and optional additional source thoughts. Preserve rationale and source selection while changing direction or candidates.
- Show both thought identities, direction/category, rationale and sources in a visible review summary before one explicit **Create connection**. Pending submission prevents duplicate activation. Canonical `201` alone establishes creation; known failures retain inputs. Never guess which reference is unavailable or whether it was rejected.
- Drafts stay intact between wizard steps, but refresh or leaving the Idea page may clear them. The user explicitly chose simplicity over navigation-warning machinery: no history interception, browser restrictions or browser storage. A simple Cancel confirmation is sufficient. Leaving cannot cancel a sent write.
- **Approved:** an uncertain save retains a readonly, copyable submitted snapshot and warns that the connection may already exist. No automatic retry, reliable reconciliation, duplicate-prevention or exactly-once claim.

## Essential corrections and boundaries

**Additional sources are existing thoughts informing the connection, not verified evidence or endorsement.** “Keep the original words” is a confusing sample title, not a preservation setting. Make source identity clear with title, attribution and actual-text preview; use **Remove supporting thought**, not checkbox-like settings. Correct implementation copy within B, without another asset-approval loop or an unreviewed layout change. Do not rename real thoughts or edit saved wording.

Preserve the existing Quiet Night shell, Source Sans 3, contextual return, Idea tools and primary Evolve action. The desktop raster's Capture selection is wrong: retain existing Idea/Explore navigation and blue selection/focus. Existing cyan-underlined secondary tools and flat palette tokens override incidental generated boxes, icons, gradients or styling.

Use browser → Next server → existing Hono `POST /connections`: `fromId`, `toId`, `category`, nonempty `explanation`, optional `sourceIds` defaulting to `[]`. Endpoints/sources require normal visibility; invalid input is `400`, unavailable references `404`. IDs/authorship are server-derived. No daemon expansion, connection editing, new categories or evolution-parent changes.

**thought-loom-rry** owns controlled domain/transport/state tests, owned desktop/phone browser coverage, affected documentation and actual-client designer review. Verify source identity, keyboard/focus, discard guards, stale searches, responsive readability, failures and uncertainty. Ordinary implementation checks are not new user design decisions; discuss only unsupported capabilities or material departures from B.
