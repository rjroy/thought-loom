# Thoughtloom

The current MVP captures immutable originals, saves their provenance/date,
queues weaving jobs, and searches originals plus any recorded interpretations.
You can inspect recorded relationships, their evidence and revision history.
Automated weaving is available when explicitly connected to your own native
agent service. Without that setup, originals remain saved and queued; capture
does not invent AI annotations. **Dialogue is not implemented yet.** The concept mockups are guidelines,
not a pixel contract or a claim that the full experience is built.

## Run locally

Use Bun **1.4.3** and Node.js **26.13.0** (`.tool-versions`). Node runs Next;
Bun runs the daemon and workspace scripts.

```sh
bun install --frozen-lockfile
bun dev
```

Open **http://127.0.0.1:3000**. The launcher starts both services and Ctrl+C
stops both. Next binds to `127.0.0.1:3000`; Hono binds to `127.0.0.1:3001`.
It explicitly supplies an absolute SQLite path at `.data/thoughtloom.sqlite`
(gitignored). Restarts reuse that database. Do not delete it to restart.
Set `THOUGHTLOOM_DATABASE_PATH`, `THOUGHTLOOM_WEB_PORT`, or
`THOUGHTLOOM_DAEMON_PORT` before launch to use another path/ports.

The responsive phone layout can be tried in desktop browser device emulation.
**Do not expose either service to a network or use a public tunnel.** There is
no authentication yet. Other local processes can access the loopback services.
Real phone access waits for a separate hosting/authentication decision.
No OpenCode service, model, provider secret, or paid call is needed for capture
and retrieval. Configured weaving uses your selected agent/provider/model.

For a production-mode local launch, run `bun run build` then `bun start`.
The build command must succeed first; it does not start either service.

### Try this checkpoint

1. Capture a few lines, including deliberate leading spaces and line breaks.
   Select **Save original**. The original page should show your exact words,
   origin, date, and **Queued for weaving**, with an explicit unavailable-worker
   explanation. Queued does not mean AI processing is running or complete.
2. Bookmark/copy the `/sources/<id>` address. Refresh and reopen it in a new
   tab. Stop with Ctrl+C, run `bun dev` again, and reopen the same address.
3. To try an actual service failure locally: stop the combined launcher, then
   run only Next in one terminal:
   `node apps/web/node_modules/next/dist/bin/next dev apps/web --hostname 127.0.0.1 --port 3000`.
   Enter a draft and save. The error should preserve the draft. Leave that tab
   open. In another terminal start the daemon with
   `THOUGHTLOOM_DATABASE_PATH="$PWD/.data/thoughtloom.sqlite" bun run apps/daemon/src/index.ts`.
   Select **Retry save** without editing. Stop both terminals afterward.

A failed acknowledgement can mean the write already succeeded. Unchanged
retries reuse the same key and payload, so the daemon returns the original
receipt rather than adding another source/job. Editing after failure starts
a new save and warns that the earlier attempt may already be saved. Unsaved
drafts are held in the open capture page only; navigating away, closing, or
reloading it can lose them. Save before searching or leaving that page.
Successful saves navigate to the stable source URL. Bookmark it or use search
to find your words later. There is deliberately no permanent all-notes list.

### Find and inspect a thought

1. Capture an original containing a distinctive word or phrase. Use **Search
   thoughts** in the header to find it. Search accepts fragments, recorded
   aliases/acronyms, and a bounded single-typo fallback; it is not agentic search.
2. Select **Open thought**. The inquiry view keeps the original, its date/origin,
   and any recorded interpretations and connections distinct. Expand **Read
   full original** to inspect every character, or **Open saved original** for
   the existing standalone source URL.
3. Without configured weaving, ordinary captures have no AI notes. Empty states say so. When recorded
   notes exist, their author, tentative status, evidence links, connection
   direction/rationale, and **View history** are readable. There is no mandatory
   approval inbox. Read-only history does not provide rejection/restoration
   controls yet; those arrive with contextual development.
4. **Back to results** retains the query, including after following a connected
   thought. Browser Back also returns to the query. An empty query does not
   become a listing of every note. No-match and unavailable states explain a
   recovery without claiming your data is gone.

For an explicit **example-only** review workspace:

```sh
bun run demo
```

This creates a **new separate database** under `.data/examples/inquiry-*/` and
prints its exact `THOUGHTLOOM_DATABASE_PATH='…' bun dev` launch command. Stop
an existing workspace first, then use that printed command. Nothing seeds the
normal database automatically. All example sources/annotations say **Example**;
the notes were inserted by a controlled fixture, not generated by a live model.
Try `SDK` (including a recorded alias), `coordinaton` (a typo), and
`intent preservation` (an AI-note match absent from the original wording).
Inspect the full source, alternate interpretations, historical versions,
connection rationale, and evidence. Stop it with Ctrl+C. Plain `bun dev`
returns to your normal database unless you have set a database-path override.

