"""Retention (design A.9). Dry run by default; --apply deletes. The owner approves retention first.

    python -m luma_backup.prune                 (shows what it would delete)
    python -m luma_backup.prune --apply
    python -m luma_backup.prune --destroy-legacy-plaintext --apply

Rules: keep the newest 7 verified sets, plus the newest verified set from each of the last 4 ISO
weeks, and always the 2 newest verified sets. Failed or unfinished sets go after 7 days. Only
folders named like 20261119T033000Z or 20261119T033000Z.partial are touched, never links.
"""

from __future__ import annotations

import argparse
import datetime as dt
import os
import shutil
import sys
from pathlib import Path

from . import manifest as mf
from .config import SET_DIR_RE, Paths, add_path_args, parse_iso, parse_stamp, paths_from_args, utc_now

KEEP_NEWEST = 7
KEEP_WEEKS = 4
KEEP_MIN = 2
FAILED_DAYS = 7


def _is_link(path: Path) -> bool:
    return path.is_symlink() or (hasattr(path, "is_junction") and path.is_junction())


def _contains_link(folder: Path) -> bool:
    for root, dirs, files in os.walk(folder, followlinks=False):
        for name in dirs + files:
            if _is_link(Path(root) / name):
                return True
    return False


def scan(root: Path) -> list[dict]:
    sets = []
    if not root.is_dir():
        return sets
    for child in root.iterdir():
        if not SET_DIR_RE.match(child.name) or _is_link(child) or not child.is_dir():
            continue
        partial = child.name.endswith(".partial")
        result = "partial"
        legacy = None
        try:
            m = mf.read_json(child / "manifest.json")
            legacy = m.get("database", {}).get("legacy_plaintext_password_rows")
            if not partial:
                result = m.get("result", "failed")
        except (OSError, ValueError):
            result = "partial" if partial else "failed"
        sets.append({"path": child, "stamp": child.name[:16], "when": parse_stamp(child.name[:16]),
                     "verified": result == "verified" and not partial, "legacy": legacy})
    return sorted(sets, key=lambda s: s["stamp"], reverse=True)


def plan(root: Path, now: dt.datetime) -> tuple[list[dict], list[tuple[dict, str]]]:
    """Returns (keep, delete-with-reason)."""
    sets = scan(root)
    verified = [s for s in sets if s["verified"]]
    keep = {id(s) for s in verified[:max(KEEP_NEWEST, KEEP_MIN)]}
    week_keys = []
    for back in range(KEEP_WEEKS):
        iy, iw, _ = (now - dt.timedelta(weeks=back)).isocalendar()
        week_keys.append((iy, iw))
    for key in week_keys:
        for s in verified:  # newest first
            iy, iw, _ = s["when"].isocalendar()
            if (iy, iw) == key:
                keep.add(id(s))
                break
    deletions: list[tuple[dict, str]] = []
    for s in sets:
        if s["verified"]:
            if id(s) not in keep:
                deletions.append((s, "older than the kept backups"))
        elif (now - s["when"]).days >= FAILED_DAYS:
            deletions.append((s, "failed or unfinished, older than 7 days"))
    kept = [s for s in sets if all(s is not d for d, _ in deletions)]
    return kept, deletions


def plan_legacy(root: Path) -> list[tuple[dict, str]]:
    """Sets that still hold plain-text passwords, once a newer verified set holds none."""
    sets = scan(root)
    clean = [s for s in sets if s["verified"] and s["legacy"] == 0]
    if not clean:
        return []
    newest_clean = clean[0]["stamp"]
    return [(s, "holds plain-text passwords") for s in sets
            if (s["legacy"] or 0) > 0 and s["stamp"] < newest_clean]


def delete(entries: list[tuple[dict, str]]) -> list[str]:
    done = []
    for s, _ in entries:
        path: Path = s["path"]
        if _is_link(path) or _contains_link(path):
            continue  # never follow or remove links
        shutil.rmtree(path)
        done.append(path.name)
    return done


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Remove old Luma backups (dry run unless --apply).")
    add_path_args(parser)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--destroy-legacy-plaintext", action="store_true")
    parser.add_argument("--now", help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    paths: Paths = paths_from_args(args)
    now = parse_iso(args.now) if args.now else utc_now()
    status = mf.load_status(paths.status_file)
    if args.apply and (status.get("last_attempt") or {}).get("result") != "verified":
        print("Nothing deleted: prune only runs right after a checked backup.")
        return 1
    entries = plan_legacy(paths.backup_root) if args.destroy_legacy_plaintext else plan(paths.backup_root, now)[1]
    if not entries:
        print("Nothing to delete.")
        return 0
    for s, reason in entries:
        print(f"{'Deleting' if args.apply else 'Would delete'} {s['path'].name}: {reason}")
    if args.apply:
        print(f"Deleted {len(delete(entries))} backup folders.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
