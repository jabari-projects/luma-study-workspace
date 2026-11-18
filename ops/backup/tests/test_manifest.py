from __future__ import annotations

import pytest

from luma_backup import manifest as mf
from luma_backup.config import UnsafePath, check_safe_location
from luma_backup.pgtools import LocalCluster, PgFailure


def _manifest():
    m = mf.new_manifest("20261119T033000Z", "synthetic", "2026-11-19T03:30:00Z",
                        {"pg_dump": "17.12", "gpg": "2.4.9", "python": "3.14"}, "lb-2026-11-a")
    m["files"] = [{"name": "db.dump.gpg", "bytes": 10, "sha256": "a" * 64}]
    return m


def test_new_manifest_validates():
    m = mf.validate(_manifest())
    assert m["result"] == "unverified" and m["restore_test"]["result"] == "not_run"
    assert m["restore_needs"]["roles"] == ["anon", "authenticated", "service_role"]


@pytest.mark.parametrize("breaker", [
    lambda m: m.pop("files"),
    lambda m: m.update(schema_version=2),
    lambda m: m.update(source="laptop"),
    lambda m: m.update(result="great"),
    lambda m: m["files"].append({"name": "x", "bytes": 1}),
    lambda m: m["files"].append({"name": "x", "bytes": 1, "sha256": "nothex"}),
])
def test_bad_manifests_refused(breaker):
    m = _manifest()
    breaker(m)
    with pytest.raises(mf.ManifestError):
        mf.validate(m)


@pytest.mark.parametrize("bad", ["kid@example.test", "postgres://u:p@h/db", "sb_secret_x", "$argon2id$v=19",
                                 "eyJhbGciOiJIUzI1NiJ9.eyJ"])
def test_private_text_never_written(jtmp, bad):
    m = _manifest()
    m["note"] = bad
    with pytest.raises(mf.ManifestError):
        mf.write_json(jtmp / "manifest.json", m)
    assert not (jtmp / "manifest.json").exists()


def test_status_counts_failures_and_resets(jtmp):
    path = jtmp / "status.json"
    assert mf.load_status(path)["last_attempt"] is None
    kw = {"started_at": "2026-11-19T03:30:00Z", "finished_at": "2026-11-19T03:35:00Z"}
    mf.record_attempt(path, stamp="20261119T033000Z", result="failed", error_code="dump_failed", message="x", **kw)
    st = mf.record_attempt(path, stamp="20261120T033000Z", result="failed", error_code="locked", message="y", **kw)
    assert st["consecutive_failures"] == 2 and st["last_verified"] is None
    st = mf.record_attempt(path, stamp="20261121T033000Z", result="verified", error_code=None, message="ok", **kw)
    assert st["consecutive_failures"] == 0 and st["last_verified"]["stamp"] == "20261121T033000Z"
    with pytest.raises(ValueError):
        mf.record_attempt(path, stamp="s", result="failed", error_code="made_up", message="", **kw)


@pytest.mark.parametrize("path", [
    "C:/LumaBackups",
    "G:/LumaLocal/Luma Knowledge/backups",
    "J:/LumaPilot/wt-backup/backups",
    "J:/LumaPilot/wt-backup/frontend/public/backups",
])
def test_unsafe_locations_refused(path):
    with pytest.raises(UnsafePath):
        check_safe_location(path, "backup")


def test_safe_location_allowed():
    assert check_safe_location("G:/LumaBackups", "backup").drive.upper() == "G:"


def test_restore_target_is_always_local(jtmp):
    cluster = LocalCluster.__new__(LocalCluster)
    cluster.port, cluster.password, cluster.host = 55433, "x", "db.example.supabase.co"
    with pytest.raises(PgFailure):
        cluster.conn("postgres")
