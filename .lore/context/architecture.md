---
title: Architecture and working agreement
date: 2026-11-03
status: agreed baseline
tags: [thoughtloom, restart, architecture, workflow]
---

# Architecture and working agreement

## Agreed technology

- **Website:** Next.js with React.
- **Daemon:** Hono.
- **Runtime and tooling:** Bun.
- **Storage:** SQLite through Bun's built-in `bun:sqlite`, selected for the Phase 1 foundation. Each non-root thought has one evolution parent; weaver-discovered connections are stored in a separate linking table, not as additional evolution parents.
- **Agent runtime:** OpenCode, for weaving, evolution, and Agentic export.

## OpenCode integration and compatibility

Use the maintained `@opencode/client` from the daemon to attach to the configured operator-managed OpenCode service. Keep service credentials and the client server-side. The application does not own the shared service's startup, shutdown, or upgrades.

OpenCode **2.2.2** is an allowed integration baseline; targeting a newer release is also allowed. Do not reject a service merely because its version is newer than the development baseline. Avoid exact-version equality checks or discovery constraints that silently enforce that restriction. Validate the API capabilities actually needed, and report a concrete incompatibility if one exists; accepting newer versions is not a claim that every future API will be compatible.

Reuse the prior [2.2.2 integration validation](../work/research/opencode-2.2.2-validation.md) and [restricted-generation research](../work/research/opencode-2.2.2-restricted-generation.md) as starting evidence. Their pinned versions and exact-version discovery examples describe historical fixtures, not production version gates. Revalidate relevant behavior with a focused compatibility smoke when integrating or changing versions; do not repeat broad research or alter the operator's service merely to reproduce the baseline.

### Agent tool-access policy

Weaver and Evolve may use the operator-configured OpenCode native tools and MCPs, including shell and filesystem access, with fully permissive unattended execution. Thoughtloom does not maintain a per-tool allowlist. This trusts the operator environment and its configured tools, including future additions, with relevant thought context and any external side effects.

Agentic Search, Agentic Export and import segmentation remain restricted to their application capabilities, without native or MCP tool access. Imported thoughts should enter the Weaver process after persistence; that handoff is separate from segmentation and does not broaden segmentation permissions.

Thoughtloom's application capabilities must retain scoped reads, rejection filtering and authorized writes. Permissive native access is not a sandbox: a tool that can reach underlying files or databases can bypass those application boundaries. Stop cannot undo external effects, and session permissions do not sandbox service-level plugins or override operator hard policies.

Existing sessions retain their saved permission bindings rather than gaining access implicitly on restart. A future discussion will explore System One/Jev-like decision models for tighter contextual permissions; that is not part of the initial permissive policy.

### Native result attribution

The saved endpoint and session identify the native conversation; its owner, run and protocol metadata must agree with the run. The saved binding remains immutable creation intent, not a requirement that mutable native model, directory, title, view time or unrelated metadata remain identical. Deny-bound execution still verifies its saved native permission rules. Search cleanup retains its separately sealed, stricter cancellation authority.

The daemon reads the complete paginated parent-session history and compares actual user inputs, in order and byte-for-byte, with the persisted prompt journal. OpenCode supplies no assistant-to-input parent identifier: the daemon correlates the final parent assistant and successful idle boundary after the current owned input, with no active or inbox work, rather than inventing one. Only that final assistant's text becomes an application envelope. Native tool, child, intermediate and compaction text is not an application result. Opaque auxiliary history and unfamiliar assistant parts alone are not input conflicts. Missing decisive evidence remains uncertain and observation-only, without resend. A different actual user input is a conflict, not an application request; cancellation must not claim or intentionally interrupt unrelated foreign work. This is not mixed-conversation support or an atomic barrier against external writers.

Ordinary cancellation requires a terminal boundary for every potentially dispatched journal step and an empty inbox/inactive session; an empty snapshot or interrupt acknowledgement is not proof. A queued non-user native item remains pending work, not an owned prompt to cancel or a reason to interrupt. Stop and rejection still fence late publication. Restricted Search, Export and import retain their deny policy and reject actual forbidden-tool or standalone shell execution evidence, as well as conflicting inputs. Previously interrupted runs are not automatically revived.

As an explicit exception to waiting for remote proof, a user may acknowledge remote uncertainty and retire one failed or interrupted interpretation-capable weave. This permanently fences its local execution and publication and removes only that run as an admission and dispatch blocker. The earlier native work may still run or have external effects, including overlapping a replacement. Retirement is not native settlement or cancellation; existing lawful cleanup remains best effort. Other active or unsettled runs still block, and queued automatic work may proceed under normal serialization. There is no automatic retirement.

## Creation-owned connection discovery

Creation-owned connection discovery uses ordinary durable weave journals and the existing supervisor, not another queue. A connection-only purpose is encoded with its immutable subject/creation-origin trigger and has application-scoped reads plus warranted connections involving that subject, but no thought/title writes or public reply publication. Creation, receipts/issued membership and discovery admission commit together. Ordinary interpretation work remains a distinct dispatch/admission/retirement class. Evolve Stop fences pending discovery for its saved contributions/developments using persisted origins; it does not undo saved connections or establish remote cancellation. Weaver's operator-managed native tool policy remains unchanged and is not a sandbox.

