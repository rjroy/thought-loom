---
title: OpenCode 2.2.2 owned domain tools
date: 2026-10-30
status: completed
tags: [opencode, thoughtloom, native-client, plugins, tool-authorization]
modules: [daemon, agent-tools]
related: [.lore/work/research/opencode-2.2.2-validation.md, .lore/work/design/thoughtloom-mvp.md]
---

# OpenCode 2.2.2 owned domain tools

## Key Findings

Use a small first-party, project-local **V2 server plugin** to expose Thoughtloom domain tools. Supported native tool execution supplies session identity separately from model arguments; the plugin forwards it to Hono, which owns authorization and persistence. This replaces the unresolved MCP bridge registration/binding path without embedding an engine, launching a replacement service, or weakening constrained tools.

**Evidence status:** the original 2026-10-30 source investigation is completed. Its findings below use exact public revision **`098aa7fd6e02b03d6fc410f0b052038c7d4c5e81`** (OpenCode 2.2.2), not upstream main or V1 plugin examples. The 2026-10-31 isolated application witness recorded below adds actual fixture execution evidence; compatibility with the operator's personal service/configuration remains unverified. The existing [integration report](opencode-2.2.2-validation.md) remains the reused baseline for `@opencode/client@2.2.2`, attaching to an operator-managed service, admission, ordinary-history recovery and previously tested permissions/MCP behavior. None of that broad characterization was rerun.

## Supported boundary

| Concern | Pinned source finding |
| --- | --- |
| Registration | V2 uses `Plugin.define({ id, setup(ctx) })` and `await ctx.tool.transform(editor => editor.add(...))`. Tool definitions use `name`, `input`, `execute` and `options`; `options.codemode: false` exposes direct tools. No guessed registration endpoint or V1 `tool({ args, ... })` API is needed. [Plugin overview][plugin-overview] [Tool registration][tool-docs] |
| Native identity | `Tool.Context` supplies `sessionID`, `agent`, `messageID`, call `id` and `progress`. The Promise executor additionally receives `signal`. These fields are separate from domain input. [Schema][tool-context] [Promise types][promise-tool] |
| Identity provenance | The runner passes its session and assistant-message IDs into execution. The registry constructs context independently of `call.input`, and the Promise adapter preserves it. `messageID` identifies the assistant message, **not the admitted user prompt**. Call IDs are not secrets or independent authorization grants. [Runner][runner-context] [Registry][registry-execute] [Adapter][promise-adapter] |
| Local loading | `.opencode/plugins/` is auto-discovered; explicit local plugin directories are also supported. Configuration discovery starts from the native location and walks ancestors, unless project discovery is disabled. This is location/project loading, not per-session plugin isolation. [Loading][plugin-overview] [Discovery][config-discovery] |
| Activation | The supervisor holds readiness through plugin loading/setup. The runner awaits plugin activation before selecting context and before tool execution. Register the direct tools during awaited setup; do not add an independent asynchronous registration race. This is not a new MCP connection/catalog barrier or a universal readiness guarantee. [Supervisor][plugin-activation] [Runner waits][runner-activation] |
| Status | Public location-scoped `plugin.list` exposes plugin status; the schema distinguishes `active` and `failed`. Active status alone does not prove advertisement, policy compatibility or successful domain execution. The pinned protocol labels plugin routes experimental; do not assume an unversioned compatibility promise. [Protocol][plugin-protocol] [State][plugin-state] |

The installed baseline `@opencode/schema/dist/tool.d.ts:10–15` also confirms the native context fields. The operator's running service and personal plugins were not inspected or certified by this investigation.

## Minimal Thoughtloom architecture

