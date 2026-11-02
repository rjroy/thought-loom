# Production setup through `~/.dotfiles`

This is the handoff for an agent implementing Thoughtloom deployment in the
operator's Ansible repository, `~/.dotfiles`. It describes production-mode,
**local loopback** operation, not an authenticated network server.

The application launcher exists. The Thoughtloom Ansible tasks, variables,
templates and handlers described below **do not exist yet**. This document does
not authorize deployment, runtime installation, service restarts or native-agent
activation. Read both repositories' `AGENTS.md` before making changes.

## Boundaries and required decisions

- Keep the development checkout and its testing launcher separate. Production
  uses a separate clone at `{{ applications_dir }}/thoughtloom`, normally
  `~/Applications/thoughtloom`. Agents edit source/templates in `~/.dotfiles`,
  never files under `~/Applications/`; the operator runs approved automation.
- Use a fresh, empty production database. Do not copy the development database,
  inspect personal content, import a corpus or adopt existing native state.
- Both listeners bind `127.0.0.1`. There is no authentication. Do not add a
  reverse proxy, public tunnel or network listener. Remote access needs a
  separate hosting/authentication decision.
- Before implementation, obtain the target inventory host/user, source URL,
  exact available commit, two unused ports, absolute runtime paths, private
  state paths, and whether to enable/start the user service. Do not assume a
  local unpushed commit is available remotely or push it automatically.
- Basic capture/retrieval requires no model or provider. Native weaving is a
  separate opt-in with possible content disclosure and charges.

## Inputs to declare in Ansible

Add explicitly opted-in `thoughtloom_*` variables using existing dotfiles
variable conventions. These names are proposed role inputs, not an existing API:

| Input | Contract |
| --- | --- |
| `thoughtloom_enabled` | Default false, also gated by `agentic_services_enabled` |
| `thoughtloom_repository` / `thoughtloom_revision` | Approved source and exact commit available from that source |
| `thoughtloom_checkout` | Separate deployment clone, normally `{{ applications_dir }}/thoughtloom` |
| `thoughtloom_bun_executable` | Absolute executable reporting `1.4.3` |
| `thoughtloom_node_executable` | Absolute executable reporting `v26.13.0` |
| `thoughtloom_web_port` / `thoughtloom_daemon_port` | Distinct unused ports, each 1024–65535; do not borrow dev ports |
| `thoughtloom_database_path` | Absolute private production SQLite file, outside checkout |
| `thoughtloom_launch_file` | Absolute owned regular file, not a symlink, mode `0600` |
| `thoughtloom_service_enabled` / `thoughtloom_service_started` | Explicit operator choices; default false |
| `thoughtloom_native_config_file` | Optional existing absolute file; omit for initial non-agentic setup |

Suggested private roots are `~/.config/thoughtloom/release/` for configuration,
`~/.local/share/thoughtloom/release/` for data, and
`~/.local/state/thoughtloom/release/backups/` for backups. Resolve `~` to the
target user's absolute home in rendered files. Directories use `0700`; private
files use `0600`. Refuse unexpected existing paths, foreign ownership or symlink
destinations rather than silently adopting or overwriting them.

These are deployment layout suggestions, not an implemented instance registry.
The older [setup design](../.lore/work/design/thoughtloom-setup.md) is a draft;
do not assume its proposed discovery, adoption or doctor commands exist.

## Application configuration

Render a private launch file, with real absolute paths and selected ports:

```text
THOUGHTLOOM_DATABASE_PATH="/ABSOLUTE/PRIVATE/DATA/thoughtloom.sqlite"
THOUGHTLOOM_WEB_PORT="SELECTED_WEB_PORT"
THOUGHTLOOM_DAEMON_PORT="SELECTED_DAEMON_PORT"
```

