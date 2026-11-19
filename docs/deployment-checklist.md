# Deployment checklist

Use this list for every Luma update that changes the database. Every step needs the owner's OK.
Nothing here happens on its own.

Plain rule: updates add things. They never delete student work.

## Before the day

1. **Plan the change.** Write each part down as one of:
   - *Add* (new tables or new columns with a default). Normal updates only do this.
   - *Code* (new backend or website code).
   - *Clean up* (removing something old). This is never part of a normal update. It gets its
     own update, its own OK and its own fresh backup.

   Normal updates never drop a column, a table or any rows.

2. **Practice on a copy.** On this PC, take the newest checked backup and try the new database
   changes on a throwaway copy:

   ```
   python rehearse_migrations.py --stamp <newest backup> --after <last migration already live>
   ```

   (Run it in `ops\backup`.) It must say "Rehearsal passed." That means every old row is still
   there and unchanged, and each change ran twice without trouble. The PGlite checkers for the
   new migration files must pass too.

3. **Pick a break time** (only for risky database changes), inside the approved maintenance
   window. Tell students at least 48 hours ahead.

## On the day

4. **Get ready.** Start the "getting ready" phase, so people can finish saving. Wait until the
   grace time is over. From then on every save, AI job and payment webhook is refused, so
   nothing new can be written.

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
   when the backup started, nothing made after the backup can be lost.

6. **Change the database.** The owner pastes the new SQL into the Supabase SQL editor and runs
   it. Then runs the file's VERIFY part and checks the numbers. With more than one file, run
   them one at a time in name order. For this release (live today: up to
   `2026_11_17_content_reports.sql`), that is:
   1. `2026_11_18_monthly_feedback.sql` (the monthly feedback poll: new `feedback_*` tables only)
   2. `2026_11_19_maintenance_state.sql` (the maintenance break tables)
   3. `2026_11_19_student_work_versions.sql` (new columns on notes, summaries, flashcards and
      study plans)

   All three only add things; each is safe to run twice. The practice run in step 2
   (`--after 2026_11_17`) runs exactly these three, in this order.

7. **Update the backend first** (Render), **then the website** (Vercel). The new backend works
   with both the old and the new website, so the order is safe. The database change (step 6)
   must come before the backend: a new server that can't read the break settings (tables
   missing, or the database slow) keeps reading open but refuses saves with "try again in a
   minute" until it can, so it never lets work through during a break by mistake.

8. **Run the checks.** Reopen only if they all pass. Then in Stripe (Developers > Webhooks),
   check that any events that got "try again later" during the break were sent again and
   worked. Resend any that still failed. Never turn the webhook off.

## Later

9. **Clean up** (a normal update, at least 7 days later): make the version check required,
   remove the temporary overlap code and the old-draft cleanup, and close the Task Board items.

## If something goes wrong

10. **Roll back the code, not the data.** To undo code, redeploy the last good Render and
    Vercel builds. That is safe, because the added columns stay and old code ignores them.
    A bad database change gets a new fix-forward SQL file, never a delete. If an update fails
    during the break: stay in maintenance, roll the code back, run the checks, then reopen.

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

## Approvals still needed (none of these have happened)

- The backup time and how long to keep backups, and turning on the two scheduled tasks.
- The first real backup (the owner runs `setup_credentials.py`, then `backup_run.py --production`).
- Where the second copy goes (USB drive or something else).
- The maintenance window, and each actual break.
- Applying the new database changes to the live site, then updating the backend and the website.
- The privacy text changes (drafts kept in the tab only, how long backups are kept, backups kept
  on the owner's own drive).
- Whether to keep a list of account deletions so a restore could re-apply them.
