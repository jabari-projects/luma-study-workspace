"""Migration rehearsal (design A.10 step 6): build a FAKE database shaped like production today
(live shape + every migration already live), seed it with realistic fake student work, back it up
with the real pipeline, restore it to a throwaway cluster, apply this release's migrations in
order twice, and prove every old row is byte-for-byte the same as in the source database.
Also proves the checker catches lost, added or changed rows, changed column types and wrong defaults.
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

# This release's files, in the order the owner runs them (docs/deployment-checklist.md R3 and step 6).
RELEASE = ["2026_11_18_monthly_feedback.sql", "2026_11_19_maintenance_state.sql",
           "2026_11_19_student_work_versions.sql"]
FEEDBACK_TABLES = {"feedback_polls", "feedback_questions", "feedback_responses", "feedback_answers",
                   "feedback_skips", "feedback_comment_themes", "feedback_theme_members", "feedback_admin_updates"}
MAINTENANCE_TABLES = {"maintenance_state", "maintenance_instances", "maintenance_jobs", "maintenance_log"}
# New columns on student work tables: (type, default, NOT NULL).
VERSION_COLUMNS = {"version": ("bigint", "1", True), "create_key": ("uuid", None, False)}
NEW_COLUMNS = {"notes": VERSION_COLUMNS, "summaries": VERSION_COLUMNS, "study_sessions": VERSION_COLUMNS,
               "flashcards": {**VERSION_COLUMNS, "progress_rev": ("bigint", "0", True)}}
# A few declared defaults of the new tables, as Postgres reports them.
NEW_TABLE_DEFAULTS = {("maintenance_state", "phase"): "'none'::text", ("maintenance_state", "rev"): "1",
                      ("maintenance_state", "reason"): "''::text", ("maintenance_state", "note"): "''::text",
                      ("maintenance_instances", "in_flight"): "0",
                      ("feedback_responses", "urgent_set_by_admin"): "false",
                      ("feedback_admin_updates", "status"): "'reviewing'::text",
                      ("feedback_admin_updates", "published"): "false"}


@pytest.fixture(scope="module")
def live_set(pg_bin, j_base, g_base):
    """A verified backup of the production-shaped fake database, and that database's own digests."""
    tools = PgTools(pg_bin, j_base / "reh-src-tmp")
    cluster = synthetic.build_production(tools, j_base / "reh-src", free_port())
    fake = FakeStorage(KEY).start()
    try:
        source = rehearsal.table_digests(tools, cluster.conn("postgres"))
        sc = make_scenario("rehearsal", j_base, g_base, pg_bin)
        secrets_store.seal(synthetic.secrets_dict(cluster, fake.url, KEY, PASSPHRASE), sc.paths.secrets_file)
        proc = run_script("backup_run.py", ["--source", "synthetic", *sc.args(), "--storage-retry-waits", "0,0,0"])
        assert proc.returncode == 0, proc.stdout + proc.stderr
    finally:
        fake.stop()
        cluster.destroy()
    set_dir = next(p for p in sc.paths.backup_root.iterdir() if p.is_dir() and p.name[:1].isdigit())
    return sc, set_dir, mf.read_json(set_dir / "manifest.json"), source


def rehearse(live_set, migrations):
    sc, set_dir, manifest, _ = live_set
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


def test_source_looks_like_production(live_set):
    _, _, manifest, source = live_set
    assert {t: source[t]["rows"] for t in synthetic.PRODUCTION_SEEDED_COUNTS} == synthetic.PRODUCTION_SEEDED_COUNTS
    assert source["users"]["rows"] >= 10
    assert not any(t in source for t in FEEDBACK_TABLES | MAINTENANCE_TABLES), "release tables are not live yet"
    assert {t: n["rows_before"] for t, n in manifest["database"]["tables"].items()} == \
        {t: s["rows"] for t, s in source.items()}
    assert manifest["result"] == "verified"


