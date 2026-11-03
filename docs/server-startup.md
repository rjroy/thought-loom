# Server startup

[Start here](../README.md) · [Daemon API](daemon-api.md) · [Testing](testing.md)

The current server is a Hono application running on Bun with SQLite storage. It listens only on `127.0.0.1`. There is no visual client or OpenCode connection to start alongside it yet.

## Install

Install [Bun](https://bun.sh), then run from the project root:

```sh
bun install --frozen-lockfile
```

Use the committed lockfile. SQLite support comes from Bun's built-in `bun:sqlite`; a separate database server is not required.

## Configure

| Variable | Required | Meaning |
| --- | --- | --- |
| `THOUGHTLOOM_USER_TOKEN` | Yes | User-role bearer credential; at least 32 characters after trimming surrounding whitespace. |
| `THOUGHTLOOM_AI_TOKEN` | Yes | AI-role bearer credential; at least 32 characters after trimming surrounding whitespace and different from the user token. |
| `THOUGHTLOOM_DB_PATH` | Yes | SQLite database path. Parent directories are created after configuration validation. An absolute path avoids working-directory surprises. |
| `THOUGHTLOOM_PORT` | No | Integer from `0` through `65535`; default `3001`. `0` selects an available ephemeral port. |

The server's bind address is not configurable: it is `127.0.0.1`, not all interfaces. Loopback binding does not replace authentication.

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

Core migration includes shared responses and durable run tables. Storage support does not mean a worker is running: automatic weaving, native OpenCode execution, job supervision and public run endpoints are not integrated yet. Starting the current daemon does not submit model work.

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

Use Ctrl+C or send SIGTERM. The entrypoint handles SIGINT and SIGTERM, stops the listener, then closes SQLite. Repeated stop requests do not repeat cleanup. A shutdown failure produces a sanitized error and nonzero exit status.

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
