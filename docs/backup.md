# Backups

A backup is a saved copy of Luma. It holds every account, note, flashcard and summary, plus the
pictures people upload. If something goes wrong, a backup lets you get that work back.

Backups are not website updates. Making a backup never changes the live site.

Run every command below in a terminal opened in the `ops\backup` folder of the Luma code.

## What a backup does

Each time it runs, the backup tool:

1. Copies the database (all the study work).
2. Copies the uploaded files (pictures) into a separate file.
3. Locks both files with a long secret word, called the passphrase.
4. Checks that the locked files open and match what was copied.
5. Does a practice restore on this PC only, in a throwaway database, and checks every table.
6. Deletes the unlocked copies.
7. Writes down what happened, so you always know if the last backup worked.

The practice restore never touches the live site. It never sends email, never calls Stripe and
never uses any paid service.

## Where the files are

| What | Where |
|---|---|
| Locked backups | `G:\LumaBackups\<date and time>\` |
| How the last backup went | `G:\LumaBackups\status.json` |
| A note when something is wrong | `G:\LumaBackups\ATTENTION.txt` |
| Logs (no student data, no passwords) | `G:\LumaBackups\logs\` |
| Your saved keys (locked to your Windows user) | `J:\LumaOps\secrets\luma-backup.dpapi` |
| The backup tools | `ops\backup\` in the Luma code |

Each backup folder has four files:

- `db.dump.gpg`: the locked database copy.
- `storage.tar.gpg`: the locked uploaded files.
- `manifest.json`: when it ran, how many rows each table had, and file checksums. No names,
  emails or note text.
- `restore-report.json`: what the practice restore checked and whether it passed.

The folder name is the time in UTC (6 hours ahead of Central in winter, 5 in summer).
`20261119T033000Z` means 3:30 AM UTC on 19 November 2026.

A folder ending in `.partial` did not finish. You can delete it once the next backup works.

Never put backups in GitHub, in the Obsidian notes on `G:\LumaLocal`, or on the website.
The tools refuse to save there.

## One-time setup

You need: this PC, drive `G:`, drive `J:`, and about 10 minutes.

1. Use only the newest keys. If the database password or the secret key was ever shown or
   shared somewhere, make a new one in Supabase first (Project settings > Database, and Project
   settings > API keys). A new secret key must also go on Render, or the website stops working,
   so ask for help with that step.
2. Open a terminal in `ops\backup`.
3. Run:

   ```
   python setup_credentials.py
   ```

4. It asks for the Session pooler details from Supabase > Connect > Session pooler: host, port
   (5432), user, database (postgres) and password. Then your project URL and the secret key.
   What you type for passwords and keys does not show on screen.
5. It shows your new backup passphrase **one time**. Save it right away in your password
   manager as "Luma backup passphrase" plus the name it shows (like `lb-2026-11-a`).
6. Press Enter. The screen clears.
7. Check it worked:

   ```
   python setup_credentials.py --check
   ```

   You should see `Database: OK` and `Files: OK`.

## Your first backup

In `ops\backup`:

```
python backup_run.py --production
```

It takes a few minutes. The last line says if it worked, for example:
"Backup 20261119T033000Z is saved, locked and checked: 18 tables, 412 rows, 0 uploaded files."

If it did not work, the last line says why in plain words, and the log in
`G:\LumaBackups\logs\` has more.

## Check that backups are OK

```
python -m luma_backup.check_status
```

| It says | What to do |
|---|---|
| "Backups are OK." | Nothing. |
| "Your newest checked backup is 3 days old." | Run a backup. |
| "The last backup did not work: ..." | Read the reason, fix it, run a backup again. |
| "An unfinished backup folder is left over. Delete ..." | Delete that folder. |
| "The backup drive G: is not connected." | Plug in or turn on drive G:. |

The tool never guesses that a backup worked. If it can't prove it, it tells you.

## Practice restore of an older backup

Any time, you can check that an older backup still opens and restores:

```
python restore_test_run.py --stamp 20261119T033000Z
```

This uses a throwaway database on this PC only. It never touches the live site.

A real restore onto the live site is different. It would undo everything people did since that
backup. The tools can't do it. It needs your clear OK, and a plan for what would be lost. See
`docs/deployment-checklist.md`, step 11.

## Keep the passphrase safe

- The passphrase is in two places: your password manager, and the locked keys file on `J:`.
- The keys file only opens for your Windows user on this PC. If this PC breaks, only the
  password manager copy can open your backups. So keep it there.
- Never put the passphrase in a note, an email, GitHub or the Obsidian vault.
- To see it again on this PC: `python setup_credentials.py --show-passphrase lb-2026-11-a`
- To make a new one: `python setup_credentials.py --rotate-passphrase`. Older backups still
  open with their old passphrase, so keep the old ones in the password manager too.

## Make a second copy (recommended)

One copy on one drive is not enough. If drive `G:` breaks, the backups go with it.

The suggestion: an external USB drive that stays unplugged except on copy days.

1. Plug in the USB drive. Say it shows up as `E:`.
2. In `ops\backup`, run:

   ```
   python -m luma_backup.copy_second --dest E:\LumaBackups2
   ```

3. It copies only checked backups (locked files, manifest and report), then re-checks every
   file on the USB drive. It never copies anything unlocked.
4. Unplug the drive and keep it somewhere safe, away from this PC.

Do this once a week, or after any big change. A paid cloud copy is possible later, but only with
your OK.

## Running backups on a schedule (needs your OK first)

The scheduled tasks are ready but not turned on. Before they are, please choose:

- **Backup time.** Suggested: 9:30 PM Central, every day (the PC is more likely to be on then
  than late at night).
- **Check time.** Suggested: when you log on, and at 10:00 AM.
- **How long to keep backups.** Suggested: the newest 7, plus one from each of the last 4
  weeks (about 35 days). Unfinished or failed ones go after 7 days. The 2 newest good ones are
  always kept.

After you say yes, the setup is:

```
powershell -ExecutionPolicy Bypass -File schedule\register_tasks.ps1 -Time 21:30 -CheckTime 10:00
```

That only shows the plan. Add `-Register` at the end to turn it on. Both tasks run only while you
are logged on. If the PC was off at backup time, the backup runs at the next chance. If a backup
fails or is missed, a message pops up and `G:\LumaBackups\ATTENTION.txt` explains it.

To turn it off again: `powershell -ExecutionPolicy Bypass -File schedule\unregister_tasks.ps1`

To remove old backups by hand: `python -m luma_backup.prune` shows what it would delete.
`python -m luma_backup.prune --apply` deletes them (only right after a good backup).

## Old plain-text passwords

Some older accounts may still have passwords saved in plain text. Each manifest counts them
(`legacy_plaintext_password_rows`), without showing any. After all passwords are hashed and a
new backup shows 0, delete the older backups that still hold them:

```
python -m luma_backup.prune --destroy-legacy-plaintext --apply
```

## For developers

- Code and tests: `ops/backup/` (Python standard library only). See `ops/backup/README.md`.
- Tests use fake data only and never touch production:
  `python -m pytest ops/backup/tests -q -p no:cacheprovider`
