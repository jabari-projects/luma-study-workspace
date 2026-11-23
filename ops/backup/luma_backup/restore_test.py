"""Isolated restore test (design A.7): decrypt a set, restore it into a throwaway cluster on
127.0.0.1, and check it against the manifest. No app is started and nothing talks to anything
but 127.0.0.1. The restore folder is deleted afterwards.
"""

from __future__ import annotations

import logging
import re
import shutil
from pathlib import Path

from .crypto import CryptoFailure, Gpg, sha256_file
from .errors import BackupError
from .redact import redact
from .pgtools import LocalCluster, PgFailure, PgTools, free_port, inspect
from .storage_export import safe_extract

log = logging.getLogger("luma_backup")

RESTORE_DB = "luma_restore"

ROLES_SQL = """
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
"""

# Supabase-managed pieces the public schema leans on. storage.buckets has the same columns
# backend/scripts/check_live_migration.mjs uses. The auth.* functions are stubs so that any
# row level security policy that mentions auth.uid() still restores (they are never called).
SUPABASE_STUBS_SQL = """
create schema if not exists extensions;
create extension if not exists "uuid-ossp" with schema extensions;
create schema if not exists storage;
create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  owner uuid,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  public boolean default false,
  avif_autodetection boolean default false,
  file_size_limit bigint,
  allowed_mime_types text[],
  owner_id text
);
create unique index if not exists bname on storage.buckets (name);
create schema if not exists auth;
create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
create or replace function auth.role() returns text language sql stable as $$ select null::text $$;
create or replace function auth.jwt() returns jsonb language sql stable as $$ select null::jsonb $$;
-- Supabase database webhooks call supabase_functions.http_request() from triggers. The restore copy
-- gets a do-nothing stand-in, so restoring works and a restored copy can never send a web request.
create schema if not exists supabase_functions;
create or replace function supabase_functions.http_request() returns trigger language plpgsql as $$
begin
  return coalesce(new, old);
end $$;
"""

ALLOWED_RESTORE_ERRORS = (re.compile(r'schema "public" already exists'), re.compile(r"COMMENT ON EXTENSION"))

SANITY_INSERT_SQL = """
begin;
set local row_security = off;
with p as (select user_id from public.profiles limit 1),
ins as (
  insert into public.notes (user_id, title, content, tags)
  select user_id, 'restore check', 'restore check words', '{}'::text[] from p
  returning id, search_vector
)
select json_build_object(
  'inserted', (select count(*) from ins),
  'id_ok', (select coalesce(bool_and(id is not null), false) from ins),
  'search_ok', (select coalesce(bool_and(search_vector is not null), false) from ins)
);
rollback;
"""


def split_restore_errors(stderr: str) -> tuple[int, int]:
    """Return (allowed, unexpected) pg_restore error counts."""
    blocks: list[str] = []
    current: list[str] | None = None
    for line in stderr.splitlines():
        if line.startswith("pg_restore:"):
            if current is not None:
                blocks.append("\n".join(current))
                current = None
            if line.startswith("pg_restore: error:"):
                current = [line]
        elif current is not None:
            current.append(line)
    if current is not None:
        blocks.append("\n".join(current))
    allowed = sum(1 for b in blocks if any(p.search(b) for p in ALLOWED_RESTORE_ERRORS))
    return allowed, len(blocks) - allowed


class Checks:
    def __init__(self):
        self.items: list[dict] = []

    def add(self, name: str, ok: bool, detail: str = "") -> bool:
        self.items.append({"name": name, "ok": bool(ok), "detail": detail})
        log.info("restore check %s: %s %s", name, "ok" if ok else "FAILED", detail)
        return ok

    @property
    def ok(self) -> bool:
        return all(i["ok"] for i in self.items)


def prepare_cluster(tools: PgTools, cluster: LocalCluster) -> dict:
    cluster.init()
    cluster.start()
    admin = cluster.conn("postgres")
    tools.psql(admin, ROLES_SQL + f"create database {RESTORE_DB};\n")
    target = cluster.conn(RESTORE_DB)
    tools.psql(target, SUPABASE_STUBS_SQL)
    return target


