"""Synthetic end to end (design A.10): create, encrypt, verify, restore and compare a backup of a
fake Luma database and fake Storage, then the failure cases. Nothing here touches production.
"""

from __future__ import annotations

import datetime as dt
import json
import secrets
import shutil
from pathlib import Path

import pytest

from conftest import make_scenario, run_script
from fake_storage import MARKER as STORAGE_MARKER, PATH_MARKER, FakeStorage, expected_summary
from luma_backup import manifest as mf
from luma_backup import secrets_store, synthetic
from luma_backup.config import SYNTHETIC_SOURCE_PORT, iso, make_stamp, parse_iso, utc_now
from luma_backup.crypto import looks_like_openpgp, sha256_file
from luma_backup.pgtools import PgTools

PASSPHRASE = "synthetic-passphrase-" + secrets.token_hex(8)
STORAGE_KEY = "sb_secret_synthetic_" + secrets.token_hex(8)
NO_WAITS = ["--storage-retry-waits", "0,0,0"]


@pytest.fixture(scope="module")
def source(pg_bin, j_base):
    tools = PgTools(pg_bin, j_base / "src-tmp")
    cluster = synthetic.build(tools, j_base / "src", SYNTHETIC_SOURCE_PORT)
    yield cluster
    cluster.destroy()


@pytest.fixture(scope="module")
def storage():
    fake = FakeStorage(STORAGE_KEY).start()
    yield fake
    fake.stop()


def scenario(name, j_base, g_base, pg_bin, source, storage, passphrase=PASSPHRASE):
    sc = make_scenario(name, j_base, g_base, pg_bin)
    secrets_store.seal(synthetic.secrets_dict(source, storage.url, STORAGE_KEY, passphrase), sc.paths.secrets_file)
    return sc


def backup(sc, *extra):
    return run_script("backup_run.py", ["--source", "synthetic", *sc.args(), *NO_WAITS, *extra])


def leaked(text: str, source) -> list[str]:
    bad = [source.password, PASSPHRASE, STORAGE_KEY]
    return [b for b in bad if b in text]


def all_logs(sc) -> str:
    return "\n".join(p.read_text(encoding="utf-8") for p in sc.paths.logs_dir.glob("*.log"))


def sets(sc) -> list[Path]:
    return sorted(p for p in sc.paths.backup_root.iterdir() if p.is_dir() and p.name[:1].isdigit())


def status(sc) -> dict:
    return mf.load_status(sc.paths.status_file)


def empty(folder: Path) -> bool:
    return not folder.exists() or not any(folder.iterdir())


@pytest.fixture(scope="module")
def good(j_base, g_base, pg_bin, source, storage):
    sc = scenario("good", j_base, g_base, pg_bin, source, storage)
    proc = backup(sc)
    print(proc.stdout)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    return sc, proc


