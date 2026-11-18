"""Fixed paths and constants (design A.2). Every path can be overridden by a CLI flag for tests."""

from __future__ import annotations

import datetime as dt
import re
from dataclasses import dataclass
from pathlib import Path

PG_BIN = Path("J:/LumaOps/postgres/pgsql/bin")
GNUPG_HOME = Path("J:/LumaOps/gnupg-backup")
SECRETS_FILE = Path("J:/LumaOps/secrets/luma-backup.dpapi")
BACKUP_ROOT = Path("G:/LumaBackups")
WORK_BASE = Path("J:/LumaOps/backup-work")
RESTORE_BASE = Path("J:/LumaOps/restore-work")
VAULT_ROOT = Path("G:/LumaLocal")

DPAPI_ENTROPY = b"luma-backup-v1"
STALE_LOCK_HOURS = 6
STALE_PARTIAL_HOURS = 6
DEFAULT_WARN_HOURS = 48
MIN_FREE_BYTES = 1024**3
MAX_STORAGE_OBJECTS = 200_000
SYNTHETIC_SOURCE_PORT = 55432
RESTORE_PORTS = (55433, 55499)
LOCAL_HOST = "127.0.0.1"

STAMP_FORMAT = "%Y%m%dT%H%M%SZ"
STAMP_RE = re.compile(r"^\d{8}T\d{6}Z$")
SET_DIR_RE = re.compile(r"^\d{8}T\d{6}Z(\.partial)?$")

# The files a verified set holds. Nothing else is ever copied out of a set.
SET_FILES = ("db.dump.gpg", "storage.tar.gpg", "manifest.json", "restore-report.json")


class UnsafePath(Exception):
    """A configured path would put backup data somewhere it must never go."""


@dataclass(frozen=True)
class Paths:
    backup_root: Path = BACKUP_ROOT
    work_base: Path = WORK_BASE
    restore_base: Path = RESTORE_BASE
    pg_bin: Path = PG_BIN
    gnupg_home: Path = GNUPG_HOME
    secrets_file: Path = SECRETS_FILE

    @property
    def status_file(self) -> Path:
        return self.backup_root / "status.json"

    @property
    def lock_file(self) -> Path:
        return self.backup_root / ".lock"

    @property
    def logs_dir(self) -> Path:
        return self.backup_root / "logs"

    @property
    def attention_file(self) -> Path:
        return self.backup_root / "ATTENTION.txt"


def add_path_args(parser) -> None:
    """The same path flags on every command, so tests can point everything at test folders."""
    parser.add_argument("--root", type=Path, default=BACKUP_ROOT, help="where encrypted sets go")
    parser.add_argument("--work-base", type=Path, default=WORK_BASE, help="short-lived plaintext work folder")
    parser.add_argument("--restore-base", type=Path, default=RESTORE_BASE, help="throwaway restore folder")
    parser.add_argument("--pg-bin", type=Path, default=PG_BIN)
    parser.add_argument("--gnupg-home", type=Path, default=GNUPG_HOME)
    parser.add_argument("--secrets", type=Path, default=SECRETS_FILE)


def paths_from_args(args) -> Paths:
    return Paths(
        backup_root=args.root,
        work_base=args.work_base,
        restore_base=args.restore_base,
        pg_bin=args.pg_bin,
        gnupg_home=args.gnupg_home,
        secrets_file=args.secrets,
    )


def utc_now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0)


def make_stamp(now: dt.datetime) -> str:
    return now.astimezone(dt.timezone.utc).strftime(STAMP_FORMAT)


def parse_stamp(stamp: str) -> dt.datetime:
    return dt.datetime.strptime(stamp, STAMP_FORMAT).replace(tzinfo=dt.timezone.utc)


def iso(now: dt.datetime) -> str:
    return now.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(text: str) -> dt.datetime:
    return dt.datetime.strptime(text, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc)


def _inside(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def check_safe_location(path: Path, label: str) -> Path:
    """Refuse C:, the Obsidian vault, any git worktree and the public website folder."""
    resolved = Path(path).resolve()
    if resolved.drive.upper() == "C:":
        raise UnsafePath(f"The {label} folder must not be on C:. Use J: or G:.")
    if _inside(resolved, VAULT_ROOT.resolve()):
        raise UnsafePath(f"The {label} folder must not be inside the notes vault (G:/LumaLocal).")
    parts = [p.lower() for p in resolved.parts]
    for i in range(len(parts) - 1):
        if parts[i] == "frontend" and parts[i + 1] == "public":
            raise UnsafePath(f"The {label} folder must never be inside the public website folder.")
    for parent in [resolved, *resolved.parents]:
        if (parent / ".git").exists():
            raise UnsafePath(f"The {label} folder must not be inside a git folder ({parent}).")
    return resolved


def check_paths(paths: Paths) -> None:
    check_safe_location(paths.backup_root, "backup")
    check_safe_location(paths.work_base, "work")
    check_safe_location(paths.restore_base, "restore")
    check_safe_location(paths.gnupg_home, "gpg home")
