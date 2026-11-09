# Thoughtloom

*Where ideas take shape.*

Thoughtloom explores a question: can AI help someone discover and develop thinking they would otherwise have missed?

The goal is to capture rough thoughts without ceremony, find meaningful connections, and develop ideas through dialogue. The thinking should remain useful outside the application, not become another chat transcript to reread.

## Principles

- Preserve original thinking. Development adds new thoughts to a branching chain rather than rewriting the past.
- Keep titles editable, separate from immutable thought content and ancestry.
- Attribute AI contributions. Reading a suggestion does not mean agreeing with it.
- Give users control. Rejected material stays available for deliberate inspection but is excluded from AI use.
- Keep business rules independent of screens. The daemon comes first; visual changes must not silently reshape the domain model.

## Start here

| Document | What it covers |
| --- | --- |
| [Server startup](docs/server-startup.md) | Install and run the daemon and web client; configure their server-side boundary. |
| [Production deployment](docs/production-deployment.md) | Build and supervise persistent loopback-bound services, with optional private HTTPS access; manage credentials, backups and upgrades. |
| [Testing concepts](docs/testing.md) | Automated test boundaries, isolated fixtures, the walkthrough, and manual testing. |
| [Daemon API](docs/daemon-api.md) | Authentication, request and response shapes, routes, and examples. |
| [Database schema](docs/database-schema.md) | SQLite tables, relationships, constraints, and migrations. |
| [Portable backup and restore](docs/backup-restore.md) | Online JSON/original-media capture, Git backup and offline empty-target restore; contracts and validation boundaries. |
| [Client design system](apps/web/DESIGN.md) | Implemented palette, typography, layout, interaction patterns, and responsive rules. |

## Current state

The Bun/TypeScript daemon provides SQLite persistence, immutable evolution trees, editable titles, rejection/restoration, FTS5 search with spellfix1 typo handling, both Markdown export modes, and manual test scripts. Configured OpenCode integration supports background weaving, conversational development, and read-only report investigation through scoped application capabilities.

Weaver instructions support URL summaries and source-informed interpretations through available native/MCP tools. Bare link lists can produce separately searchable sibling summaries with inline source links; completed weaving retains a Full reply with outcome and access limitations. Retrieval depends on the operator's tools and source access; Thoughtloom does not archive fetched source snapshots. See [URL-aware weaving](.lore/context/url-weaving.md).

Idea's [Reinterpret action](docs/server-startup.md#reinterpret-an-idea) requests fresh weaving without replacing earlier interpretations, replies or branches. It also provides a recovery path after source access changes.

Lossless Markdown import is available from Capture through a separate import workspace, with queued execution, restricted configured segmentation or local structural fallback, bookmarkable reports, and user-only original-byte inspection. Imported wording is preserved; document order does not create an evolution chain.

Retained image/PDF import is available from Capture's **Import → Image or PDF** workspace and through the user-only [backend API](docs/daemon-api.md#retained-media-import-and-source-inspection). The client separates original retention from AI interpretation and supports receipt recovery, source inspection/download, run status and deliberate retry. Originals stay outside SQLite; normal Weaver/Evolve receives a managed absolute path for OpenCode's tools. **The daemon and OpenCode must share filesystem access.** See the [web workflow](docs/server-startup.md#image-and-pdf-import-workflow) and [setup and paired backups](docs/server-startup.md#retained-media-and-shared-filesystem).

Conversational agentic search is available from Explore's **Ask your library** and **Saved searches** links: saved conversations rediscover existing thoughts without creating new knowledge. Sessions have bookmarkable links and remain until explicitly deleted. See the [web workflow](docs/server-startup.md#conversational-search) or try the [isolated daemon walkthrough](docs/testing.md#isolated-agentic-search-walkthrough) without a provider.

The separate Next.js/React client provides Capture, bookmarkable Explore searches, Idea reading with title metadata, user-created connections and rejection/restoration controls, Evolve with recorded developments and known-run status/Stop, and Simple/Agentic Markdown exports. Browser requests use a server-only daemon boundary. Without agent configuration, capture, search, user-created connections and Simple export remain usable; weaving jobs stay queued and titles use the display fallback. Evolve and Agentic export require explicit server-side agent configuration. Settings remains reserved, with no implemented settings screen.

Product intent and working agreements live in [`.lore/context/`](.lore/context/). The documents above distinguish implemented behavior from explicitly marked planned contracts.
