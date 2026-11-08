---
title: User-triggered reinterpretation
date: 2026-11-08
status: approved
tags: [thoughtloom, weaving, reinterpretation]
---

# User-triggered reinterpretation

Design for `thought-loom-xls`. The user agreed the product behavior below and authorized implementation. The contract below is the implementation target, not a claim that the endpoints are already available. Beads owns execution status and task sequencing.

## Agreed behavior

- Reinterpret is a user-only action under Idea's More actions, available for any active thought, including AI-created thoughts and retained media sources.
- Interpret the selected thought afresh through normal weaving. No additional text is required; contributions and instructions belong in Evolve.
- Publish new interpretations as direct children of that thought. Preserve earlier interpretations, Full replies, and all existing ancestry and branches. Never automatically reject or replace earlier output.
- Rejected subjects must be restored first. Rejected earlier interpretations remain unavailable to AI but do not block reinterpretation of an active subject.
- Show existing interpretation work instead of starting overlapping work. After completion or safe cancellation, another explicit request can start fresh work. Unsettled cancellation cannot authorize replacement work.
- Keep the user on the same Idea page, show progress, and refresh Surrounding Context as new children arrive. Do not automatically navigate to new output.

## Proposed implementation boundaries

Reuse ordinary weave runs, the worker, normal access fences, run status/Stop, issued-thought tracking, and retained response associations. Preserve title-fill safeguards. Media continues to use its managed shared-filesystem path, not another attachment mechanism.

Existing storage already supports multiple weave runs for a subject, keyed by subject and trigger; each run retains its own Full reply. Idea already reads multiple associated replies. No new thought kind, relationship, or database migration appears necessary.

Add a user-only command at `POST /thoughts/:id/reinterpret` with an empty object body and a validated idempotency key. Each admitted explicit request receives a distinct durable trigger within the existing weave-run fields. Exact replay returns its original run, including after completion; a new key means a new request, not a semantic duplicate check.

Check visibility and admit transactionally. Before admitting new work, inspect all interpretation-capable subject weave work, including uncertain submissions and unsettled cancellation, not merely the latest run. Do not block unrelated Evolve discussions or exports: they are not a second interpretation of this subject. A text title-clear weave can interpret and participates in exclusion. A genuine media-title-only job permits only conditional title fill, can coexist, and never fulfills Reinterpret.

An existing active interpretation is exposed rather than duplicated. The response must distinguish an admitted/replayed command from an existing-work conflict. Do not falsely acknowledge the new key as durably admitted when returning an unrelated active run: the existing schema cannot store a second receipt alias for that run. This distinction must survive exact-key recovery and races.

Support read-only lookup of an admitted request by subject and key, following existing keyed receipt patterns. A lost response must not cause a new-key write. The client preserves the pending key until reconciliation; explicit same-key retry is distinct from requesting another interpretation. Use existing run observation and Stop once the run is known. No generic command framework is needed.

### Keyed command and recovery

The proposed fixed lookup is `GET /thoughts/:id/reinterpret/by-key/:key`. Both routes are user-only. Keys use the existing case-sensitive `[A-Za-z0-9._:-]{1,128}` grammar without normalization. The immutable identity is `(subjectId, reinterpret:<key>)` in existing run fields, not a new receipt table.

Use a control snapshot with `receipt: {subjectId, requestKey, runId} | null`, `run: existing weave status | null`, and `eligibility: {eligible, reason, blockingRun}`. Eligibility is advisory; a write always rechecks. It must distinguish active work, unsettled or unverified work, and a rejected subject. A terminal run status alone does not establish replacement eligibility.

| Request outcome | Contract |
| --- | --- |
| Fresh POST admitted | 202 with receipt and run. |
| Exact POST replay | 200 with the original receipt and current run, even after completion. |
| Unrelated active interpretation | 409 `interpretation-active`, identifying existing work; no receipt admitted for the submitted key. Show that work rather than start another. |
| Unsettled or unverified earlier work | 409 `interpretation-unsettled`; no new admission. |
| Fresh request on rejected subject | Refuse admission; restore first. |
| Lookup finds receipt after subject rejection | Return user-only control receipt/status, never thought text, Full replies, file paths, or native identities. |
| Lookup finds no receipt | 200 with null receipt means only “not recorded at this read”; it cannot prove a delayed POST will never arrive. Missing subject is 404. |
| Unknown POST outcome | Retain pending subject/key. Check receipt or explicitly resend the identical request with the same key; never manufacture a new key from timeout or lookup absence. |

Authenticate and validate before receipt lookup; resolve an exact receipt before fresh-request visibility/exclusion checks. Receipt recovery never starts or resumes work. AI credentials have no history/control bypass. A reload must not silently produce a replacement write; preserve the pending command identity for reconciliation or require explicit recovery before another submission.

### Automatic scheduling and execution

