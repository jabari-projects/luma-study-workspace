"""Migration rehearsal: restore a backup set into a throwaway cluster on 127.0.0.1, apply pending
migration files twice, and prove every existing row survived unchanged (design A.10 step 6, E.1 step 2).

Each row is hashed inside Postgres: md5 over the row's text form (only the columns that existed
before), with fixed output settings so the hash never depends on server settings. Per table, the
row hashes are folded into one digest, so the same digest taken on the source database before the
backup proves backup + restore + migrations kept every row. Only names, counts, pass/fail and
digests come out, never row content.
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

# Output settings that change how values print. Fixed so a row's text, and so its hash, is the
# same on any cluster (source, restore) whatever its own settings are.
STABLE_OUTPUT_SQL = ("set timezone to 'UTC';\nset datestyle to 'ISO, YMD';\nset intervalstyle to 'postgres';\n"
                     "set extra_float_digits to 1;\nset bytea_output to 'hex';\n")

COLUMNS_SQL = """
select coalesce(json_object_agg(t.table_name, json_build_object(
  'columns', (select json_agg(c.column_name order by c.ordinal_position) from information_schema.columns c
              where c.table_schema = 'public' and c.table_name = t.table_name),
  'types', (select coalesce(json_object_agg(a.attname, format_type(a.atttypid, a.atttypmod)), '{}'::json)
            from pg_attribute a
            where a.attrelid = ('public.' || quote_ident(t.table_name))::regclass
              and a.attnum > 0 and not a.attisdropped),
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

_NO_ROWS = "select null::text as tbl, null::text as pk, null::text as h where false"


def _ident(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def _lit(name: str) -> str:
    return "'" + name.replace("'", "''") + "'"


def _row_hash_select(table: str, columns: list[str], pk: list[str]) -> str:
    cols = ", ".join(f"x.{_ident(c)}" for c in columns)
    key = f"(row({', '.join('x.' + _ident(c) for c in pk)}))::text" if pk else "''"
    return (f"select {_lit(table)} as tbl, {key} as pk, md5((row({cols}))::text) as h "
            f"from public.{_ident(table)} x")


def _rows_sql(shape: dict, tables: list[str]) -> str:
    """Every row of these tables as (tbl, pk, h), hashing only the columns listed in `shape`."""
    selects = [_row_hash_select(t, shape[t]["columns"], shape[t]["pk"]) for t in tables]
    return " union all ".join(selects) if selects else _NO_ROWS


def _per_table(tools: PgTools, conn: dict, rows_sql: str, tables: list[str]) -> dict:
    """{table: {"rows": n, "digest": md5 of its sorted row hashes}} (digest None for an empty table)."""
    got = tools.psql_json(conn, STABLE_OUTPUT_SQL + f"""
with r as ({rows_sql})
select coalesce(json_object_agg(tbl, json_build_object('rows', n, 'digest', d)), '{{}}'::json)
from (select tbl, count(*) as n,
             md5(string_agg(pk || ':' || h, ',' order by pk collate "C", h collate "C")) as d
      from r group by tbl) s;
""")
    return {t: got.get(t, {"rows": 0, "digest": None}) for t in tables}


def table_digests(tools: PgTools, conn: dict) -> dict:
    """Row count and digest of every public table, over all its current columns.

    Taken on a source database before a backup, these must equal the rehearsal's per-table
    digests after the migrations (same rows, same values in every column that existed).
    """
    shape = tools.psql_json(conn, COLUMNS_SQL)
    tables = sorted(shape)
    return _per_table(tools, conn, _rows_sql(shape, tables), tables)


def snapshot(tools: PgTools, conn: dict) -> dict:
    shape = tools.psql_json(conn, COLUMNS_SQL)
    tables = sorted(shape)
    tools.psql(conn, STABLE_OUTPUT_SQL + "\n".join([
        f"drop schema if exists {SNAP_SCHEMA} cascade;",
        f"create schema {SNAP_SCHEMA};",
        f"create table {SNAP_SCHEMA}.before (tbl text, pk text, h text);",
        f"insert into {SNAP_SCHEMA}.before {_rows_sql(shape, tables)};"]) + "\n")
    digests = _per_table(tools, conn, f"select tbl, pk, h from {SNAP_SCHEMA}.before", tables)
    return {"shape": shape, "tables": digests}


def _not_default_sql(table: str, col: str, info: dict) -> str | None:
    """Rows where a column breaks its NOT NULL or its default: a constant default, or NULL when it
    has no default. None when neither can be checked (a default like now() or gen_random_uuid())."""
    conds = []
    if info["not_null"]:
        conds.append(f"x.{_ident(col)} is null")
    d = info["default"]
    if d is None:
        conds.append(f"x.{_ident(col)} is not null")
    elif _CONSTANT_DEFAULT.match(d.strip()):
        conds.append(f"x.{_ident(col)} is distinct from ({d})")
    if not conds:
        return None
    return (f"select {_lit(table)} as tbl, {_lit(col)} as col, count(*) as n "
            f"from public.{_ident(table)} x where {' or '.join(conds)}")


def compare(tools: PgTools, conn: dict, before: dict) -> dict:
    shape, before_tables = before["shape"], before["tables"]
    after = tools.psql_json(conn, COLUMNS_SQL)
    missing_tables = sorted(t for t in shape if t not in after)
    missing_columns = sorted(t for t, info in shape.items()
                             if t in after and not set(info["columns"]) <= set(after[t]["columns"]))
    kept = [t for t in sorted(shape) if t in after and t not in missing_columns]
    retyped = sorted(t for t in kept
                     if any(after[t]["types"][c] != shape[t]["types"][c] for c in shape[t]["columns"]))
    rows_sql = _rows_sql(shape, kept)
    counts = tools.psql_json(conn, STABLE_OUTPUT_SQL + f"""
with now_rows as ({rows_sql})
select json_build_object(
  'rows_before', (select count(*) from {SNAP_SCHEMA}.before),
  'rows_now', (select count(*) from now_rows),
  'changed_or_missing', (select count(*) from (select tbl, pk, h from {SNAP_SCHEMA}.before
                                              except all select tbl, pk, h from now_rows) d)
);
""")
    now_tables = _per_table(tools, conn, rows_sql, kept)
    tables = {t: {"rows_before": before_tables[t]["rows"], "digest_before": before_tables[t]["digest"],
                  "rows_after": now_tables[t]["rows"] if t in now_tables else None,
                  "digest_after": now_tables[t]["digest"] if t in now_tables else None}
              for t in sorted(shape)}

    # What the migrations added: new tables (every column) and new columns on old tables. For each
    # column: type, default, NOT NULL, and how many rows break the NOT NULL or the default.
    added = [(t, c) for t in sorted(after) for c in after[t]["columns"]
             if t not in shape or c not in shape[t]["columns"]]
    probes = [q for q in (_not_default_sql(t, c, after[t]["defaults"][c]) for t, c in added) if q]
    wrong: dict[tuple[str, str], int] = {}
    if probes:
        rows = tools.psql_json(conn, "select coalesce(json_agg(json_build_object('t', tbl, 'c', col, 'n', n)), "
                                     f"'[]'::json) from ({' union all '.join(probes)}) p;")
        wrong = {(r["t"], r["c"]): r["n"] for r in rows}
    new_tables = sorted(t for t in after if t not in shape)
    new_rows = {}
    if new_tables:
        counted = " union all ".join(f"select {_lit(t)} as tbl, count(*) as n from public.{_ident(t)}"
                                     for t in new_tables)
        new_rows = tools.psql_json(conn, f"select json_object_agg(tbl, n) from ({counted}) c;")
    new_schema: dict[str, dict] = {}
    for t, c in added:
        entry = new_schema.setdefault(t, {"new_table": t not in shape,
                                          "rows": new_rows[t] if t in new_rows else tables[t]["rows_after"],
                                          "columns": {}})
        entry["columns"][c] = {"type": after[t]["types"][c], **after[t]["defaults"][c],
                               "not_default": wrong.get((t, c))}
    old_table_checked = [(t, c) for t, c in added if t in shape and (t, c) in wrong]
    return {"missing_tables": missing_tables, "missing_columns": missing_columns, "retyped": retyped, **counts,
            "tables": tables, "new_schema": new_schema,
            "new_columns_checked": len(old_table_checked),
            "new_columns_wrong": sum(wrong[k] for k in old_table_checked)}


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
        result["tables"] = cmp["tables"]
        result["new_schema"] = cmp["new_schema"]
        checks.add("no table removed", not cmp["missing_tables"], f"missing={len(cmp['missing_tables'])}")
        checks.add("no column removed", not cmp["missing_columns"], f"tables={len(cmp['missing_columns'])}")
        checks.add("no column changed type", not cmp["retyped"], f"tables={len(cmp['retyped'])}")
        checks.add("every old row unchanged", cmp["changed_or_missing"] == 0,
                   f"before={cmp['rows_before']} changed_or_missing={cmp['changed_or_missing']}")
        recounted = [t for t, n in cmp["tables"].items() if n["rows_after"] != n["rows_before"]]
        checks.add("row counts unchanged", not recounted,
                   f"tables={len(cmp['tables'])} different={len(recounted)}")
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
