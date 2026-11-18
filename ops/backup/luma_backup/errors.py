"""One error type with a fixed code and a plain message (design A.8)."""

from __future__ import annotations

ERROR_CODES = (
    "secrets_unavailable",
    "tool_missing",
    "disk_low",
    "locked",
    "db_connect_failed",
    "dump_failed",
    "storage_failed",
    "encrypt_failed",
    "verify_failed",
    "restore_failed",
    "cleanup_failed",
)

PLAIN = {
    "secrets_unavailable": "The saved keys could not be opened. Run setup_credentials.py again.",
    "tool_missing": "A backup tool is missing or too old (PostgreSQL 17 tools or gpg 2.4).",
    "disk_low": "There is not enough free space on the backup drive or the work drive.",
    "locked": "Another backup or restore test is already running.",
    "db_connect_failed": "Could not connect to the database. Check the internet and the saved database password.",
    "dump_failed": "The database copy did not finish.",
    "storage_failed": "Could not copy the uploaded files.",
    "encrypt_failed": "Could not lock (encrypt) the backup files.",
    "verify_failed": "A locked backup file does not match what was saved.",
    "restore_failed": "The practice restore did not pass.",
    "cleanup_failed": "Could not delete a temporary unlocked copy.",
}


class BackupError(Exception):
    """`message` is plain words for the owner. `detail` is redacted and goes to the log only."""

    def __init__(self, code: str, message: str | None = None, detail: str = ""):
        if code not in ERROR_CODES:
            raise ValueError(f"unknown error code {code}")
        self.code = code
        self.message = message or PLAIN[code]
        self.detail = detail
        super().__init__(f"{code}: {self.message}")
