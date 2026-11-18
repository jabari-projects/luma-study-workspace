from __future__ import annotations

import datetime as dt
import json
import os
import subprocess

from conftest import run_script
from luma_backup import manifest as mf
from luma_backup import prune
from luma_backup.config import make_stamp

NOW = dt.datetime(2026, 12, 31, 12, 0, tzinfo=dt.timezone.utc)


def make_set(root, when, result="verified", partial=False, legacy=0):
    name = make_stamp(when) + (".partial" if partial else "")
    folder = root / name
    folder.mkdir(parents=True)
    (folder / "manifest.json").write_text(json.dumps({
        "result": result, "database": {"legacy_plaintext_password_rows": legacy}}), encoding="utf-8")
    return folder


def names(entries):
    return sorted(s["path"].name for s, _ in entries)


def test_keeps_seven_newest_and_weekly(jtmp):
    created = [make_set(jtmp, NOW - dt.timedelta(days=d)) for d in range(0, 60, 2)]  # 30 verified sets
    kept, delete = prune.plan(jtmp, NOW)
    kept_names = {s["path"].name for s in kept}
    for folder in created[:7]:
        assert folder.name in kept_names
    weeks = {(NOW - dt.timedelta(weeks=w)).isocalendar()[:2] for w in range(4)}
    for wk in weeks:
        newest = max((s for s in kept if s["when"].isocalendar()[:2] == wk), key=lambda s: s["stamp"], default=None)
        assert newest is not None
    assert len(kept) <= 7 + 4
    assert all(s["when"] < NOW - dt.timedelta(days=13) for s, _ in delete)


def test_failed_and_partial_go_after_seven_days(jtmp):
    make_set(jtmp, NOW - dt.timedelta(days=1))
    make_set(jtmp, NOW - dt.timedelta(days=2))
    young = make_set(jtmp, NOW - dt.timedelta(days=3), partial=True)
    old_partial = make_set(jtmp, NOW - dt.timedelta(days=8), partial=True)
    old_failed = make_set(jtmp, NOW - dt.timedelta(days=9), result="failed")
    _, delete = prune.plan(jtmp, NOW)
    assert names(delete) == sorted([old_partial.name, old_failed.name])
    assert young.name not in names(delete)


def test_always_keeps_two_newest_verified(jtmp):
    a = make_set(jtmp, NOW - dt.timedelta(days=200))
    b = make_set(jtmp, NOW - dt.timedelta(days=300))
    make_set(jtmp, NOW - dt.timedelta(days=1), result="failed")
    _, delete = prune.plan(jtmp, NOW)
    assert a.name not in names(delete) and b.name not in names(delete)


def test_ignores_other_folders_and_links(jtmp):
    (jtmp / "logs").mkdir()
    (jtmp / "notes-from-owner").mkdir()
    target = make_set(jtmp / "elsewhere", NOW - dt.timedelta(days=100), result="failed")
    link = jtmp / make_stamp(NOW - dt.timedelta(days=100))
    subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(target)], capture_output=True, check=True)
    try:
        sets = prune.scan(jtmp)
        assert all(s["path"] != link for s in sets)
        prune.delete([({"path": link}, "x")])
        assert target.exists()
    finally:
        os.rmdir(link)


def test_dry_run_deletes_nothing_and_apply_needs_a_verified_run(jtmp):
    root = jtmp / "root"
    for d in range(12):
        make_set(root, NOW - dt.timedelta(days=d * 9))
    before = sorted(p.name for p in root.iterdir())
    args = ["--root", str(root), "--now", "2026-12-31T12:00:00Z"]
    assert run_script("luma_backup.prune", args).returncode == 0
    assert sorted(p.name for p in root.iterdir()) == before
    refused = run_script("luma_backup.prune", [*args, "--apply"])
    assert refused.returncode == 1 and sorted(p.name for p in root.iterdir()) == before
    mf.record_attempt(root / "status.json", stamp=make_stamp(NOW), started_at="2026-12-31T12:00:00Z",
                      finished_at="2026-12-31T12:00:00Z", result="verified", error_code=None, message="ok")
    applied = run_script("luma_backup.prune", [*args, "--apply"])
    assert applied.returncode == 0
    left = [p for p in root.iterdir() if p.is_dir()]
    assert 2 <= len(left) < 12
    newest_two = sorted(before, reverse=True)[:2]
    assert all((root / n).exists() for n in newest_two)


def test_destroy_legacy_plaintext(jtmp):
    old = make_set(jtmp, NOW - dt.timedelta(days=5), legacy=9)
    older = make_set(jtmp, NOW - dt.timedelta(days=6), legacy=9)
    assert prune.plan_legacy(jtmp) == [], "nothing goes until a clean verified set exists"
    make_set(jtmp, NOW - dt.timedelta(days=1), legacy=0)
    newer_dirty = make_set(jtmp, NOW, legacy=2)
    assert names(prune.plan_legacy(jtmp)) == sorted([old.name, older.name])
    assert newer_dirty.name not in names(prune.plan_legacy(jtmp))
