"""Run pg_dump / psql / pg_restore / initdb / pg_ctl with a minimal child environment.

Secrets reach child processes only through PGPASSWORD in a child env built from scratch.
Nothing from the parent env passes through (no SUPABASE_*, STRIPE_*, RESEND_* ...).
"""

from __future__ import annotations

import json
import os
import random
import secrets as pysecrets
import shutil
import socket
import subprocess
from pathlib import Path

from .config import LOCAL_HOST, RESTORE_PORTS
from .errors import BackupError
from .redact import redact

TOOLS = ("pg_dump", "pg_restore", "psql", "initdb", "pg_ctl")


class PgFailure(Exception):
    """A Postgres tool failed. `detail` is already redacted."""

    def __init__(self, detail: str):
        self.detail = detail
        super().__init__(detail)


def _exe(pg_bin: Path, name: str) -> Path:
    suffix = ".exe" if os.name == "nt" else ""
    return Path(pg_bin) / f"{name}{suffix}"


class PgTools:
    def __init__(self, pg_bin: Path, temp_dir: Path):
        self.pg_bin = Path(pg_bin)
        self.temp_dir = Path(temp_dir)
        for name in TOOLS:
            if not _exe(self.pg_bin, name).is_file():
                raise BackupError("tool_missing", f"The PostgreSQL tool {name} is missing from {self.pg_bin}.")
        out = subprocess.run([str(_exe(self.pg_bin, "pg_dump")), "--version"], capture_output=True,
                             text=True, env=self.child_env(), timeout=60)
        text = out.stdout.strip()
        if not text.startswith("pg_dump (PostgreSQL) 17."):
            raise BackupError("tool_missing", "pg_dump must be version 17.")
        self.version = text.rsplit(" ", 1)[-1]

    def exe(self, name: str) -> str:
        return str(_exe(self.pg_bin, name))

    def child_env(self, conn: dict | None = None) -> dict:
        self.temp_dir.mkdir(parents=True, exist_ok=True)
        system_root = os.environ.get("SYSTEMROOT", r"C:\Windows")
        env = {
            "SYSTEMROOT": system_root,
            # initdb and pg_ctl start the server through cmd.exe; without COMSPEC initdb crashes.
            "COMSPEC": os.environ.get("COMSPEC", system_root + r"\System32\cmd.exe"),
            "PATH": str(self.pg_bin),
            "TEMP": str(self.temp_dir),
            "TMP": str(self.temp_dir),
            "PGCLIENTENCODING": "UTF8",
            "PGAPPNAME": "luma-backup",
            "PGCONNECT_TIMEOUT": "20",
        }
        if conn:
            env.update({
                "PGHOST": str(conn["host"]),
                "PGPORT": str(conn["port"]),
                "PGUSER": str(conn["user"]),
                "PGDATABASE": str(conn["dbname"]),
                "PGSSLMODE": str(conn.get("sslmode", "require")),
                "PGPASSWORD": str(conn["password"]),
            })
        return env

    def run(self, args: list[str], conn: dict | None = None, input_text: str | None = None,
            timeout: int = 600) -> subprocess.CompletedProcess:
        try:
            proc = subprocess.run(args, input=input_text, capture_output=True, text=True,
                                  encoding="utf-8", errors="replace", env=self.child_env(conn),
                                  timeout=timeout, stdin=None if input_text is not None else subprocess.DEVNULL)
        except subprocess.TimeoutExpired:
            raise PgFailure(f"{Path(args[0]).stem} timed out") from None
        return proc

    def psql(self, conn: dict, sql: str, timeout: int = 300) -> str:
        proc = self.run([self.exe("psql"), "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-f", "-"],
                        conn=conn, input_text=sql, timeout=timeout)
        if proc.returncode != 0:
            raise PgFailure(redact(proc.stderr.strip())[:2000])
        return proc.stdout

    def psql_json(self, conn: dict, sql: str, timeout: int = 300):
        out = [line for line in self.psql(conn, sql, timeout).splitlines() if line.strip()]
        if not out:
            raise PgFailure("query returned nothing")
        return json.loads(out[-1])

    def can_connect(self, conn: dict) -> bool:
        try:
            return self.psql(conn, "select 1;", timeout=60).strip() == "1"
        except PgFailure:
            return False


# ------------------------------------------------------------------ inspection (names and numbers only)

def fingerprint_sql() -> str:
    return """
select json_build_object(
  'tables', (select coalesce(json_agg(c.relname order by c.relname), '[]'::json)
             from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'public' and c.relkind in ('r', 'p')),
  'rls_tables', (select coalesce(json_agg(c.relname order by c.relname), '[]'::json)
                 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                 where n.nspname = 'public' and c.relkind in ('r', 'p') and c.relrowsecurity),
  'triggers', (select coalesce(json_agg(x.tgname order by x.tgname), '[]'::json) from (
                 select distinct t.tgname from pg_trigger t
                 join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
                 where n.nspname = 'public' and not t.tgisinternal) x),
  'indexes', (select count(*) from pg_index i join pg_class c on c.oid = i.indrelid
              join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public'),
  'constraints', (select count(*) from pg_constraint co join pg_namespace n on n.oid = co.connamespace
                  where n.nspname = 'public' and co.contype in ('p', 'u', 'f', 'c', 'x')),
  'per_table', (select coalesce(json_object_agg(c.relname, json_build_object(
                   'indexes', (select count(*) from pg_index i where i.indrelid = c.oid),
                   'constraints', (select count(*) from pg_constraint co where co.conrelid = c.oid
                                   and co.contype in ('p', 'u', 'f', 'c', 'x')))), '{}'::json)
                from pg_class c join pg_namespace n on n.oid = c.relnamespace
                where n.nspname = 'public' and c.relkind in ('r', 'p'))
);
"""


