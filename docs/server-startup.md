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

Dev and production listeners bind to `127.0.0.1`; the default web origin is `http://127.0.0.1:3000`. Open that exact origin. An explicit `/` arrival shows the approved 2.4-second constellation intro, dissolves into real Explore, then replaces the root history entry with `/explore` (restoring a remembered search URL when present). **Skip intro** or Escape bypasses it; reduced motion navigates without the animated delay. Without JavaScript, **Open Explore** remains a normal link. Direct `/explore`, Capture at `/capture` and deep links do not show the intro. The daemon is started separately; starting the web client does not launch the daemon or OpenCode.

| Web server variable | Default / purpose |
| --- | --- |
| `THOUGHTLOOM_WEB_ORIGIN` | `http://127.0.0.1:3000`; the single trusted browser origin and Host. Accepts loopback HTTP(S) or an explicitly configured remote HTTPS origin, without credentials, paths, queries or fragments. |
| `THOUGHTLOOM_DAEMON_URL` | `http://127.0.0.1:3001`; server-only daemon origin. Only loopback HTTP(S) origins are accepted, without embedded credentials, paths, queries, or fragments. |
| `THOUGHTLOOM_USER_TOKEN` | The daemon's user-role bearer credential, validated when the server transport is used. Never expose it through a `NEXT_PUBLIC_*` variable. |
| `THOUGHTLOOM_IMPORT_MAX_BYTES` | Maximum bytes in one imported file, default `1048576` (1 MiB). Set consistently for the web server and daemon; this is a transport safeguard, not a segmentation or model-effort setting. |

Export these variables in the launching shell. Next.js has its own application environment-file handling; Bun's `--no-env-file` flag is not a guarantee that Next.js will ignore such files. Keep all daemon credentials server-only. The web client does not need the daemon's AI token, database path, or agent configuration. It does not make direct browser-to-daemon requests. Server requests reject redirects, use bounded timeouts and `no-store`, and sanitize failures. The web request boundary rejects untrusted Host values and missing or foreign Origin values on mutations; forwarded headers do not establish trust.

For private Tailscale Serve access, set `THOUGHTLOOM_WEB_ORIGIN=https://gsai.raptor-piranha.ts.net` (using your actual HTTPS hostname), and configure Serve to proxy to the loopback web port while preserving the original Host. HTTPS and tailnet access must be controlled externally. The application has no built-in login; origin checks are not authentication. Do not enable Funnel or otherwise expose it publicly. See [production deployment](production-deployment.md) for the boundary. Use Ctrl-C to stop either web process without stopping the independently running daemon.

Include the external port in `THOUGHTLOOM_WEB_ORIGIN` when the browser URL uses one (for example, `https://host.example:3002`). In development, Next automatically allows that origin's exact hostname for its dev assets; no additional hostname setting is needed. Restart the web development server after changing its configuration. This Next development allowance does not replace the application's exact Host and mutation Origin checks or apply to production access control.

Next.js development incoming-request logging is disabled in `apps/web/next.config.ts`: search and bookmarked page URLs contain private query text. This does not disable application diagnostics or critical-error logging. Do not re-enable request-URL logging to debug searches; server transport diagnostics intentionally omit query strings and content.

### Capture workflow

Enter thought text and an optional title, then Save. The browser calls the fixed Next.js `POST /api/capture` route; that server forwards only capture fields to daemon `POST /thoughts`. Identity and other defaults remain daemon-owned. A confirmed canonical `201` receipt enables Saved and Capture another; it does not wait for background weaving. Open idea uses the returned ID to open `/ideas/<id>`.

Pending submission prevents repeated saves and retains the submitted text/title. Known pre-creation rejection allows deliberate Retry save. A timeout, dropped response, unexpected server failure, or invalid receipt instead shows **Not sure it saved**: the thought may already exist. No write is automatically replayed. The retained snapshot stays copyable; **Save another copy** is an explicit new capture with a duplicate warning. Opening Explore in a new tab is navigation, not confirmation of the original save.