def test_release_keeps_every_student_row(live_set):
    later = synthetic.migration_files(after=synthetic.LIVE_MIGRATIONS_UPTO)
    assert [p.name for p in later] == RELEASE
    result = rehearse(live_set, later)
    assert result["passed"], result
    assert all(c["ok"] for c in result["checks"]), result["checks"]
    rounds = [c["name"] for c in result["checks"] if c["name"].startswith("round ")]
    assert rounds == [f"round {r}: {name}" for r in (1, 2) for name in RELEASE], "in order, twice"

    # Every old row, compared with the source database itself (so backup + restore + migrations).
    _, _, _, source = live_set
    tables = result["tables"]
    assert set(tables) == set(source)
    for table, n in tables.items():
        assert n["rows_before"] == n["rows_after"] == source[table]["rows"], table
        assert n["digest_before"] == n["digest_after"] == source[table]["digest"], table
    counts = result["counts"]
    assert counts["changed_or_missing"] == 0
    assert counts["rows_now"] == counts["rows_before"] == sum(s["rows"] for s in source.values()) > 0

    # New columns: exactly these, with these defaults, and every old row holds the default.
    new = result["new_schema"]
    assert {t for t, info in new.items() if not info["new_table"]} == set(NEW_COLUMNS)
    for table, cols in NEW_COLUMNS.items():
        got = new[table]["columns"]
        assert {c: (g["type"], g["default"], g["not_null"]) for c, g in got.items()} == cols, table
        assert all(g["not_default"] == 0 for g in got.values()), table
    assert counts["new_columns_checked"] == 9 and counts["new_columns_wrong"] == 0

    # New tables: exactly these, empty except the one maintenance settings row, all at their defaults.
    assert {t for t, info in new.items() if info["new_table"]} == FEEDBACK_TABLES | MAINTENANCE_TABLES
    assert {t: info["rows"] for t, info in new.items() if info["new_table"] and info["rows"]} == \
        {"maintenance_state": 1}
    for (table, col), default in NEW_TABLE_DEFAULTS.items():
        assert new[table]["columns"][col]["default"] == default, (table, col)
    assert all(g["not_default"] in (0, None) for info in new.values() if info["new_table"]
               for g in info["columns"].values())

    sc, _, _, _ = live_set
    assert not any(sc.paths.restore_base.iterdir()) if sc.paths.restore_base.exists() else True
    # Names, counts and pass/fail only, for the release evidence (run pytest with -rP to see it).
    print(f"RESULT passed={result['passed']} rows_before={counts['rows_before']} rows_after={counts['rows_now']} "
          f"changed_or_missing={counts['changed_or_missing']} tables={len(tables)}")
    for c in result["checks"]:
        print(f"CHECK {'PASS' if c['ok'] else 'FAIL'} {c['name']} {c['detail']}".rstrip())
    for table, n in sorted(tables.items()):
        print(f"TABLE {table} source={source[table]['rows']} before={n['rows_before']} after={n['rows_after']} "
              f"checksum_same={n['digest_before'] == n['digest_after'] == source[table]['digest']}")
    for table, info in sorted(new.items()):
        print(f"NEW {'table' if info['new_table'] else 'columns'} {table} rows={info['rows']} "
              f"columns={len(info['columns'])} "
              f"defaults_ok={all(g['not_default'] in (0, None) for g in info['columns'].values())}")


def test_cli_prints_counts_only(live_set):
    sc, set_dir, _, source = live_set
    proc = run_script("rehearse_migrations.py", ["--stamp", set_dir.name, "--after", synthetic.LIVE_MIGRATIONS_UPTO,
                                                 *sc.args()])
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "Rehearsal passed." in proc.stdout
    n = source["notes"]["rows"]
    assert f"rows  notes  before={n} after={n}" in proc.stdout
    assert "new table  maintenance_state  rows=1" in proc.stdout
    assert "new columns  flashcards  version, create_key, progress_rev" in proc.stdout
    assert "@" not in proc.stdout and synthetic.MARKER not in proc.stdout


@pytest.mark.parametrize("sql", [
    "update public.notes set title = 'rewritten';",
    # One microsecond on one row's time, and one card's review count inside one deck's cards.
    "update public.notes set updated_at = updated_at + interval '1 microsecond' "
    "where id = (select min(id::text)::uuid from public.notes);",
    "update public.flashcards set cards = jsonb_set(cards, '{0,review,reps}', '99') "
    "where id = (select min(id::text)::uuid from public.flashcards where cards <> '[]'::jsonb);",
], ids=["titles", "one-microsecond", "card-progress"])
def test_changed_rows_are_caught(live_set, j_base, sql):
    bad = extra_migration(j_base, f"9999_change_{secrets.token_hex(2)}.sql", sql)
    result = rehearse(live_set, [bad])
    assert not result["passed"]
    assert not check(result, "every old row unchanged")["ok"]
    changed = [t for t, n in result["tables"].items() if n["digest_before"] != n["digest_after"]]
    assert len(changed) == 1


def test_deleted_rows_are_caught(live_set, j_base):
    bad = extra_migration(j_base, "9999_delete_cards.sql", "delete from public.flashcards;")
    result = rehearse(live_set, [bad])
    assert not result["passed"]
    assert not check(result, "row counts unchanged")["ok"]
    assert not check(result, "every old row unchanged")["ok"]


def test_added_rows_are_caught(live_set, j_base):
    bad = extra_migration(j_base, "9999_copy_a_note.sql",
                          "insert into public.notes (user_id, title, content, tags) "
                          "select user_id, title, content, tags from public.notes where user_id is not null limit 1;")
    result = rehearse(live_set, [bad])
    assert not result["passed"]
    assert not check(result, "row counts unchanged")["ok"]
    assert check(result, "every old row unchanged")["ok"]


def test_dropped_column_is_caught(live_set, j_base):
    bad = extra_migration(j_base, "9999_drop_column.sql",
                          "alter table public.study_sessions drop column if exists subject;")
    result = rehearse(live_set, [bad])
    assert not result["passed"]
    assert not check(result, "no column removed")["ok"]


def test_changed_column_type_is_caught(live_set, j_base):
    # The values print the same afterwards, so only the type check sees it.
    bad = extra_migration(j_base, "9999_retype.sql",
                          "alter table public.transcripts alter column source type varchar(40);")
    result = rehearse(live_set, [bad])
    assert not result["passed"]
    assert not check(result, "no column changed type")["ok"]
    assert check(result, "every old row unchanged")["ok"]


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
    filled = extra_migration(j_base, "9999_add_key_filled.sql",
                             "alter table public.notes add column if not exists create_key uuid;\n"
                             "update public.notes set create_key = gen_random_uuid();")
    result = rehearse(live_set, [filled])
    assert not check(result, "new columns have their defaults")["ok"]
