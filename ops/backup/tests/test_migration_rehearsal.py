"""Migration rehearsal (design A.10 step 6): back up a database that only has the live migrations,
restore it to a throwaway cluster, apply every later migration twice, and prove old rows survive.
Also proves the checker catches lost or changed rows and wrong defaults.
"""

from __future__ import annotations

import secrets

import pytest

from conftest import make_scenario, run_script
from fake_storage import FakeStorage
from luma_backup import manifest as mf
from luma_backup import rehearsal, secrets_store, synthetic
from luma_backup.config import make_stamp, utc_now
from luma_backup.crypto import Gpg
from luma_backup.pgtools import PgTools, free_port

PASSPHRASE = "rehearsal-passphrase-" + secrets.token_hex(8)
KEY = "sb_secret_rehearsal_" + secrets.token_hex(8)


@pytest.fixture(scope="module")
def live_set(pg_bin, j_base, g_base):
    tools = PgTools(pg_bin, j_base / "reh-src-tmp")
    cluster = synthetic.build(tools, j_base / "reh-src", free_port(),
                              migrations=synthetic.migration_files(upto=synthetic.LIVE_MIGRATIONS_UPTO))
    fake = FakeStorage(KEY).start()
    try:
        sc = make_scenario("rehearsal", j_base, g_base, pg_bin)
        secrets_store.seal(synthetic.secrets_dict(cluster, fake.url, KEY, PASSPHRASE), sc.paths.secrets_file)
        proc = run_script("backup_run.py", ["--source", "synthetic", *sc.args(), "--storage-retry-waits", "0,0,0"])
        assert proc.returncode == 0, proc.stdout + proc.stderr
    finally:
        fake.stop()
        cluster.destroy()
    set_dir = next(p for p in sc.paths.backup_root.iterdir() if p.is_dir() and p.name[:1].isdigit())
    return sc, set_dir, mf.read_json(set_dir / "manifest.json")


def rehearse(live_set, migrations):
    sc, set_dir, manifest = live_set
    gpg = Gpg(sc.paths.gnupg_home)
    try:
        return rehearsal.run(set_dir, manifest, PASSPHRASE, sc.paths.pg_bin, gpg, sc.paths.restore_base,
                             make_stamp(utc_now()) + secrets.token_hex(2), migrations)
    finally:
        gpg.kill_agent()


def extra_migration(j_base, name: str, sql: str):
    folder = j_base / "extra-migrations"
    folder.mkdir(exist_ok=True)
    path = folder / name
    path.write_text(sql, encoding="utf-8")
    return path


def check(result, name):
    return next(c for c in result["checks"] if c["name"] == name)


def test_later_migrations_keep_every_row(live_set):
    later = synthetic.migration_files(after=synthetic.LIVE_MIGRATIONS_UPTO)
    assert later, "there are migrations after the live ones"
    # This release's files, in the order the owner runs them (docs/deployment-checklist.md).
    assert [p.name for p in later if p.name >= "2026_11_18"] == [
        "2026_11_18_monthly_feedback.sql",
        "2026_11_19_maintenance_state.sql",
        "2026_11_19_student_work_versions.sql",
    ]
    result = rehearse(live_set, later)
    assert result["passed"], result
    assert result["counts"]["changed_or_missing"] == 0
    assert result["counts"]["rows_now"] >= result["counts"]["rows_before"] > 0
    assert sum(1 for c in result["checks"] if c["name"].startswith("round 2:")) == len(later), "ran twice"
    sc, _, _ = live_set
    assert not any(sc.paths.restore_base.iterdir()) if sc.paths.restore_base.exists() else True


def test_cli_prints_counts_only(live_set):
    sc, set_dir, _ = live_set
    proc = run_script("rehearse_migrations.py", ["--stamp", set_dir.name, "--after", synthetic.LIVE_MIGRATIONS_UPTO,
                                                 *sc.args()])
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "Rehearsal passed." in proc.stdout
    assert "@" not in proc.stdout and synthetic.MARKER not in proc.stdout


def test_changed_rows_are_caught(live_set, j_base):
    bad = extra_migration(j_base, "9999_rewrite_titles.sql", "update public.notes set title = 'rewritten';")
    result = rehearse(live_set, [bad])
    assert not result["passed"]
    assert not check(result, "every old row unchanged")["ok"]


def test_deleted_rows_are_caught(live_set, j_base):
    bad = extra_migration(j_base, "9999_delete_cards.sql", "delete from public.flashcards;")
    result = rehearse(live_set, [bad])
    assert not result["passed"]
    assert not check(result, "no table lost rows")["ok"]


def test_dropped_column_is_caught(live_set, j_base):
    bad = extra_migration(j_base, "9999_drop_column.sql",
                          "alter table public.study_sessions drop column if exists subject;")
    result = rehearse(live_set, [bad])
    assert not result["passed"]
    assert not check(result, "no column removed")["ok"]


def test_new_column_defaults(live_set, j_base):
    good = extra_migration(j_base, "9999_add_version.sql",
                           "alter table public.notes add column if not exists version integer not null default 1;")
    result = rehearse(live_set, [good])
    assert result["passed"], result
    assert result["counts"]["new_columns_checked"] >= 1
    wrong = extra_migration(j_base, "9999_add_version_wrong.sql",
                            "alter table public.notes add column if not exists version integer not null default 1;\n"
                            "update public.notes set version = 7;")
    result = rehearse(live_set, [wrong])
    assert not check(result, "new columns have their defaults")["ok"]
