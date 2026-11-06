# Server startup

[Start here](../README.md) · [Daemon API](daemon-api.md) · [Testing](testing.md)

The daemon is a Hono application running on Bun with SQLite storage. It listens only on `127.0.0.1`. The separate Next.js/React client provides Capture, Explore, Idea, Evolve and Export as described below. Optional agents attach to an existing operator-managed OpenCode service; Thoughtloom does not start that service.

## Install

Install [Bun](https://bun.sh), then run from the project root:

```sh
bun install --frozen-lockfile
```

Use the committed lockfile. SQLite support comes from Bun's built-in `bun:sqlite`; a separate database server is not required.

### Web client foundation

For a quick local trial, `bash scripts/setup-test.sh` generates matching private launchers. Start `scripts/daemon.local.sh` in one terminal and `scripts/web.local.sh` in another, then open `http://127.0.0.1:3000/capture`. Setup does not start services or reset the database. Its daemon uses real agent configuration, so queued work and site actions can incur model charges. See [rough local setup](testing.md#rough-local-agent-setup) for configuration and the optional smoke test. The manual commands below remain available.

The root install includes the `apps/web` Bun workspace and uses the same committed lockfile. Start the web development server from the project root:

```sh
bun --no-env-file run web:dev
```

For the production client:

```sh
bun --no-env-file run web:build
bun --no-env-file run web:start
```

`web:start` is the production server command, not a development server; no separate `web:prod` alias is required. For persistent configuration, process supervision, backups and upgrades, follow [Production deployment](production-deployment.md).

Dev and production listeners bind to `127.0.0.1`; the default web origin is `http://127.0.0.1:3000`. Open that exact origin. Capture is available at `/capture` and search at `/explore`. The daemon is started separately; starting the web client does not launch the daemon or OpenCode.

| Web server variable | Default / purpose |
| --- | --- |
| `THOUGHTLOOM_WEB_ORIGIN` | `http://127.0.0.1:3000`; the single trusted browser origin and Host. Accepts loopback HTTP(S) or an explicitly configured remote HTTPS origin, without credentials, paths, queries or fragments. |
| `THOUGHTLOOM_DAEMON_URL` | `http://127.0.0.1:3001`; server-only daemon origin. Only loopback HTTP(S) origins are accepted, without embedded credentials, paths, queries, or fragments. |
| `THOUGHTLOOM_USER_TOKEN` | The daemon's user-role bearer credential, validated when the server transport is used. Never expose it through a `NEXT_PUBLIC_*` variable. |
| `THOUGHTLOOM_IMPORT_MAX_BYTES` | Maximum bytes in one imported file, default `1048576` (1 MiB). Set consistently for the web server and daemon; this is a transport safeguard, not a segmentation or model-effort setting. |

Export these variables in the launching shell. Next.js has its own application environment-file handling; Bun's `--no-env-file` flag is not a guarantee that Next.js will ignore such files. Keep all daemon credentials server-only. The web client does not need the daemon's AI token, database path, or agent configuration. It does not make direct browser-to-daemon requests. Server requests reject redirects, use bounded timeouts and `no-store`, and sanitize failures. The web request boundary rejects untrusted Host values and missing or foreign Origin values on mutations; forwarded headers do not establish trust.

For private Tailscale Serve access, set `THOUGHTLOOM_WEB_ORIGIN=https://gsai.raptor-piranha.ts.net` (using your actual HTTPS hostname), and configure Serve to proxy to the loopback web port while preserving the original Host. HTTPS and tailnet access must be controlled externally. The application has no built-in login; origin checks are not authentication. Do not enable Funnel or otherwise expose it publicly. See [production deployment](production-deployment.md) for the boundary. Use Ctrl-C to stop either web process without stopping the independently running daemon.

Next.js development incoming-request logging is disabled in `apps/web/next.config.ts`: search and bookmarked page URLs contain private query text. This does not disable application diagnostics or critical-error logging. Do not re-enable request-URL logging to debug searches; server transport diagnostics intentionally omit query strings and content.

### Capture workflow

Enter thought text and an optional title, then Save. The browser calls the fixed Next.js `POST /api/capture` route; that server forwards only capture fields to daemon `POST /thoughts`. Identity and other defaults remain daemon-owned. A confirmed canonical `201` receipt enables Saved and Capture another; it does not wait for background weaving. Open idea uses the returned ID to open `/ideas/<id>`.

Pending submission prevents repeated saves and retains the submitted text/title. Known pre-creation rejection allows deliberate Retry save. A timeout, dropped response, unexpected server failure, or invalid receipt instead shows **Not sure it saved**: the thought may already exist. No write is automatically replayed. The retained snapshot stays copyable; **Save another copy** is an explicit new capture with a duplicate warning. Opening Explore in a new tab is navigation, not confirmation of the original save.

Drafts and recovery snapshots are held in mounted application memory, including return from Import. There is no application-managed reload/session persistence, offline queue, or autosave guarantee; keep an uncertain draft open. Capture another clears the form after a successful save. Neither UI diagnostics nor server logs include thought content or credentials.

### Markdown import workflow

Choose **Import** beside the Capture heading to open `/import`. Choose Markdown files, then explicitly start the import; selecting files alone sends nothing. Invalid local files are marked **Not sent** and excluded from admitted totals. Each admitted file reports its own state, so a failed file does not stop the others. AI grouping and successful structural fallback both preserve the original wording; empty or metadata-only files may import with zero thoughts.

Reports use `/import?batchId=<id>` and can be bookmarked or reopened through **Recent imports**. Inspect source deliberately opens the retained original for the user, not an extra AI-readable thought. Eligible imported thoughts open the normal Idea view. Identical files are skipped; changed files at known paths leave the existing import untouched.

An uncertain admission is not permission to upload another copy. If batch admission is uncertain, no batch ID is confirmed; check Recent imports. If file admission is uncertain, the batch is known but a file ID may not be: keep the mounted workspace, which retains the submitted bytes and key, and check the report. For a known file or run, check that same identity. No replacement request is sent automatically. Stop applies to a known import run, not the whole batch. Leaving the page does not cancel admitted work. Unsent selections and in-flight browser recovery state are not persisted across reloads.

The browser uses fixed `/api/imports/...` Next routes, which attach credentials server-side and forward to the existing daemon import and inspection APIs. Uploads are bounded before multipart parsing; malformed upstream success reports remain unconfirmed rather than becoming successful imports in the UI.

When changing the import byte limit, provide it when building and starting the web server as well as starting the daemon. Next's proxy buffer allows the configured file size plus 4 KiB of metadata and 64 KiB of multipart framing, or its existing 10 MiB default when larger. The import boundary still enforces the individual file limit. This framework buffer is per request, not a global memory budget.

### Explore workflow and bookmarks

Explore starts with a query, not a recent-thought feed. The browser uses fixed Next.js `GET /api/search`; the daemon owns retrieval, result ordering, counts and context. Author/kind filters, UTC dates, relevance/newest/oldest sorting and inclusive Show rejected are supported. Expand a snippet to read the actual matching text. Retained replies remain distinct results even when they open the same thought as another match.

Search URLs are bookmarkable, for example:

```text
/explore?q=connections&author=ai&kind=developing-idea&sort=newest
```

Opening a valid search URL in a fresh page or reloading initializes its query, filters, date bounds, sort and scope. Search terms are consequently visible in browser history and bookmarks; credentials and result bodies are not embedded in these links. In-app return also preserves result expansion and scroll using per-browser memory, not a shared server cache or persistent result store. Clear filters keeps the query and sort. Narrow screens expose the same refinements through Filters, with Close/Escape and focus return.

Show rejected includes active and rejected results. Thought badges use existing user inspection reads; failed inspection is **Status unknown**, not proof that a result is active or rejected. Replies are not independently rejectable thoughts. Surrounding context remains the daemon's active-only projection. Loading, empty and failed searches are distinct; failures retain the query/selections and offer deliberate retry. Newer searches cannot be replaced by stale responses.

Thought and response links target `/ideas/<id>`, preserving a known response ID and validated local Explore return state where applicable. Rejected inspection intent is carried by that validated return state; it must not become an AI access bypass.

### Idea reading and changes

Direct `/ideas/<id>` bookmarks load the normally visible thought without requiring previous browser state. Optional `responseId` selects only a reply associated with that focused thought. A validated local Explore `returnTo` preserves search state and deliberate Show rejected intent; explicit user inspection scopes are also supported. Invalid or external return targets do not broaden access or redirect outside the app. The contextual header Back arrow follows the previous viewed thought when available, otherwise the preserved Explore results; it is not the evolution parent or blind browser history. Evolve and contextual Export keep their route-return destinations in the same header control. The parent-title link and Export's Back to setup remain separate content actions. Explore and Capture have no invented contextual Back destination.

Thought text, authorship and ancestry are not editable. Edit title and Clear title change separate metadata; clearing permits later generation without promising when it will happen. The immediate parent is a separate visible title link based on `parentId`, not browsing history or an ancestor walk. Surrounding Context includes direct children (including AI interpretations), discovered connections and the focused thought's provenance sources. Each other thought appears once with all applicable relationship labels and connection-specific actions. There is no catch-all History or overlapping Sources disclosure. Full reply and connection rationale remain on demand. Ordinary unavailable sources/parents never silently fall back to broader access; rejected material still requires deliberate user inspection. Response links cannot fetch an unrelated reply by bypassing the focused thought's associations.

More actions contains contextual export and rejection/restoration controls. Evolve is unavailable for rejected ideas. Individual idea rejection leaves descendants active. Connection restoration applies only to explicitly rejected connections, not links merely hidden because an endpoint is rejected. Restoring an idea or branch does not restore independently rejected connections.

Branch rejection uses the daemon's exact preview and affected count. If confirmation returns `409`, the dialog invalidates the old confirmation, loads a fresh preview, and requires another explicit confirmation. It never automatically repeats the destructive request. Branch restoration uses the existing bodyless operation, without an invented count/preview. Only confirmed command responses show success. Pending changes prevent duplicate submissions and keep their original target; unknown write outcomes stay unconfirmed without automatic replay or false success.

### Evolve workspace

`/evolve?thoughtId=<id>` opens a fresh workspace for a normally visible thought. Loading or reloading the page does not send a contribution, resume an earlier run, or stop daemon work. In-app browsing and return retain the mounted workspace's draft, known run references and continuation choice. Explicitly choosing Evolve from an earlier Idea starts from that selected thought instead. This is browser memory, not persistent conversation storage: reload loses that workspace without canceling durable daemon work.

Send submits only the contribution text against the selected continuation. A canonical admission records the user contribution and establishes the known run ID; it is not a completed development. The workspace observes that run and separates recorded developments from its retained reply. Change selects an actual saved continuation; Open idea only browses. Complete fallback replies can use their associated contribution as the development, while interrupted fallback replies do not become continuation points.

Unconfirmed admission retains its submitted snapshot without automatic resend or guessed run lookup. A failed status read does not mark the run failed. Temporary output/reply read errors retain previously confirmed display text with a warning, but unconfirmed points cannot be used for Send until checked successfully. Confirmed normal-scope unavailability removes those records; Change still permits deliberate selection of a remaining eligible thought. Check this run observes a known ID; Stop uses the daemon's existing stop operation and retains saved output and the next draft. An unconfirmed Stop is not proof of cancellation, and leaving the page is not Stop. All input/output reads remain normal-scoped; unavailable records do not silently fall back to rejected-history inspection. Model configuration remains daemon-side, with no client effort or model selector for Evolve.

### Export workspace

Idea's contextual Export action opens `/export?thoughtId=<id>`. Simple uses that read-only, normally visible root plus a positive whole count and breadth/depth traversal. A missing or unavailable root disables only Simple; Agentic remains independent. Simple previews the actual returned Markdown and downloads those same bytes as `thoughtloom-simple.md`, without another export request.

Agentic takes a request and Quick/Standard/Thorough effort, not Simple's tree restrictions or model/cost limits. After confirmed admission its submitted request and effort stay read-only, with a known run ID for Check and Stop. Back to setup and in-app return retain mounted work; a fresh page or reload starts setup without replaying, resuming or stopping daemon work. Missing configuration means no report started; unknown admission is not silently resubmitted. Observation or Stop errors preserve the last real status. Leaving is not Stop, and Stop does not promise immediate native cancellation.

Completed status is not enough for **Report ready**: the report must also be read successfully. Interrupted/failed work has no invented partial report. A transient artifact error does not replace an already read report with substitute content. Download saves the received artifact bytes as `thoughtloom-report.md` without requesting another report.

Both previews format Markdown without active body links, external images or raw HTML. Local Idea links come only from the producer-appended Sources block after normal-scope identity checks. Later-rejected or unavailable sources do not fall back to history; source attribution is not endorsement. These display checks never rewrite the downloaded Markdown or make historical reports eligible agent context.

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
| `THOUGHTLOOM_LOG_LEVEL` | No | `error`, `warning`, `info` (default), or `verbose`; case-insensitive. Controls daemon diagnostics. |
| `THOUGHTLOOM_IMPORT_MAX_BYTES` | No | Positive safe integer, default `1048576` (1 MiB): maximum bytes in one uploaded file. Invalid values fail startup without echoing the value. |

The server's bind address is not configurable: it is `127.0.0.1`, not all interfaces. Loopback binding does not replace authentication.

Import uploads additionally allow at most 4 KiB of UTF-8 metadata and 64 KiB of multipart framing/headers; the streamed aggregate is bounded before parsing. At most two upload receivers buffer concurrently; another receives `503` and `Retry-After`. Configure any future server-side proxy to allow the file bound plus those overheads without truncating bytes. These are transport/capacity bounds, not vault file-count, model-turn, token, or cost quotas. Parsing remains in-process. Parser memory depends on content and runtime; the byte default is not a proven parser memory bound and provides no hard memory or latency guarantee.

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

For a rough local test, [the setup helper](testing.md#rough-local-agent-setup) generates matching private launchers from explicit configuration or defaults to `openai/gpt-6.1-sol`, with `low`, `medium`, and `high` variants for quick, standard, and thorough effort. These are helper defaults, not a daemon model fallback.

`service: {"discover": true}` attaches only to an already-running managed service and preserves its authentication headers, including Basic authentication. It never starts, stops or upgrades the service. Alternatively, use `service: {"url": "<service-url>", "token": "<optional-bearer-token>"}` for an explicit endpoint; omit `token` when not needed. Keep this setting server-side and out of commits or browser code. Credentials are not stored in run bindings or diagnostic errors.

Unknown fields, invalid values or a non-absolute directory produce a sanitized configuration error. Absence of this setting preserves capture, reads, search and Simple export. Capture and user title-clear on eligible active notes still persist queued weave jobs; they do not create native bindings or invoke a model without agent configuration. Clearing a rejected note's title does not invite agent work. Explicit Evolve and Agentic export requests return `503` before admission when configuration is absent.

Without agent configuration, a local import driver processes admitted Markdown files using the lossless parser and structural grouping with reason `ai-unconfigured`. Empty/metadata-only sources use `not-needed` and create no thoughts or weave jobs. Each successful file and its ordinary weave admissions commit together; those weave jobs remain queued without an agent and do not hold file/batch completion open. Duplicate waiters are rechecked locally. Local processing creates no new native binding, invokes no model or operator service, and fabricates no native completion. Source artifacts remain user-only. The [import and source-inspection HTTP routes](daemon-api.md#markdown-import-and-source-inspection) also serve the web import workspace through its Next.js boundary.

With agent configuration, admitted novel Markdown files use a separate restricted import worker on the same managed service and configured `standard` model/variant. Its fresh session denies all native tools, advertises no library capabilities and receives only its own exact document, parser manifest and fixed segmentation instructions. The worker persists preparation, binding and submission intent before sending the one initial prompt. Valid terminal output selects AI grouping; owned terminal failure selects structural `ai-failed`, and completed invalid/empty/non-stop output selects `ai-invalid`. Proven pre-submission service unavailability selects `ai-unavailable`; lost acknowledgement, active work, incomplete history or an outage after intent remains observation-only with the same session/prompt. The import workspace reports the resulting file states without changing these daemon rules.

With configuration present, the supervisor processes queued work and may invoke the selected model, including jobs retained from earlier runs. Weave and Evolve use the `standard` variant mapping. Agentic export uses the immutable request's `quick`, `standard` or `thorough` mapping. Attachment is lazy and does not delay daemon readiness. Unavailable discovery or transport does not roll back successful capture or invent a completed result. The application follows durable native session/prompt identities after uncertain acknowledgements rather than blindly resubmitting.

Weave instructions direct the model to search existing thinking based on the subject's claims, themes and implications, fully read promising candidates, and propose warranted, explained connections. Search snippets are not evidence; initial-context thoughts are already read, and connection reads do not read their endpoints. Discovery and semantic quality are not guaranteed: no findings is valid. Scoped access and full-read checks enforce eligibility, not the meaning of a proposed relationship.

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

## Logging

`THOUGHTLOOM_LOG_LEVEL` sets the diagnostic threshold:

| Level | Includes |
| --- | --- |
| `error` | Unexpected or terminal failures. |
| `warning` | Errors and recoverable warnings, such as service unavailability. |
| `info` | Warnings/errors plus captures and meaningful work/lifecycle changes. This is the default. |
| `verbose` | All of the above plus routine polling, reads and boundary diagnostics. |

Successful idle polling does not produce Info messages. Invalid configured levels fail startup with a sanitized configuration error. Thought contents, credentials and raw sensitive exceptions are not diagnostic payloads, even at Verbose.

```sh
THOUGHTLOOM_LOG_LEVEL=verbose bun run daemon
# Or, with a generated test launcher:
THOUGHTLOOM_LOG_LEVEL=warning scripts/daemon.local.sh
```

Restart the daemon to change its configured level. Each daemon instance owns its logger and threshold; the setting does not alter the operator's OpenCode service logging. The successful startup readiness JSON below remains unconditional because it is a protocol notification used to discover the listening URL, not a filtered diagnostic. API helper results and exported Markdown are also unaffected.

## Startup and readiness

Startup validates configuration before opening the database or listener, creates the database directory, runs the [schema migration](database-schema.md#migrations), and wires the domain services into Hono.

Core migration includes search indexes, shared responses, durable run steps, capability results and bindings. One daemon-owned technical timer drives independent bounded queues: at most four import file ticks and eight ordinary run ticks are in flight. These are service concurrency limits, not model-effort or batch-size quotas. Finite membership high-water marks and ordered cursors prevent a growing vault from extending one scan forever; free slots can advance while another native call waits. The import driver rechecks up to fifty waiters before and after each scan and settles proven local cancellation separately. Parsing and native calls run outside SQL transactions. Without agent configuration, import processing remains local and ordinary weave jobs stay queued.

Imports retain the existing run/step journal, exact private prepared input and write-once partition/evidence choice. A local choice leaves the step `prepared`, native state `unknown` and envelope absent, while finalization completes the run. Genuine terminal completion records native completion even for invalid output; terminal failure retains the last unknown/running native fact rather than fabricating successful completion. Restart resumes a saved partition without discovery, private-input re-exposure or another model call. Without agent configuration, a bound import can also resume structural processing when its retained initial input and queued/prepared/unknown journal prove that no submission intent was recorded. The binding remains historical metadata, not proof of dispatch; this path needs no native cleanup call. Submitted or ambiguous native histories without a saved choice are never reinterpreted as never submitted. Native cancellation pending after choice survives successful file completion and is settled independently; cancellation outages do not undo the source. Logs include safe identities, counts and outcomes, never source text, frontmatter, paths, private prepared inputs or provider exceptions.

Each import worker retains at most four genuine, frozen parser preparations, keyed to its claim generation, file, current prompt and exact input/source fingerprints. Entries contain manifest/fallback data, not an AST, source buffer or native history. Submitted jobs authorize and observe their persisted prompt before any parsing; pending/running/uncertain observations do not parse or refill evicted entries. Terminal selection reuses a matching preparation or parses once to restore it and checks the complete immutable saved job. Unchanged pre-dispatch retries use fixed-size verified-input metadata without reparsing, even after proof-cache eviction. Neither cache nor metadata replaces storage ownership, source-byte or native-history checks. Durable choice, settlement, observed Stop/claim loss and pause/shutdown release preparations; bounded metadata scans also clean up runs settled elsewhere. A stale claim remains only as lightweight live-run metadata to prevent this worker reclaiming a successor generation; no closed-run fenced-ID set is retained. These optimizations add no process isolation, forced garbage collection or model quota.

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

Use Ctrl+C or send SIGTERM. The entrypoint handles SIGINT and SIGTERM, pauses/drains agent or local import work and stops the listener before closing SQLite. The local driver yields between bounded work phases, cancels its timer before drain, and performs no further durable transition after pause. Local shutdown is not user Stop: it does not undo saved work or request native cancellation merely because the daemon is leaving. Restart reconciles existing identities and resumes eligible local imports. Repeated stop requests do not repeat cleanup; cleanup continues after individual errors. A shutdown failure produces a sanitized error and nonzero exit status.

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

The browser client communicates through the Next.js server, never directly with the daemon. Both bearer credentials remain server-side. They represent service roles, not a multiuser account system. The API does not enable permissive browser CORS access.

Implementation: [`config.ts`](../src/daemon/config.ts), [`runtime.ts`](../src/daemon/runtime.ts), and [`main.ts`](../src/daemon/main.ts).
