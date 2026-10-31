---
title: Thoughtloom dev and release setup design
date: 2026-10-31
status: draft
tags: [thoughtloom, deployment, ansible, setup]
related: [README.md, .lore/local/plans/thoughtloom-mvp.md, .lore/work/research/opencode-2.2.2-owned-tools.md]
---

# Thoughtloom dev and release setup design

## Goal and boundary

Make exactly two **local loopback** setups, `dev` and `release`, discoverable
and safe to operate without scattering untracked runtime directories. `dev`
adopts the existing generated root in place; `release` uses a separate clone
and starts with an **empty database**. No general arbitrary-instance platform,
automatic dev database copy or merge is planned. This is a draft for discussion,
not authorization to implement,
adopt, restart, migrate, or delete anything. Remote phone access, hosting and
authentication remain separate (`thought-loom-yj3`); no public bind, tunnel,
new login system, or global OpenCode configuration changes are in scope.

## Current constraints

- The application uses Bun 1.4.3 and Node 26.13.0. `scripts/run.ts` owns the
  combined launcher; its explicit web/daemon port environment variables default
  to 3000/3001. Persistent instances must record and supply both ports, not
  assume defaults or take over an occupied listener. The daemon and Next bind
  loopback. The app currently runs ordinary Next `start`, **not** a standalone
  build: a release needs its built workspace and compatible `node_modules`.
- Native setup is fresh-path-only and creates a private app-owned connection,
  plugin and location; it rejects existing destinations. Sessions, grants and
  plugin configuration are tied to their location. The maintained client
  attaches to an operator-managed OpenCode 2.2.2 service; it does not own that
  service or authorize automatic provider calls.
- Recon supplied by the caller reports an active, user-approved worker on
  4173/4174 and a private existing root at
  `~/.local/share/thoughtloom/connection-20261031T144903Z-f72b5123`, containing
  two sources and three completed jobs at schema 16. This is an observation,
  not permission to inspect, move, delete, rekey or change it. Existing work
  and any active/uncertain commands must survive future deployment work.
- `~/.dotfiles/roles/agentic-services/tasks/main.yml` is opt-in via
  `agentic_services_enabled`; `adventure-engine.yml` and the role handlers show
  user-service wiring. `roles/media-services/tasks/img-gallery.yml` provides a
  better model for pinned-runtime assertions, check-mode and reproducible build
  checks; `services/img-gallery/README.md` is a service documentation precedent.
  Deployment uses a separate new clone at `{{ applications_dir }}/thoughtloom`
  (normally `~/Applications/thoughtloom`), distinct from the development
  checkout. Agents author repository and dotfiles sources, templates and docs;
  the operator runs the approved automation that manages the deployment clone.
  The standing prohibition on direct agent edits under `~/Applications/` remains.

## Setup design

1. **Two-profile discovery.** The single persisted discovery mechanism is
   `${XDG_CONFIG_HOME:-~/.config}/thoughtloom/instances/`, containing fixed
   `dev.json` and `release.json` records when those setups are registered; no
   second registry or arbitrary profile names. Validate schema/version, owner
   and absolute paths; fail closed on malformed, foreign, symlinked or ambiguous
   entries. Each record identifies its own checkout, explicit web/daemon ports,
   and roots for config, data, state, cache, backup and native
   location, including relevant ownership and references. Secrets are stored in
   private files, not manifests, logs, dotfiles, or version control. Directories
   holding private state use 0700 and secret files 0600.
2. **Predictable release roots.** Illustrative fresh paths are
   `~/.config/thoughtloom/instances/release.json`,
   `~/.local/share/thoughtloom/instances/release/` for data/native location,
   `~/.local/state/thoughtloom/instances/release/` for state/backups, and
   `~/.cache/thoughtloom/instances/release/` for cache. Validate the exact layout
   before use; XDG roots are not a code checkout. Record dev's existing paths
   without moving them. Use an explicit app-owned
   native location and no unregistered timestamped connection roots. Retain
   per-release immutable plugin/config versions only when required for safe
   compatibility, with manifest references and explicit retention; never remove
   files still referenced by runs or another instance.
3. **Small reusable application operations interface.** Design one
   noninteractive interface, shared by automation and agents, for discover/list,
   prepare/adopt, status/doctor, start/stop, update, backup/restore and removal;
   combine commands where natural rather than build a platform. A possible
   interactive wizard is a thin optional client of these same operations, not a
   second installer, secret store or source of truth. Status/doctor are read-only
   by default, report safe identity/status/counts without source text or
   credentials, and never prompt a model, enable a worker, or restart services.
   Validate ownership, mode, path ancestry and process/service identity; creation
   refuses unknown existing paths, uses exclusive creation, and repeated runs do
   not overwrite, rekey or rotate credentials. Define structured, redacted
   outcomes and dry-run before mutation.
4. **Ansible declares desired host state.** Add an explicitly opted-in
   Thoughtloom integration to the existing user-service role, with variables
   for instance, explicit ports, exact revision/source and private paths. It
   calls the common interface rather than reproducing its logic. User systemd
   units/handlers must own only the selected Thoughtloom service; no native
   operator-service installation, automatic policy change, global config edit,
   runtime installation, sudo, or wildcard permissions. Pinned runtime checks
   fail with actionable instructions; check-mode must not build or mutate.
   Service enable/start and agent-worker enablement are explicit decisions, not
   side effects of doctor or a health probe. Ansible variables are authoritative
   for **declared desired inputs**; the manifest is the single persisted
   inventory of observed ownership, paths and applied state, not a competing
   desired-state registry. Show an explicit diff before compatible in-place
   nonsecret changes. Omitted variables preserve existing values; defaults apply
   only on creation, so an omitted model or setting never resets an instance.
   Identity, path, port or native-location conflicts fail with an actionable
   explicit adoption/migration step, never silent relocation or takeover.

