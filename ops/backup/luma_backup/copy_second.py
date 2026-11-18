"""Copy verified, encrypted sets to a second place and check every SHA-256 there (design A.9).

    python -m luma_backup.copy_second --dest E:/LumaBackups2

Only the locked files, the manifest and the restore report are copied. Never plaintext.
"""

from __future__ import annotations

import argparse
import os
import shutil
import sys
from pathlib import Path

from . import manifest as mf
from .config import SET_FILES, STAMP_RE, UnsafePath, add_path_args, check_safe_location, paths_from_args
from .crypto import sha256_file


def _verified_sets(root: Path) -> list[tuple[Path, dict]]:
    out = []
    if not root.is_dir():
        return out
    for child in sorted(root.iterdir()):
        if not (child.is_dir() and STAMP_RE.match(child.name)):
            continue
        try:
            m = mf.validate(mf.read_json(child / "manifest.json"))
        except (OSError, ValueError, mf.ManifestError):
            continue
        if m["result"] == "verified" and m["restore_test"]["result"] == "passed":
            out.append((child, m))
    return out


def _matches(folder: Path, m: dict) -> bool:
    for f in m["files"]:
        p = folder / f["name"]
        if not p.is_file() or sha256_file(p) != (f["bytes"], f["sha256"]):
            return False
    return True


def copy_sets(root: Path, dest: Path) -> tuple[list[str], list[str], list[str]]:
    """Returns (copied, already_there, failed) stamps."""
    root_r = Path(root).resolve()
    dest_r = check_safe_location(dest, "second copy")
    if dest_r == root_r or root_r in dest_r.parents or dest_r in root_r.parents:
        raise UnsafePath("The second copy must be a different place from the first.")
    dest_r.mkdir(parents=True, exist_ok=True)
    copied, present, failed = [], [], []
    for src, m in _verified_sets(root):
        final = dest_r / src.name
        if final.is_dir() and _matches(final, m):
            present.append(src.name)
            continue
        tmp = dest_r / f"{src.name}.partial"
        shutil.rmtree(tmp, ignore_errors=True)
        tmp.mkdir()
        for name in SET_FILES:
            if (src / name).is_file():
                shutil.copy2(src / name, tmp / name)
        if not _matches(tmp, m):
            shutil.rmtree(tmp, ignore_errors=True)
            failed.append(src.name)
            continue
        shutil.rmtree(final, ignore_errors=True)
        os.replace(tmp, final)
        copied.append(src.name)
    return copied, present, failed


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Copy checked backups to a second drive.")
    add_path_args(parser)
    parser.add_argument("--dest", type=Path, required=True)
    args = parser.parse_args(argv)
    paths = paths_from_args(args)
    try:
        copied, present, failed = copy_sets(paths.backup_root, args.dest)
    except UnsafePath as exc:
        print(f"Copy stopped: {exc}")
        return 2
    except OSError:
        print(f"Copy stopped: could not write to {args.dest}. Is the drive plugged in?")
        return 2
    if failed:
        print(f"Copied {len(copied)}, but {len(failed)} did not match after copying: {', '.join(failed)}.")
        return 2
    print(f"Second copy is up to date: {len(copied)} copied, {len(present)} already there and checked.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
