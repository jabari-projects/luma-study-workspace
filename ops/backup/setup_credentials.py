"""OWNER RUNS THIS in their own terminal. Never run by Claude or by a script.

Saves the database and Storage keys, plus a new backup passphrase, sealed with Windows DPAPI
so they open only for this Windows user on this PC (design A.3).

    python setup_credentials.py                      first setup (or to replace the keys)
    python setup_credentials.py --check              test the saved keys (prints OK lines only)
    python setup_credentials.py --rotate-passphrase  new passphrase for new backups; old ones still open
    python setup_credentials.py --show-passphrase lb-2026-11-a
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import getpass
import json
import os
import secrets
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from luma_backup import secrets_store  # noqa: E402
from luma_backup.config import GNUPG_HOME, PG_BIN, RESTORE_BASE, SECRETS_FILE, WORK_BASE  # noqa: E402
from luma_backup.errors import BackupError  # noqa: E402
from luma_backup.pgtools import PgFailure, PgTools  # noqa: E402
from luma_backup.storage_export import StorageClient, check_storage_url  # noqa: E402


def clear_screen() -> None:
    os.system("cls" if os.name == "nt" else "clear")  # noqa: S605 - fixed command, no input


def ask(prompt: str, secret: bool = False) -> str:
    value = getpass.getpass(prompt) if secret else input(prompt)
    return value.strip()


def jwt_role(token: str) -> str | None:
    """Read the role claim of a legacy key WITHOUT verifying it (only to refuse the anon key)."""
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        return json.loads(base64.urlsafe_b64decode(payload)).get("role")
    except (IndexError, ValueError):
        return None


def new_passphrase_id(existing: set[str]) -> str:
    today = dt.date.today()
    for letter in "abcdefghijklmnopqrstuvwxyz":
        pid = f"lb-{today:%Y-%m}-{letter}"
        if pid not in existing:
            return pid
    raise SystemExit("Too many passphrases this month.")


def show_passphrase_once(pid: str, passphrase: str) -> None:
    print()
    print(f"Your backup passphrase ({pid}):")
    print()
    print(f"    {passphrase}")
    print()
    print(f"Save this in your password manager now, as 'Luma backup passphrase {pid}'. "
          "Backups can't be opened without it if this PC is lost.")
    input("Press Enter when it is saved. The screen will clear.")
    clear_screen()


def lock_folders() -> None:
    user = os.environ.get("USERNAME")
    if not user:
        print("Could not find your Windows user name, so the folders were not locked.")
        return
    for folder in (SECRETS_FILE.parent, GNUPG_HOME, WORK_BASE, RESTORE_BASE):
        folder.mkdir(parents=True, exist_ok=True)
        subprocess.run(["icacls", str(folder), "/inheritance:r", "/grant:r", f"{user}:(OI)(CI)F"],
                       capture_output=True, check=False)
    print("Your backup folders on J: are now readable only by you.")


def collect(prefill: dict | None = None) -> dict:
    """Ask for the logins. Non-secret values (host, user, project URL) may come prefilled from the
    command line so the owner only pastes the two secrets; secrets are always typed, hidden."""
    prefill = prefill or {}
    print("Open Supabase > your project > Connect > Session pooler. Copy each value when asked.")
    host = prefill.get("host") or ask("Host (ends with .pooler.supabase.com): ")
    if host.endswith(".supabase.co") and host.startswith("db."):
        raise SystemExit("That is the direct address. It does not work from home internet on the free plan. "
                         "Use the Session pooler host instead.")
    if not host.endswith(".pooler.supabase.com"):
        raise SystemExit("The host must end with .pooler.supabase.com.")
    port = "5432" if prefill.get("host") else (ask("Port (5432): ") or "5432")
    if port != "5432":
        raise SystemExit("Use port 5432 (Session pooler). Port 6543 can't make backups.")
    user = prefill.get("user") or ask("User (looks like postgres.<project-id>): ")
    if not user.startswith("postgres."):
        raise SystemExit("The user must look like postgres.<project-id>.")
    dbname = "postgres" if prefill.get("host") else (ask("Database (postgres): ") or "postgres")
    password = ask("Database password (hidden): ", secret=True)
    url = (prefill.get("url") or ask("Project URL (https://<project-id>.supabase.co): ")).rstrip("/")
    check_storage_url(url, production=True)
    key = ask("Secret key (sb_secret_... or the service_role key) (hidden): ", secret=True)
    if not key.startswith("sb_secret_") and jwt_role(key) != "service_role":
        raise SystemExit("That is not a secret (service) key. The public anon or publishable key can't be used.")
    answer = ask("Are these the newest database password and secret key (made after the last time any key "
                 "was shown or shared)? Type yes: ")
    if answer.lower() != "yes":
        raise SystemExit("Stopped. Make new keys in Supabase first, then run this again.")
    return {"db": {"host": host, "port": int(port), "user": user, "dbname": dbname, "password": password,
                   "sslmode": "require"},
            "storage": {"url": url, "service_key": key}}


def setup(prefill: dict | None = None) -> None:
    existing: dict = {}
    if SECRETS_FILE.is_file():
        try:
            existing = secrets_store.load(SECRETS_FILE).to_dict()
        except secrets_store.SecretsUnavailable:
            existing = {}
    data = collect(prefill)
    if existing.get("passphrase"):
        # Keep the passphrase so older backups still open with the same one.
        data.update({k: existing[k] for k in ("passphrase", "passphrase_id", "old_passphrases")})
        data["created_at"] = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        secrets_store.seal(data, SECRETS_FILE)
        print(f"Keys saved. Your backup passphrase is unchanged ({data['passphrase_id']}).")
    else:
        pid = new_passphrase_id(set())
        data.update({"passphrase": secrets.token_urlsafe(32), "passphrase_id": pid, "old_passphrases": {},
                     "created_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")})
        secrets_store.seal(data, SECRETS_FILE)
        show_passphrase_once(pid, data["passphrase"])
    lock_folders()
    print("Next: python setup_credentials.py --check")


def check() -> int:
    s = secrets_store.load(SECRETS_FILE)
    s.register()
    ok = True
    temp = WORK_BASE / "check-tmp"
    try:
        connected = PgTools(PG_BIN, temp).can_connect(dict(s.db))
        print("Database: OK" if connected else "Database: could not connect")
        ok = connected
    except (BackupError, PgFailure):
        print("Database: the PostgreSQL 17 tools are missing")
        ok = False
    finally:
        shutil.rmtree(temp, ignore_errors=True)
    try:
        names = [b["name"] for b in StorageClient(s.storage["url"], s.storage["service_key"]).list_buckets()]
        print(f"Files: OK ({', '.join(names) or 'no buckets'})")
    except BackupError:
        print("Files: could not list the Storage buckets")
        ok = False
    return 0 if ok else 2


def rotate() -> None:
    s = secrets_store.load(SECRETS_FILE)
    data = s.to_dict()
    data["old_passphrases"][s.passphrase_id] = s.passphrase
    pid = new_passphrase_id({s.passphrase_id, *s.old_passphrases})
    data["passphrase"], data["passphrase_id"] = secrets.token_urlsafe(32), pid
    secrets_store.seal(data, SECRETS_FILE)
    show_passphrase_once(pid, data["passphrase"])
    print("New backups use the new passphrase. Older backups still open with their own.")


def show(pid: str) -> None:
    s = secrets_store.load(SECRETS_FILE)
    show_passphrase_once(pid, s.passphrase_for(pid))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--check", action="store_true")
    group.add_argument("--rotate-passphrase", action="store_true")
    group.add_argument("--show-passphrase", metavar="ID")
    # Non-secret values only; the password and key are always typed (hidden) by the owner.
    parser.add_argument("--host", help="Session pooler host, e.g. aws-0-us-east-2.pooler.supabase.com")
    parser.add_argument("--user", help="Database user, e.g. postgres.<project-id>")
    parser.add_argument("--project-url", help="https://<project-id>.supabase.co")
    args = parser.parse_args()
    if not sys.stdin.isatty():
        print("Run this yourself in a terminal window. It asks for keys and must not be run by a script.")
        return 2
    try:
        if args.check:
            return check()
        if args.rotate_passphrase:
            rotate()
        elif args.show_passphrase:
            show(args.show_passphrase)
        else:
            setup({"host": args.host, "user": args.user, "url": args.project_url})
        return 0
    except secrets_store.SecretsUnavailable as exc:
        print(exc)
        return 2


if __name__ == "__main__":
    sys.exit(main())
