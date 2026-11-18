"""One full backup run: preflight, database dump, Storage export, encrypt, verify, manifest,
isolated restore test, status. Design sections A.4-A.8.

    python backup_run.py --production            (the owner, after setup_credentials.py)
    python backup_run.py --source synthetic ...  (tests only: fake data on 127.0.0.1)

Exit codes: 0 = verified, 2 = failed. The last line printed is plain words.
"""

from __future__ import annotations

import argparse
import logging
import os
import platform
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from luma_backup import manifest as mf  # noqa: E402
from luma_backup import restore_test, secrets_store, storage_export  # noqa: E402
from luma_backup.common import (check_free_space, clear_leftover_work, close_logging, drive_present,  # noqa: E402
                                remove_tree_checked, run_lock, setup_logging)
from luma_backup.config import (LOCAL_HOST, UnsafePath, add_path_args, check_paths, iso, make_stamp,  # noqa: E402
                                paths_from_args, utc_now)
from luma_backup.crypto import CryptoFailure, Gpg, sha256_file  # noqa: E402
from luma_backup.errors import BackupError  # noqa: E402
from luma_backup.pgtools import PgFailure, PgTools, inspect  # noqa: E402

log = logging.getLogger("luma_backup")

PG_DUMP_ARGS = ["-Fc", "-Z", "6", "--schema=public", "--no-publications", "--no-subscriptions",
                "--no-security-labels", "--lock-wait-timeout=30s"]


def check_source(secrets: secrets_store.Secrets, source: str) -> None:
    """A production run must use the Supabase session pooler; a synthetic run must stay on 127.0.0.1."""
    db = secrets.db
    if source == "production":
        if not str(db.get("host", "")).endswith(".pooler.supabase.com") or int(db.get("port", 0)) != 5432 \
                or db.get("sslmode") != "require":
            raise BackupError("secrets_unavailable",
                              "The saved database address must be the Supabase session pooler on port 5432.")
    elif db.get("host") != LOCAL_HOST:
        raise BackupError("secrets_unavailable", "A synthetic run only talks to a database on 127.0.0.1.")


def dump_database(tools: PgTools, conn: dict, work: Path, manifest: dict) -> Path:
    if not tools.can_connect(conn):
        raise BackupError("db_connect_failed")
    try:
        before = inspect(tools, conn)
    except PgFailure as exc:
        raise BackupError("dump_failed", detail=exc.detail) from None
    dump = work / "db.dump"
    proc = tools.run([tools.exe("pg_dump"), *PG_DUMP_ARGS, "-f", str(dump)], conn=conn, timeout=3600)
    if proc.returncode != 0 or not dump.is_file():
        raise BackupError("dump_failed", detail=proc.stderr[-1500:])
    try:
        after = inspect(tools, conn)
    except PgFailure as exc:
        raise BackupError("dump_failed", detail=exc.detail) from None
    if before["fingerprint"]["tables"] != after["fingerprint"]["tables"]:
        raise BackupError("dump_failed", "The database changed shape during the copy. Try again later.")
    manifest["database"] = {
        "tables": {t: {"rows_before": before["counts"].get(t, 0), "rows_after": after["counts"].get(t, 0)}
                   for t in before["fingerprint"]["tables"]},
        "schema_fingerprint": before["fingerprint"],
        "legacy_plaintext_password_rows": before["legacy_plaintext_password_rows"],
    }
    log.info("database: %d tables, %d rows", len(manifest["database"]["tables"]),
             sum(v["rows_after"] for v in manifest["database"]["tables"].values()))
    return dump


def encrypt_and_verify(gpg: Gpg, plain: Path, out: Path, passphrase: str, err_dir: Path) -> dict:
    psize, psha = sha256_file(plain)
    try:
        gpg.encrypt(plain, out, passphrase)
    except CryptoFailure as exc:
        raise BackupError("encrypt_failed", detail=str(exc)) from None
    try:
        vsize, vsha = gpg.decrypt_hash(out, passphrase, err_dir)
    except CryptoFailure as exc:
        raise BackupError("verify_failed", detail=str(exc)) from None
    if (vsize, vsha) != (psize, psha):
        raise BackupError("verify_failed")
    plain.unlink()
    if plain.exists():
        raise BackupError("cleanup_failed", f"Could not delete the unlocked copy at {plain}. Delete it by hand.")
    esize, esha = sha256_file(out)
    return {"name": out.name, "bytes": esize, "sha256": esha, "plain_bytes": psize, "plain_sha256": psha}


