# Maintenance breaks

A maintenance break is a short, planned time when Luma closes so a risky change (like a
database update) can be done safely. Students are told first, get time to save, and see
whether their work was saved. Nothing about a break starts by itself.

Status: built and tested locally with made-up data. **Not deployed. The database change
is not applied.** See "Approvals needed" at the end.

## The steps of a break

| Step | What students see | What still works |
|---|---|---|
| Open (`none`) | Nothing | Everything |
| Announced | A small notice they can close: "Luma will take a short break on Tue, Dec 1 at 5:00 AM CST. Your saved work is safe." | Everything |
| Getting ready (`draining`) | A notice they can't close: "Luma is getting ready for a short break. Finish and save your work now." plus "All your work in this tab is saved." (or how many things aren't) | Reading. Editors that were already open can save during the grace time (5 to 30 minutes, 10 by default). New editors, AI tools, uploads and sign-ups wait. |
| In maintenance (`active`) | The page is covered by "Luma is taking a short break", the reason, a guess of when it ends ("a guess, not a promise") and "Your saved work is safe." If a tab still has unsaved work, the editor stays open with "Your work isn't saved yet. Keep this tab open. Copy your text to be safe." and a **Copy my text** button. | Only sign-in, the status page, health checks and the admin's maintenance page |
| Checking | Same as in maintenance | Same |
| Reopened | "Luma is back. Thanks for waiting!" for 30 minutes | Everything |

Luma never moves a student to another page, reloads or signs them out because of a break.

The public page **/status** shows the same information without signing in. During a break it
checks again by itself after 30 seconds, 1, 2 and 4 minutes, then stops and shows **Check
again**. It pauses while the tab is hidden. It never shows technical text.

## Running a break (admin)

Open **Maintenance** in the sidebar (admins only), or go to `/admin/maintenance`.

1. **Schedule a break.** Type the start and the end in Central (Chicago) time. The page shows
   the time back to you ("That is Tue, Dec 1, 5:00 AM CST"). Times that are skipped or happen
   twice when clocks change are refused. Pick why, and add a short note if you like.
2. **Start getting ready** about 15 minutes before the start. Pick how many minutes students
   get to finish saving.
3. **Enter maintenance.** Luma only starts if it is safe:
   - the saving time is over (and at least 60 seconds have passed since getting ready began);
   - no AI or other long task is still running;
   - no server is still answering a request, and no server went quiet while busy;
   - for a database update: the stamp of a backup made **in this break** is typed in, and you
     ticked that its restore test passed.
   If it isn't safe, the page says why in plain words. Press **Try again** later, or **Postpone**.
4. Do the work (for example the backup, then the database change, then the deploys, in the
   order in `docs/deployment-checklist.md`).
5. **Run checks.** Luma checks that the database answers, every needed table and column is
   there, no records were lost since the break began, the break log can be written, and picture
   storage answers. **Reopen Luma** only works when every check passed in the last 30 minutes.
   If a check fails, Luma stays closed: fix it (for example roll the code back), then run the
   checks again.

Stripe payment messages that arrive during the break, and in the last minute before the
grace time ends, get "try again later" (503 with Retry-After: 600). Stripe sends them again;
after reopening, check Stripe's webhook page.

A server that has just started (a deploy, a crash, a cold start) and can't read the break
settings yet keeps reading open but refuses saves, AI work and payment messages with a 503
and Retry-After: 30, until it can read them. It never guesses "no break". Each server process
has its own row (Render instance id plus process id), so several workers on one instance are
all counted. Log in stays open during a break but no longer upgrades old password hashes then.

Reopen checks also need the student-work columns (version, create_key, progress_rev), and
every server that reported in the last two minutes must run the same code version.

## Proposed window (you choose)

There is no usage history yet (only 2 analytics events), so this is a reasonable guess:

- **First choice: Tuesday or Wednesday, 5:00 to 6:00 AM Central.** Students 13 to 17 are
  asleep and school hasn't started.