Drafts and recovery snapshots are held in mounted application memory, including return from Import. There is no application-managed reload/session persistence, offline queue, or autosave guarantee; keep an uncertain draft open. Capture another clears the form after a successful save. Neither UI diagnostics nor server logs include thought content or credentials.

### Markdown import workflow

Choose **Import** beside the Capture heading to open `/import`. Choose Markdown files, then explicitly start the import; selecting files alone sends nothing. Invalid local files are marked **Not sent** and excluded from admitted totals. Each admitted file reports its own state, so a failed file does not stop the others. AI grouping and successful structural fallback both preserve the original wording; empty or metadata-only files may import with zero thoughts.

Reports use `/import?batchId=<id>` and can be bookmarked or reopened through **Recent imports**. Inspect source deliberately opens the retained original for the user, not an extra AI-readable thought. Eligible imported thoughts open the normal Idea view. Identical bytes are skipped across filenames; different bytes are imported even when ordinary selections share a filename. Only reliable known paths in non-loose namespaces receive changed-path protection.

An uncertain admission is not permission to upload another copy. If batch admission is uncertain, no batch ID is confirmed; check Recent imports. If file admission is uncertain, the batch is known but a file ID may not be: keep the mounted workspace, which retains the submitted bytes and key, and check the report. For a known file or run, check that same identity. No replacement request is sent automatically. Stop applies to a known import run, not the whole batch. Leaving the page does not cancel admitted work. Unsent selections and in-flight browser recovery state are not persisted across reloads.

The browser uses fixed `/api/imports/...` Next routes, which attach credentials server-side and forward to the existing daemon import and inspection APIs. Uploads are bounded before multipart parsing; malformed upstream success reports remain unconfirmed rather than becoming successful imports in the UI.

When changing the import byte limit, provide it when building and starting the web server as well as starting the daemon. Next's proxy buffer allows the configured file size plus 4 KiB of metadata and 64 KiB of multipart framing, or its existing 10 MiB default when larger. The import boundary still enforces the individual file limit. This framework buffer is per request, not a global memory budget.

### Conversational search

Explore's **Ask your library** opens `/explore/ask`; **Saved searches** opens `/explore/ask/saved`. Ordinary keyword Search remains separate and does not invoke an agent. **New search** explicitly creates an empty saved session and composing context, without calling a model. Sessions use `/explore/ask/<id>`; opening or refreshing a bookmark does not create a session or submit a turn. Use **Resume** to open a composing context when needed.

Send a message with Quick, Standard (default), or Thorough effort to investigate the existing library. Discoveries accumulate beside the conversation on desktop and in a disclosure on narrow screens. Preview reads an eligible idea; Open idea uses the normal Idea screen with a return link. Removing a discovery affects that occurrence only, not the library idea; a later investigation may rediscover it. **History** is a separate user-only view with no composer, not additional AI context.

Session actions include Edit title, Copy link and Delete. Delete removes the session's conversation and discoveries from Thoughtloom, not library thoughts, and does not promise erasure by OpenCode or a provider. Unsent drafts and reading position are retained in browser memory during in-app navigation, not promised across a full refresh or browser restart.

Queued or running searches expose Check and Stop for the known run. Leaving the page does not stop it. An uncertain admission retains a separate request snapshot; Check reconciles the original key rather than submitting another turn. Context changes block the old draft and offer an explicit new blank draft, without silently copying old context. Failed reads are not evidence that a search failed. Rejected material is unavailable in normal conversation, discoveries and previews.

The browser uses fixed Next.js search-session and search-run routes; credentials remain server-side. Requests carry the client's clock and matching time zone, while record timestamps remain daemon-owned. A pending admission retains its original request clock and identity for reconciliation. New model turns require configured daemon agents; saved-session reads and local management remain available without them.

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

