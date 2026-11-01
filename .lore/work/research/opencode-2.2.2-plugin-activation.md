---
title: OpenCode 2.2.2 plugin activation and loaded-version witness
date: 2026-10-31
status: completed
tags: [opencode, plugin, activation, version-witness]
modules: [daemon, agent-tools]
related: [.lore/work/research/opencode-2.2.2-owned-tools.md, .lore/work/design/thoughtloom-setup.md]
---

# OpenCode 2.2.2 plugin activation and loaded-version witness

**Final isolated evidence:** The reviewed generated-title source uses embedded
identifier `thoughtloom-generated-titles-v1`; Bun 1.4.3 five-source bundle A is
`45cdf149bc2c5ddb5f16eb3ebecc925794c88604d2205455996a0e02d7f200da`.
The final-bundle watcher and source-title fixtures subsequently passed as detailed
below. The source-title fixture used a test-specific permission ceiling, not the
operator's native setup. This does not authorize or establish live rollout.
Earlier unimplemented/pending statements in this dated research are historical.

## Scope and evidence

Read-only source research at OpenCode 2.2.2, exact source revision [`098aa7fd6e02b03d6fc410f0b052038c7d4c5e81`](https://github.com/anomalyco/opencode/tree/098aa7fd6e02b03d6fc410f0b052038c7d4c5e81). No service, provider, model, runtime configuration, or plugin bundle was changed or invoked. The installed SDK inspected was `@opencode/client@2.2.2` under `node_modules/.bun/@opencode+client@2.2.2+2d96f3c6656179bf/node_modules/@opencode/client`.

## Findings

- **Automatic plugin activation exists, but a supported location-scoped plugin reload operation was not found.** The pinned [`PluginSupervisor`](https://github.com/anomalyco/opencode/blob/098aa7fd6e02b03d6fc410f0b052038c7d4c5e81/packages/core/src/plugin/supervisor.ts#L123-L244) watches configured plugin-source changes, `PluginModule` changes, and update events, then serializes activation. A failed package load retains its previous generation. This describes the internal supervisor; it does **not** prove that replacing Thoughtloom's fixed `index.js` is observed by the module watcher or activates the new code.
- **`location.reload()` is broader than this feature needs.** The pinned [`location.reload` protocol](https://github.com/anomalyco/opencode/blob/098aa7fd6e02b03d6fc410f0b052038c7d4c5e81/packages/protocol/src/groups/location.ts) says it shuts down and rebuilds every loaded location, cancels pending permissions/forms, and lets running sessions continue with fresh services at the next step boundary. Do not invoke it casually or treat it as a plugin-only refresh.
- **The public plugin status is not a loaded-code-version witness.** Installed SDK `dist/promise/generated/types.d.ts:599-604` defines `PluginInfo` as optional `id`, `source`, `features`, and `state`. The pinned [`plugin.list` endpoint](https://github.com/anomalyco/opencode/blob/098aa7fd6e02b03d6fc410f0b052038c7d4c5e81/packages/protocol/src/groups/plugin.ts) reports current status, but these fields contain no loaded bundle hash/revision. The app currently checks only `thoughtloom` state `active` (`apps/daemon/src/native-adapter.ts:542-543`).
- **Current setup is explicitly not a load witness.** `apps/daemon/src/native-setup.ts:79-82` labels setup as offline configuration generation, not a native loading witness. It writes a plugin entry at the app-owned runtime directory and points the selected location at that directory (`:114-123`). A hash of this on-disk file would attest only the file, not the executing bundle.
- **Potential future witness, not implemented:** a setup-time handshake from the executing plugin, carrying an immutable build fingerprint to an app-owned daemon boundary, could witness code that ran without a model call. It would be app-side evidence, **not cryptographic attestation** against other code in the shared native process. Missing/stale handshake must fail closed; `active` status or disk contents must not substitute.

## Safe boundary and next validation

Do not switch a shared fixed-location plugin while a native run is active or admission is uncertain. Existing research describes one native session per job attempt and immutable session-to-run grants ([owned-tools research](.lore/work/research/opencode-2.2.2-owned-tools.md)); source reviewed here does not establish a safe in-place upgrade protocol for queued, running, or uncertain jobs. Preserve the location and credentials; do not create random locations to evade plugin caching. If activation cannot be verified without a broad reload, retain the old working configuration until an operator-approved coordination/recovery procedure exists.

When separately authorized, use a bounded controlled fixture (no personal content or paid model): test the documented activation route at the same fixed location; establish that the witness changes only after new plugin setup executes; test failed activation retaining old code; and verify old/admission-uncertain runs do not gain the new operation while post-witness admissions do. This plan is not runtime evidence and does not authorize a service reload or model call.

**Gate conclusion:** title-generation activation remains unproven. Manual title functionality need not be gated; do not enable a new native title action until activation and an executing-bundle witness are implemented and verified under the required operational authorization.

## Concrete source-backed proposal: read-only native capability RPC

This addition refines the earlier setup-time HTTP-handshake idea. Prefer an existing native plugin RPC: it needs no new daemon endpoint, bridge credential, session, prompt or generation call. The API and dispatch mechanism below are verified in source; the Thoughtloom RPC, activation fixture and actual loaded-build proof are **not implemented or runtime-verified by this research**.

### Exact API and lifecycle anchors

Installed paths below are relative to the Thoughtloom repository root. Recheck them against the pinned revision before implementation rather than guessing an SDK interface:

- `packages/agent-tools/node_modules/@opencode/plugin/dist/promise/plugin.d.ts:25-61`: Promise `Plugin.Context` supplies native `location`, `rpc: RpcDomain`, and `setup`/cleanup. Corresponding pinned [Promise plugin context](https://github.com/anomalyco/opencode/blob/098aa7fd6e02b03d6fc410f0b052038c7d4c5e81/packages/plugin/src/promise/plugin.ts#L26-L64).
- `packages/agent-tools/node_modules/@opencode/plugin/dist/promise/rpc.d.ts:5-21`: `ctx.rpc.register(definition, handlers)` returns a registration with `dispose`; handlers receive a cancellation signal. Registration accepts a portable RPC definition, not an arbitrary HTTP handler. The plugin-local RPC domain does not accept a different location or transport headers. Corresponding pinned [RPC types](https://github.com/anomalyco/opencode/blob/098aa7fd6e02b03d6fc410f0b052038c7d4c5e81/packages/plugin/src/promise/rpc.ts).
- `packages/agent-tools/node_modules/@opencode/schema/dist/rpc.d.ts:15-49`: portable definitions provide an ID, method input/output schemas and events. Use a small read-only method with bounded JSON fields; no new framework is needed.
- `packages/agent-tools/node_modules/@opencode/plugin/dist/promise/tool.d.ts:53-59`: `ctx.tool.list()` returns currently registered tools after transforms. A witness can filter this to the finite known actions, never return tool executors or arbitrary schemas.
- `packages/agent-tools/node_modules/@opencode/plugin/dist/promise/adapter.js:73-98,145-152,463`: Promise RPC callbacks execute through the native registry; setup registrations attach to the plugin scope and cleanup runs on unload. Native [RPC register/disposal](https://github.com/anomalyco/opencode/blob/098aa7fd6e02b03d6fc410f0b052038c7d4c5e81/packages/core/src/rpc.ts#L69-L105) uses scoped acquisition/release. [Dispatch](https://github.com/anomalyco/opencode/blob/098aa7fd6e02b03d6fc410f0b052038c7d4c5e81/packages/core/src/rpc.ts#L108-L141) selects the current registration and validates input/output; the registry is a [location service](https://github.com/anomalyco/opencode/blob/098aa7fd6e02b03d6fc410f0b052038c7d4c5e81/packages/core/src/rpc.ts#L177).
- Native [`RpcHandler`](https://github.com/anomalyco/opencode/blob/098aa7fd6e02b03d6fc410f0b052038c7d4c5e81/packages/server/src/handlers/rpc.ts#L8-L31) explicitly awaits `Plugin.awaitActivation` before calling the registry. The [public endpoint](https://github.com/anomalyco/opencode/blob/098aa7fd6e02b03d6fc410f0b052038c7d4c5e81/packages/protocol/src/groups/rpc.ts#L12-L28) is `POST /api/rpc/:rpcID/:method`; the [API composition](https://github.com/anomalyco/opencode/blob/098aa7fd6e02b03d6fc410f0b052038c7d4c5e81/packages/protocol/src/api.ts#L167-L188) applies location middleware.
- `node_modules/.bun/@opencode+client@2.2.2+2d96f3c6656179bf/node_modules/@opencode/client/dist/promise/generated/types.d.ts:5220-5228` defines `RpcCallInput` with `rpcID`, `method`, optional `location.directory`, and `input`. The generated method is declared in the same package's `dist/promise/generated/client.d.ts:167-168`. Its implementation, `dist/chunks/pty-handoff-0e3ghr9a.js:1306-1315`, sends `{input}` and returns the RPC response object. **Decode `result.output`, not `result.data`.** The native handler constructs `{output}`; absent output produces `{}`.

Plugin ID `thoughtloom` should remain stable. Do not substitute a newly versioned plugin ID for the witness: native [slot metadata](https://github.com/anomalyco/opencode/blob/098aa7fd6e02b03d6fc410f0b052038c7d4c5e81/packages/core/src/plugin.ts#L275-L308) distinguishes a requested definition from an older fallback activation. Public inventory is not a fresh callback from the executing implementation.

### Proposed finite contract and readiness rule

Register `thoughtloom.capabilities`, method `inspect`, after the existing tool transform succeeds. Proposed payload, not an implemented API:

```text
input:  { nonce }
output: { protocol: 1, nonce, buildId, setupId, nativePid, directory, actions }
```

- `buildId` is an immutable reviewed-build identifier embedded in the compiled code. Derive it from reviewed build inputs or an explicitly reviewed release identifier. Do not obtain it from the on-disk entry, `ctx.options`, a daemon response or mutable manifest. Keep the reviewed final bundle SHA-256 as separate artifact provenance; do not label this embedded identifier a hash of executing bytes.
- `setupId` is fresh for this setup/registration lifetime, not a new native session or location. `nativePid` comes from the executing host process; `directory` comes from native `ctx.location` and must match the existing private connection's fixed location.
- `actions` is a bounded known list, including a versioned title action such as `record_title_v1` only when its registration is present. The RPC is metadata-only: no content, credentials, arbitrary forwarding, mutations or model requests.
- The daemon uses its existing authenticated native client with an explicit location and fresh nonce. Validate the schema, nonce, expected embedded build, action, directory and native process identity. Recheck service identity and reject superseded probe results. The callback is evidence within the trusted native process, **not cryptographic attestation against another plugin in that same process**.
- Use the ordinary bounded five-second read request during preparation. Do not add readiness waiting after admission starts or change the separate configurable fifteen-second default admission budget. No probe may submit a prompt or trigger a retry.

After a daemon restart, perform a **fresh RPC**, not a cached readiness lookup. The already-loaded native registration can answer a new nonce without re-running setup or reloading the location. Native identity changes invalidate earlier proof. There is no push handshake whose delayed arrival could enable a different build.

Missing, stale, malformed or timed-out proof disables the **new title action**. Where the existing plugin remains active and baseline tools are available, ordinary weaving continues with its previous actions and excerpt fallback. Do not falsely claim readiness for a failed baseline plugin. No implementation may make missing title proof an uncertain prompt admission or require resending saved input.

### New-run authority must be implemented, not assumed

The current schema does have an immutable action list: `apps/daemon/src/storage.ts:177-188` defines `owned_grants.operations` and its identity guard. `apps/daemon/src/tool-boundary.ts:44-55,63-99` enforces and hashes that scope; `native_commands` retains the immutable command payload/hash. These are existing safety primitives, **not an implemented build/capability snapshot**.

Implementation must select effective actions once for a **new run**, freeze its capability/build selection in the command profile and corresponding grant, and use that frozen profile for subsequent verification/recovery. Current permission derivation from mutable selected configuration must not silently expand old profiles. Never append the new action to an existing grant, rebind a shared session, or upgrade preparing/running/uncertain attempts when a newer witness arrives. Previously queued work without a run may use the new capability only after validated activation.

The new title forwarder must supply its embedded marker as plugin-owned metadata, not accept it from model arguments. The daemon still checks the run's granted action/build, current target/formulation and title revision, protected user overrides, and revocation/abandonment. A readiness response is not write authority. Title requests belong only in ordinary weaving whose frozen profile includes the action; there is no extra mandatory title session or corpus backfill.

### File watching: source-supported, actual activation still conditional

The installed loader supplies a concrete path beyond the earlier supervisor overview:

- `packages/agent-tools/node_modules/@opencode/plugin/dist/source.js:12-36` tracks the entry file, fingerprints its local graph and reloads changed attempts. `dist/source.node.js:8-54` loads fresh local generations; `dist/source.bun.js:10-74` invalidates local module caches before loading.
- Native [`PluginModule.watch`](https://github.com/anomalyco/opencode/blob/098aa7fd6e02b03d6fc410f0b052038c7d4c5e81/packages/core/src/plugin/module.ts#L20-L43) subscribes to tracked files. [`loadServer`](https://github.com/anomalyco/opencode/blob/098aa7fd6e02b03d6fc410f0b052038c7d4c5e81/packages/core/src/plugin/module.ts#L175-L192) reads through those sources.
- Native [`Watcher`](https://github.com/anomalyco/opencode/blob/098aa7fd6e02b03d6fc410f0b052038c7d4c5e81/packages/core/src/filesystem/watcher.ts#L201-L229) watches the parent directory for an individual entry and filters its filename, relevant to atomic replacement. Watching can be [disabled](https://github.com/anomalyco/opencode/blob/098aa7fd6e02b03d6fc410f0b052038c7d4c5e81/packages/core/src/filesystem/watcher.ts#L81-L87) or unavailable. Supervisor change consumption/activation remains serialized as cited above.
- **The existing isolated fixture disables watching**: `tests/native/plugin-isolation.ts:140` sets `OPENCODE_DISABLE_FILEWATCHER=1`. Running that fixture unchanged cannot establish automatic A-to-B activation.

Source establishes the mechanism, not the actual installation's effective watcher settings, event delivery or successful replacement. No automatic reload has been exercised in this investigation.

### Bounded validation and explicit operational gate

First use unit/scripted boundaries: actual plugin setup with a test-owned RPC context, and the real installed SDK against fake HTTP. Cover response-envelope decoding, marker/nonce/location/process mismatch, superseded replies, missing RPC, frozen old grants, and preserved baseline weaving without title proof.

Then, **only when separately authorized**, adapt the guarded native fixture with a narrowly reviewed watcher-enabled profile and one fixed test-owned location:

1. Load reviewed build A and obtain its fresh RPC witness with zero model/provider requests.
2. Atomically replace the **same entry** with reviewed build B. Require a B callback with unchanged native PID and location; no replacement location, process restart or `location.reload`.
3. Exercise malformed-module and setup-failure swaps. On-disk B must never substitute for a successful B witness; an older retained/fallback generation cannot enable a different expected build.
4. Recreate only the daemon client and obtain a fresh witness without reloading native. Verify disposal/replacement behavior and stale-response rejection.
5. Separately validate the title action through the explicitly authorized controlled fake-provider weaving case, including old-run denial and user-title protection. This is not permission for a personal-content or paid-provider run.

Actual fixed-location rollout needs explicit operational approval: hold app admissions, defer queued captures, and resolve preparing/running/uncertain work before changing the app-owned bundle and narrowly scoped permissions/expected-build selection. Unresolved native work requires an operator decision; empty history/inbox is not cancellation proof. Preserve the existing location, connection file, credentials, unrelated settings and immutable run profiles. Fresh provisioning is not an in-place update procedure.

If watching does not deliver a matching witness within the bounded validation, **STOP with the new capability disabled**. Keep the known working baseline or use an explicitly approved rollback; do not repeatedly probe with prompts, create replacement locations, rotate credentials or invoke `location.reload` casually. The concrete fallback decision is to defer generated-title activation, or separately approve the broader all-loaded-location reload and its consequences. Manual titles/excerpts remain usable, but the generated-title shipping requirement is not complete.

This is a source-backed conditional design and evidence path, not proof of runtime activation. Parent verification of this addition and controlled implementation/activation evidence remain pending; the research record must not be used to authorize operational changes by itself.

## Controlled watcher verification

An independently controlled OpenCode 2.2.2 watcher rerun passed once with the accepted 58-file manifest SHA-256 `06ff4a9b5355eb13758f700f1c5900c63e4c5537b876521adb6f9203aee4ce9e`. The recorded receipt is `/tmp/opencode/plugin-watch-witness-rerun.log`: `A-to-B`, `malformed: no-B-observed`, `freshClient: true`, zero provider requests and cleanup completed. The fixture assertions established A→B in the same PID/location with a changed setup ID, followed by a fresh client observing the same B setup with a fresh nonce.

The malformed replacement assertion establishes only that B was not observed during that check; it does not prove the watcher observed the malformed file or a failed setup. This is isolated fixture evidence, not a native title-tool test, proof of title generation, or authorization/evidence for live rollout. Neither `.10` nor `.18` is closed by this result.

## Final generated-title bundle verification

The independent final-bundle watcher receipt `/tmp/opencode/finalbundle-watch-witness.log`
records A→B at the same PID/location, a changed setup ID, a fresh client and nonce,
the expected 11-action inventory, zero provider requests and completed cleanup.
The malformed-swap observation remains limited to no B observed; it does not
establish a witnessed failed setup. Marker-swapped fixture B SHA-256 is
`1b4eaea29e41bac3f108a3d1c307073484fe9ff9384f9cf9a8db735a8fa292e1`.

The separately reviewed source-title fixture receipt
`/tmp/opencode/title-native-witness-rerun.log` records matching RPC, new frozen
command/grant, a native completed title-tool call and AI revision, preserved
USER override and original, zero semantic changes or follow-up jobs, grant
revocation, four local fake-provider requests and completed cleanup. Its
test-specific title permission ceiling is not production setup proof. Native
exact-item invocation was not exercised; controlled tests cover exact-version
storage and projection. The accepted 64-artifact manifest SHA-256 is
`4aafd83fe75f2386e91aa26c8d0c75a77b7b2b80639af9e02d8e5d3f1d0888a9`.

These results satisfy the scoped investigation and controlled-witness criteria,
not live activation. Any real fixed-location bundle or permission change requires
separate operational approval, admission coordination and the safe fallback
above; do not silently restart or reconfigure a shared service.
