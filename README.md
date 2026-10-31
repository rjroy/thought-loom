# Thoughtloom

The current MVP captures immutable originals, saves their provenance/date,
queues weaving jobs, and searches originals plus any recorded interpretations.
You can inspect recorded relationships, their evidence and revision history.
Automated weaving is available when explicitly connected to your own native
agent service. Without that setup, originals remain saved and queued; capture
does not invent AI annotations. Contextual dialogue can retain challenges, return
canonical responses and record developing ideas through the same configured
service. Meaningful saved changes can queue focused background follow-up;
its status and confirmed findings stay separate from the discussion. The concept mockups are guidelines,
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
The services reject non-loopback or malformed request authorities and untrusted
origins; this guard is not authentication or protection from local processes.
Real phone access waits for a separate hosting/authentication decision.
No OpenCode service, model, provider secret, or paid call is needed for capture
and retrieval. Configured weaving uses your selected agent/provider/model.

For a production-mode local launch, run `bun run build` then `bun start`.
The build command must succeed first; it does not start either service.

### Back up and inspect a restored copy

These commands back up **only the Thoughtloom application SQLite database**,
not OpenCode's database, service registration, generated native configuration,
provider credentials, or other files. Arrange separate secure backups for those
only if you own them and understand their recovery requirements. Database copies
contain private originals and discussion text; keep them in private storage.

Stop the Thoughtloom launcher first and wait for shutdown. Do not copy only the
main `.sqlite` file: committed data may still be in its WAL. SQLite's online
backup API, used by the `sqlite3` CLI `.backup` command below, reads a consistent
database including committed WAL contents. The repository does not currently
provide a backup command; install nothing automatically. These instructions
require an existing `sqlite3` executable with `.backup` and `mktemp`.

Replace both placeholders with **absolute paths** to the actual application
database and an existing private parent directory. The default application path
is the repository's absolute `.data/thoughtloom.sqlite` path, unless you set
`THOUGHTLOOM_DATABASE_PATH`. For this shell recipe paths must contain only ASCII
letters, digits, `_`, `.`, `/`, and `-`; choose safe paths rather than editing
the quoting. It creates a new private directory, never an existing destination.

```sh
SOURCE_DB='/ABSOLUTE/PATH/TO/thoughtloom.sqlite'
BACKUP_PARENT='/ABSOLUTE/PATH/TO/PRIVATE/BACKUPS'
SNAPSHOT=$(
  set -u
  umask 077 || exit 1
  for p in "$SOURCE_DB" "$BACKUP_PARENT"; do
    case "$p" in /*) ;; *) exit 1 ;; esac
    case "$p" in *[!A-Za-z0-9_./-]*) exit 1 ;; esac
  done
  [ -f "$SOURCE_DB" ] && [ -s "$SOURCE_DB" ] && [ -d "$BACKUP_PARENT" ] || exit 1
  dir=$(mktemp -d "$BACKUP_PARENT/thoughtloom-backup.XXXXXXXX") || exit 1
  printf 'Working directory (retain on failure): %s\n' "$dir" >&2 || exit 1
  sqlite3 -readonly "$SOURCE_DB" ".backup '$dir/snapshot.sqlite'" || exit 1
  [ -s "$dir/snapshot.sqlite" ] || exit 1
  check=$(sqlite3 -readonly "$dir/snapshot.sqlite" 'PRAGMA integrity_check;') || exit 1
  [ "$check" = ok ] || exit 1
  printf '%s\n' "$dir/snapshot.sqlite"
) && printf 'Verified snapshot: %s\n' "$SNAPSHOT"
```

If the command fails or does not print the verified path, **stop**; do not use
the incomplete directory as a backup. Its printed working directory is retained
for diagnosis and can be removed deliberately after inspection. The check detects SQLite structural
corruption, not missing business content. Reopen and inspect a restored copy as
below; keep the original and backup unchanged. Do not run this command against a
personal OpenCode database.

To restore, set `SNAPSHOT` to the printed absolute path and `RESTORE_PARENT` to
another existing private directory. The same path-character restriction applies.
This creates a *new* directory and database; it never overwrites the original or
the snapshot. Stop if any command fails or no verified path is printed; retain
the printed working directory for diagnosis before deliberately removing it.