def run_backup(paths, source: str, stamp: str, started, waits) -> dict:
    """Raises BackupError on any failure. Leaves a final <stamp>/ folder only when verified."""
    partial = paths.backup_root / f"{stamp}.partial"
    work = paths.work_base / stamp
    with run_lock(paths, stamp, "backup"):
        # A run that was killed earlier may have left unlocked student data behind: remove it
        # first (checked gone), or stop with cleanup_failed.
        clear_leftover_work(paths)
        try:
            secrets = secrets_store.load(paths.secrets_file)
        except secrets_store.SecretsUnavailable as exc:
            raise BackupError("secrets_unavailable", str(exc)) from None
        secrets.register()
        check_source(secrets, source)
        check_free_space(paths.backup_root, paths.work_base, paths.restore_base)
        gpg: Gpg | None = None
        manifest: dict | None = None
        try:
            tools = PgTools(paths.pg_bin, work / "tmp")
            gpg = Gpg(paths.gnupg_home)
            manifest = mf.new_manifest(stamp, source, iso(started),
                                       {"pg_dump": tools.version, "gpg": gpg.version,
                                        "python": platform.python_version()}, secrets.passphrase_id)
            partial.mkdir(parents=True, exist_ok=False)
            try:
                dump = dump_database(tools, dict(secrets.db), work, manifest)
                url = storage_export.check_storage_url(secrets.storage["url"], source == "production")
                client = storage_export.StorageClient(url, secrets.storage["service_key"], waits=waits)
                tar_path, st = storage_export.export(client, work)
                manifest["scope"]["storage"]["buckets"] = st["buckets"]
                manifest["storage"] = st["summary"]
                manifest["files"] = [
                    encrypt_and_verify(gpg, dump, partial / "db.dump.gpg", secrets.passphrase, work / "tmp"),
                    encrypt_and_verify(gpg, tar_path, partial / "storage.tar.gpg", secrets.passphrase, work / "tmp"),
                ]
            finally:
                # Plaintext lives only in the work folder, and only until here.
                remove_tree_checked(work)
            mf.write_json(partial / "manifest.json", manifest)
            report, error = restore_test.run(partial, manifest, secrets.passphrase, paths.pg_bin, gpg,
                                             paths.restore_base, stamp, iso(utc_now()))
            mf.write_json(partial / "restore-report.json", report)
            manifest["restore_test"]["result"] = report["result"]
            manifest["result"] = "verified" if error is None else "failed"
            manifest["finished_at"] = iso(utc_now())
            mf.write_json(partial / "manifest.json", manifest)
            if error is not None:
                raise error
            os.replace(partial, paths.backup_root / stamp)
            return manifest
        except Exception:
            if partial.exists() and not any(partial.glob("*.gpg")):
                # Nothing encrypted was written, so there is nothing worth keeping.
                remove_tree_checked(partial)
            elif partial.exists() and manifest is not None:
                manifest["result"] = "failed"
                manifest["finished_at"] = manifest["finished_at"] or iso(utc_now())
                mf.write_json(partial / "manifest.json", manifest)
            raise
        finally:
            if work.exists():
                remove_tree_checked(work)
            if gpg is not None:
                gpg.kill_agent()


STATUS_WRITE_FAILED = ("Luma couldn't write the backup status file, so this backup can't be "
                       "trusted. Look at the backup drive, then run a backup again.")


def record(paths, **attempt) -> bool:
    """Writes the attempt to status.json. If that fails, leaves ATTENTION.txt directly, so a
    broken status file is never silent. Returns False when the status could not be written."""
    try:
        mf.record_attempt(paths.status_file, **attempt)
        return True
    except Exception as exc:  # noqa: BLE001 - a status that can't be written must be reported
        log.info("could not write the status file: %s", type(exc).__name__)
        try:
            paths.backup_root.mkdir(parents=True, exist_ok=True)
            paths.attention_file.write_text(STATUS_WRITE_FAILED + "\n", encoding="utf-8")
        except OSError:
            log.info("could not write ATTENTION.txt either")
        print(STATUS_WRITE_FAILED)
        return False


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Make one encrypted, restore-tested Luma backup.")
    which = parser.add_mutually_exclusive_group(required=True)
    which.add_argument("--production", action="store_true", help="back up the live Luma database and files")
    which.add_argument("--source", choices=["synthetic"], help="tests only: fake data on 127.0.0.1")
    add_path_args(parser)
    parser.add_argument("--storage-retry-waits", default="2,5,15", help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    paths = paths_from_args(args)
    source = "production" if args.production else "synthetic"
    waits = tuple(float(x) for x in args.storage_retry_waits.split(","))

    try:
        check_paths(paths)
    except UnsafePath as exc:
        print(f"Backup stopped: {exc}")
        return 2
    if not drive_present(paths.backup_root):
        print(f"Backup stopped: the backup drive {paths.backup_root.anchor} is not connected.")
        return 2

    started = utc_now()
    stamp = make_stamp(started)
    log_path = setup_logging(paths, stamp)
    log.info("backup %s started (%s)", stamp, source)
    try:
        manifest = run_backup(paths, source, stamp, started, waits)
        db = manifest["database"]["tables"]
        message = (f"Backup {stamp} is saved, locked and checked: {len(db)} tables, "
                   f"{sum(v['rows_after'] for v in db.values())} rows, "
                   f"{sum(b['objects'] for b in manifest['storage'].values())} uploaded files.")
        if not record(paths, stamp=stamp, started_at=iso(started), finished_at=iso(utc_now()),
                      result="verified", error_code=None, message=message):
            return 2
        log.info(message)
        return 0
    except BackupError as exc:
        if exc.detail:
            log.info("details: %s", exc.detail)
        record(paths, stamp=stamp, started_at=iso(started), finished_at=iso(utc_now()),
               result="failed", error_code=exc.code, message=exc.message)
        log.info("Backup failed (%s): %s See %s", exc.code, exc.message, log_path)
        return 2
    except Exception as exc:  # noqa: BLE001 - an unknown problem must still be recorded, never hidden
        log.info("unexpected problem: %s", type(exc).__name__)
        message = "The backup stopped because of an unexpected problem."
        record(paths, stamp=stamp, started_at=iso(started), finished_at=iso(utc_now()),
               result="failed", error_code=None, message=message)
        log.info("Backup failed: %s See %s", message, log_path)
        return 2
    finally:
        close_logging()


if __name__ == "__main__":
    sys.exit(main())
