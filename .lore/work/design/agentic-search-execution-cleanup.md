---
title: Agentic search execution ownership and cleanup
date: 2026-11-06
status: draft
tags: [thoughtloom, agentic-search, execution-ownership, cancellation, sqlite]
modules: [agent, daemon, storage]
related: [.lore/work/design/agentic-search-schema-api.md, .lore/context/architecture.md]
---

# Agentic search execution ownership and cleanup

## Decision and boundary

Concretize [the accepted retention design, §8](agentic-search-schema-api.md#8-retention-and-deletion-including-active-work) with a **private SQLite sidecar lease, the existing per-run flight lane, and cancellation-only ID/hash evidence**. No second execution engine, provider, external locking program or package is required. This document proposes implementation; it does not claim these guarantees already exist.

Current anchors: [`RunWorker`](../../../src/agent/worker.ts) coalesces execution promises but skips search cancellation; [`ConfiguredRunWorker.tick`](../../../src/agent/configured-worker.ts) resolves service **before** that lane. [`runtime.close`](../../../src/daemon/runtime.ts) drains supervisors/imports but has no lease. [`cancelOwned`](../../../src/agent/opencode-adapter.ts) requires prompt text and settles from empty/inactive alone. [`purgeLocalSearchSession`](../../../src/storage/search-purge.ts) correctly refuses bindings/possible dispatch today. Preserve that refusal until the controller below is installed.

## 1. Exclusive execution owner

1. Support the documented single-operator **Linux, local-filesystem SQLite** deployment. Resolve the existing DB file through `realpath`; for a new file resolve/create its parent, exclusively create the regular file if absent, then resolve it. Record canonical path plus device/inode identity. Reject hard-linked DBs, nonregular files, URI/shared-memory paths and unsupported network/individual-file-bind-mount aliases for this file-backed runtime; isolated in-memory repository tests are a different boundary. Symlink aliases resolve to one canonical DB. `realpath` alone cannot detect mount aliases: use Linux filesystem/mount metadata to reject unsupported file mounts, not a second path-derived lock. Do not silently invent a different lock namespace.
2. Use `<canonical-db-path>.execution-owner.sqlite`, in the same private service-owned directory. Create with mode `0600`; reject symlink/nonregular/hard-linked sidecars. Reject concurrent/double acquisition in the same process before opening a second sidecar handle; this local guard does not replace cross-process locking. Keep one private `bun:sqlite` connection, `busy_timeout=0`, verified rollback-journal `journal_mode=DELETE`, and an open **`BEGIN EXCLUSIVE`** for the entire runtime. No knowledge-DB transaction is held. No code outside the lease module opens, commits, rolls back, vacuums or deletes that sidecar. Never unlink/rotate a live lock file; normally retain it across restarts.
3. The SQLite VFS's OS locks arbitrate competing processes; a stopped/hung holder is not stealable, and process death closes its descriptors. No PID existence, heartbeat, elapsed grace period or lock-file presence proves ownership. Contention fails startup before migration/readiness/native work, with a fixed diagnostic. A second daemon does not silently become an observer.
4. Acquire before opening/migrating the knowledge DB for work; open that DB using the canonical path and recheck file identity. Acquire even with **no agent configuration**, so local imports, future cleanup and commands share one runtime lifetime. Ordinary commands remain usable because the long write lock is on the sidecar only. Config-less cleanup scans retain pending work without creating an SDK client or guessing credentials.
5. `ExecutionOwner.assertHeld()` checks the private lease is active and DB/sidecar identities remain unchanged before native authorization and around awaits. Directory/path replacement while running is unsupported, like replacing a live SQLite database; detected changes poison execution, never trigger automatic reacquisition. Trusted directory ownership is a deployment precondition, not protection against a privileged filesystem writer.
6. Startup partial failure and shutdown first stop new listener work/timers, pause execution and cleanup admission, and join **all** registered setup/execution/cleanup/import/listener flights. After listener requests finish, take the worker's final drain barrier, not just the supervisor's earlier promise snapshot. A request committing Delete after pause may persist pending cleanup/retire IDs but may not launch an unregistered cleanup RPC; restart resumes that durable row. Close the knowledge DB, then release/close the sidecar last. Rejected-but-settled promises are drained; a still-pending promise is not. If drain cannot finish, do not voluntarily release the lease/DB; operational forced termination leaves durable uncertainty for the next owner. No shutdown timeout becomes settlement proof.

**Alternatives:** a main-DB lifetime write transaction blocks ordinary writes; WAL/read transactions do not supply exclusivity; PID/O_EXCL files are stale after crashes; heartbeat leases permit split-brain after pauses. `flock` via an external program or FFI adds a lifetime/descriptor dependency unnecessarily. Sidecar SQLite uses the project's existing runtime/VFS, but real child-process/crash tests must establish its actual Bun/Linux behavior before enabling it. No runtime experiments were performed for this design-only invocation.

**Rollout is explicit:** all pre-lease daemon versions must be stopped/drained before first activation; they do not honor this lock. Do not start/stop services implicitly. New lease acquisition proves no *qualified predecessor* can issue future calls, not that an old network request cannot arrive. It proves nothing about an unattributed historical `submit_owner` or an independently running copied DB.

## 2. Attribution and minimal persistent additions

Use the acquired lease capability to mint an opaque runtime owner ID, then register it in a short knowledge-DB transaction **before any worker starts**. The capability, not a caller-selected string, supplies new search submission attribution. Bind the registry record to the canonical DB device/inode/path identity and lease protocol version. A restored/copied DB with different identity cannot inherit predecessor-drain proof automatically.

Proposed schema changes, limited to non-content control state:

| Addition/change | Why existing state is insufficient |
| --- | --- |
| `execution_owners(id PK, database_identity, lease_protocol)`; immutable records | Current module-random `processSubmitOwner` has no durable evidence that its process participated in the exclusive-lease protocol. Registry membership plus matching DB identity qualifies lineage; it is not a liveness flag. |
| Nullable immutable `agent_bindings.execution_owner_id` FK | Attribute session setup **before its first RPC**, including setup with no authorized prompt. Search binding insertion writes it under the lease; ordinary/import binding contracts remain unchanged. Existing rows stay null/unattributed. |
| Nullable `search_native_cleanup.submit_owner` | An intact never-authorized journal has no submission owner. Never fill this with a guessed PID/current owner or pretend a legacy null was authorized. Preserve existing nonnull values verbatim. |
| Immutable `search_native_cleanup.prompt_manifest_json` (nullable only for preserved older rows) | One last prompt/hash cannot validate the full native conversation, multiple step owners or an unsubmitted successor. Store version, fenced generation, binding setup owner, and every issued step's ordered position/ID/input SHA-256 or honest null, submission owner or null, and snapshot phase. No prompt text/result/clock/topic is copied. |

Keep existing `binding_json`, `last_prompt_id`, `prompt_sha256`, admission/drain/state columns. Focus is the last **authorized** prompt when one exists, otherwise the current prepared prompt; the manifest also includes any later never-authorized successor. Mutable `evidence_json` contains only versioned per-prompt admission/terminal certificates and drain attribution. Seal manifest identity separately from evolving observations. New rows require an exact manifest; an incomplete historical manifest cannot gain settlement authority.

Authorization classification is `never-authorized`, `authorized-uncertain`, or `unattributed`; snapshot SQL native completion is not itself a copied terminal certificate. Any authorized step requires its exact hash. Relax the current hash CHECK only to retain missing-hash/incomplete identities in pending/ownership-conflict, never to allow their terminal settlement; retain `never-submitted` only when **all** steps are proven never authorized. Missing/legacy attribution stays `unknown-after-restart`/pending, even after a new lease is acquired. Preserve older already-settled rows as historical rows without inventing a manifest; new insert/transition guards must not let that migration allowance authorize fresh settlement.

Narrow the cleanup insert guard to either (a) its retained tombstoned search owner, or (b) its retained **terminal search run with pending cancellation and a closed slot**. This permits Stop/rejection cleanup snapshots without purging their messages. It grants cancellation only, not active execution or ordinary/import authority. Preserve search-only child-first purge guards and all unrelated trigger/index bytes. Rebuild only the cleanup control table if nullability/CHECK changes require it; preserve rows/rowids/legacy allowances and test migration rollback/FKs-on. Do not rebuild the knowledge/run closure merely for this control change.

## 3. One per-run lane, with an explicit join point

Extend the existing `RunWorker.flights` entry into `{execution, cleanupTail}` for that ID, not an independent cleanup worker racing it. Register the execution promise **before** configured service resolution; move `ConfiguredRunWorker` preflight inside that lane. Include lazy session setup, submission, observation and transport-fact persistence in the captured execution promise; no detached native callback may outlive that registration. Import drains remain owned by the existing import driver; the runtime lease covers both lifetimes.

Cleanup requests coalesce by run ID and append **after the captured execution promise**. A terminal execution tick only requests that append; it must not await cleanup that waits on itself. Cleanup never recursively calls `tick`/`cancel` or enters its own join. Supervisor/runtime shutdown drains execution **and cleanup tails**, including direct command-triggered lanes not present in the supervisor's current map. Keep lane entries until their tails settle, even after SQL runs disappear.

The existing technical supervisor polls retained terminal pending cancellations **and** the metadata-only cleanup outbox for purged runs, with bounded fair candidates and the same per-run lane/capacity. Missing runs with cleanup rows are cancellation-only; missing runs without rows are not recreated. Pause blocks new execution/cleanup RPCs but still joins already-owned calls. Remote unresolved cleanup remains durable after a local tail ends.

The outbox is the backlog, not an unbounded in-memory promise queue. Retirement captures already-registered flights, drops their active claims without deleting their lane entries, and notifies the bounded scanner. Cleanup tails enter through its shared capacity; Delete never fans out one SDK task per historical run. Purged IDs without a lane need no permanent in-memory blacklist: missing runs/tombstones plus their cancellation-only outbox prohibit execution.

## 4. Delete and fence sequence

1. The existing user-only `searchSessions.delete` remains the control boundary. Its repository gets an explicit optional retention-controller dependency; without it, retain the current safe local-only purge and `native-cleanup-required` refusal. No HTTP/AI deletion capability is added here.
2. Under one immediate SQL transaction and the current lease, collect owned runs/bindings/steps; fence generations and active slots, invalidate composers, and tombstone/title-clear the session. Seal non-content cleanup identities **before erasing** inputs. A binding is persisted before any session-setup RPC; absence plus an intact never-authorized journal is useful proof, never absence alone.
3. Insert/reuse exact cleanup rows for unsettled bindings; no `REPLACE`. Preserve an existing terminal-run cleanup snapshot when Delete moves its source from retained to purged. Unknown owners/hashes retain uncertainty rather than synthesizing proof. Delete content dependencies, composers, occurrences/messages, execution children and runs in the existing guarded order, while turn mappings still prove ownership; verify local content is gone. No await/native call occurs under the DB lock.
4. Immediately after commit, retire those execution IDs, clear `forgetSearchClock(runId)`, capture registered execution promises and notify the existing bounded cleanup scheduler synchronously. SQL tombstones/generation checks already prevent a new tick or late callback from acquiring execution authority during this transition. Return local Delete success (future `204`) **without** awaiting join, SDK cancellation or a provider. Failed SQL leaves content, fences and cleanup rows unchanged and schedules nothing.
5. Join setup/submit/observe outside SQL. Persist `drained` only after the captured local execution flight settles and qualified owner lineage excludes another issuer. A lost/aborted/timed-out RPC is locally drained but its admission remains uncertain. A held session-create before prompt authorization may leave an external empty container; no automatic session deletion is promised. A configuration-resolution flight without a binding cannot subsequently authorize a purged run.
6. Stop/rejection use the same lane and settlement rules while retaining user text/confirmed discoveries. At cleanup admission, snapshot their immutable journal into the same non-content outbox under terminal/pending proof. A later Delete can purge locally while that cleanup awaits RPCs; cleanup authority remains only the sealed outbox identity, never a renewed active claim.

Submission still requires the exact existing SQL authorization point in [`SqliteAgentBindings.assertActive`](../../../src/storage/agent-binding.ts): lease held, current claim/prompt/binding/eligibility, then durable `submit_owner` and submitting state **before** `prompt()`. Preserve generation/source checks around every await. No authorized search prompt is resent after uncertainty or restart.

## 5. Cancellation-only native contract

Factor search cancellation from the current prompt-text parser/ordinary `cancelOwned`, without weakening ordinary/import completion or cancellation semantics. Search cleanup resolves a sealed binding from its outbox, not `AgentBindings.get` after purge. It never calls ensure/create/submit, a capability dispatcher or a reply finalizer.

Before mutation, use matching server-side credentials for the **recorded exact endpoint**, then verify native session ID, Thoughtloom/run/protocol metadata, model/variant, directory, deny-all permissions and absence of fork/revert/unsafe state. Search does not inherit ordinary cancellation's current tolerance of model/location drift. Paginate the complete owned history with cursor-progress checks; validate every user ID/hash/order against the sealed manifest, duplicate/unsafe/foreign context, and each inbox session/ID/hash. An observed never-authorized prompt is a contradiction, not new admission authority. Unknown/foreign active input is ownership-conflict, not authority to interrupt it. Recheck ownership around RPCs; do not retarget a replacement endpoint or pretend the facade offers an atomic external-writer barrier.

Hash decoded native user bytes transiently, discard all text/output, and persist only IDs/hashes/enum phases/terminal facts. Do not parse late assistant prose as a protocol envelope. Matching admission ACKs can update `admitted`; they are not terminal evidence. Install a bounded search-only transport-fact callback **before** the post-await active fence can discard an ACK: validate receipt ID/session/hash, then update only a matching sealed cleanup identity if one exists. It cannot resurrect a run, write prose or authorize another RPC.

After local drain, cancel only owned inbox IDs and interrupt only the verified wholly-owned session; reconcile again. A terminal certificate requires the matched admitted user prompt and its correlated assistant/idle boundary (success, failure or interruption), complete ordered owned history, empty inbox and inactive session. An idle alone, empty/missing session, SDK return/timeout or successful interrupt is not a future-admission barrier. Missing credentials/outage remain pending; observed ownership drift becomes ownership-conflict. No raw causes/credentials/native text enter logs or cleanup records.

| Durable state | Settlement condition |
| --- | --- |
| All steps proven never authorized | Qualified setup owner excluded/joined and local flight drained; settle locally. This does not assert remote-container erasure. |
| Any authorized/uncertain/admitted step | Qualified issuer lineage plus local drain **and positive matching terminal evidence for every authorized prompt**, empty inbox/inactive state. A never-authorized prepared successor is not sent to obtain evidence. |
| Authorized prompt never appears | Keep non-content pending indefinitely; observe/cancel the same identity only. No resend, grace period or absence inference. |
| Restart before a durable drain marker | Reacquire exclusive lease, qualify each setup/submission owner against the registry/current DB identity, then record predecessor local drain. Already-dispatched network requests remain uncertain. Unattributed/copied/legacy ownership cannot take this shortcut. |

Persist outbox progress in short identity-checked transactions. On conclusive settlement, atomically mark its row settled and, if the original retained terminal run still exists, settle only that run's pending cancellation; never reopen status/slot or manufacture a reply. Settled outbox rows may then be removed; the session tombstone remains.

## 6. Concrete interfaces and integration seams

```ts
interface ExecutionOwner { readonly id: string; readonly databaseIdentity: string; assertHeld(): void }
interface OwnedRuntimeLease extends ExecutionOwner { releaseAfterDrain(proof: RuntimeDrained): void }
// Factory owns the private connection; RuntimeDrained is a runtime-issued opaque join proof, not a boolean.
acquireExecutionOwner(dbPath): Promise<OwnedRuntimeLease>;
RunWorker.tick(runId, beforePoll?: () => Promise<void>): Promise<void>; // same registered lane
ConfiguredRunWorker.retireSearchRuns(runIds): void; // capture/join/enqueue; no await by Delete
ConfiguredRunWorker.drain(): Promise<void>; // all execution + cleanup tails, not just supervisor ticks
SearchRetention.purgeInTransaction(sessionId, at, owner): readonly RunId[];
SearchRetention.afterCommit(runIds): void;
SearchCleanupStore.recordAdmission(fact: OwnedAdmissionFact): void; // exact IDs/hash only
SearchCancellationPort.reconcile(identity: SealedCleanupIdentity): Promise<CleanupObservation>;
```

`SealedCleanupIdentity` contains run/session IDs, immutable binding, setup/submit owner provenance, ordered prompt IDs/hashes/authorization and drain proof; no `input`, actor selector, arbitrary metadata or active-run capability. `CleanupObservation` is pending, ownership-conflict, admitted, or terminal certificates—not model output. Pass the lease capability through configured worker/native fences and cleanup; a forged DTO/string is not a lease. Local control DTOs remain phase-4-private; no routes/client changes are implied.

## 7. Validation gate and unresolved evidence

- **Actual processes:** a proposed `tests/agent-execution-owner.test.ts` owns local DB/sidecar paths and child Bun processes. Prove contention through relative/symlink spellings, same-process double acquisition, main-DB commands while sidecar is locked, partial-start failure, release only after held setup/execution/cleanup drains, and crash/SIGKILL release. Inspect the supported filesystem behavior; do not substitute an in-process boolean fixture. Reject hard links/identity replacement and test source-identity mismatch on a copied fixture.
- **Decoded fake SDK:** the test author's new recovery/cleanup fixtures should hold authorization before native admission, then Stop/reject/Delete; show local purge returns before remote settlement, concurrent polls coalesce, no self-join, late ACKs are metadata-only, unknown requests are never resent, and empty remote state remains pending both before and after timeout/drain/restart. Later owned admission/terminal evidence must settle exactly once. Include a prepared successor after earlier authorized prompts, full-history pagination/cursor faults, foreign input/model/location/endpoint drift, missing credentials and legacy unattributed owners.
- **Storage/privacy:** preserve FKs/rowids/indexes/unrelated triggers and existing legacy rows; inject rollback after tombstone/manifest copy before purge. Compare library tables unchanged and all local search prose/results absent. Cleanup schemas/log captures must reject text, thought/provenance payloads, credentials and raw exceptions. Cover retained Stop/rejection → cleanup → Delete races, cache clearing, terminal non-revival and user-only controls. No operator/provider fixture or service change is permitted.

No new user-facing product choice is proposed. Remaining gates are fresh design review of the lease/provenance/schema fit and real owned-process evidence of Bun/Linux locking. If those tests disprove the sidecar lifetime guarantees, stop and report before selecting FFI/a new dependency or changing deployment support. The first-rollout shutdown and unsupported-path checks must be disclosed, not performed implicitly. Full execution/cleanup implementation remains frozen until this design gate is reviewed.
