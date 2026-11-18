"""Migration rehearsal: restore a backup set into a throwaway cluster on 127.0.0.1, apply pending
migration files twice, and prove every existing row survived unchanged (design A.10 step 6, E.1 step 2).

Rows are compared inside Postgres with an md5 per row over the columns that existed before.
Only names, counts and pass/fail come out.
"""

from __future__ import annotations

import logging
import re
import shutil
from pathlib import Path

from .crypto import Gpg
from .errors import BackupError
from .pgtools import LocalCluster, PgFailure, PgTools, free_port
from .restore_test import Checks, open_set, prepare_cluster, restore_dump

log = logging.getLogger("luma_backup")

SNAP_SCHEMA = "luma_rehearsal"

COLUMNS_SQL = """
select coalesce(json_object_agg(t.table_name, json_build_object(
  'columns', (select json_agg(c.column_name order by c.ordinal_position) from information_schema.columns c
              where c.table_schema = 'public' and c.table_name = t.table_name),
  'defaults', (select coalesce(json_object_agg(c.column_name, json_build_object(
                  'default', c.column_default, 'not_null', c.is_nullable = 'NO')), '{}'::json)
               from information_schema.columns c
               where c.table_schema = 'public' and c.table_name = t.table_name),
  'pk', (select coalesce(json_agg(a.attname order by a.attnum), '[]'::json)
         from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
         where i.indrelid = ('public.' || quote_ident(t.table_name))::regclass and i.indisprimary)
)), '{}'::json)
from information_schema.tables t where t.table_schema = 'public' and t.table_type = 'BASE TABLE';
"""

# A default that is a plain constant (number, boolean, or a quoted literal with a cast).
_CONSTANT_DEFAULT = re.compile(r"^(?:-?\d+(?:\.\d+)?|true|false|'(?:[^']|'')*'(?:::[\w\s\[\].\"]+)?)$", re.I)