1. Keep the maintained client in Hono and attach to the explicitly selected existing service. The operator still owns native startup/shutdown. `packages/agent-tools/` contains only the reviewed first-party server plugin and its narrow forwarding boundary, not another agent framework or database owner.
2. Load it only for the dedicated application location. Check native setup `ctx.location` against that intended location and retain it separately from model arguments; ancestor discovery alone is not an exact-location security boundary. [Setup context][plugin-context] Do not silently edit global agents/policies or override project-discovery settings.
3. Define only the required domain tools, with no model-controlled authority fields. Construct the forwarding envelope from native `sessionID`, `agent`, `messageID` and call `id`; domain input must not overwrite them. Forward to narrowly authenticated loopback Hono tool endpoints. Keep the bridge credential server-side in private application runtime storage, never prompts, browser code or committed configuration. Forward cancellation with `context.signal`; cancellation is not rollback.
4. Hono authenticates the transport, then looks up the persisted **owned session→run grant**. Persist and verify the association before prompt admission. Check active/revoked/settled state, expected location/agent, operation scope, referenced IDs, authority, versions and immutable mutation receipts. Background and dialogue grants permit different operations. Unowned sessions, including unmapped children/forks, fail closed even if native permissions were inherited.
5. For phase 3, use **one native session per job attempt/run**, with an immutable session→run grant. Never authorize against “whichever run currently uses this session.” Native context has no app run ID or admitted prompt ID. Later dialogue reuse must retain a stable authorization scope or establish explicit assistant-message/run attribution before writes; a mutable current-run lookup is not that proof. Keep native message/call identifiers for correlation and receipt deduplication, together with immutable payload checks; do not promise exactly-once effects.
6. Use the same existing Hono domain service for tools and other application mutations. All source immutability, evidence/version, correction/reversal, transaction and history rules remain unchanged. Log attempts/outcomes with safe identifiers/categories, not credentials, note contents, raw tool payloads or hidden reasoning.

### Permissions are explicit, not implied by registration

Use a dedicated agent plus default-deny session permissions and individual required domain-action allows, **not wildcard allow**. Session rules merge after ordinary agent rules before tool discovery; wholly denied actions are excluded from the snapshot. [Context selection][session-context] [Snapshot filtering][registry-filter] Ordinary permission evaluation uses the last matching action/resource rule, with configured denies checked before saved grants. [Permission implementation][permission]

Each custom executor must also call **`ctx.permission.assert`** using its native execution context and fixed operation action before forwarding. `options.permission` helps discovery filtering; it is not an automatic execution-time assertion. [Execution helper][runtime-execute] The official V2 example supplies `sessionID`, `agent` and `source: { type: "tool", messageID, id }`. [Assertion example][permission-docs] Hono still performs independent domain authorization. Known policy conflicts require operator resolution; never autoapprove asks or diagnose a generic failure as permission denial.

## Trust limits and decision boundary

- The bridge credential authenticates the **transport**, not a run. Native context plus the daemon's owned grant establishes application scope. This is trusted first-party forwarding, **not cryptographic attestation** from OpenCode to Hono: code possessing that credential can assert an envelope.
- Plugins execute in the native server process with its OS privileges. Other operator-installed plugins can alter tools/hooks or override names; hostile same-account code can read credentials or bypass application storage boundaries. Native-service credential holders are trusted operators, not isolated tenants. Ownership metadata and allowlists do not turn the shared service into a hostile-plugin sandbox.
- Default-deny model tools constrain agent access, not arbitrary plugin code. Location is context/configuration scope, not filesystem confinement. The plugin must not write SQLite directly; Hono remains the domain authority.
- This first-party transport replacement fits the approved constrained-tools direction: it preserves service ownership and authorization requirements rather than relaxing them. If the selected service disables project discovery, blocks the plugin, or cannot enforce required restrictions, **stop and obtain operator resolution**. Do not edit global configuration, bypass policies, install silently, or substitute a weaker mechanism.

## Focused verification still required

Reuse the baseline report; do not repeat its broad native profiles or introduce an MCP startup sleep/refresh probe for this plugin path.

- Controlled plugin/daemon tests should prove native-context envelope construction, rejection of scope overrides and unowned/cross-run/revoked sessions, immutable grant binding, permission assertion, and stale/duplicate mutation safety. Script the maintained-client boundary; ordinary tests must not start native OpenCode.
- Under explicitly authorized selected service/location/agent/model settings, read location-scoped plugin status and perform **one harmless actual Thoughtloom tool operation**. Witness the matching native session/message identity at Hono, expected tool availability, and the durable receipt. Separately exercise fail-closed unowned/revoked requests at the daemon boundary; connected/active status alone is not execution proof.
- Use bounded status/outcome diagnosis. A failed or missing plugin must not trigger autoapproval, a hardcoded startup delay, or resubmission of a possibly admitted prompt. Preserve the existing recovery and uncertainty rules.

**Not performed in the original 2026-10-30 source investigation:** plugin installation/loading, native-service calls, model calls, configuration edits, application tests or the narrow real smoke. Source/doc fidelity checks do not establish runtime or operator-configuration compatibility.

## 2026-10-31 — isolated application witness

