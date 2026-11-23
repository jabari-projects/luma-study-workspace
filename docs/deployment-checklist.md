# Deployment checklist

Use this list for every Luma update that changes the database. Every step needs the owner's OK.
Nothing here happens on its own.

Plain rule: updates add things. They never delete student work.

Hard rules for every release:

- **The database change runs and passes VERIFY before anything is merged or pushed to `main`.**
  Render and Vercel both deploy on a push to `main`. A new backend on the old database refuses
  every save with "try again in a minute" (it can't read the break settings), and where the break
  tables exist but the new columns don't, saves fail.
- **Never run the new website against the old backend**, not even for a few minutes. The new
  website can't confirm a save on the old backend ("We couldn't check that your work was saved"),
  each **Try again** on a new note, deck or plan makes another copy (the old backend ignores the
  Idempotency-Key), and study grades aren't saved (405). `frontend/src/work/saveClient.test.ts`
  ("against the OLD backend") shows this. So: backend first, website second; when rolling back,
  website first, backend second.
- Turn **auto-deploy off** on both hosts before merging, and deploy by hand:
  - Render: the service's Settings > Build & Deploy > Auto-Deploy: **No** (or `autoDeploy: false`
    in `render.yaml`).
  - Vercel: Project Settings > Git > Ignored Build Step: "Don't build anything" for `main` (or pause
    production deployments). Turn both back on after the release.

## Before the day

1. **Plan the change.** Write each part down as one of:
   - *Add* (new tables or new columns with a default). Normal updates only do this.
   - *Code* (new backend or website code).
   - *Clean up* (removing something old). This is never part of a normal update. It gets its
     own update, its own OK and its own fresh backup.

   Normal updates never drop a column, a table or any rows.

2. **Practice on a copy of the real data.** At least a day before (never for the first time in the
   release window), take a real backup and pass its restore test:

   ```
   python setup_credentials.py          (first time only)
   python backup_run.py --production
   ```

   Then try the new database changes on a throwaway copy of that backup:

   ```
   python rehearse_migrations.py --stamp <that backup> --after <last migration already live>
   ```

   (Run them in `ops\backup`.) It must say "Rehearsal passed." Keep its output with the release
   notes. That means every old row is still there and unchanged (a checksum per row over every
   column it had), no table gained or lost rows, no column was removed or changed type, new
   columns hold their defaults on old rows, and each change ran twice without trouble. It also
   lists each table's row count before and after. It is the only check that runs on the real
   shape of production: if production was changed by hand (a column added in the dashboard, say),
   this is where it shows. `ops/backup/tests/test_migration_rehearsal.py` runs the same practice
   on a fake database shaped like production. The PGlite checkers for the new migration files
   must pass too.

3. **Pick a break time** (only for risky database changes), inside the approved maintenance
   window. Tell students at least 48 hours ahead.

## First release only (release 1: maintenance mode is not installed yet)

Live today is `main` 7b602b9: it has no maintenance gate, no `/admin/maintenance` page and no
edit-session token. So for this one release **nothing can pause writes**: steps 4 and 5 below
can't be used, and their promise "nothing made after the backup can be lost" does **not** hold.
That is acceptable only because all three files just add things: old code ignores them, and no
existing row or value changes. Do this instead:

R1. **Before the window:** turn auto-deploy off on Render and Vercel (hard rules above). Take the
    backup and pass its restore test (step 2), and run the rehearsal on it. Write down the backup
    name. Work saved after this backup exists only in the live database; that is fine because
    nothing in this release removes or changes it.

R2. **Announce a short low-traffic window by hand** (no banner exists yet): for example a message on
    the help page or to known students, "Luma is updating between 05:00 and 05:30. Save your work
    before then."

R3. **Run the three SQL files** in the Supabase SQL editor, in this order, one at a time, with the
    old backend still live:
    1. `2026_11_18_monthly_feedback.sql`
    2. `2026_11_19_maintenance_state.sql`
    3. `2026_11_19_student_work_versions.sql`

    Each file starts with `lock_timeout 5s` and `statement_timeout 120s`. If a file stops with
    "canceling statement due to lock timeout" (or statement timeout), nothing changed: wait a
    minute and run the same file again. While a file runs, saves to the tables it touches wait a
    moment and then go through; the four index builds in file 3 block writes on notes, summaries,
    flashcards and study plans while they build (seconds for tables of a few thousand rows; the
    rehearsal in step 2 shows how long on a copy of the real data, and the 120 s statement timeout
    is the upper limit). The student-work file also stops
    by itself (and changes nothing) if production already has one of its columns or indexes in
    another shape.

R4. **VERIFY is a hard stop.** Run each file's VERIFY part. Stop the release (and change nothing
    else) unless all of these are exactly right:
    - 9 column rows: `version` default `1`, NOT NULL on notes, summaries, flashcards and
      study_sessions; `create_key` nullable, no default, on the same four; `progress_rev` default
      `0`, NOT NULL on flashcards;
    - 4 indexes named `*_user_create_key_uidx`;
    - `select count(*) from public.notes where version is null` = 0;
    - `select id, phase, rev from public.maintenance_state` = one row: `1, none, 1`;
    - RLS on for the 4 `maintenance_*` and the 8 `feedback_*` tables.

R5. **Merge to `main` and push** (auto-deploy is off, so nothing deploys yet).