## Adoption, upgrades and recovery

- **Adopt in place, only after later authorization.** Prefer registering the
  existing connection as `dev` with verified references, ownership and ports;
  do not move its location or regenerate credentials merely for tidy paths.
  Current setup code is fresh-only, so adoption needs an explicit safe contract;
   it must not silently treat an unknown directory as managed. `release` starts
   empty and later receives only explicitly authorized ingestion; never silently
   copy, promote or merge dev data or run duplicate workers.
- **Deployment clone and exact revision.** The operator-approved Ansible run
  manages `{{ applications_dir }}/thoughtloom`, a separate clone, not an XDG
  code-release tree. Stop only the selected owned application service, then
  check out the explicitly selected revision, install from the lockfile with
  exact pinned runtimes and `bun install --frozen-lockfile`, build Next and
  start that service. Local checkpoints may be unpushed: establish how the
  chosen revision is made available without assuming a remote has it or pushing
  automatically. On failure restore the prior code/dependencies and only use a
  verified, schema-compatible recovery snapshot; do not assume backward SQLite
  migrations or atomic alternate-release switching. Verify this recovery path
  before changing a real instance.
- **Do not mutate in-flight scope.** Updates preserve immutable run/session IDs,
  grants, command receipts, native location and referenced plugin/config
  versions. Reconcile queued/active/uncertain work with its actual service;
  never blindly resubmit, rotate the transport credential, or replace a running
  process belonging to something else. Restart only owned units with explicit
  activation and a safe rollback/recovery path. Provider compatibility and
  live model output are not a deployment health check.
- **Plugin upgrades need an activation check.** The Thoughtloom daemon and the
  plugin running inside OpenCode are separate pieces of software. Updating a
  plugin file or restarting Thoughtloom can leave old plugin code loaded in an
  already-running OpenCode service. The update design must verify the actually
  active plugin version, not just the file on disk. Engineering must research
  the pinned native version's supported location-scoped reload and read-only
  activation witness; do not assume those capabilities exist. If activation
  cannot be witnessed or supported reload is unavailable, stop before switching
  and retain the old working configuration. Coordinate a supported reload only
  with separate operator approval; never assume or perform a service restart.
  Preserve native location, credential and run provenance; no random locations
  or rekeying to bypass this check. Technical investigation and a controlled
  validation plan are tracked in `thought-loom-8r5.10`.
- **Backup and removal.** Reuse the documented SQLite online snapshot and
  restore-to-new-path safety properties, including WAL and no blind worker
  resumption; do not imply OpenCode state is included. Removal is explicit for
  one selected instance and defaults to disabling/removing its service wiring
  while preserving data, backups and native provenance. Retain a discoverable
  disabled/retired manifest with those references until explicit purge, so
  preserved paths never become unregistered orphans. Purging retained data is
  separate approval, with a dry-run enumerating exact paths and references;
  never wildcard-clean unknown directories or stop unowned processes.

## Markdown corpus ingestion

The empty release setup needs a deliberate way to bring in the user's
Obsidian-style Markdown corpus. A small agentic script may be appropriate, but
its interface, format and behavior are design discussion only, not approved or
implemented. Discuss source fidelity, provenance, relative and wiki links,
frontmatter and failure/retry semantics before choosing a format. Never silently
strip metadata, infer unsupported meanings, inspect a corpus or import anything.
Follow-up `thought-loom-8r5.9` is escalated for that discussion. Ingestion is
explicit and user-authorized, not an automatic dev copy or setup side effect.

## Future implementation and evidence

1. Review this design. No deployment, ingestion or code authorization follows
   merely from saving it.
2. Implement and independently review/test the shared instance operations and
   one canonical repository operations guide; add a short `AGENTS.md` pointer
   instructing agents to list/doctor before any create, reuse recorded paths,
   preserve provenance/approvals and avoid implicit native restarts/provider
   calls. Any wizard delegates to the common interface.
3. Implement opt-in `~/.dotfiles` Ansible role/task, templates and handlers,
   and a `services/thoughtloom/README.md` pointing to that canonical contract.
   Follow existing check-mode/runtime patterns; agents do not directly modify
   protected `~/Applications/` paths. Only the operator runs approved automation
   to manage the separate deployment clone there.
4. With explicit later authorization, adopt dev in place and prepare the empty
   release setup. Inspect dry-runs and ports; activate only intended owned
   services. Native worker activation and later ingestion each need explicit
   approval; preserve the existing active dev until then.
5. Validate on isolated fixture directories and disposable user units: repeat
   prepare/adopt and second Ansible apply with no churn; test foreign paths,
   symlinks, ownership, no-overwrite, redaction, concurrent creation/port races,
   explicit ports, compatible drift, omitted-field preservation, conflict refusal,
   retired-instance discovery and check-mode/syntax. Exercise WAL backup/restore,
   migration failure and pending/uncertain runs; verify stale/unwitnessed plugin
   activation is refused and deployment build/readiness failure rollback never
   kills or modifies other processes. No real model calls are
   needed for deployment validation. Review docs and operational boundary before
   any real adoption.

The operator must provide the exact available revision to deploy; do not assume
unpushed checkpoints exist remotely or push them automatically. Plugin reload
feasibility is an engineering responsibility, not a question the user needs to
resolve by understanding a native API.