Optional keys are `THOUGHTLOOM_NATIVE_CONFIG_FILE` and
`THOUGHTLOOM_TOOL_CONNECTION_FILE`. All path values must name existing files.
The database must therefore exist before launch; first startup initializes its
schema. For a new installation, create an empty file exclusively, only after
confirming the destination is fresh. Never truncate an existing database on a
repeat apply. The database parent must remain writable for SQLite WAL files.

The parser accepts only these five keys; no `export`, shell expansion, duplicate
keys or inline comments. Use JSON double-quoted strings for paths. Do not use a
symlink to a dotfiles `.env`: this launcher rejects a symlinked launch file.
Omitted Thoughtloom settings do not inherit ambient `THOUGHTLOOM_*` values.
Keep credentials out of tracked inventory, templates, diffs and logs; use private
operator-supplied files, and `no_log`/disabled diffs for sensitive Ansible tasks.

## Ansible implementation sequence

Follow these existing dotfiles patterns, adapting rather than copying their
application-specific versions or secrets:

- `roles/agentic-services/tasks/main.yml`: opt-in task inclusion.
- `roles/media-services/tasks/img-gallery.yml`: exact runtime assertions,
  frozen lockfile install, build signature and check-mode handling.
- `roles/agentic-services/tasks/adventure-engine.yml` and
  `roles/agentic-services/handlers/main.yml`: user units and scoped handlers.

1. Add `roles/agentic-services/tasks/thoughtloom.yml`, an opt-in inclusion with
   its own `thoughtloom` tag (including child tasks), and explicit variables.
   Never run unrelated agentic services just to deploy Thoughtloom.
2. Assert executable versions against `package.json`/`.tool-versions`. Fail
   with actionable instructions if missing or mismatched; do not install
   runtimes, change global selections or use privilege escalation.
3. Validate paths, ownership, ports and any existing service identity. For an
   update, record the current revision/configuration and arrange a verified
   backup before changing code. Stop only the selected owned application unit,
   with approval; an occupied port is not permission to kill its listener.
4. Manage the separate clone at the exact approved commit. Refuse an unexpected
   or dirty checkout rather than forcing it. Install and build from its root:

   ```sh
   bun install --frozen-lockfile
   bun run build
   ```

   Use the selected absolute Bun executable and a PATH whose Node resolves to
   the pinned executable for both build and runtime. Keep workspace dependencies:
   this is ordinary Next `start`, not a standalone bundle. Require
   `apps/web/.next/BUILD_ID`; write a build signature only after success. Include
   revision, lockfile and runtime versions in that signature so unchanged
   repeat applies do not rebuild or restart unnecessarily.
5. Create private directories, initialize only a fresh empty database file,
   and render the launch file without replacing existing data or native state.
6. Template `services/thoughtloom/thoughtloom.service.j2` into the target user's
   `~/.config/systemd/user/thoughtloom.service`. Add user-scoped daemon-reload
   and restart handlers; ensure reload precedes any start/restart. A deployment
   failure must not trigger a restart into a partial build. Flush successful
   changes before health checks, and honor explicit enable/start choices.
7. Add `services/thoughtloom/README.md` pointing to this guide, with that host's
   nonsecret operational choices. Do not duplicate application setup logic.

Check mode must not clone, initialize data, install, build, start or restart.
Read-only runtime probes may run in check mode. On an unprovisioned host, report
what cannot yet be checked instead of invoking commands in nonexistent paths.

### User-service contract

Use `Type=simple`, the deployment checkout as `WorkingDirectory`, a private
`UMask=0077`, and an explicit PATH containing pinned Node and Bun directories.
Render absolute paths with correct systemd quoting, not shell interpolation.
The foreground process is the existing combined launcher:

```text
ExecStart=/ABSOLUTE/BUN --no-env-file run /ABSOLUTE/CHECKOUT/scripts/run.ts start --launch-env /ABSOLUTE/PRIVATE/launch.env
```

