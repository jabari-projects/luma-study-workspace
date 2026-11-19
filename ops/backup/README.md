# ops/backup

Encrypted local backups of the Luma database and uploaded files, with an isolated restore test.
The owner's guide is [docs/backup.md](../../docs/backup.md). This file is for whoever changes the code.

Python standard library only (`requirements.txt` is empty on purpose). Windows only (DPAPI, Task
Scheduler). PostgreSQL 17 tools come from `J:/LumaOps/postgres/pgsql/bin`, gpg 2.4 from Git for Windows.

## Commands (run from this folder)

| Command | Who | What |
|---|---|---|
| `python setup_credentials.py` | owner only, in their own terminal | saves keys + makes the passphrase (DPAPI-sealed) |
| `python setup_credentials.py --check` | owner | tests the saved keys, prints OK lines only |
| `python backup_run.py --production` | owner / scheduled task | one full backup, restore test, status |
| `python restore_test_run.py --stamp <stamp>` | owner | practice restore of an existing set on 127.0.0.1 |
| `python rehearse_migrations.py --stamp <stamp> --after <name>` | owner, before a migration | restore + apply pending migrations in order, twice + per-row checksums, row counts, column types, defaults |
| `python -m luma_backup.check_status [--notify]` | owner / scheduled task | 0 OK, 1 warning, 2 failed |
| `python -m luma_backup.prune [--apply]` | owner, after retention is approved | dry run unless `--apply` |
| `python -m luma_backup.copy_second --dest E:/LumaBackups2` | owner | second copy, SHA-256 checked |
| `schedule/register_tasks.ps1 -Time HH:mm -CheckTime HH:mm` | owner | prints the plan; registers only with `-Register` |

Every command takes `--root --work-base --restore-base --pg-bin --gnupg-home --secrets`, so tests can
point everything at test folders.

## Rules the code enforces

- Secrets reach child processes only through `PGPASSWORD` in an env built from scratch (plus
  `SYSTEMROOT`, `COMSPEC`, `PATH=<pg bin>`, `TEMP`) or gpg's stdin. Never on a command line, in a log,
  manifest, status file or exception message. Known secret values are also redacted by exact match.
- A restore target is always `127.0.0.1`. Nothing here can write to a remote database.
- Refuses to put backups on `C:`, in `G:/LumaLocal`, inside a git folder or in `frontend/public`.
- Plaintext lives only in `J:/LumaOps/backup-work/<stamp>` and `J:/LumaOps/restore-work/<stamp>` and is
  deleted (and checked gone) in `finally` blocks. `check_status` warns if anything is left there.
- Manifests, reports and status hold names and numbers only; writing `@`, a postgres URL, a JWT, an
  `sb_secret_` key or an argon2 string is refused.
- `.partial` becomes a final set folder only after the restore test passes.

## Tests

From the worktree root:

```
J:/LumaPilot/wt-feedback/backend/.venv/Scripts/python.exe -m pytest ops/backup/tests -q -p no:cacheprovider
```

They build a fake Luma database (from `backend/scripts/fixtures/live_shape_2026_11_15.json` plus every
migration file) on 127.0.0.1:55432, a fake Storage API on 127.0.0.1, and write encrypted test sets to
`G:/LumaBackups/_test/<run-id>` (deleted afterwards unless `LUMA_BACKUP_KEEP_TEST=1`). Clusters and
work folders go to `J:/LumaOps/backup-test/<run-id>` and are deleted. If `pg_dump.exe` is missing the
database tests skip with a reason.

## Differences from the design (J:/LumaPilot/safety-design.md, section A)

- Child env also carries `COMSPEC`: `initdb` crashes without it on Windows.
- Restore prep adds `auth.uid()/role()/jwt()` stubs, so a row level security policy that mentions
  them still restores. They are never called.
- Manifest `files[]` also records `plain_bytes`/`plain_sha256`, so the restore test can prove the
  unlocked copy is byte-for-byte the original.
- The "5 search triggers" sanity check compares with the source's triggers (recorded in the manifest)
  and notes whether there are 5, instead of failing a faithful backup of a database that has fewer.
- `restore_test_run.py` records `last_restore_test` in `status.json`; `check_status` exits 2 if it failed.
- `check_status --set-interval HOURS` records the approved schedule (called by `register_tasks.ps1`).
