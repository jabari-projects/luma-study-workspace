"""A run that was killed (power loss, a crash) can leave unlocked student data in the work or
restore folder. The next run removes it under the lock, and a status file that can't be
written is never silent. Synthetic files only, on J:."""

from __future__ import annotations

import backup_run
from luma_backup import manifest as mf
from luma_backup.common import clear_leftover_work
from luma_backup.config import Paths


def paths(jtmp) -> Paths:
    return Paths(backup_root=jtmp / "root", work_base=jtmp / "work", restore_base=jtmp / "restore")


def test_leftover_work_and_restore_folders_are_removed_and_checked_gone(jtmp):
    p = paths(jtmp)
    dump = p.work_base / "20261122T150000Z" / "db.dump"
    dump.parent.mkdir(parents=True)
    dump.write_bytes(b"SYNTHETIC plaintext dump")
    cluster = p.restore_base / "20261122T151000Z" / "cluster"
    cluster.mkdir(parents=True)
    (cluster / "PG_VERSION").write_text("17", encoding="utf-8")
    keep = p.work_base / "README.txt"  # not stamp-named: never touched
    keep.write_text("owner's note", encoding="utf-8")

    assert clear_leftover_work(p) == 2
    assert not (p.work_base / "20261122T150000Z").exists()
    assert not (p.restore_base / "20261122T151000Z").exists()
    assert keep.exists()
    assert clear_leftover_work(p) == 0  # nothing left: nothing to do


def test_missing_folders_are_fine(jtmp):
    assert clear_leftover_work(paths(jtmp)) == 0


def test_a_status_file_that_cant_be_written_is_reported_not_silent(jtmp, monkeypatch, capsys):
    p = paths(jtmp)

    def broken(*_args, **_kwargs):
        raise PermissionError("simulated: G: refused the write")

    monkeypatch.setattr(mf, "record_attempt", broken)
    ok = backup_run.record(p, stamp="20261122T150000Z", started_at="2026-11-22T15:00:00Z",
                           finished_at="2026-11-22T15:10:00Z", result="verified", error_code=None, message="ok")
    assert ok is False
    assert backup_run.STATUS_WRITE_FAILED in p.attention_file.read_text(encoding="utf-8")
    assert backup_run.STATUS_WRITE_FAILED in capsys.readouterr().out


def test_a_written_status_returns_true(jtmp):
    p = paths(jtmp)
    assert backup_run.record(p, stamp="20261122T150000Z", started_at="2026-11-22T15:00:00Z",
                             finished_at="2026-11-22T15:10:00Z", result="verified", error_code=None, message="ok")
    assert mf.load_status(p.status_file)["last_verified"]["stamp"] == "20261122T150000Z"
    assert not p.attention_file.exists()