Keep automatic invitations from title clearing and Evolve completion durably queued in their existing owning transactions. A busy subject must not make a valid title edit or Evolve publication roll back, and must not silently discard its weave invitation.

Serialize interpretation execution at the existing worker/storage boundary. A started subject weave remains incumbent across successor steps and restart; otherwise select the oldest queued invitation using existing insertion order. Check before dispatch, including authoritatively before each new native submission. A postponed job stays queued without failure or generation churn. Continue observing and cancelling already-submitted work, including legacy overlaps, without dispatching more. Reuse existing per-run flights and exclusive execution ownership, not another scheduler.

Both manual admission paths and worker dispatch use the subject-wide exclusion rule. Media-title-only work is the narrow capability-restricted exception described above.

### Positive settlement, including historical runs

The existing ordinary cancellation implementation can mark work settled from empty inbox/inactive snapshots. This is a pre-existing defect: a timed-out native submission can arrive later. A cancel acknowledgement or idle snapshot alone is not positive proof of safety.

Before replacement, retain the narrowly proven never-submitted case; otherwise reconcile every potentially submitted step in the retained journal, not only the current prompt. Require matching native prompt identity/input and a correlated terminal execution boundary for each, followed by empty inbox/inactive state. Do not publish output during cancellation reconciliation. Serialize reconciliation with outstanding local execution flights and existing runtime ownership.

Missing identity, contradictory ownership, outages, or admission that was authorized but never observed remain unresolved. Cancellation can remove a pending native item without leaving a usable certificate; such work may stay blocked indefinitely. Do not invent a successful terminal step or use a timeout as permission to proceed.

Old `settled` flags are not sufficient evidence either. No migration is required if admission re-proves safety from retained journal/native evidence when needed, or conservatively refuses it. Perform external reconciliation outside the SQLite transaction, then recheck the unchanged run/journal identities and current subject blockers transactionally. If proof is unavailable, return an unsettled conflict. Unlocking genuinely unprovable work requires a separately authorized operator decision, not an automatic reset. This design does not add an experimental native-log integration or cleanup framework.

The browser uses fixed Next.js server handlers, never direct daemon access. Keep canonical Idea publication in its existing reader; progress observation does not own Thought children or Full replies. Earlier replies remain selectable through the existing interface.

Media's initial-processing retry remains distinct: it can recover initial failure only before an interpretation exists. General Reinterpret may run after successful output. Both admission paths must respect the same subject-work exclusion, including concurrent initial retry versus reinterpretation; do not weaken media file or rejection guards.

Derive an explicit reinterpretation purpose from the immutable `reinterpret:<key>` trigger and carry it through admission, prompt construction, publication, and completion. Initial media processing/retry keeps its historical-child prohibition. Media reinterpretation instead permits one newly issued interpretation for this run, directly parented to the selected source; historical interpretations cannot fulfill it or prevent it.

Keep existing outcome conventions: an honest text/URL weave can complete without new thoughts and retain a fallback Full reply. A media reinterpretation without its own interpretation fails while retaining the complete limitation reply; prior output cannot turn it into success. Settlement remains separate from that result. Do not create artificial failure thoughts or overwrite earlier replies.

## Verification and documentation

Use isolated, controlled fixtures. Cover user-only authorization, active and rejected subjects, AI-authored subjects, rejected prior output, distinct-key siblings, exact replay, lost-response lookup, concurrent admission, initial-media-retry races, uncertain work, Stop/settlement/restart, title-only jobs and title-fill races, multiple readable replies, and preserved ancestry. Include delayed native admission after timeout/Stop, initially empty observations, unverified historical settlement, whole-journal reconciliation, automatic enqueue without transaction rollback, and serialized successor dispatch. Verify shared-file access and media guards without an operator service or real provider.

Browser checks must exercise More actions, duplicate activation, ambiguous admission recovery, progress and Stop, refresh without navigation or lost context, and visible new children with earlier replies retained. Include desktop and phone layout checks through the designer; reuse existing components rather than adding a new screen.

Update current API, testing, schema-trigger documentation if applicable, client design contract, and product context with the implementation. Do not describe the proposed endpoints as already available. A schema or daemon capability gap requires discussion rather than a silent client workaround.

## Source anchors

- `src/storage/weave-admission.ts`: current run deduplication and media retry gates.
- `src/storage/run-schema.ts`: existing subject/trigger uniqueness.
- `src/storage/run-operations.ts`: interpretation publication and retained reply associations.
- `src/storage/run-fences.ts` and `src/storage/run-worker.ts`: cancellation, visibility, and settlement.
- `apps/web/src/server/idea.ts` and `apps/web/src/components/idea-view.tsx`: current multi-reply reading and canonical publication.
- `.lore/context/url-weaving.md`: source access, immutable output, and the original recovery use case.