```sh
SNAPSHOT='/ABSOLUTE/PATH/TO/VERIFIED/snapshot.sqlite'
RESTORE_PARENT='/ABSOLUTE/PATH/TO/PRIVATE/RESTORES'
RESTORE_DB=$(
  set -u
  umask 077 || exit 1
  for p in "$SNAPSHOT" "$RESTORE_PARENT"; do
    case "$p" in /*) ;; *) exit 1 ;; esac
    case "$p" in *[!A-Za-z0-9_./-]*) exit 1 ;; esac
  done
  [ -f "$SNAPSHOT" ] && [ -s "$SNAPSHOT" ] && [ -d "$RESTORE_PARENT" ] || exit 1
  dir=$(mktemp -d "$RESTORE_PARENT/thoughtloom-restore.XXXXXXXX") || exit 1
  printf 'Working directory (retain on failure): %s\n' "$dir" >&2 || exit 1
  sqlite3 -readonly "$SNAPSHOT" ".backup '$dir/restored.sqlite'" || exit 1
  [ -s "$dir/restored.sqlite" ] || exit 1
  check=$(sqlite3 -readonly "$dir/restored.sqlite" 'PRAGMA integrity_check;') || exit 1
  [ "$check" = ok ] || exit 1
  printf '%s\n' "$dir/restored.sqlite"
) && printf 'Verified restored copy: %s\n' "$RESTORE_DB"
```

First inspect the restored copy **without native configuration**. With all
Thoughtloom launchers stopped and from the repository root, replace the path
with the verified restored path if using a new shell:

```sh
env -u THOUGHTLOOM_NATIVE_CONFIG_FILE -u THOUGHTLOOM_TOOL_CONNECTION_FILE \
  THOUGHTLOOM_DATABASE_PATH="$RESTORE_DB" \
  bun --no-env-file run apps/daemon/src/index.ts
```

This starts only the loopback daemon, not Next, and disables automatic `.env`
loading for that process. Stop it with Ctrl+C after inspecting known source IDs
through the local API. The database-path override is for this process only;
ordinary `bun dev` otherwise uses its configured/default path, **not** the
restored copy. Do not overwrite the original to switch databases.

A backup can contain queued, active or uncertain jobs and run/session IDs from
its capture time. With the worker unconfigured, jobs cannot be admitted or
reconciled with a native service. Do not blindly reconnect native configuration
or retry work from a restored copy: it may duplicate external effects or refer
to sessions whose real state has since changed. Inspect status and reconcile
with the operator-owned service and current original database first; no automatic
safe-merge or replay procedure is claimed. The user-led evaluation procedure is
in `.lore/work/validation/thoughtloom-real-corpus-experiment.md`.

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
   approval inbox. User correction and reject/restore controls append attributed
   versions without removing earlier evidence or history.
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

### Develop a thought through dialogue

1. Open a thought’s inquiry. **Discuss original** works even with no AI notes.
   **Discuss this reading** or **Discuss this connection** attaches discussion
   to that exact formulation/revision (including directed endpoints), not a
   silently changing latest version. The quoted target stays visible.
2. Enter a challenge in **Develop this thought**, then **Send thought**. Your
   exact input becomes a retained, searchable source before the dialogue job
   is admitted. **Your thought saved** and **Waiting for agent** are not claims
   that the native service is responding. Missing setup keeps input queued;
   configure your own service before expecting a response.
3. **Latest exchange** separates your input from canonical AI response text.
   **Developed here** shows only confirmed domain changes, not a model’s prose
   claim that it saved something. A run can complete with no written reply or
   no useful changes. Long replies have a full-reply disclosure. Older saved
   exchanges are folded, not turned into a permanent chat feed.
4. Open a developing idea and **From this discussion** to follow its derivation.
   Source/evidence links to your discussion input show its exact text/date and
   **Return to discussion**, rather than a fictitious capture-weaving status.
   Search distinguishes your discussion input from originals and AI notes.
5. Reload/bookmark the `?dialogue=<id>` inquiry URL. Reopening the same exact
   target from search resolves its existing context through an idempotent
   creation key and then reads current history. A changed target version is a
   different context. There is no global conversation index or chat-room system.
6. **Check status** only reads. An uncertain save acknowledgement preserves the
   exact draft/key for **Retry send**; this replays the save command, not a new
   agent prompt. One active turn per original prevents overlapping discussions.
   If another context is busy, the draft stays intact; the current API does not
   identify that other discussion, so the UI does not invent a link to it.