def test_backup_verified_end_to_end(good, source):
    sc, proc = good
    found = sets(sc)
    assert [p.name.endswith(".partial") for p in found] == [False], "one final set, no .partial left"
    set_dir = found[0]
    assert sorted(p.name for p in set_dir.iterdir()) == ["db.dump.gpg", "manifest.json", "restore-report.json",
                                                        "storage.tar.gpg"]

    # Locked files: OpenPGP, and nothing readable inside.
    for name in ("db.dump.gpg", "storage.tar.gpg"):
        raw = (set_dir / name).read_bytes()
        assert looks_like_openpgp(set_dir / name)
        for needle in (synthetic.MARKER, STORAGE_MARKER, PATH_MARKER, "example.test", "argon2", "photosynthesis"):
            assert needle.encode() not in raw, f"{needle} readable in {name}"

    # Manifest: hashes match, no private text.
    text = (set_dir / "manifest.json").read_text(encoding="utf-8")
    m = mf.validate(json.loads(text))
    for needle in ("@", synthetic.MARKER, STORAGE_MARKER, PATH_MARKER, "face.png", "top.png", "back.jpg"):
        assert needle not in text
    for f in m["files"]:
        assert sha256_file(set_dir / f["name"]) == (f["bytes"], f["sha256"])
    assert m["result"] == "verified" and m["source"] == "synthetic"
    assert m["restore_test"]["result"] == "passed"
    assert m["database"]["legacy_plaintext_password_rows"] == synthetic.LEGACY_PLAINTEXT_ROWS
    assert "luma_password_hash_guard" in m["database"]["schema_fingerprint"]["triggers"]
    assert m["storage"] == expected_summary()
    assert m["scope"]["storage"]["buckets"] == ["avatars", "themes"]

    # Restore report: passed, and the true counts inside the backup equal what was seeded.
    report = json.loads((set_dir / "restore-report.json").read_text(encoding="utf-8"))
    assert report["result"] == "passed", report
    for table, n in synthetic.SEEDED_COUNTS.items():
        assert report["rows_restored"][table] == n, table
    assert all(n == 0 for t, n in report["rows_restored"].items() if t not in synthetic.SEEDED_COUNTS)
    assert report["storage"] == expected_summary()
    assert "@" not in json.dumps(report)

    # Plaintext is gone, status says verified, the check is happy.
    assert empty(sc.paths.work_base) and empty(sc.paths.restore_base)
    st = status(sc)
    assert st["last_attempt"]["result"] == "verified" and st["consecutive_failures"] == 0
    assert st["last_verified"]["stamp"] == set_dir.name
    chk = run_script("luma_backup.check_status", sc.args())
    assert chk.returncode == 0, chk.stdout
    assert not leaked(proc.stdout + proc.stderr + all_logs(sc), source)


def test_wrong_passphrase_fails_restore(good, j_base, g_base, pg_bin, source, storage):
    sc_good, _ = good
    sc = scenario("wrongpass", j_base, g_base, pg_bin, source, storage, passphrase="not-the-right-passphrase")
    good_set = sets(sc_good)[0]
    shutil.copytree(good_set, sc.paths.backup_root / good_set.name)
    proc = run_script("restore_test_run.py", ["--stamp", good_set.name, *sc.args()])
    assert proc.returncode == 2, proc.stdout
    rt = status(sc)["last_restore_test"]
    assert rt["result"] == "failed" and rt["error_code"] == "restore_failed"
    assert run_script("luma_backup.check_status", sc.args()).returncode == 2
    assert empty(sc.paths.restore_base)
    assert not leaked(proc.stdout + all_logs(sc), source)


def test_good_set_passes_a_later_restore_test(good):
    sc, _ = good
    stamp = sets(sc)[0].name
    proc = run_script("restore_test_run.py", ["--stamp", stamp, *sc.args()])
    assert proc.returncode == 0, proc.stdout
    assert status(sc)["last_restore_test"]["result"] == "passed"
    assert len(list(sets(sc)[0].glob("restore-report-*.json"))) == 1
    assert empty(sc.paths.restore_base)


