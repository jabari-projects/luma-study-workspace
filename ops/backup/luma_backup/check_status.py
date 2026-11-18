"""Missed-run and failure check (design A.8). Never assumes a backup worked.

    python -m luma_backup.check_status [--notify]      (run from ops/backup)

Exit codes: 0 = OK, 1 = warning, 2 = failed. Prints one plain line.
"""

from __future__ import annotations

import argparse
import datetime as dt
import sys
from pathlib import Path

from . import manifest as mf
from .common import drive_present, lock_is_stale
from .config import (DEFAULT_WARN_HOURS, SET_DIR_RE, STALE_PARTIAL_HOURS, Paths, add_path_args, parse_iso,
                     parse_stamp, paths_from_args, utc_now)

OK, WARN, FAIL = 0, 1, 2

UNREADABLE_MESSAGE = ("Luma can't read the backup status file. Don't trust the backups until "
                      "a new backup runs and this check says OK.")


def _age_words(hours: float) -> str:
    if hours < 48:
        n = max(1, int(hours))
        return f"{n} hour{'s' if n != 1 else ''}"
    days = int(hours // 24)
    return f"{days} days"


def _has_files(folder: Path) -> Path | None:
    if not folder.is_dir():
        return None
    for child in folder.iterdir():
        return child
    return None


def evaluate(paths: Paths, now: dt.datetime) -> tuple[int, str]:
    if not drive_present(paths.backup_root):
        return FAIL, f"The backup drive {paths.backup_root.anchor[:2]} is not connected."
    status = mf.load_status(paths.status_file)
    last = status.get("last_attempt")
    if last and last.get("result") == "failed":
        return FAIL, f"The last backup did not work: {last.get('message') or 'no details'}"
    rt = status.get("last_restore_test")
    if rt and rt.get("result") == "failed":
        return FAIL, f"The last restore test of backup {rt.get('stamp')} did not work: {rt.get('message')}"

    # Unencrypted student data left on disk is a failure, not a warning, unless a run that
    # holds the lock right now is still using its work folder.
    running = paths.lock_file.exists() and not lock_is_stale(paths.lock_file, now)
    if not running:
        for base in (paths.work_base, paths.restore_base):
            leftover = _has_files(base)
            if leftover is not None:
                return FAIL, (f"An unlocked copy of student data is left over at {leftover}. "
                              "The next backup deletes it, or delete it by hand now.")

    warnings: list[str] = []
    warn_hours = status.get("warn_after_hours") or DEFAULT_WARN_HOURS
    verified = status.get("last_verified")
    if not verified:
        warnings.append("There is no checked backup yet.")
    else:
        age = (now - parse_iso(verified["finished_at"])).total_seconds() / 3600
        if age > warn_hours:
            warnings.append(f"Your newest checked backup is {_age_words(age)} old.")

    if paths.backup_root.is_dir():
        for child in sorted(paths.backup_root.iterdir()):
            if child.is_dir() and SET_DIR_RE.match(child.name) and child.name.endswith(".partial"):
                age = (now - parse_stamp(child.name[:16])).total_seconds() / 3600
                if age > STALE_PARTIAL_HOURS:
                    warnings.append(f"An unfinished backup folder is left over. Delete {child}.")
    if paths.lock_file.exists() and lock_is_stale(paths.lock_file, now):
        warnings.append(f"An old lock file is left over. If no backup is running, delete {paths.lock_file}.")

    if warnings:
        more = f" (and {len(warnings) - 1} more)" if len(warnings) > 1 else ""
        return WARN, warnings[0] + more
    return OK, f"Backups are OK. Newest checked backup: {verified['stamp']}."


def safe_evaluate(paths: Paths, now: dt.datetime) -> tuple[int, str]:
    """evaluate(), but a status file that can't be read (bad JSON, no permission, a broken
    date) is a FAIL with plain words, never a crash that looks like a warning (exit 1)."""
    try:
        return evaluate(paths, now)
    except Exception:  # noqa: BLE001 - any problem reading the status must be reported, not hidden
        return FAIL, UNREADABLE_MESSAGE


def notify(paths: Paths, code: int, message: str, show_box: bool = True) -> None:
    """Show a message box and leave ATTENTION.txt when something is wrong; clear it when OK."""
    if code == OK:
        try:
            paths.attention_file.unlink(missing_ok=True)
        except OSError:
            pass
        return
    if drive_present(paths.backup_root):
        try:
            paths.backup_root.mkdir(parents=True, exist_ok=True)
            paths.attention_file.write_text(message + "\n", encoding="utf-8")
        except OSError:
            pass  # the message box below still shows
    if show_box and sys.platform == "win32":
        import ctypes
        MB_ICONWARNING, MB_SETFOREGROUND = 0x30, 0x10000
        ctypes.windll.user32.MessageBoxW(None, message, "Luma backups need a look", MB_ICONWARNING | MB_SETFOREGROUND)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Check that Luma backups are recent and worked.")
    add_path_args(parser)
    parser.add_argument("--notify", action="store_true", help="show a message box and write ATTENTION.txt")
    parser.add_argument("--no-box", action="store_true", help=argparse.SUPPRESS)  # tests: file only
    parser.add_argument("--now", help=argparse.SUPPRESS)  # tests: a faked clock, e.g. 2026-11-22T10:00:00Z
    parser.add_argument("--set-interval", type=int, metavar="HOURS",
                        help="record the approved schedule (register_tasks.ps1 does this); 0 clears it")
    args = parser.parse_args(argv)
    paths = paths_from_args(args)
    if args.set_interval is not None:
        status = mf.load_status(paths.status_file)
        hours = args.set_interval or None
        status["expected_interval_hours"] = hours
        status["warn_after_hours"] = round(hours * 1.5) if hours else None
        mf.write_json(paths.status_file, status)
        print(f"Backups are expected every {hours} hours." if hours else "No backup schedule is recorded.")
        return OK
    now = parse_iso(args.now) if args.now else utc_now()
    code, message = safe_evaluate(paths, now)
    print(message)
    if args.notify:
        notify(paths, code, message, show_box=not args.no_box)
    return code


if __name__ == "__main__":
    sys.exit(main())