- Second choice: Sunday 7:00 to 8:00 AM Central.
- Avoid the Sundays when clocks change (2nd Sunday of March, 1st Sunday of November) and
  school-night evenings.
- Announce at least 2 days ahead. Start getting ready 15 minutes before. Grace 10 minutes.
- Nothing repeats. Each break is scheduled by hand.

## How it works (for developers)

- Code: `backend/app/maintenance.py`. Database change: `backend/app/schemas/migrations/2026_11_19_maintenance_state.sql`
  (additive: four new tables, RLS on, no access for `anon`/`authenticated`). PGlite check:
  `PGLITE_DIR=J:/LumaOps/pglite node backend/scripts/check_maintenance_migration.mjs`.
- One row (`maintenance_state`, id 1) holds the phase for every server. Each change is a
  compare-and-swap on `rev` and writes one `maintenance_log` row (codes and counts only).
- Each server process keeps a 5-second copy of that row and reads it again only when a request
  arrives after the copy is old. There are no timers or background loops.
- Each server counts its own requests in flight and, while a break is planned, writes the
  count to `maintenance_instances` (at most once a second, and right away when it drops to 0).
  AI and other long requests have a `maintenance_jobs` row while they run.
- The gate (`MaintenanceMiddleware`) sits inside CORS, so its 503 answers can be read by the
  browser. There is no bypass: no header, query, cookie or role skips it. Admins get 503 on
  student pages during a break too. Only these stay open: `GET /maintenance/status`,
  `GET /health`, `GET /health/ready`, `GET /robots.txt`, `GET /me/profile`, `POST /login` and
  `/admin/maintenance*` (which still needs an admin).
- Every answer carries `X-Luma-Maintenance` and `X-Luma-Maintenance-Rev`. The browser reads the
  status when the app opens, when that rev changes, and on focus if the last check is over a
  minute old (`frontend/src/maintenance/observe.ts`).
- Editors call `beginEditing()` (`frontend/src/maintenance/editSession.ts`) when they open. It
  gets a signed edit-session token; during the grace time only saves with a token made before
  getting ready began are let through.

## Tested vs assumed

Tested locally with made-up data (see the commit message for exact counts):

- Every phase and path group, the exact 503 body and headers, CORS on the 503, the edit-session
  rules (forged, late and expired tokens refused), DST gap and overlap refused on the server and
  in the browser, CST/CDT shown on both sides of a change.
- Two simulated servers sharing one state (the second follows within 5 seconds of its next
  request), in-flight work on the second server blocking the first from starting maintenance,
  a server that went quiet mid-work, a restart (state reloaded, new server joins, no timers).
- Running AI jobs block; stale jobs don't. Reopen refused while a check fails, when records were
  lost, or when the checks are old. Starting a database update refused without a backup stamp.
- Students get 403 on every admin route in every phase; nobody can get around the break.
- Stripe webhooks: 503 + Retry-After 600 during the break and from 60 s before the grace ends,
  handled before that, in the thread pool.
- A new server whose first read of the break state fails refuses changes (503, Retry-After 30)
  and keeps reading open; two workers sharing one Render instance id get separate rows; a missing
  student-work column or two code versions running fail the reopen checks; log in during the
  break writes nothing.
- Editors: a save held by a break saves once when Luma reopens (or with Try again); an editor
  opened before the drain sends its edit-session header and saves in the grace time.
- In the browser (desktop, tablet, phone): typing during an announcement keeps focus and text;
  the draining notice; the break cover keeps the navigation and an open editor's text; the full
  admin flow; the status page's bounded checks, pause while hidden, and plain failure message.

Assumed, not tested here:

- Real Supabase/PostgREST behaviour of the new tables (PGlite and a fake client were used).
- Render running more than one instance (two instances were simulated in one process).
- Stripe really retrying a 503 delivery (that is Stripe's documented behaviour).

## Approvals needed

1. Applying `2026_11_19_maintenance_state.sql` to production (after a verified backup).
2. Deploying the backend, then the frontend.
3. The maintenance window, and each actual break.
