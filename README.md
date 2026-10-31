# Thoughtloom

The first MVP slice captures an immutable original, saves its provenance/date,
and atomically queues a weaving job. Search, AI notes, dialogue, and the weaving
worker are **not implemented yet**. The concept mockups are guidelines, not a
pixel contract or a claim that the full experience is built.

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
No OpenCode service, model, provider secret, or paid call is needed here.

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
drafts are held in the open tab only; closing/reloading it can lose them.
Successful saves navigate to the stable source URL. Bookmark it: there is no
all-notes list or search yet.

## Boundaries and checks

Browser requests use same-origin `/api/captures` and `/api/sources/<id>` routes.
Only server code knows the internal `THOUGHTLOOM_DAEMON_URL`; it accepts only
an operator-configured HTTP loopback base, never a URL from the browser. The
source page also reads through that server-side boundary without caching.
Cross-origin capture requests are rejected, but this is not authentication.

The Hono `POST /captures` contract requires an `Idempotency-Key` of 1–128 ASCII
letters, digits, or `._~-` characters. Reuse it for the exact same parsed text
and provenance; changed payloads with that key return 409. Hono owns SQLite
and job writes. Each storage call closes its connection; shutdown waits for
active requests. Logs omit note content and raw payloads.

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