def _ident(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def _lit(name: str) -> str:
    return "'" + name.replace("'", "''") + "'"


def _row_hash_select(table: str, columns: list[str], pk: list[str]) -> str:
    cols = ", ".join(f"x.{_ident(c)}" for c in columns)
    key = f"(row({', '.join('x.' + _ident(c) for c in pk)}))::text" if pk else "''"
    return (f"select {_lit(table)} as tbl, {key} as pk, md5((row({cols}))::text) as h "
            f"from public.{_ident(table)} x")


def snapshot(tools: PgTools, conn: dict) -> dict:
    shape = tools.psql_json(conn, COLUMNS_SQL)
    parts = [f"drop schema if exists {SNAP_SCHEMA} cascade;",
             f"create schema {SNAP_SCHEMA};",
             f"create table {SNAP_SCHEMA}.before (tbl text, pk text, h text);"]
    for table, info in sorted(shape.items()):
        parts.append(f"insert into {SNAP_SCHEMA}.before {_row_hash_select(table, info['columns'], info['pk'])};")
    tools.psql(conn, "\n".join(parts) + "\n")
    return shape


def compare(tools: PgTools, conn: dict, before: dict) -> dict:
    after = tools.psql_json(conn, COLUMNS_SQL)
    missing_tables = sorted(t for t in before if t not in after)
    selects = [_row_hash_select(t, info["columns"], info["pk"]) for t, info in sorted(before.items())
               if t in after and set(info["columns"]) <= set(after[t]["columns"])]
    missing_columns = sorted(t for t, info in before.items()
                             if t in after and not set(info["columns"]) <= set(after[t]["columns"]))
    union = " union all ".join(selects) if selects else "select null::text, null::text, null::text where false"
    counts = tools.psql_json(conn, f"""
with now_rows as ({union})
select json_build_object(
  'rows_before', (select count(*) from {SNAP_SCHEMA}.before),
  'rows_now', (select count(*) from now_rows),
  'changed_or_missing', (select count(*) from (select tbl, pk, h from {SNAP_SCHEMA}.before
                                              except all select tbl, pk, h from now_rows) d)
);
""")
    # New columns: NOT NULL ones must be filled, constant defaults must be in place on old rows.
    default_checks = []
    for table, info in sorted(after.items()):
        if table not in before:
            continue
        for col in info["columns"]:
            if col in before[table]["columns"]:
                continue
            d = info["defaults"][col]
            conds = []
            if d["not_null"]:
                conds.append(f"x.{_ident(col)} is null")
            if d["default"] is not None and _CONSTANT_DEFAULT.match(d["default"].strip()):
                conds.append(f"x.{_ident(col)} is distinct from ({d['default']})")
            if conds:
                default_checks.append(f"(select count(*) from public.{_ident(table)} x where {' or '.join(conds)})")
    bad_defaults = 0
    if default_checks:
        bad_defaults = tools.psql_json(conn, f"select json_build_object('n', {' + '.join(default_checks)});")["n"]
    per_table_drop = []
    for table in sorted(before):
        if table in after:
            n = tools.psql_json(conn, f"""select json_build_object('b', (select count(*) from {SNAP_SCHEMA}.before
                where tbl = {_lit(table)}), 'a', (select count(*) from public.{_ident(table)}));""")
            if n["a"] < n["b"]:
                per_table_drop.append(table)
    return {"missing_tables": missing_tables, "missing_columns": missing_columns, **counts,
            "new_columns_checked": len(default_checks), "new_columns_wrong": bad_defaults,
            "tables_with_fewer_rows": per_table_drop}


def run(set_dir: Path, manifest: dict, passphrase: str, pg_bin: Path, gpg: Gpg, restore_base: Path,
        run_stamp: str, migrations: list[Path]) -> dict:
    checks = Checks()
    result = {"stamp": manifest["stamp"], "migrations": [m.name for m in migrations], "checks": checks.items,
              "passed": False}
    work = Path(restore_base) / f"{run_stamp}-rehearsal"
    cluster: LocalCluster | None = None
    try:
        tools = PgTools(pg_bin, work / "tmp")
        plain = open_set(set_dir, manifest, ("db.dump.gpg",), passphrase, gpg, work, checks)
        cluster = LocalCluster(tools, work / "cluster", free_port())
        target = prepare_cluster(tools, cluster)
        allowed, unexpected = restore_dump(tools, target, plain["db.dump.gpg"])
        plain["db.dump.gpg"].unlink()
        if not checks.add("backup restored", unexpected == 0, f"allowed={allowed} unexpected={unexpected}"):
            raise BackupError("restore_failed")
        before = snapshot(tools, target)
        for round_no in (1, 2):
            for path in migrations:
                try:
                    tools.psql(target, path.read_text(encoding="utf-8"), timeout=900)
                    checks.add(f"round {round_no}: {path.name}", True)
                except PgFailure:
                    checks.add(f"round {round_no}: {path.name}", False)
                    raise BackupError("restore_failed", f"{path.name} did not run cleanly.") from None
        cmp = compare(tools, target, before)
        result["counts"] = {k: cmp[k] for k in ("rows_before", "rows_now", "changed_or_missing",
                                                 "new_columns_checked", "new_columns_wrong")}
        checks.add("no table removed", not cmp["missing_tables"], f"missing={len(cmp['missing_tables'])}")
        checks.add("no column removed", not cmp["missing_columns"], f"tables={len(cmp['missing_columns'])}")
        checks.add("every old row unchanged", cmp["changed_or_missing"] == 0,
                   f"before={cmp['rows_before']} changed_or_missing={cmp['changed_or_missing']}")
        checks.add("no table lost rows", not cmp["tables_with_fewer_rows"],
                   f"tables={len(cmp['tables_with_fewer_rows'])}")
        checks.add("new columns have their defaults", cmp["new_columns_wrong"] == 0,
                   f"checked={cmp['new_columns_checked']} wrong={cmp['new_columns_wrong']}")
        result["passed"] = checks.ok
    except BackupError as exc:
        result["error"] = exc.message
    except PgFailure:
        result["error"] = "A database step failed."
    finally:
        if cluster is not None:
            cluster.stop()
        shutil.rmtree(work, ignore_errors=True)
        if work.exists():
            result["passed"] = False
            result["error"] = f"Could not delete {work}. Delete it by hand."
    return result