Direct contribution/development API creation has no originating run. Its thought and direct-thought discovery identity commit together in the knowledge writer; direct and run-origin triggers have separate validity contracts and retain their exact bytes in backups. Direct owners cannot impersonate a run-created source or be swept into an unrelated Evolve Stop cascade. This uses the existing immutable run journal, not another queue or schema version.

Automated connection writes deduplicate only inside the Weaver/Evolve capability aggregate, by directed endpoints and category. Authorization and full reads precede lookup. An eligible match yields an explicit already-present result with original attribution; any explicitly rejected match yields only an opaque not-created result and prevents an equivalent clone, including when another match is visible. Lookup/effect/no-op, exposures and immutable receipt/result commit together. Replay never reinterprets a no-op after restoration. Direct/manual connections remain multiplicative, with no global unique constraint or category/direction collapse. Existing JSON TEXT journals carry these typed outcomes without changing frozen logical backup inventories.

Local connection screening separately skips unordered pairs with any active AI-visible connection, before the judge and again at initial-prompt publication. Its remaining coverage is exhaustive. Logical-7 adds one private nullable connection FK per screening pair as explicit historical exclusion proof; real probabilities remain unchanged, and exclusions commit atomically with nominations/witnesses/exact input. They are not cross-review negative caches or authority to replay restored work. Connection changes alone do not force search fallback, and an already-prepared prompt is never rewritten. This optimization does not broaden write deduplication or manual restrictions.

## Daily-review core

The approved bounded daily review reuses one restricted Weaver run per selected text subject, combining absent-title and connection checks without creating interpretations or public replies. Immutable UTC-date batches and run-linked members seal admission; only successful completion of both checks records a member completion time, including no-change reviews. Execution, screening progress and native uncertainty remain in the existing journals/supervisor. Historical creation ownership does not suppress daily screening. Cross-purpose subject coordination preserves positive settlement/restore fences without widening interpretation ownership or retirement authority. [Admission and scheduling](../../docs/database-schema.md#daily-review-metadata-and-scheduling) are implemented; configured daemon startup wakes the daily driver at boot and on its shared technical timer. The initial 30-day/20-subject policy is tuning, not a schema constant or a model-effort quota.

## Client and daemon boundary

The browser client must never access the daemon directly. Browser requests that need daemon functionality go through the Next.js server, which communicates with the daemon.

```text
Browser (React) → Next.js server → Hono daemon
```

The implemented Next.js server uses fixed application routes and server-side HTTP forwarding to the Hono daemon. Credentials remain server-side. See the [web setup and workflows](../../docs/server-startup.md) and [daemon API](../../docs/daemon-api.md). Preserve this boundary when extending either side.

## Working agreement

Work on the daemon and the web client separately, in distinct implementation scopes. A client or visual task does not authorize changing the daemon to make it work.

If visual/client work is blocked because the daemon does not support what is needed, stop and discuss the missing capability with the user before proceeding. Do not silently expand the task into daemon work or bypass the server boundary to work around the gap.

## Daemon-first development

The initial implementation sequence built and validated the daemon before the visual client. The first milestone established immutable thoughts, evolution trees, separate connections, and rejection/restoration through domain logic, SQL storage, and a Hono API, without real AI or UI work. Both agent integration and the Next.js client are now implemented; these phases describe the project's starting sequence, not unfinished prerequisites.

Provide practical Bun scripts so the user can exercise daemon behavior without a visual client. These scripts do not need a polished CLI experience. They complement, rather than replace, automated tests of the business rules.

Agent integration and the Next.js client use the established domain operations and contracts. Search and export must remain exercisable independently of the visual client.

The domain model describes thoughts and their behavior, not screen layouts or cards. A visual change may require a different query or response shape, but must not automatically trigger a domain-model rewrite. If it exposes a genuinely missing business capability, stop and discuss it under the working agreement above.

## Visual-client design gate

The original Phase 5 gate required an **Impeccable comp-led design phase for each screen** with the user before client implementation. The client now exists; the designer-led per-screen approval gate remains in force for future visual implementation. Use the [implemented design system](../../apps/web/DESIGN.md) and approved screen references as current context, not as blanket approval for new visual work.

The designer owns this work using the Impeccable workflow. Establish the relevant screen inventory and shared visual direction, then review and agree screen comps before implementing visual changes. Mockup layout alone does not approve colors or imagery. Settings now implements installation-wide additional instructions for Weaver, Evolve, Agentic Search and Agentic Export, separately from operator model/tool configuration; see the [Settings agreement](agent-instructions.md). Do not invent additional Settings features to complete a comp.

Any daemon capability gap exposed by design still requires discussion, not a silent domain rewrite or an out-of-scope daemon change.

These are the agreed starting constraints and development direction, not a complete architecture or implementation plan. Further architecture decisions remain open for discussion.
