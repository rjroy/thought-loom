# Production deployment

[Start here](../README.md) · [Server startup](server-startup.md) · [Testing](testing.md)

Thoughtloom can run as two persistent processes: the Bun daemon and the built Next.js server. **`web:start` is already the production command**; a `web:prod` alias is unnecessary. Build once per release with `web:build`, then start that build without rebuilding on each restart. The daemon runs TypeScript directly with Bun in both development and production; it has no separate compilation step or hot reload.

This guide covers a **single-operator deployment on Linux**, with both listeners bound to `127.0.0.1`. Access can remain local or use a privately controlled HTTPS proxy such as Tailscale Serve. There is no built-in account/login system, and origin checks and bearer credentials are not a substitute for one. Control HTTPS and tailnet access externally. Do not enable Tailscale Funnel, publish the ports, or otherwise expose the application publicly.

## 1. Prepare a release

Use a stable checkout owned by the account that will run the services, rather than a disposable worktree. Keep persistent data and private configuration outside that checkout. Install Bun and the [native extension prerequisites](server-startup.md#native-spelling-extension). Record the Bun version and release commit used for deployment.

From the project root:

```sh
bun install --frozen-lockfile
bun --no-env-file run build:spellfix
bun --no-env-file test
bun --no-env-file run typecheck
bun --no-env-file run web:typecheck
bun --no-env-file run web:build
```

Install the full frozen workspace dependencies, including build tools. Rebuild `build/sqlite/spellfix.so` on the target platform; do not copy an arbitrary binary from a development machine. Keep the checkout, installed dependencies and generated Next.js build together. Do not build over a running release; stop it first or prepare a separate release directory.

Do not use `scripts/setup-test.sh` as a deployment installer. It generates new credentials, points at checkout-local data, configures a real agent by default, and generates a launcher for `web:dev`.

## 2. Store persistent configuration

Create private configuration and data directories owned by the service account. For example, use `~/.config/thoughtloom/` and `~/.local/share/thoughtloom/`, with directory permissions `700` and configuration-file permissions `600`. Use absolute paths in configuration and service definitions.

Create two environment files. These examples use **systemd environment-file syntax**, not shell scripts: omit `export`, and do not use `$HOME`, `$(...)`, or other shell expansion. Replace placeholders before starting services.

`daemon.env`:

```ini
THOUGHTLOOM_USER_TOKEN=<persistent-user-token>
THOUGHTLOOM_AI_TOKEN=<different-persistent-ai-token>
THOUGHTLOOM_DB_PATH=/absolute/private/data/thoughtloom.sqlite
THOUGHTLOOM_PORT=3001
THOUGHTLOOM_LOG_LEVEL=info
```

`web.env`:

```ini
NODE_ENV=production
THOUGHTLOOM_USER_TOKEN=<same-persistent-user-token-as-daemon>
THOUGHTLOOM_DAEMON_URL=http://127.0.0.1:3001
THOUGHTLOOM_WEB_ORIGIN=http://127.0.0.1:3000
```

Generate two independent random credentials of at least 32 characters and store them securely, rather than generating replacements on every launch. The user token must match between services. The web process needs neither the AI token nor the database path or agent configuration. Never use `NEXT_PUBLIC_*` for these credentials, commit the files, or include their contents in diagnostics.

The daemon also opens a private media directory, defaulting to the canonical database filename plus `.media`. Set `THOUGHTLOOM_MEDIA_DIR` only to an intended absolute private location and include it in backups even when outside the database directory. Media processing requires the daemon and OpenCode to share those absolute paths under the service UID. See [media settings and access](server-startup.md#retained-media-and-shared-filesystem).

Use the exact configured browser origin, including its port. This guide uses the default web port `3000`. Changing `THOUGHTLOOM_WEB_ORIGIN` alone does not change the listening port.

For private Tailscale Serve access, replace the web origin with the actual externally served HTTPS origin, for example `THOUGHTLOOM_WEB_ORIGIN=https://host.example:3002`. For additional browser URLs, set `THOUGHTLOOM_WEB_ADDITIONAL_ORIGINS` to a comma-separated list of full origins, for example `https://host.example:3003,https://other.example:8443`. The primary remains trusted; no additions are configured by default. Configure Serve separately to proxy each address to `http://127.0.0.1:3000` while preserving the original Host header. Each origin may be remote only with HTTPS; it must not include credentials, a path, query or fragment. Requests require a configured actual Host, and mutations require its corresponding exact Origin; forwarded headers do not establish trust. Changing the allowlist does not configure the proxy or listening port. Keep `THOUGHTLOOM_DAEMON_URL` loopback-only and do not proxy the daemon. Tailscale access policy and HTTPS are external responsibilities; no application login is provided. Do not use Funnel or public exposure.

Bun's `--no-env-file` does not disable Next.js's own environment-file loading. Keep private `.env*` files out of the release checkout when service configuration is the intended source of truth. Do not copy development environment files into the release or use real credentials as build/test fixtures.

### Optional agents

Initially omit `THOUGHTLOOM_AGENT_CONFIG` to bring up capture, search and Simple export without model calls. Evolve and Agentic export require it. Captures can retain queued weave jobs; enabling agents later may process that backlog and incur charges.

To enable agents, add the serialized JSON described in [agent configuration](server-startup.md#agent-configuration) to the daemon's environment only. In a systemd environment file, an assignment can wrap the JSON in single quotes, for example `THOUGHTLOOM_AGENT_CONFIG='{"service":{"discover":true},...}'`; the ellipsis is illustrative, not valid configuration. Supply the full approved directory, model and effort mapping.

Verify access from the actual service account and service environment. Interactive-shell discovery and credentials may not be available there. An explicit service endpoint is also supported. Thoughtloom never starts, stops or upgrades the operator-managed OpenCode service. Do not configure Thoughtloom to manage that shared service as a dependency.

## 3. Supervise both processes

The following are **templates**, not installed units. Replace every `/absolute/...` path, including the Bun executable path (`command -v bun` can locate it) and its containing directory in `PATH`. A service manager does not inherit your interactive shell's PATH or exported variables. The nested package scripts also invoke `bun`, so setting only an absolute `ExecStart` path is not enough.

For user services, place these under `~/.config/systemd/user/` for the chosen account.

`thoughtloom-daemon.service`:

```ini
[Unit]
Description=Thoughtloom daemon

[Service]
Type=simple
WorkingDirectory=/absolute/thoughtloom-release
EnvironmentFile=/absolute/private/config/daemon.env
Environment=PATH=/absolute/bun-directory:/usr/local/bin:/usr/bin:/bin
ExecStart=/absolute/path/to/bun --no-env-file run daemon
Restart=on-failure
RestartSec=5
UMask=0077
TimeoutStopSec=120

[Install]
WantedBy=default.target
```

`thoughtloom-web.service`:

```ini
[Unit]
Description=Thoughtloom production web server
After=thoughtloom-daemon.service

[Service]
Type=simple
WorkingDirectory=/absolute/thoughtloom-release
EnvironmentFile=/absolute/private/config/web.env
Environment=PATH=/absolute/bun-directory:/usr/local/bin:/usr/bin:/bin
ExecStart=/absolute/path/to/bun --no-env-file run web:start
Restart=on-failure
RestartSec=5
UMask=0077
TimeoutStopSec=120

[Install]
WantedBy=default.target
```

The stop timeout is an operational starting value, not an application guarantee. Monitor shutdown and increase it if necessary; forced termination can interrupt cleanup. The daemon handles SIGTERM/SIGINT, pauses/drains local work and the listener, then closes SQLite. Shutdown does not mean user Stop and does not request native cancellation merely because the process is leaving.

After editing and reviewing the templates:

```sh
systemctl --user daemon-reload
systemctl --user enable --now thoughtloom-daemon.service
systemctl --user enable --now thoughtloom-web.service
systemctl --user status thoughtloom-daemon.service thoughtloom-web.service
journalctl --user -u thoughtloom-daemon.service -u thoughtloom-web.service -n 50
```

`After=` orders startup, not readiness. Check the daemon's successful startup event and actual browser operations. A user manager normally follows login sessions; if services must start at boot and survive logout, have the host administrator configure the account's user-manager persistence, or deploy equivalent system services under an unprivileged account. Merely enabling these user units does not guarantee unattended boot availability.

## 4. Verify the deployment

1. Confirm the daemon emits its successful startup event with `http://127.0.0.1:3001/`, and that both services remain running without restart loops.
2. Open `/capture` at the configured browser origin (for the default, `http://127.0.0.1:3000/capture`). Capture a clearly identified verification thought, find it in Explore, open it, and try Simple export. These operations persist real data; they are not an isolated fixture.
3. Cleanly restart both services and verify the same thought remains available. Check that each listener remains loopback-only.
4. If agents are intentionally enabled, perform a small Evolve or Agentic export and inspect its final status. This calls a real model and may incur charges. Without agent configuration, lack of these features is expected, not a deployment failure.

There is no dedicated health endpoint in this procedure. A listening port or rendered page alone does not verify authenticated web-to-daemon access or optional agent availability. Avoid copying private search URLs, tokens or thought content into monitoring logs.

For isolated pre-deployment browser checks, use the existing [`web:test:runtime` and `web:test:integration` harnesses](testing.md#web-foundation-checks) with their documented prerequisites. They build production Next.js servers against owned fixtures, not your persistent database or operator-managed model service. They do not establish real-provider readiness.

## 5. Back up, upgrade and recover

The stopped-file procedure below supports paired-copy inspection and upgrade rollback. It is not portable recovery with inert historical work: a raw database copy can resume retained jobs when agents are enabled. For portable backup and offline recovery, use [Backup and restore](backup-restore.md), including its [standalone restore command](backup-restore.md#standalone-offline-installation). Protect backup copies like the original library, including rejected material.

1. Stop the web service, then the daemon, and verify both have exited cleanly before copying data or changing the active release:
   ```sh
   systemctl --user stop thoughtloom-web.service thoughtloom-daemon.service
   ```
2. Back up the SQLite database and any SQLite sidecars **with its matching media directory**, including `store.json`, originals and private subdirectories, as one stopped set. The media directory defaults to `<canonical-db-path>.media` unless `THOUGHTLOOM_MEDIA_DIR` selects another absolute location; do not assume it is inside the database directory. Preserve the service UID and private modes. Protect backups like the original data, and retain the previous release identifier and private configuration securely. Copying a live database file alone is not supported. Follow the [paired media backup/restore procedure](server-startup.md#paired-media-backup-and-restore).
3. Prepare and validate the new release using step 1 above. Keep credentials and the database path unchanged. Update unit paths if switching release directories, and run `systemctl --user daemon-reload` after changing units.
4. Start the daemon, check startup/migration success, then start the web service and repeat the deployment checks.

The daemon applies schema migrations at startup. Do not assume an old binary can read a newly migrated database. If recovery requires rollback, stop both services and restore a matching pre-upgrade database/media set and release together, preserving the failed state for investigation. Keep shared absolute media paths stable for saved model inputs; first verify relocated copies without agents. Restoring a backup loses writes made after that backup; do not overwrite newer data without deciding how to preserve it. Exercise restore procedures separately with a copy before relying on a backup.

Never reset or replace a database while the daemon is running. Restart services after configuration changes; do not rerun the test setup helper to rotate production credentials or repair deployment configuration.