def _ident(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def count_sql(tables: list[str]) -> str:
    if not tables:
        return "select '{}'::json;"
    parts = ", ".join(f"'{t.replace(chr(39), chr(39) * 2)}', (select count(*) from public.{_ident(t)})" for t in tables)
    return f"select json_build_object({parts});"


LEGACY_PASSWORD_SQL = """
select case when exists (select 1 from information_schema.columns
                         where table_schema = 'public' and table_name = 'users' and column_name = 'password')
  then (select json_build_object('n', (select count(*) from public.users
                                        where password is not null and password not like '$argon2%')))
  else json_build_object('n', null) end;
"""

READ_ONLY_PREFIX = "begin transaction read only;\nset local row_security = off;\nset local statement_timeout = '120s';\n"


def inspect(tools: PgTools, conn: dict, with_counts: bool = True) -> dict:
    """Fingerprint plus row counts, inside one read-only transaction.

    row_security = off makes Postgres raise an error instead of silently hiding rows
    if row level security would apply, so a count is never quietly too low.
    """
    fp = tools.psql_json(conn, READ_ONLY_PREFIX + fingerprint_sql() + "commit;\n")
    result = {"fingerprint": fp}
    if with_counts:
        result["counts"] = tools.psql_json(conn, READ_ONLY_PREFIX + count_sql(fp["tables"]) + "commit;\n")
        result["legacy_plaintext_password_rows"] = tools.psql_json(
            conn, READ_ONLY_PREFIX + LEGACY_PASSWORD_SQL + "commit;\n")["n"]
    return result


# ------------------------------------------------------------------ throwaway local clusters

def free_port(low: int = RESTORE_PORTS[0], high: int = RESTORE_PORTS[1]) -> int:
    ports = list(range(low, high + 1))
    random.shuffle(ports)
    for port in ports:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind((LOCAL_HOST, port))
                return port
            except OSError:
                continue
    raise PgFailure("no free local port")


class LocalCluster:
    """A Postgres cluster that only ever listens on 127.0.0.1. Used for restore tests and synthetic data."""

    def __init__(self, tools: PgTools, base_dir: Path, port: int):
        self.tools = tools
        self.base_dir = Path(base_dir)
        self.data_dir = self.base_dir / "data"
        self.log_file = self.base_dir / "server.log"
        self.port = port
        self.password = pysecrets.token_urlsafe(24)
        self.host = LOCAL_HOST

    def conn(self, dbname: str = "postgres") -> dict:
        if self.host != LOCAL_HOST:  # hard rule: a restore target is never remote
            raise PgFailure("restore target must be 127.0.0.1")
        return {"host": LOCAL_HOST, "port": self.port, "user": "postgres", "dbname": dbname,
                "password": self.password, "sslmode": "disable"}

    def init(self) -> None:
        self.base_dir.mkdir(parents=True, exist_ok=True)
        pwfile = self.base_dir / "initdb.pw"
        pwfile.write_text(self.password + "\n", encoding="utf-8")
        try:
            proc = self.tools.run([self.tools.exe("initdb"), "-D", str(self.data_dir), "-U", "postgres",
                                   "-A", "scram-sha-256", f"--pwfile={pwfile}", "-E", "UTF8",
                                   "--locale=C", "--no-instructions"], timeout=300)
        finally:
            pwfile.unlink(missing_ok=True)
        if proc.returncode != 0:
            raise PgFailure("initdb failed: " + redact(proc.stderr.strip())[:500])

    def start(self) -> None:
        opts = f"-c listen_addresses={LOCAL_HOST} -c port={self.port} -c fsync=off -c max_connections=20"
        # Output goes to a file, never a pipe: the server inherits pg_ctl's handles on Windows
        # and a pipe would keep this call waiting until the server stops.
        out_path = self.base_dir / "pg_ctl.out"
        with open(out_path, "wb") as out:
            proc = subprocess.run([self.tools.exe("pg_ctl"), "-D", str(self.data_dir), "-l", str(self.log_file),
                                   "-w", "-t", "90", "-o", opts, "start"], stdout=out, stderr=out,
                                  stdin=subprocess.DEVNULL, env=self.tools.child_env(), timeout=180)
        if proc.returncode != 0:
            raise PgFailure("could not start the local test database")

    def stop(self) -> None:
        if not (self.data_dir / "postmaster.pid").exists():
            return
        out_path = self.base_dir / "pg_ctl.out"
        with open(out_path, "ab") as out:
            subprocess.run([self.tools.exe("pg_ctl"), "-D", str(self.data_dir), "-m", "fast", "-w", "-t", "90",
                            "stop"], stdout=out, stderr=out, stdin=subprocess.DEVNULL,
                           env=self.tools.child_env(), timeout=180)

    def destroy(self) -> None:
        self.stop()
        shutil.rmtree(self.base_dir, ignore_errors=True)