Independent execution of the single opt-in command documented in [`tests/native/README.md`](../../../tests/native/README.md) passed using the isolated app-owned fixture, maintained client and first-party plugin. The existing operator integration report was reused, not rerun.

- Native **2.2.2**; plugin **active**; job **completed**.
- **2 native tool calls:** `read_source` and `record_interpretation`; **1 durable domain receipt**. The original remained unchanged and the owned grant was revoked on settlement.
- **3 daemon replay refusals** exercised unknown-session, settled/revoked-session and bad-transport requests. These were daemon-boundary checks, **not additional native prompts**.
- **4 fake-provider requests**; cleanup **completed**. No paid model or operator-service calls were made.

This proves the isolated fixture's actual tool boundary, not personal-policy compatibility, an OS sandbox, every completion case, or a completed review of the current application. The original source-investigation date and pinned references remain unchanged.

## Pinned source references

[plugin-overview]: https://github.com/anomalyco/opencode/blob/098aa7fd6e02b03d6fc410f0b052038c7d4c5e81/services/www/src/docs/content/build/plugins/index.mdx#L9-L89
[tool-docs]: https://github.com/anomalyco/opencode/blob/098aa7fd6e02b03d6fc410f0b052038c7d4c5e81/services/www/src/docs/content/build/plugins/server.mdx#L970-L1049
[tool-context]: https://github.com/anomalyco/opencode/blob/098aa7fd6e02b03d6fc410f0b052038c7d4c5e81/packages/schema/src/tool.ts#L14-L20
[promise-tool]: https://github.com/anomalyco/opencode/blob/098aa7fd6e02b03d6fc410f0b052038c7d4c5e81/packages/plugin/src/promise/tool.ts#L11-L23
[plugin-context]: https://github.com/anomalyco/opencode/blob/098aa7fd6e02b03d6fc410f0b052038c7d4c5e81/packages/plugin/src/promise/plugin.ts#L26-L29
[runner-context]: https://github.com/anomalyco/opencode/blob/098aa7fd6e02b03d6fc410f0b052038c7d4c5e81/packages/core/src/session/runner/step.ts#L90-L100
[registry-execute]: https://github.com/anomalyco/opencode/blob/098aa7fd6e02b03d6fc410f0b052038c7d4c5e81/packages/core/src/tool.ts#L297-L314
[promise-adapter]: https://github.com/anomalyco/opencode/blob/098aa7fd6e02b03d6fc410f0b052038c7d4c5e81/packages/plugin/src/promise/adapter.ts#L670-L679
[config-discovery]: https://github.com/anomalyco/opencode/blob/098aa7fd6e02b03d6fc410f0b052038c7d4c5e81/packages/core/src/config/discovery.ts#L59-L128
[plugin-activation]: https://github.com/anomalyco/opencode/blob/098aa7fd6e02b03d6fc410f0b052038c7d4c5e81/packages/core/src/plugin/supervisor.ts#L123-L244
[runner-activation]: https://github.com/anomalyco/opencode/blob/098aa7fd6e02b03d6fc410f0b052038c7d4c5e81/packages/core/src/session/runner/llm.ts#L220-L293
[plugin-protocol]: https://github.com/anomalyco/opencode/blob/098aa7fd6e02b03d6fc410f0b052038c7d4c5e81/packages/protocol/src/groups/plugin.ts#L8-L80
[plugin-state]: https://github.com/anomalyco/opencode/blob/098aa7fd6e02b03d6fc410f0b052038c7d4c5e81/packages/schema/src/plugin.ts#L44-L56
[session-context]: https://github.com/anomalyco/opencode/blob/098aa7fd6e02b03d6fc410f0b052038c7d4c5e81/packages/core/src/session/context.ts#L132-L145
[registry-filter]: https://github.com/anomalyco/opencode/blob/098aa7fd6e02b03d6fc410f0b052038c7d4c5e81/packages/core/src/tool.ts#L249-L263
[runtime-execute]: https://github.com/anomalyco/opencode/blob/098aa7fd6e02b03d6fc410f0b052038c7d4c5e81/packages/core/src/tool/runtime.ts#L29-L45
[permission]: https://github.com/anomalyco/opencode/blob/098aa7fd6e02b03d6fc410f0b052038c7d4c5e81/packages/core/src/permission.ts#L86-L198
[permission-docs]: https://github.com/anomalyco/opencode/blob/098aa7fd6e02b03d6fc410f0b052038c7d4c5e81/services/www/src/docs/content/build/plugins/server.mdx#L729-L740