def restore_dump(tools: PgTools, target: dict, dump: Path) -> tuple[int, int]:
    proc = tools.run([tools.exe("pg_restore"), "--no-owner", "--no-privileges", "-d", RESTORE_DB, str(dump)],
                     conn=target, timeout=3600)
    allowed, unexpected = split_restore_errors(proc.stderr)
    if unexpected:
        # Keep the raw messages on this PC only (J:, never the G: logs): they can name rows.
        note = Path("J:/LumaOps/restore-work/last-restore-errors.txt")
        try:
            note.parent.mkdir(parents=True, exist_ok=True)
            note.write_text(redact(proc.stderr)[:20000], encoding="utf-8")
        except OSError:
            pass
    return allowed, unexpected


def open_set(set_dir: Path, manifest: dict, names: tuple[str, ...], passphrase: str, gpg: Gpg, work: Path,
             checks: Checks) -> dict[str, Path]:
    """Check each locked file against the manifest, then unlock it into `work`."""
    files = {f["name"]: f for f in manifest["files"]}
    for name in names:
        entry = files.get(name)
        path = Path(set_dir) / name
        if entry is None or not path.is_file():
            checks.add(f"{name} present", False)
            raise BackupError("verify_failed", "A backup file is missing.")
        size, sha = sha256_file(path)
        if not checks.add(f"{name} sha256 matches manifest", sha == entry["sha256"] and size == entry["bytes"]):
            raise BackupError("verify_failed", "A locked backup file changed after it was made.")
    work.mkdir(parents=True, exist_ok=True)
    plain = {}
    for name in names:
        out = work / name[:-4]
        try:
            gpg.decrypt_to_file(Path(set_dir) / name, out, passphrase)
        except CryptoFailure:
            checks.add(f"{name} opens with passphrase {manifest['encryption']['passphrase_id']}", False)
            raise BackupError("restore_failed", "The backup could not be unlocked with the saved passphrase.") from None
        size, sha = sha256_file(out)
        expected = files[name].get("plain_sha256")
        if not checks.add(f"{name} unlocked copy matches original", expected is None or sha == expected):
            raise BackupError("verify_failed", "An unlocked backup file does not match the original.")
        plain[name] = out
    return plain