7. **Stop response** requests cancellation/interrupt for the fenced turn. It
   does not prove settlement or undo already recorded changes. Completion may
   win; uncertain outcomes remain uncertain. There is no dialogue-run Retry
   command. After a definite failure/interruption you may send a new thought.
8. For an item discussion, **Use my saved thought as formulation** explicitly
   applies your latest saved input as a protected user correction. Relationships
   can be rejected with a reason and restored. **Restore this version** appends
   a user-authored revision; it does not erase intervening versions. A stale
   revision returns a conflict for review, never an automatic overwrite.

Switching discussion targets with their buttons preserves separate drafts in
the open page. Navigating away or reloading can lose **unsaved** drafts. Agent
context contains bounded recent history, not the entire stored conversation;
the current API does not report exact prompt-history truncation. The readable
projection also has a finite saved-turn limit and no older-history pagination.

### Inspect background follow-up

1. With your own service configured, complete a discussion that actually records
   a reading, developing idea or relationship change. A successful meaningful
   turn can queue a **Background follow-up** pass. Prose claiming a change,
   alias-only output, failed turns and explicitly stopped turns do not trigger
   this path. Protected user corrections, rejection and restoration can also
   queue a pass after their saved revision.
2. The subordinate section below the inquiry shows what triggered each pass,
   affected **exact versions**, worker availability and job outcome. Triggering
   discussion/input links retain the retrieval query. Version links open known
   history, not a silently substituted current reading. References outside the
   bounded context are labelled rather than turned into fabricated links.
3. Pending changes may share one unclaimed pass. Active/pending work is shown
   before older outcomes; job/origin/target/change truncation is explicit. This
   is a bounded projection, not a complete job dashboard or an approval inbox.
4. Polling changes background status without taking focus, closing disclosures
   or replacing the question draft. **View follow-up findings** explicitly loads
   the current bounded reading snapshot. Confirmed updates retain AI attribution
   and evidence; the discussion remains pinned to its chosen context revision.
   Zero-change completion is valid. A new background interpretation is not a
   developing idea merely because model prose calls it one.
5. Missing setup and a configured-but-unavailable service are different states.
   **Check status** only reads. Eligible definite failures/interruption may
   offer **Retry follow-up**, fenced to that job and run. An unknown retry
   acknowledgement retains its exact key/payload; another click replays that
   command. A definite conflict refreshes state, and only a later explicit click
   creates a fresh command for the current run. No source or turn is resubmitted.

The native follow-up adapter is exercised with controlled scripted dependencies
in tests; this does not establish compatibility with every live provider or
operator policy. Provider charges and the loopback-only access boundary above
still apply. Responsive phone layout does not enable remote phone hosting.

Current setup generates separate capture/dialogue operation scopes and bundles
the owned plugin. An older private setup does not automatically gain new tools.
Use a fresh isolated setup if upgrading that configuration; do not modify a
personal/shared service silently. Model/provider charges and operator-policy
responsibilities still apply. No example agent or annotations are auto-seeded.

## Boundaries and checks

Browser data requests use same-origin Next routes: `/api/captures`, `/api/search`,
`/api/sources/<id>`, `/api/sources/<id>/inquiry`, and
`/api/sources/<id>/weaving` (with a narrow `/retry` command). Dialogue routes
create/read a pinned context, save turns and request Stop. Narrow item/relationship
routes forward version-fenced user corrections and restore/reject commands.
`/api/sources/<id>/follow-ups` reads background status; its narrow
`/<jobId>/retry` command forwards only an idempotent, version-fenced retry.
Only server code knows the internal `THOUGHTLOOM_DAEMON_URL`; it accepts only
an operator-configured HTTP loopback base, never a URL from the browser. The
source page also reads through that server-side boundary without caching.
Cross-origin mutations are rejected, but this is not authentication.

The daemon owns `GET /sources/<id>/inquiry`: a consistent read-only snapshot
of the source, its items and direct neighbors, incident relationships, recent
attributed histories, and evidence-source references. It does not traverse the
whole graph. Indexed reads cap fan-out/history and show truncation honestly;
oversized evidence closure or missing references return unavailable rather than
fabricated links. Next runtime-validates the shared contract, including endpoint
and evidence closure. Hono assigns user authority for the narrow UI commands;
browser/model-provided actor fields are not accepted.

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