R6. **Deploy the backend** (Render, by hand). Wait until it is live, then check:
    - `GET /health/ready` answers 200;
    - `GET /maintenance/status` answers 200 with `"phase": "none"` (a 503 here means the new
      backend can't read `maintenance_state`: stop and look before going on);
    - one test save with a test account: create a note, change it, delete it.

    From the moment the new backend is live, pages that students opened before the deploy keep
    working: their saves go through the OVERLAP path (last write wins). Saves made while Render
    swaps instances may get "try again in a minute" (503) on an old page; old pages have no retry,
    so the student presses Save again.

R7. **Only then deploy the website** (Vercel: promote the build, or redeploy `main`). Load the site
    in a private window, sign in with a test account, and save a note.

R8. Turn auto-deploy back on for both. Skip steps 4, 5 and 8 below for this release. Use the full
    maintenance flow from release 2 on.

## On the day (release 2 on, with maintenance mode live)

4. **Get ready.** Start the "getting ready" phase, so people can finish saving. Wait until the
   grace time is over. From then on every save, AI job and payment webhook is refused, so
   nothing new can be written (log in still works, but it no longer writes either).

5. **Fresh backup, then pause.** After the grace time ends and *before* pressing Enter
   maintenance, run:

   ```
   python backup_run.py --production
   ```

   The practice restore must pass. Type the backup name (like `20261119T033000Z`) into the
   maintenance form next to Enter maintenance and tick "restore test passed"; a database update
   is refused without it (`backup_missing`), and there is nowhere to type it once maintenance is
   on. Then press Enter maintenance. It turns on only if the safety check passes; if it does not
   pass, don't force it: move the break and write down why. Because writes were already refused
   when the backup started, nothing made after the backup can be lost. (This holds only once the
   maintenance gate is live: not for release 1, see above.)

6. **Change the database.** The owner pastes the new SQL into the Supabase SQL editor and runs
   it. Then runs the file's VERIFY part and checks the numbers; a wrong number stops the release.
   With more than one file, run them one at a time in name order. A lock or statement timeout
   rolls the file back with nothing changed: run it again.

7. **Update the backend first** (Render, by hand), wait until it is live and `/health/ready` and
   `/maintenance/status` answer, **then the website** (Vercel). The new backend works with both the
   old and the new website; the new website never runs on the old backend. The database change
   (step 6) must come before the backend: a new server that can't read the break settings
   (tables missing, or the database slow) keeps reading open but refuses saves with "try again in
   a minute" until it can, so it never lets work through during a break by mistake.

8. **Run the checks.** Reopen only if they all pass. Then in Stripe (Developers > Webhooks),
   check that any events that got "try again later" during the break were sent again and
   worked. Resend any that still failed. Never turn the webhook off.

## Later

9. **Clean up** (a normal update, its own OK): make the version check required, remove the
   temporary overlap code, and close the Task Board items. Not before all of these:
   - a "new version, save and reload" signal has shipped (old pages have no autosave and no draft
     for saved items, and students leave tabs open for weeks);
   - the backend logs show no `PUT` without `expected_version` for 14 days in a row;
   - the 428 answer's text tells old pages in plain words: "Luma was updated. Copy your text
     somewhere safe, then reload the page."

   The old-device note draft migration (`luma.noteDraft`) is removed separately, after 2027-02-01.

## If something goes wrong

10. **Roll back the code, not the data.** To undo code, **first** redeploy the last good Vercel
    build (the website) and check that it loads, **then** the last good Render build (the backend).
    Never leave the new website live on the old backend (see the hard rules). The added columns and
    tables stay, and old code ignores them. A bad database change gets a new fix-forward SQL file,
    never a delete. If an update fails during the break: stay in maintenance, roll the code back
    (website first), run the checks, then reopen. (Release 1 has no maintenance to stay in: roll
    the website back, then the backend.)

11. **Never restore the live site from a backup on its own.** A live restore puts the whole
    database back to how it was at backup time. Everything people did after that would be lost.
    Only the owner can decide to do it. Before asking, write down:
    - the backup time;
    - everything made, changed or deleted since then (it would be lost, or deleted accounts
      would come back);
    - Stripe events since then;
    - how to re-apply any account deletions made after the backup.

    No tool in `ops/backup` can write to the live database. Backups are only ever restored to a
    throwaway database on this PC.

## Release notes for students (release 1)

- Notes, summaries, decks and study plans now save by themselves a moment after each change.
- Unsaved words are now kept **only in the browser tab** you are using. Closing the tab before
  saving loses a new note that was never saved. (Before, an unsaved new note was kept on the
  device.) A note the old version kept on your device is offered once when you open **Write a
  note**, so nothing you had is lost.
- If two tabs change the same note, Luma asks which version to keep instead of overwriting.

## Approvals still needed (none of these have happened)

- The backup time and how long to keep backups, and turning on the two scheduled tasks.
- The first real backup and its restore test (the owner runs `setup_credentials.py`, then
  `backup_run.py --production`), then the rehearsal on it, before release day.
- Where the second copy goes (USB drive or something else).
- The release 1 window (announced by hand), and later the maintenance window and each break.
- Turning auto-deploy off on Render and Vercel for the release, and on again after.
- Applying the new database changes to the live site, then updating the backend and the website.
- The privacy text changes (drafts kept in the tab only, how long backups are kept, backups kept
  on the owner's own drive).
- Whether to keep a list of account deletions so a restore could re-apply them.
