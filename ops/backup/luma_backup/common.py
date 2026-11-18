"""Shared pieces for the command scripts: the run lock, the redacted log and preflight checks."""

from __future__ import annotations

import json
import logging
import os
import shutil
import sys
from contextlib import contextmanager
from pathlib import Path

from .config import MIN_FREE_BYTES, STALE_LOCK_HOURS, Paths, iso, parse_iso, utc_now
from .errors import BackupError
from .redact import RedactingFilter

log = logging.getLogger("luma_backup")


def setup_logging(paths: Paths, stamp: str, quiet: bool = False) -> Path:
    paths.logs_dir.mkdir(parents=True, exist_ok=True)
    log_path = paths.logs_dir / f"{stamp}.log"
    log.handlers.clear()
    log.setLevel(logging.INFO)
    log.propagate = False
    fh = logging.FileHandler(log_path, encoding="utf-8")
    fh.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    fh.addFilter(RedactingFilter())
    log.addHandler(fh)
    if not quiet:
        sh = logging.StreamHandler(sys.stdout)
        sh.setFormatter(logging.Formatter("%(message)s"))
        sh.addFilter(RedactingFilter())
        log.addHandler(sh)
    return log_path


def close_logging() -> None:
    for h in list(log.handlers):
        h.close()
        log.removeHandler(h)


def drive_present(path: Path) -> bool:
    anchor = Path(path).anchor
    return bool(anchor) and Path(anchor).exists()


def check_free_space(*folders: Path) -> None:
    for folder in folders:
        folder.mkdir(parents=True, exist_ok=True)
        if shutil.disk_usage(folder).free < MIN_FREE_BYTES:
            raise BackupError("disk_low", f"Less than 1 GB is free on {Path(folder).anchor}")


def read_lock(lock_file: Path) -> dict | None:
    try:
        return json.loads(lock_file.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def lock_is_stale(lock_file: Path, now=None) -> bool:
    now = now or utc_now()
    info = read_lock(lock_file) or {}
    try:
        started = parse_iso(info["started_at"])
    except (KeyError, ValueError, TypeError):
        started = None
    if started is None:
        import datetime as dt
        started = dt.datetime.fromtimestamp(lock_file.stat().st_mtime, dt.timezone.utc)
    return (now - started).total_seconds() > STALE_LOCK_HOURS * 3600


@contextmanager
def run_lock(paths: Paths, stamp: str, what: str):
    paths.backup_root.mkdir(parents=True, exist_ok=True)
    try:
        fd = os.open(paths.lock_file, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        if lock_is_stale(paths.lock_file):
            raise BackupError("locked", f"An old lock file is left at {paths.lock_file}. "
                                        "If no backup is running, delete it.") from None
        raise BackupError("locked") from None
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump({"stamp": stamp, "what": what, "pid": os.getpid(), "started_at": iso(utc_now())}, fh)
    try:
        yield
    finally:
        try:
            paths.lock_file.unlink()
        except OSError:
            log.info("could not remove the lock file")


def remove_tree_checked(folder: Path) -> None:
    """Delete a plaintext folder and prove it is gone."""
    shutil.rmtree(folder, ignore_errors=True)
    if Path(folder).exists():
        raise BackupError("cleanup_failed", f"Could not delete the unlocked copy at {folder}. Delete it by hand.")
