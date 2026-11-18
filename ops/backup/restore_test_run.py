"""Restore-test an existing backup set by its stamp (design A.7), in a throwaway local cluster.

    python restore_test_run.py --stamp 20261119T033000Z

It never touches the live database. The result goes into the set folder as
restore-report-<test stamp>.json and into status.json as last_restore_test.
Exit codes: 0 = passed, 2 = failed.
"""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from luma_backup import manifest as mf  # noqa: E402
from luma_backup import restore_test, secrets_store  # noqa: E402
from luma_backup.common import clear_leftover_work, close_logging, drive_present, run_lock, setup_logging  # noqa: E402
from luma_backup.config import (STAMP_RE, UnsafePath, add_path_args, check_paths, iso, make_stamp,  # noqa: E402
                                paths_from_args, utc_now)
from luma_backup.crypto import Gpg  # noqa: E402
from luma_backup.errors import BackupError  # noqa: E402

log = logging.getLogger("luma_backup")


def find_set(root: Path, stamp: str) -> Path:
    for name in (stamp, f"{stamp}.partial"):
        if (root / name).is_dir():
            return root / name
    raise BackupError("verify_failed", f"There is no backup called {stamp}.")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Practice-restore one backup set on this PC only.")
    parser.add_argument("--stamp", required=True)
    add_path_args(parser)
    args = parser.parse_args(argv)
    paths = paths_from_args(args)
    if not STAMP_RE.match(args.stamp):
        print("Restore test stopped: the stamp looks like 20261119T033000Z.")
        return 2
    try:
        check_paths(paths)
    except UnsafePath as exc:
        print(f"Restore test stopped: {exc}")
        return 2
    if not drive_present(paths.backup_root):
        print(f"Restore test stopped: the backup drive {paths.backup_root.anchor} is not connected.")
        return 2

    now = utc_now()
    run_stamp = make_stamp(now)
    setup_logging(paths, f"{run_stamp}-restore")
    log.info("restore test of %s started", args.stamp)
    error: BackupError | None = None
    try:
        with run_lock(paths, run_stamp, "restore test"):
            clear_leftover_work(paths)  # unlocked copies a killed run left behind
            set_dir = find_set(paths.backup_root, args.stamp)
            try:
                manifest = mf.validate(mf.read_json(set_dir / "manifest.json"))
            except (OSError, ValueError, mf.ManifestError):
                raise BackupError("verify_failed", "The backup's manifest is missing or damaged.") from None
            try:
                secrets = secrets_store.load(paths.secrets_file)
                secrets.register()
                passphrase = secrets.passphrase_for(manifest["encryption"]["passphrase_id"])
            except secrets_store.SecretsUnavailable as exc:
                raise BackupError("secrets_unavailable", str(exc)) from None
            gpg = Gpg(paths.gnupg_home)
            try:
                report, error = restore_test.run(set_dir, manifest, passphrase, paths.pg_bin, gpg,
                                                 paths.restore_base, run_stamp, iso(utc_now()))
            finally:
                gpg.kill_agent()
            mf.write_json(set_dir / f"restore-report-{run_stamp}.json", report)
    except BackupError as exc:
        error = exc
    try:
        if error is None:
            message = f"Backup {args.stamp} restored and checked on this PC."
            mf.record_restore_test(paths.status_file, stamp=args.stamp, tested_at=iso(utc_now()), result="passed",
                                   error_code=None, message=message)
            log.info(message)
            return 0
        if error.detail:
            log.info("details: %s", error.detail)
        mf.record_restore_test(paths.status_file, stamp=args.stamp, tested_at=iso(utc_now()), result="failed",
                               error_code=error.code, message=error.message)
        log.info("Restore test failed (%s): %s", error.code, error.message)
        return 2
    finally:
        close_logging()


if __name__ == "__main__":
    sys.exit(main())
