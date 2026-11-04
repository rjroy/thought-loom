# Server startup

[Start here](../README.md) · [Daemon API](daemon-api.md) · [Testing](testing.md)

The server is a Hono application running on Bun with SQLite storage. It listens only on `127.0.0.1`. There is no visual client yet. Optional agents attach to an existing operator-managed OpenCode service; Thoughtloom does not start that service.

## Install

Install [Bun](https://bun.sh), then run from the project root:

```sh
bun install --frozen-lockfile
```

Use the committed lockfile. SQLite support comes from Bun's built-in `bun:sqlite`; a separate database server is not required.

### Native spelling extension

The internal spelling-suggestion service uses SQLite's public-domain spellfix1 extension. Build it locally with:

```sh
bun run build:spellfix
```

The build verifies the vendored source hash, then invokes `${CC:-cc}` with `-O2 -fPIC -shared`. It requires Bash, `sha256sum`, a C compiler and compatible SQLite extension headers (`sqlite3ext.h` and `sqlite3.h`). The current build is verified on Linux x86_64; other platforms require their own compatibility validation. It does not install a system extension or link a second SQLite runtime.

The generated `build/sqlite/spellfix.so` is ignored by Git. Rebuild it for the target environment. Source is pinned to SQLite revision `6932c59ee5c280599dfae9e7b431698a7cab9687`; the build script records its URL and SHA-256.

Loading is lazy when spelling support is requested, not part of daemon readiness or exact/prefix FTS5 retrieval. Search can request it when the original query has no scoped hits. A missing or incompatible artifact fails internally with: `Unable to load spellfix1; run bun run build:spellfix and verify compatible SQLite headers and runtime`. HTTP callers receive a sanitized `500`. There is no alternate fuzzy-search fallback. Build the extension before testing typo-tolerant [public search](daemon-api.md#search-get-search).

## Configure

| Variable | Required | Meaning |
| --- | --- | --- |
| `THOUGHTLOOM_USER_TOKEN` | Yes | User-role bearer credential; at least 32 characters after trimming surrounding whitespace. |
| `THOUGHTLOOM_AI_TOKEN` | Yes | AI-role bearer credential; at least 32 characters after trimming surrounding whitespace and different from the user token. |
| `THOUGHTLOOM_DB_PATH` | Yes | SQLite database path. Parent directories are created after configuration validation. An absolute path avoids working-directory surprises. |
| `THOUGHTLOOM_PORT` | No | Integer from `0` through `65535`; default `3001`. `0` selects an available ephemeral port. |
| `THOUGHTLOOM_AGENT_CONFIG` | No | Server-only JSON agent configuration described below. Omit it to use ordinary daemon features without agent configuration. |

The server's bind address is not configurable: it is `127.0.0.1`, not all interfaces. Loopback binding does not replace authentication.

### Agent configuration

OpenCode integration uses this explicit configuration shape:

```json
{
  "service": {"discover": true},
  "directory": "/absolute/operator-approved/workspace",
  "model": {"providerID": "<provider-id>", "id": "<model-id>"},
  "effort": {"quick": null, "standard": null, "thorough": null}
}
```

Set the serialized JSON in `THOUGHTLOOM_AGENT_CONFIG`; placeholders above are not runnable model choices. All fields and all three effort entries are required when configuring agents. Variant entries are model-specific strings or explicit `null` for that model's default variant. There are no universal `low`/`high` names or application turn, token, cost, search-count or note-count quotas. No model is selected from the catalog automatically.

`service: {"discover": true}` attaches only to an already-running managed service and preserves its authentication headers, including Basic authentication. It never starts, stops or upgrades the service. Alternatively, use `service: {"url": "<service-url>", "token": "<optional-bearer-token>"}` for an explicit endpoint; omit `token` when not needed. Keep this setting server-side and out of commits or browser code. Credentials are not stored in run bindings or diagnostic errors.

Unknown fields, invalid values or a non-absolute directory produce a sanitized configuration error. Absence of this setting preserves capture, reads, search and Simple export. Capture and user title-clear on eligible active notes still persist queued weave jobs; they do not create native bindings or invoke a model without agent configuration. Clearing a rejected note's title does not invite agent work. Explicit Evolve and Agentic export requests return `503` before admission when configuration is absent.

With configuration present, the supervisor processes queued work and may invoke the selected model, including jobs retained from earlier runs. Weave and Evolve use the `standard` variant mapping. Agentic export uses the immutable request's `quick`, `standard` or `thorough` mapping. Attachment is lazy and does not delay daemon readiness. Unavailable discovery or transport does not roll back successful capture or invent a completed result. The application follows durable native session/prompt identities after uncertain acknowledgements rather than blindly resubmitting.

Bindings retain the selected location/model/variant and endpoint, not credentials. Changing model configuration does not rebind existing runs. If the currently resolved endpoint differs from a persisted binding, that run remains unavailable rather than receiving the new endpoint's credentials. Resolve the service mismatch before expecting recovery.

All model context comes from scoped Thoughtloom reads. Native deny permissions are defense in depth, not a universal sandbox for operator plugins or policies. Use a trusted service and approved workspace. Already-sent context cannot be withdrawn retroactively; rejection fences further application reads, submissions, writes and publication, with best-effort native interruption.

For a disposable local run:

```sh
export THOUGHTLOOM_USER_TOKEN="$(bun -e 'console.log(crypto.randomUUID())')"
export THOUGHTLOOM_AI_TOKEN="$(bun -e 'console.log(crypto.randomUUID())')"
export THOUGHTLOOM_DB_PATH="$PWD/.data/thoughtloom.sqlite"
export THOUGHTLOOM_PORT=3001
bun run daemon
```

These assignments generate distinct credentials for this shell session. Store them securely if you need to reuse them. Do not put them in browser code, commits, diagnostic output, or world-readable launch scripts.

If you create a launcher, have it change to the project root before calling `bun run daemon`. Otherwise, Bun may not find this project's package script. Quote paths and variable expansions in shell scripts.

## Startup and readiness

Startup validates configuration before opening the database or listener, creates the database directory, runs the [schema migration](database-schema.md#migrations), and wires the domain services into Hono.

Core migration includes search indexes, shared responses, durable run steps, capability results and bindings. Without agent configuration, no worker submits model work. With it, one owned supervisor drives queued/active work and pending cancellation settlement through the existing service.

A successful startup emits a lifecycle event containing the bound URL, for example:

```json
{"phase":"outcome","operation":"start","success":true,"url":"http://127.0.0.1:3001/"}
```

For port `0`, use the URL from the readiness event rather than assuming a port number. HTTP requests must carry the appropriate server credential; see [authentication](daemon-api.md#authentication).

Back up a database you care about before upgrading. Existing titles migrate into separate metadata automatically. Tests exercise migrations using isolated databases, never your configured database.

## Connect a manual client

In the client shell, set the daemon URL and the same role credential used at startup:

```sh
export THOUGHTLOOM_DAEMON_URL=http://127.0.0.1:3001
# THOUGHTLOOM_USER_TOKEN must match the running daemon.
bun run api --role user GET /thoughts
```

`THOUGHTLOOM_DAEMON_URL` is a setting for the helper script, not a daemon bind setting. Setting tokens in a child setup script does not export them back into its parent shell; use a securely configured client shell or launcher with matching values.

See [manual requests](daemon-api.md#manual-requests) for capture and title examples, or run the [isolated walkthrough](testing.md#isolated-walkthrough) without configuring a persistent daemon.

## Stop and restart

Use Ctrl+C or send SIGTERM. The entrypoint handles SIGINT and SIGTERM, pauses/drains agent work and stops the listener before closing SQLite. Local shutdown is not user Stop: it does not undo saved work or request native cancellation merely because the daemon is leaving. Restart reconciles existing identities. Repeated stop requests do not repeat cleanup; cleanup continues after individual errors. A shutdown failure produces a sanitized error and nonzero exit status.

Restart after changing code, credentials, or startup configuration. There is no hot-reload process configured by `bun run daemon`.

For disposable data, stop the daemon before replacing or removing its database. Never reset data while the server is using it.

## Failure diagnostics

Known configuration errors name the field and expected format without echoing the supplied value. For example, accidentally assigning a database path to the port produces:

```json
{"operation":"start","phase":"outcome","success":false,"message":"THOUGHTLOOM_PORT must be an integer from 0 to 65535"}
```

Other common checks:

- Missing or short tokens: configure the named token with at least 32 characters after trimming surrounding whitespace.
- Equal tokens: assign separate user and AI credentials.
- Missing database path: set `THOUGHTLOOM_DB_PATH` to the intended location.
- Generic `Daemon startup failed`: check whether the port is occupied and the database directory is accessible. Unexpected exception text is intentionally not exposed.
- Client `401`: the token is absent or does not match the running daemon; generating another token in a different shell does not update the daemon.

Lifecycle and request boundaries emit attempt/outcome events. Do not add full configuration dumps or request bodies to logs to diagnose failures; they can contain credentials or thought content.

## Browser boundary

The future browser client will communicate through the Next.js server, never directly with the daemon. Both bearer credentials remain server-side. They represent service roles, not a multiuser account system. The API does not enable permissive browser CORS access.

Implementation: [`config.ts`](../src/daemon/config.ts), [`runtime.ts`](../src/daemon/runtime.ts), and [`main.ts`](../src/daemon/main.ts).
