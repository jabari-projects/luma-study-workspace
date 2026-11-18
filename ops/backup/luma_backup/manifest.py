"""manifest.json and status.json: write, read, validate. Names and numbers only, never student data."""

from __future__ import annotations

import json
import os
import re
from pathlib import Path

from .errors import ERROR_CODES

SCHEMA_VERSION = 1
RESULTS = ("verified", "unverified", "failed")
RESTORE_RESULTS = ("passed", "failed", "not_run")

# Text that must never appear in a manifest, report or status file.
_FORBIDDEN = [
    re.compile(r"@"),
    re.compile(r"postgres(?:ql)?://", re.I),
    re.compile(r"eyJ[A-Za-z0-9_-]{4,}\."),
    re.compile(r"sb_secret_"),
    re.compile(r"\$argon2"),
]


class ManifestError(Exception):
    pass


def write_json(path: Path, data: dict) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(data, indent=2, sort_keys=True)
    assert_public_safe(text)
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(text + "\n")
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)


def read_json(path: Path) -> dict:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def assert_public_safe(text: str) -> None:
    for pattern in _FORBIDDEN:
        if pattern.search(text):
            raise ManifestError("refusing to write text that looks like private data")


def new_manifest(stamp: str, source: str, started_at: str, tools: dict, passphrase_id: str) -> dict:
    return {
        "schema_version": SCHEMA_VERSION,
        "stamp": stamp,
        "source": source,
        "started_at": started_at,
        "finished_at": None,
        "tools": tools,
        "scope": {"database": {"schemas": ["public"], "format": "pg_dump custom"}, "storage": {"buckets": []}},
        "restore_needs": {
            "roles": ["anon", "authenticated", "service_role"],
            "extensions": {"extensions": ["uuid-ossp"]},
            "same_jwt_secret_key": True,
        },
        "database": {"tables": {}, "schema_fingerprint": {}, "legacy_plaintext_password_rows": None},
        "storage": {},
        "files": [],
        "encryption": {"tool": "gpg", "mode": "symmetric", "cipher": "AES256", "passphrase_id": passphrase_id},
        "restore_test": {"result": "not_run", "report": "restore-report.json"},
        "result": "unverified",
    }


def validate(m: dict) -> dict:
    need = ["schema_version", "stamp", "source", "started_at", "tools", "scope", "restore_needs", "database",
            "storage", "files", "encryption", "restore_test", "result"]
    missing = [k for k in need if k not in m]
    if missing:
        raise ManifestError(f"manifest is missing {', '.join(missing)}")
    if m["schema_version"] != SCHEMA_VERSION:
        raise ManifestError("unknown manifest version")
    if m["source"] not in ("production", "synthetic"):
        raise ManifestError("unknown source")
    if m["result"] not in RESULTS or m["restore_test"]["result"] not in RESTORE_RESULTS:
        raise ManifestError("unknown result")
    for f in m["files"]:
        if not {"name", "bytes", "sha256"} <= set(f) or not re.fullmatch(r"[0-9a-f]{64}", f["sha256"]):
            raise ManifestError("bad file entry")
    return m


# ------------------------------------------------------------------ status.json (design A.8)

def empty_status() -> dict:
    return {
        "schema_version": SCHEMA_VERSION,
        "last_attempt": None,
        "last_verified": None,
        "last_restore_test": None,
        "consecutive_failures": 0,
        "expected_interval_hours": None,
        "warn_after_hours": None,
    }


def load_status(path: Path) -> dict:
    path = Path(path)
    if not path.is_file():
        return empty_status()
    data = read_json(path)
    base = empty_status()
    base.update(data)
    return base


def record_attempt(path: Path, *, stamp: str, started_at: str, finished_at: str, result: str,
                   error_code: str | None, message: str) -> dict:
    if result not in ("verified", "failed"):
        raise ValueError("result must be verified or failed")
    if error_code is not None and error_code not in ERROR_CODES:
        raise ValueError("unknown error code")
    status = load_status(path)
    status["last_attempt"] = {"stamp": stamp, "started_at": started_at, "finished_at": finished_at,
                              "result": result, "error_code": error_code, "message": message}
    if result == "verified":
        status["last_verified"] = {"stamp": stamp, "finished_at": finished_at}
        status["consecutive_failures"] = 0
    else:
        status["consecutive_failures"] = int(status.get("consecutive_failures") or 0) + 1
    write_json(path, status)
    return status


def record_restore_test(path: Path, *, stamp: str, tested_at: str, result: str, error_code: str | None,
                        message: str) -> dict:
    """A restore test of an older set (restore_test_run.py). check_status reports a failed one."""
    status = load_status(path)
    status["last_restore_test"] = {"stamp": stamp, "tested_at": tested_at, "result": result,
                                   "error_code": error_code, "message": message}
    write_json(path, status)
    return status
