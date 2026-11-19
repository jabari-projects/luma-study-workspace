"""Rehearse pending migrations on a copy of a backup, on this PC only (deployment checklist step 2).

    python rehearse_migrations.py --stamp 20261119T033000Z --after 2026_11_17
    python rehearse_migrations.py --stamp 20261119T033000Z --migration path/to/file.sql [...]

It restores the backup into a throwaway database on 127.0.0.1, runs the migration files in order, twice,
and checks every existing row is still there and unchanged (per-row checksums) and that no table
gained or lost rows. It prints table names, counts and pass/fail only.
Nothing here can reach the live database.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from luma_backup import manifest as mf  # noqa: E402
from luma_backup import rehearsal, secrets_store  # noqa: E402
from luma_backup.common import run_lock  # noqa: E402
from luma_backup.config import UnsafePath, add_path_args, check_paths, make_stamp, paths_from_args, utc_now  # noqa: E402
from luma_backup.crypto import Gpg  # noqa: E402
from luma_backup.errors import BackupError  # noqa: E402
from luma_backup.synthetic import migration_files  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Try pending migrations on a local copy of a backup.")
    parser.add_argument("--stamp", required=True)
    which = parser.add_mutually_exclusive_group(required=True)
    which.add_argument("--after", help="run every migration file whose name sorts after this, e.g. 2026_11_17")
    which.add_argument("--migration", type=Path, action="append", help="a migration file (repeat for more)")
    add_path_args(parser)
    args = parser.parse_args(argv)
    paths = paths_from_args(args)
    try:
        check_paths(paths)
    except UnsafePath as exc:
        print(f"Rehearsal stopped: {exc}")
        return 2
    migrations = migration_files(after=args.after) if args.after else list(args.migration)
    if not migrations:
        print("There are no migration files to try.")
        return 2
    set_dir = paths.backup_root / args.stamp
    run_stamp = make_stamp(utc_now())
    try:
        with run_lock(paths, run_stamp, "migration rehearsal"):
            manifest = mf.validate(mf.read_json(set_dir / "manifest.json"))
            secrets = secrets_store.load(paths.secrets_file)
            secrets.register()
            gpg = Gpg(paths.gnupg_home)
            try:
                result = rehearsal.run(set_dir, manifest, secrets.passphrase_for(manifest["encryption"]["passphrase_id"]),
                                       paths.pg_bin, gpg, paths.restore_base, run_stamp, migrations)
            finally:
                gpg.kill_agent()
    except (BackupError, secrets_store.SecretsUnavailable, mf.ManifestError, OSError, ValueError) as exc:
        print(f"Rehearsal stopped: {getattr(exc, 'message', None) or exc.__class__.__name__}")
        return 2
    for check in result["checks"]:
        print(f"{'PASS' if check['ok'] else 'FAIL'}  {check['name']}  {check['detail']}".rstrip())
    for table, n in sorted(result.get("tables", {}).items()):
        print(f"rows  {table}  before={n['rows_before']} after={n['rows_after']}")
    for table, info in sorted(result.get("new_schema", {}).items()):
        if info["new_table"]:
            print(f"new table  {table}  rows={info['rows']} columns={len(info['columns'])}")
        else:
            print(f"new columns  {table}  {', '.join(info['columns'])}")
    if result.get("error"):
        print(result["error"])
    print("Rehearsal passed." if result["passed"] else "Rehearsal FAILED. Do not run these migrations on Luma.")
    return 0 if result["passed"] else 2


if __name__ == "__main__":
    sys.exit(main())