Unknown fields, invalid values or a non-absolute directory produce a sanitized configuration error. Absence of this setting preserves capture, reads, search and Simple export. Capture and user title-clear on eligible active notes still persist queued weave jobs; they do not create native bindings or invoke a model without agent configuration. Clearing a rejected note's title does not invite agent work. Explicit Evolve, Agentic export and new agentic-search turn requests return `503` before admission when configuration is absent; search metadata/workspace operations, local Delete (including bound work), existing turn replay, by-key, Check and Stop remain available. Optional search HTTP clock headers use a bounded process-local receipt cache, forgotten on successful Delete and cleared after daemon drains on shutdown; they never determine database record timestamps. See the [turn/control API](daemon-api.md#turn-admission-and-control).

Without agent configuration, a local import driver processes admitted Markdown files using the lossless parser and structural grouping with reason `ai-unconfigured`. Empty/metadata-only sources use `not-needed` and create no thoughts or weave jobs. Each successful file and its ordinary weave admissions commit together; those weave jobs remain queued without an agent and do not hold file/batch completion open. Duplicate waiters are rechecked locally. Local processing creates no new native binding, invokes no model or operator service, and fabricates no native completion. Source artifacts remain user-only. The [import and source-inspection HTTP routes](daemon-api.md#markdown-import-and-source-inspection) also serve the web import workspace through its Next.js boundary.

With agent configuration, admitted novel Markdown files use a separate restricted import worker on the same managed service and configured `standard` model/variant. Its fresh session denies all native tools, advertises no library capabilities and receives only its own exact document, parser manifest and fixed segmentation instructions. The worker persists preparation, binding and submission intent before sending the one initial prompt. Valid terminal output selects AI grouping; owned terminal failure selects structural `ai-failed`, and completed invalid/empty/non-stop output selects `ai-invalid`. Proven pre-submission service unavailability selects `ai-unavailable`; lost acknowledgement, active work, incomplete history or an outage after intent remains observation-only with the same session/prompt. The import workspace reports the resulting file states without changing these daemon rules.

With configuration present, the supervisor processes queued work and may invoke the selected model, including jobs retained from earlier runs. Weave and Evolve use the `standard` variant mapping. Agentic export uses the immutable request's `quick`, `standard` or `thorough` mapping. Attachment is lazy and does not delay daemon readiness. Unavailable discovery or transport does not roll back successful capture or invent a completed result. The application follows durable native session/prompt identities after uncertain acknowledgements rather than blindly resubmitting.

Retained search turns admitted through the user-only HTTP/domain service have a configured-worker path on that same managed service. The immutable turn effort selects the configured variant; each user turn, including a clarification follow-up, gets its own deny-all native session. Initial input contains a bounded currently eligible SQL conversation and labeled frozen-client/current-daemon clock context, never copied native conversation. Exactly nine logical capabilities are advertised: `findThoughts`, `readThought`, `addDiscovery`, `relatedThoughts`, `readConnection`, `readResponse`, `readSearchConversation`, `listDiscoveries` and `normalizeTimeRange`. Requests reuse the run's existing native session across unique message IDs, with confirmed result/witness persistence before each exact successor input; strict search replies complete the turn without library writes. Context/time reads derive their session solely from the owned turn; time conversion uses an eligible retained user intent's original clock pair, not a model-supplied anchor. Connection/response reads and old conversation never grant thought full-read evidence. Exact prepared input is reused on retry.

Clock refresh now runs only when preparing a normal new model-bound input: always for the initial context, then strictly after an hour or a detected backwards-clock discontinuity. It never submits a clock-only prompt or rewrites a prepared/submitted one. The trusted optional `searchClock` dependency supplies injected monotonic time and a synchronous same-session latest client-observation lookup; defaults are `performance.now()` and the retained reported sample, not a fabricated live browser time. Daemon wall time still comes from the worker's existing `now` source. Used clock metadata is retained in exact step input, with a bounded metadata-only lifecycle cache and SQL clock-metadata recovery on cache miss/restart. No new configuration variable, provider permission or clock tool is added. See the [clock dependency and persistence contract](database-schema.md#initial-configured-search-runtime).

Search-session metadata, workspace, turn/control and Delete HTTP routes are available through the [conversational search client](#conversational-search), including browser clock forwarding. Runtime exclusivity, setup/submission provenance, retained Stop/rejection cleanup and controller-backed local retention use the sidecar/registry below. The existing configured supervisor also scans purged cleanup metadata. Authorized search cancellation stays pending until its own joined-flight/positive-terminal proof succeeds, never through ordinary cancellation settlement. The default internal no-controller session facet still refuses bound/possibly dispatched deletion. The daemon installs the actual local owner's controller in both configured and configless modes; local purge neither waits for nor certifies remote settlement. Broader recovery/race acceptance remains separate validation work.

Weave instructions direct the model to search existing thinking based on the subject's claims, themes and implications, fully read promising candidates, and propose warranted, explained connections. Search snippets are not evidence; initial-context thoughts are already read, and connection reads do not read their endpoints. Discovery and semantic quality are not guaranteed: no findings is valid. Scoped access and full-read checks enforce eligibility, not the meaning of a proposed relationship.

For captured URLs, Weaver follows the [captured intent](../.lore/context/url-weaving.md): summarize a bare URL, create separate sibling summaries for a bare list, or use contextual sources in a coherent interpretation. It is instructed to retrieve sources afresh through available permitted native/MCP tools, follow relevant references, preserve inline source links and never invent inaccessible content. Authenticated documents and Slack threads depend on operator-configured tool access; Thoughtloom does not install integrations or archive retrieved source snapshots. Successful summaries remain saved when another source is inaccessible. The final completed Weaver outcome is retained as a Full reply on the original capture and issued interpretations, including useful limitations or a no-findings result. These are probabilistic instructions and controlled application behavior, not a guarantee that a particular source can be retrieved or summarized correctly.

New Weaver and Evolve sessions allow all operator-configured native and MCP tools, including shell and filesystem operations, without a Thoughtloom approval step or per-tool allowlist. These tools may receive relevant thought context and cause external side effects. Agentic Export, Agentic Search and import segmentation retain deny-all native permissions. No new environment setting is required. Operator hard policies, unavailable tools or service-level hooks can still affect execution; Thoughtloom does not override or manage them.

Bindings retain the selected location/model/variant, endpoint and permission policy, not credentials. Changing configuration or upgrading the daemon does not rebind existing runs: an existing deny-bound Weaver/Evolve session stays denied, including on recovery. If the currently resolved endpoint differs from a persisted binding, that run remains unavailable rather than receiving the new endpoint's credentials. Resolve the service mismatch before expecting recovery.

Application-provided model context comes from scoped Thoughtloom reads. Permissive Weaver/Evolve tools can obtain additional context independently, including files accessible to the native process; this is a trusted operator environment, not a sandbox or a guarantee that native tools cannot reach rejected material. The application retains its rejection fences for scoped reads, submissions, writes and publication, with best-effort native interruption. Already-sent context cannot be withdrawn, and Stop cannot undo external effects. Restricted-role deny permissions are defense in depth, not a universal sandbox for operator plugins or policies. Use a trusted service and approved workspace.

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

Startup validates configuration, resolves/creates the supported database file, acquires its execution-owner lease, then opens the knowledge database, runs the [schema migration](database-schema.md#migrations), registers that lease's immutable owner record in a short transaction, and wires the domain services into Hono. Ownership and registration are required even without agent configuration, before worker construction, listener readiness or local import scheduling.

### Database execution ownership

The file-backed daemon currently supports Linux local filesystems with the SQLite POSIX locking behavior used here: ext2/3/4, XFS, Btrfs, tmpfs, overlayfs, ZFS and F2FS. Database paths are canonicalized through `realpath`; relative paths and symlink spellings of one file share its owner. The database must be a service-owned regular file with one hard link, not writable by other users, in a service-owned directory not writable by other users. New files are created with mode `0600`. Hard-linked files, individual-file bind mounts, network/unknown filesystem types, non-Linux runtime paths, SQLite URIs and `:memory:` daemon paths are rejected. Isolated `bun:sqlite` in-memory repositories/workers remain supported test boundaries; they are not a deployed runtime ownership bypass.

[`ExecutionOwnerLease`](../src/storage/execution-owner.ts) holds a private `<canonical-db-path>.execution-owner.sqlite` connection in rollback-journal `DELETE` mode with `busy_timeout=0` and an open `BEGIN EXCLUSIVE` for the runtime lifetime. This is **not** a lifetime transaction on the knowledge database: ordinary commands and separate knowledge-DB connections can still write. Same-process acquisition is reserved before a second sidecar handle opens; actual SQLite/VFS locks arbitrate other processes. The sidecar is service-owned mode `0600`, not a symlink or hard link. Keep it in place: do not unlink, rotate or replace a live lock file. Its presence alone does not mean an owner is alive, and no PID/heartbeat/timeout steals ownership. A hung owner stays exclusive; process death releases its OS locks.

**First rollout requires manually stopping/draining every pre-lease daemon before starting this version.** Old versions do not honor the new lock. No service is stopped or upgraded automatically. Do not replace/rename the database or sidecar beneath a running daemon. The capability checks their recorded device/inode identities and held transaction; detected changes poison native execution rather than silently reacquiring ownership. Native calls check this lifetime fence around asynchronous boundaries, including existing cancellation calls; their run/import authority and permissions remain separate and unchanged.

A contender receives only the fixed safe startup diagnostic `Daemon startup failed: execution owner already held`. Other unexpected ownership/path failures remain sanitized `Daemon startup failed`; diagnostics omit paths, credentials and raw causes. No new environment variable or external locking program/package is needed.

The held lease now mints its own opaque ID and records it in [`execution_owners`](database-schema.md#execution_owners), bound to canonical database path/device/inode and protocol `sqlite-sidecar-v1`. New deployed search bindings persist that ID as immutable `execution_owner_id` before the first session-create RPC; new search submission authorization records the current registered lease ID in `run_steps.submit_owner` before dispatch. The lease capability and exact database/registry checks supply authority, never a caller DTO/string. Ordinary/import binding contracts remain unchanged/null. Isolated workers without a deployed lease remain honestly unqualified.

On upgrade, owner migration adds the nullable binding FK without another run/knowledge rebuild. It never backfills old bindings, rewrites existing submission-owner strings or registers historical owners. Each registered runtime lease has a fresh ID; immutable registry records survive shutdown/startup failure. Historical qualification requires matching database identity and protocol, not merely a row in a copied database. A newly acquired lease, registry membership or a drained/aborted SDK call does not prove that an earlier remote request cannot arrive. Search cleanup joins the current execution lane and qualifies all setup/submission owners, then requires positive matching terminal evidence for every authorized prompt. Legacy/copied/unqualified ownership remains pending. The separate explicit retention controller permits local content purge, not inferred native absence or erasure.

The [cleanup journal](database-schema.md#cleanup-journal-and-internal-snapshot) preserves older control rows with nullable submission ownership and immutable all-step manifests. The [retained cancellation path](database-schema.md#retained-search-cancellation) snapshots terminal/pending/closed-slot search runs in the existing lane, after execution joins. It uses only sealed IDs/hashes and strict native binding/history/inbox verification, not retained prompt text or late reply publication. Missing prompts/credentials or endpoint outages remain pending; foreign ownership becomes conflict without foreign interrupts. A valid late ACK can update an existing sealed row before the active-claim fence discards it, but cannot resurrect execution.

Trusted internal code can obtain `ConfiguredRunWorker.searchRetention()` or `RunWorker.searchRetention()` only from an actual held/registered lease, then explicitly pass it to `SqliteStore.searchSessions(sources,controller)` on the same SQLite handle. The daemon does this before readiness, using its actual configured worker or the same local lane owner with an explicitly absent native port. [Controller-backed Delete](database-schema.md#explicit-search-retention-and-purged-cleanup) uses one root immediate transaction to fence generations/slots/composers, tombstone/title-clear, seal or exactly reuse noncontent cleanup identity and purge owned content. Completed outcomes stay completed; no SDK call or await occurs in that transaction. After commit it retires existing lanes without discarding their promises, clears clock metadata and coalesces a configured supervisor wake when present. The local result does not wait for native cleanup. Rollback performs no retirement or wake. Nested-transaction controller deletion is rejected rather than treating a savepoint as commit. The default no-controller refusal remains unchanged.

Purged pending rows are cancellation-only: a missing run is never rebuilt or submitted. The same native verifier and qualified predecessor checks apply, including after restart; empty history, timeout or missing native session remains uncertain without resend. Settled metadata can outlive content. There is no provider/backup/SQLite free-page erasure promise. Configuration and native permissions are unchanged. Configless runtimes have no native producer or cleanup scanner, never resolve/discover a service or construct a client, and leave unresolved cleanup metadata pending/unknown for a future matching configured restart. Local retention authority comes from the real registered lease/lifetime, not fabricated native or all-never-authorized proof.

Core migration includes search indexes, shared responses, durable run steps, capability results and bindings. One daemon-owned technical timer drives independent bounded queues: at most four import file ticks and eight shared Weave/Evolve/export/search execution or cleanup ticks are in flight. These are service concurrency limits, not model-effort or batch-size quotas. The shared supervisor alternates preference between run rows and purged cleanup rows, with separate finite membership high-water marks and ordered cursors; free slots can advance while another native call waits. Retention wakes coalesce into this same lane/capacity, not a new timer or per-run SDK fanout. The import driver rechecks up to fifty waiters before and after each scan and settles proven local cancellation separately. Parsing and native calls run outside SQL transactions. Without agent configuration, import processing remains local and queued model/cleanup work has no native dispatcher.

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

Use Ctrl+C or send SIGTERM. Shutdown seals new application-handler admission (late arrivals receive `503`), pauses workers/timers and stops the listener, then joins registered handlers and the actual run/import lanes before closing the knowledge database and finally its execution-owner sidecar. Configured service resolution is inside the existing coalesced per-run flight, not an untracked preflight; a final worker/shared-resolver and import-driver join follows the handler drain. Each run's registered promise includes its serialized search-cleanup tail, so direct cleanup ticks and held cleanup RPCs also join before lease release. Retention retirement never drops those held lanes; the supervisor also joins its coalesced notification flight. A local purge committed after pause leaves durable pending metadata without starting another RPC. Pause prevents further cleanup RPCs; unfinished remote work stays durable pending. A listener-stop error does not skip those joins: any surviving listener is sealed from database/application work. An unknown or still-pending local drain does not release ownership merely because a shutdown timeout passed. The lease's `release()` closes a resource; it does not fabricate a drain certificate.

The local driver yields between bounded work phases, cancels its timer before drain, and performs no further durable transition after pause. Local shutdown is not user Stop: it does not undo saved work or request native cancellation merely because the daemon is leaving. Restart reconciles existing identities and resumes eligible local imports. Repeated stop requests do not repeat closure; cleanup continues after individual errors and reports a sanitized failure/nonzero exit status when needed. Forced process death releases local OS locks, not remote admission uncertainty.

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
- `Daemon startup failed: execution owner already held`: another runtime owns this database, including through another relative/symlink spelling. Stop/drain the actual owner; do not delete its sidecar or infer death from elapsed time.
- Generic `Daemon startup failed`: check whether the port is occupied and the database directory is accessible. Unexpected exception text is intentionally not exposed.
- Client `401`: the token is absent or does not match the running daemon; generating another token in a different shell does not update the daemon.

Lifecycle and request boundaries emit attempt/outcome events. Do not add full configuration dumps or request bodies to logs to diagnose failures; they can contain credentials or thought content.

## Browser boundary

The browser client communicates through the Next.js server, never directly with the daemon. Both bearer credentials remain server-side. They represent service roles, not a multiuser account system. The API does not enable permissive browser CORS access.

Implementation: [`config.ts`](../src/daemon/config.ts), [`runtime.ts`](../src/daemon/runtime.ts), and [`main.ts`](../src/daemon/main.ts).