This is a template contract, not a ready-to-copy complete unit. Use
`Restart=on-failure`, a restart delay, `KillMode=control-group`, and a stop timeout
longer than the launcher's seven-second child shutdown window. Keep Node/Next
and daemon in the unit's cgroup. No shell backgrounding, `nohup`, second process
manager or independent daemon unit is needed. Logs go to the journal and may
contain private filesystem paths; restrict their handling accordingly.

Use Ansible `scope: user`, without `become`. A user manager must already be
available. Boot operation without login may require operator-managed lingering;
report that prerequisite rather than changing host login policy automatically.

## Validation and activation

Before an operator applies the integration, validate the complete role on
disposable paths and an isolated user unit, without native configuration:

1. Run Ansible syntax and check/diff validation using the existing inventory,
   limited to the intended host and new `thoughtloom` tag. Review the selected
   task list to ensure no unrelated services/system play will change. Do not
   print secret-bearing diffs. The tag is usable only after implementing it.
2. Verify first apply and second apply: no database truncation, credential
   rotation, rebuild or restart on an unchanged second run. Verify check mode
   leaves files, processes and services unchanged.
3. Exercise missing runtime, occupied port, unsafe/existing path, build failure
   and startup failure. Confirm other instances/processes remain untouched and
   failures are reported rather than masked by a successful handler.
4. Verify the rendered unit with `systemd-analyze --user verify UNIT_FILE`.
   Only after approval, apply through Ansible and inspect
   `systemctl --user status thoughtloom.service` plus
   `journalctl --user -u thoughtloom.service` for the selected deployment.
5. Run the read-only application readiness command with the pinned runtime:

   ```sh
   /ABSOLUTE/BUN --no-env-file run /ABSOLUTE/CHECKOUT/scripts/run.ts status --launch-env /ABSOLUTE/PRIVATE/launch.env
   ```

   It checks the web root and daemon `/weaving/status`. It does **not** prove
   process ownership, worker availability or native plugin activation. Check
   unit MainPID/cgroup and listener ownership separately. An unconfigured worker
   is expected for the initial capture/retrieval setup.
6. On the disposable instance, save test-owned text, retrieve it, restart only
   its owned unit and confirm persistence. Do not seed or write smoke-test notes
   into the real production database without approval.

Record actual commands/results, revision, versions, ports and private file
locations without source content or credentials. Documentation review alone is
not evidence that the Ansible role or production deployment has been tested.

## Native weaving, upgrades and recovery

For later explicitly approved weaving, follow
[Connect weaving](../README.md#connect-weaving-explicit-opt-in). It targets an
operator-managed OpenCode 2.2.2 service and fresh runtime/location directories.
The chosen daemon origin must match this deployment's port. Do not reuse dev's
connection, create a duplicate worker, restart a shared OpenCode service or make
a model call as a deployment probe. Restarting Thoughtloom does not prove a new
native plugin is loaded; resolve activation verification before switching an
existing native integration (tracked separately in `thought-loom-8r5.10`).

Before updates, reconcile active/uncertain work with the operator. Stopping the
launcher does not prove native work has drained. Follow the README's
[SQLite backup and restore procedure](../README.md#back-up-and-inspect-a-restored-copy):
stop the selected application, retain a verified WAL-aware SQLite snapshot, and
restore to a **new** private path. It does not back up OpenCode state, native
configuration or credentials. Arrange separate authorized backups for those.

On build/start failure, leave the selected service stopped and report the
failure. Restore the previous exact code/dependencies and rebuild only with a
verified compatible database. Startup may have migrated the schema; do not run
older code against it assuming backward migrations. Test recovery with a
snapshot restored to a new path, initially without native configuration. Inspect
and reconcile jobs before any worker reactivation; blind retry may duplicate
external effects. There is no claimed atomic release switch or automatic safe
rollback. Prove recovery on fixtures before upgrading real data.

Disabling deployment preserves the database, backups and native provenance.
Deletion, ingestion, moving data and purging old native configuration each need
separate authorization.