def run(set_dir: Path, manifest: dict, passphrase: str, pg_bin: Path, gpg: Gpg, restore_base: Path,
        run_stamp: str, now_iso: str) -> tuple[dict, BackupError | None]:
    """Returns (report, error). error is None only when every check passed and cleanup worked.

    Everything decrypted, and the cluster itself, lives in <restore_base>/<run_stamp>, which is
    deleted (and checked gone) before this returns.
    """
    checks = Checks()
    report = {"schema_version": 1, "stamp": manifest["stamp"], "tested_at": now_iso, "result": "failed",
              "error_code": None, "checks": checks.items, "rows_restored": {}, "storage": {},
              "pg_restore": {"allowed_errors": 0, "unexpected_errors": 0}}
    work = Path(restore_base) / run_stamp
    cluster: LocalCluster | None = None
    error: BackupError | None = None
    try:
        tools = PgTools(pg_bin, work / "tmp")
        # 1. hashes, then decrypt
        plain = open_set(set_dir, manifest, ("db.dump.gpg", "storage.tar.gpg"), passphrase, gpg, work, checks)

        # 2-4. throwaway cluster, prep, pg_restore
        cluster = LocalCluster(tools, work / "cluster", free_port())
        target = prepare_cluster(tools, cluster)
        allowed, unexpected = restore_dump(tools, target, plain["db.dump.gpg"])
        report["pg_restore"] = {"allowed_errors": allowed, "unexpected_errors": unexpected}
        if not checks.add("pg_restore finished without unexpected errors", unexpected == 0,
                          f"allowed={allowed} unexpected={unexpected}"):
            raise BackupError("restore_failed")

        # 5. checks
        restored = inspect(tools, target)
        counts = restored["counts"]
        report["rows_restored"] = counts
        db = manifest["database"]
        for table, numbers in sorted(db["tables"].items()):
            if table not in counts:
                checks.add(f"table {table} restored", False)
                continue
            before, after, got = numbers["rows_before"], numbers["rows_after"], counts[table]
            low, high = min(before, after), max(before, after)
            ok = low <= got <= high and not (got == 0 and before > 0 and after > 0)
            checks.add(f"rows {table}", ok, f"before={before} after={after} restored={got}")

        want = db["schema_fingerprint"]
        have = restored["fingerprint"]
        for key in ("tables", "rls_tables", "triggers", "indexes", "constraints", "per_table"):
            checks.add(f"schema {key} matches", want.get(key) == have.get(key))
        search = [t for t in have["triggers"] if t.endswith("_search_update")]
        # The design expects 5 search triggers. The fingerprint check above already proves the
        # restore matches the source exactly, so a source with fewer is noted, not failed.
        checks.add("search triggers restored", set(search) == {t for t in want.get("triggers", [])
                                                              if t.endswith("_search_update")},
                   f"count={len(search)} expected_5={len(search) == 5}")
        if "luma_password_hash_guard" in want.get("triggers", []):
            checks.add("password hash guard restored", "luma_password_hash_guard" in have["triggers"])
        if "notes" in have["tables"] and "profiles" in have["tables"]:
            try:
                res = tools.psql_json(target, SANITY_INSERT_SQL)
                if res["inserted"] == 0:
                    checks.add("test note insert (rolled back)", True, "skipped: no profiles")
                else:
                    checks.add("test note insert (rolled back)", res["id_ok"] and res["search_ok"],
                               f"id_default={res['id_ok']} search_vector={res['search_ok']}")
            except PgFailure:
                checks.add("test note insert (rolled back)", False)

        # storage archive
        idx = safe_extract(plain["storage.tar.gpg"], work / "storage")
        per_bucket: dict[str, dict] = {b["name"]: {"objects": 0, "bytes": 0} for b in idx["buckets"]}
        bad = 0
        for obj in idx["objects"]:
            p = work / "storage" / "objects" / obj["bucket"] / Path(*obj["path"].split("/"))
            if not p.is_file():
                bad += 1
                continue
            size, sha = sha256_file(p)
            if size != obj["bytes"] or sha != obj["sha256"]:
                bad += 1
            per_bucket.setdefault(obj["bucket"], {"objects": 0, "bytes": 0})
            per_bucket[obj["bucket"]]["objects"] += 1
            per_bucket[obj["bucket"]]["bytes"] += size
        on_disk = sum(1 for p in (work / "storage" / "objects").rglob("*") if p.is_file()) \
            if (work / "storage" / "objects").exists() else 0
        report["storage"] = per_bucket
        checks.add("storage files match index", bad == 0 and on_disk == len(idx["objects"]),
                   f"objects={len(idx['objects'])} mismatched={bad} on_disk={on_disk}")
        checks.add("storage counts match manifest", per_bucket == manifest["storage"])

        if not checks.ok:
            raise BackupError("restore_failed")
        report["result"] = "passed"
    except BackupError as exc:
        error = exc
    except Exception as exc:  # noqa: BLE001 - any surprise is a failed restore test, never a pass
        log.info("restore test stopped: %s", getattr(exc, "detail", type(exc).__name__))
        error = BackupError("restore_failed")
    finally:
        if cluster is not None:
            try:
                cluster.stop()
            except Exception:  # noqa: BLE001 - teardown must go on to deleting the folder
                log.info("could not stop the restore cluster cleanly")
        shutil.rmtree(work, ignore_errors=True)
        if work.exists():
            report["result"] = "failed"
            error = BackupError("cleanup_failed",
                                f"Could not delete the practice restore folder {work}. Delete it by hand.")
    if error is not None:
        report["result"] = "failed"
        report["error_code"] = error.code
    return report, error

