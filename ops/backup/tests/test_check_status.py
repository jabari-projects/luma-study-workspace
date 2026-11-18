from __future__ import annotations

import datetime as dt
import json
from pathlib import Path

from conftest import run_script
from luma_backup import manifest as mf
from luma_backup.check_status import FAIL, OK, WARN, evaluate
from luma_backup.config import Paths, iso, make_stamp

NOW = dt.datetime(2026, 11, 22, 16, 0, tzinfo=dt.timezone.utc)


def paths(jtmp) -> Paths:
    return Paths(backup_root=jtmp / "root", work_base=jtmp / "work", restore_base=jtmp / "restore")


def verified(p: Paths, when: dt.datetime):
    mf.record_attempt(p.status_file, stamp=make_stamp(when), started_at=iso(when), finished_at=iso(when),
                      result="verified", error_code=None, message="ok")


def test_ok_when_recent(jtmp):
    p = paths(jtmp)
    verified(p, NOW - dt.timedelta(hours=5))
    code, msg = evaluate(p, NOW)
    assert code == OK and "OK" in msg


def test_no_backup_yet_warns(jtmp):
    code, msg = evaluate(paths(jtmp), NOW)
    assert code == WARN and "no checked backup" in msg


def test_three_days_old_warns(jtmp):
    p = paths(jtmp)
    verified(p, NOW - dt.timedelta(days=3, hours=2))
    assert evaluate(p, NOW) == (WARN, "Your newest checked backup is 3 days old.")


def test_approved_schedule_interval_used(jtmp):
    p = paths(jtmp)
    verified(p, NOW - dt.timedelta(hours=40))
    st = mf.load_status(p.status_file)
    st["expected_interval_hours"], st["warn_after_hours"] = 24, 36
    mf.write_json(p.status_file, st)
    code, msg = evaluate(p, NOW)
    assert code == WARN and "40 hours" in msg


def test_failed_last_attempt(jtmp):
    p = paths(jtmp)
    verified(p, NOW - dt.timedelta(hours=30))
    mf.record_attempt(p.status_file, stamp=make_stamp(NOW), started_at=iso(NOW), finished_at=iso(NOW),
                      result="failed", error_code="db_connect_failed", message="Could not connect.")
    assert evaluate(p, NOW) == (FAIL, "The last backup did not work: Could not connect.")


def test_leftovers_warn(jtmp):
    p = paths(jtmp)
    verified(p, NOW - dt.timedelta(hours=1))
    (p.backup_root / f"{make_stamp(NOW - dt.timedelta(hours=7))}.partial").mkdir(parents=True)
    code, msg = evaluate(p, NOW)
    assert code == WARN and ".partial" in msg


def test_young_partial_is_fine(jtmp):
    p = paths(jtmp)
    verified(p, NOW - dt.timedelta(hours=1))
    (p.backup_root / f"{make_stamp(NOW - dt.timedelta(hours=1))}.partial").mkdir(parents=True)
    assert evaluate(p, NOW)[0] == OK


def test_stale_lock_and_plaintext_warn(jtmp):
    p = paths(jtmp)
    verified(p, NOW - dt.timedelta(hours=1))
    p.lock_file.write_text(json.dumps({"started_at": iso(NOW - dt.timedelta(hours=7))}), encoding="utf-8")
    code, msg = evaluate(p, NOW)
    assert code == WARN and "lock" in msg
    p.lock_file.unlink()
    (p.work_base / "20261122T150000Z").mkdir(parents=True)
    code, msg = evaluate(p, NOW)
    assert code == FAIL and "unlocked copy of student data" in msg  # never hidden as a warning


def test_unlocked_copy_outranks_other_problems_and_is_fine_while_a_run_holds_the_lock(jtmp):
    p = paths(jtmp)
    (p.restore_base / "20261122T150000Z").mkdir(parents=True)
    code, msg = evaluate(p, NOW)  # also "no checked backup yet", but the leftover comes first
    assert code == FAIL and "unlocked copy" in msg
    # A backup running right now (a fresh lock) is using its work folder: not a leftover.
    p.backup_root.mkdir(parents=True, exist_ok=True)
    p.lock_file.write_text(json.dumps({"started_at": iso(NOW - dt.timedelta(minutes=5))}), encoding="utf-8")
    code, msg = evaluate(p, NOW)
    assert code == WARN and "no checked backup" in msg


def _status_args(p):
    return ["--root", str(p.backup_root), "--work-base", str(p.work_base), "--restore-base", str(p.restore_base),
            "--notify", "--no-box", "--now", iso(NOW)]


def test_corrupt_status_file_fails_and_still_notifies(jtmp):
    p = paths(jtmp)
    p.backup_root.mkdir(parents=True)
    p.status_file.write_text("{not json", encoding="utf-8")
    result = run_script("luma_backup.check_status", _status_args(p))
    assert result.returncode == 2  # FAIL, not the "warning" code a crash would give
    assert "can't read the backup status file" in result.stdout
    assert "Traceback" not in result.stdout + result.stderr
    assert "can't read the backup status file" in p.attention_file.read_text(encoding="utf-8")


def test_broken_date_in_status_file_fails(jtmp):
    p = paths(jtmp)
    verified(p, NOW)
    st = mf.load_status(p.status_file)
    st["last_verified"]["finished_at"] = "yesterday-ish"
    mf.write_json(p.status_file, st)
    result = run_script("luma_backup.check_status", _status_args(p))
    assert result.returncode == 2 and "can't read the backup status file" in result.stdout


def test_unreadable_status_file_fails(jtmp, monkeypatch, capsys):
    from luma_backup import check_status

    p = paths(jtmp)
    p.backup_root.mkdir(parents=True)

    def refused(_path):
        raise PermissionError("simulated: G: refused the read")

    monkeypatch.setattr(mf, "load_status", refused)
    assert check_status.main(_status_args(p)) == FAIL
    assert "can't read the backup status file" in capsys.readouterr().out
    assert "can't read the backup status file" in p.attention_file.read_text(encoding="utf-8")


def test_missing_drive(jtmp):
    letter = next(c for c in "ZYXWVUTSRQPONMLK" if not Path(f"{c}:/").exists())
    p = Paths(backup_root=Path(f"{letter}:/LumaBackups"), work_base=jtmp, restore_base=jtmp)
    code, msg = evaluate(p, NOW)
    assert code == FAIL and "not connected" in msg


def test_notify_writes_and_clears_attention(jtmp):
    p = paths(jtmp)
    args = ["--root", str(p.backup_root), "--work-base", str(p.work_base), "--restore-base", str(p.restore_base),
            "--notify", "--no-box", "--now", iso(NOW)]
    p.backup_root.mkdir(parents=True)
    first = run_script("luma_backup.check_status", args)
    assert first.returncode == 1
    assert p.attention_file.read_text(encoding="utf-8").strip() == first.stdout.strip()
    verified(p, NOW)
    second = run_script("luma_backup.check_status", args)
    assert second.returncode == 0 and not p.attention_file.exists()