### Connect weaving (explicit opt-in)

Open **http://127.0.0.1:3000/setup/weaving** for the same in-app guide. The
integration targets OpenCode **2.2.2**, attached to an operator-managed service.
Thoughtloom does not install OpenCode, start a shared service, select a model,
or modify a personal/global service configuration. Selected providers may
receive source content and incur charges.

Choose an existing absolute registration-file path and accessible agent,
provider and model. From the repository root, replace **every** placeholder:

```sh
bun run scripts/setup-native.ts \
  --runtime-directory /ABSOLUTE/FRESH/RUNTIME \
  --location-directory /ABSOLUTE/FRESH/LOCATION \
  --daemon-origin http://127.0.0.1:3001 \
  --registration-file /ABSOLUTE/EXISTING/REGISTRATION \
  --agent YOUR_AGENT \
  --provider YOUR_PROVIDER \
  --model YOUR_MODEL
```

The runtime and location directories must both be **fresh absolute paths
outside this repository**. Do not substitute an existing project or a global
configuration directory. This offline command prepares private configuration,
the first-party plugin and its tool connection; it prints `nativeConfigFile`.
It neither activates a service nor proves provider compatibility. Keep generated
files private. See `scripts/setup-native.ts` for explicit optional variant and
step-budget flags; do not add browser-held credentials.

Independently start/manage your own matching OpenCode service for the exact
prepared location and registration. Stop any existing Thoughtloom launcher,
then use the actual printed configuration path:

```sh
THOUGHTLOOM_NATIVE_CONFIG_FILE='/ACTUAL/RUNTIME/native.json' bun dev
```

Keep both Thoughtloom services on loopback; there is no authentication or
remote-phone access. Keep the same database-path override if using one.

1. Capture a thought. **Original saved** acknowledges the durable source, not
   an agent outcome. **Queued for weaving** means no run has started.
2. Configured work can progress to **Weaving in progress**, then **Weaving
   completed**. Zero recorded changes is a valid result, not a fabricated
   connection. Explore recorded context to inspect tentative AI readings,
   rationale and evidence. Open inquiries update without closing disclosures.
3. Search your own words or a newly recorded formulation. Sources and AI-note
   matches remain distinct. Example-only demo annotations are not live output.
4. A confirmed failed/interrupted eligible run may offer **Retry weaving**:
   it reuses the saved source/job, not a new capture. An uncertain admission
   offers **Check status**, a read-only action, not blind resend. If the retry
   acknowledgement itself is lost, **Confirm retry** replays its same command
   key/payload. An unavailable service and missing configuration are distinct.
   Recorded partial changes remain visible. No operator policy or arbitrary
   provider/model compatibility is implied by this checkpoint.

## Boundaries and checks

Browser data requests use same-origin Next routes: `/api/captures`, `/api/search`,
`/api/sources/<id>`, `/api/sources/<id>/inquiry`, and
`/api/sources/<id>/weaving` (with a narrow `/retry` command).
Only server code knows the internal `THOUGHTLOOM_DAEMON_URL`; it accepts only
an operator-configured HTTP loopback base, never a URL from the browser. The
source page also reads through that server-side boundary without caching.
Cross-origin capture/retry requests are rejected, but this is not authentication.

The daemon owns `GET /sources/<id>/inquiry`: a consistent read-only snapshot
of the source, its items and direct neighbors, incident relationships, recent
attributed histories, and evidence-source references. It does not traverse the
whole graph. Indexed reads cap fan-out/history and show truncation honestly;
oversized evidence closure or missing references return unavailable rather than
fabricated links. Next runtime-validates the shared contract, including endpoint
and evidence closure. No new public knowledge-write endpoints are exposed.

The Hono `POST /captures` contract requires an `Idempotency-Key` of 1–128 ASCII
letters, digits, or `._~-` characters. Reuse it for the exact same parsed text
and provenance; changed payloads with that key return 409. Hono owns SQLite
and job writes. Each storage call closes its connection; shutdown waits for
active requests. Application boundary logs omit note content and raw payloads.
Development request-URL logging is disabled because search terms may contain
personal words; operation attempts/outcomes are still logged.

```sh
bun test apps/daemon/tests/capture.test.ts
bun run typecheck:daemon
bun run typecheck:web
bun run typecheck:scripts
bun run test:browser
```

Browser tests use their own temporary database, real Next/Hono HTTP services,
and the installed Chromium at `/usr/bin/chromium`. Set
`THOUGHTLOOM_CHROMIUM_PATH` for another existing executable. They do not
download browsers or call models. Ports default to 4317/4318; override with
`THOUGHTLOOM_E2E_WEB_PORT` / `THOUGHTLOOM_E2E_DAEMON_PORT` if needed. The
harness cleans up its child services and temporary database, not user data.

Source Sans 3 is self-hosted; its license and copy provenance are in
`apps/web/app/fonts/`. No personal-brand repository is needed at runtime.