def test_flipped_byte_fails_verify(good, j_base, g_base, pg_bin, source, storage):
    sc_good, _ = good
    sc = scenario("flipped", j_base, g_base, pg_bin, source, storage)
    good_set = sets(sc_good)[0]
    copy = sc.paths.backup_root / good_set.name
    shutil.copytree(good_set, copy)
    data = bytearray((copy / "db.dump.gpg").read_bytes())
    data[len(data) // 2] ^= 0x01
    (copy / "db.dump.gpg").write_bytes(bytes(data))
    proc = run_script("restore_test_run.py", ["--stamp", good_set.name, *sc.args()])
    assert proc.returncode == 2
    assert status(sc)["last_restore_test"]["error_code"] == "verify_failed"


def test_storage_500_fails_and_is_reported(j_base, g_base, pg_bin, source, storage):
    sc = scenario("storage500", j_base, g_base, pg_bin, source, storage)
    storage.mode = "fail500"
    try:
        proc = backup(sc)
    finally:
        storage.mode = "ok"
    assert proc.returncode == 2
    st = status(sc)
    assert st["last_attempt"]["error_code"] == "storage_failed" and st["consecutive_failures"] == 1
    assert sets(sc) == [], "no set folder is left for a run that saved nothing"
    assert empty(sc.paths.work_base) and empty(sc.paths.restore_base)
    chk = run_script("luma_backup.check_status", sc.args())
    assert chk.returncode == 2 and "did not work" in chk.stdout


def test_storage_wrong_size_fails(j_base, g_base, pg_bin, source, storage):
    sc = scenario("storagecorrupt", j_base, g_base, pg_bin, source, storage)
    storage.mode = "corrupt"
    try:
        proc = backup(sc)
    finally:
        storage.mode = "ok"
    assert proc.returncode == 2
    assert status(sc)["last_attempt"]["error_code"] == "storage_failed"
    assert empty(sc.paths.work_base)


def test_source_stopped_is_db_connect_failed(j_base, g_base, pg_bin, source, storage):
    sc = scenario("dbdown", j_base, g_base, pg_bin, source, storage)
    source.stop()
    try:
        proc = backup(sc)
    finally:
        source.start()
    assert proc.returncode == 2
    assert status(sc)["last_attempt"]["error_code"] == "db_connect_failed"
    assert source.password not in proc.stdout + proc.stderr
    assert source.password not in all_logs(sc)
    assert not leaked(proc.stdout + proc.stderr + all_logs(sc), source)


def test_second_run_while_locked(j_base, g_base, pg_bin, source, storage):
    sc = scenario("locked", j_base, g_base, pg_bin, source, storage)
    sc.paths.backup_root.mkdir(parents=True, exist_ok=True)
    sc.paths.lock_file.write_text(json.dumps({"stamp": "x", "started_at": iso(utc_now())}), encoding="utf-8")
    proc = backup(sc)
    assert proc.returncode == 2
    assert status(sc)["last_attempt"]["error_code"] == "locked"
    assert sc.paths.lock_file.exists(), "someone else's lock is left alone"


def test_three_day_old_backup_warns(good):
    sc, _ = good
    finished = parse_iso(status(sc)["last_verified"]["finished_at"])
    later = iso(finished + dt.timedelta(days=3, hours=1))
    chk = run_script("luma_backup.check_status", [*sc.args(), "--now", later])
    assert chk.returncode == 1
    assert "3 days old" in chk.stdout


def test_old_partial_folder_warns(good, j_base, g_base, pg_bin, source, storage):
    sc_good, _ = good
    sc = scenario("stalepartial", j_base, g_base, pg_bin, source, storage)
    sc.paths.backup_root.mkdir(parents=True, exist_ok=True)
    shutil.copy2(sc_good.paths.status_file, sc.paths.status_file)
    old = make_stamp(utc_now() - dt.timedelta(hours=7))
    (sc.paths.backup_root / f"{old}.partial").mkdir()
    chk = run_script("luma_backup.check_status", sc.args())
    assert chk.returncode == 1
    assert f"{old}.partial" in chk.stdout


def test_prune_on_real_sets(good):
    sc, _ = good
    before = [p.name for p in sets(sc)]
    dry = run_script("luma_backup.prune", sc.args())
    assert dry.returncode == 0 and [p.name for p in sets(sc)] == before
    applied = run_script("luma_backup.prune", [*sc.args(), "--apply"])
    assert applied.returncode == 0 and [p.name for p in sets(sc)] == before, "a lone verified set is always kept"


def test_second_copy_checks_hashes(good, j_base):
    sc, _ = good
    dest = j_base / "second-copy"
    first = run_script("luma_backup.copy_second", [*sc.args(), "--dest", str(dest)])
    assert first.returncode == 0, first.stdout
    assert "1 copied" in first.stdout
    copied = dest / sets(sc)[0].name
    assert sorted(p.name for p in copied.iterdir()) == ["db.dump.gpg", "manifest.json", "restore-report.json",
                                                       "storage.tar.gpg"]
    again = run_script("luma_backup.copy_second", [*sc.args(), "--dest", str(dest)])
    assert "1 already there" in again.stdout
    inside = run_script("luma_backup.copy_second", [*sc.args(), "--dest", str(sc.paths.backup_root / "x")])
    assert inside.returncode == 2
