"""One-off: hash any plaintext passwords still stored in public.users.

Login already upgrades a plaintext password to an argon2id hash the next time
that person signs in. This script lets an admin finish the job for accounts
that have not signed in since.

Safe by default:
  python scripts/hash_existing_passwords.py                 # dry run, counts only
  python scripts/hash_existing_passwords.py --verify        # read-only; exit 1 if any plaintext remains
  python scripts/hash_existing_passwords.py --apply --i-have-a-backup   # writes hashes

Options:
  --batch-size N    rows read per page (1-1000, default 500)
  --allow-empty     let --verify / --apply exit 0 when no rows were visible

HARD PRECONDITION for --apply: the login code that hashes on every write
(app/passwords.py) must already be deployed everywhere, and no old backend
version that stores plaintext may still be running. The write guard below
only checks "not yet a hash": if an old instance changed a row to a different
plaintext between this script's read and its write, the script would store a
hash of the OLD password and the user's new password would be lost.

Exit codes:
  0  finished with no failures (dry run / verify: nothing left to do)
  1  at least one row failed, the run stopped early, (--verify) plaintext remains,
     or (--verify / --apply) no rows were visible at all and --allow-empty was not given
  2  refused to run (missing --i-have-a-backup, bad option, Supabase or the
     SUPABASE_SERVICE_ROLE_KEY not configured)

Design notes:
  * Rows are read in pages ordered by id using keyset paging (id > last id),
    so updates made during the run never shift the pages.
  * Each page is hashed and written before the next page is read, so a run
    that stops part way keeps everything it already did; running again
    finishes the rest (already-hashed rows are skipped).
  * The write is conditional: it only applies while the stored value is still
    NOT an argon2 hash. A row that a concurrent login upgraded between our
    read and our write is left alone and counted as "changed_meanwhile",
    so nothing is ever hashed twice.
  * The condition deliberately does NOT filter on the old plaintext value:
    PostgREST filters travel in the request URL, and URLs end up in request
    logs (Supabase API logs, proxies, httpx debug logs). The filter used is
    the constant pattern "password NOT LIKE '$argon2%'".
  * It never prints passwords, hashes, emails, ids, tokens or exception
    messages (only exception type names and counts).

It reads SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY from the environment (same
as the backend) and refuses to run with only the anon SUPABASE_KEY: under
row-level security that key sees no rows, which would look like "checked: 0,
plaintext: 0". Run it from the backend/ folder.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from argon2 import extract_parameters  # noqa: E402
from argon2.exceptions import InvalidHashError  # noqa: E402

from app.passwords import ARGON2_PREFIX, hash_password, is_password_hash  # noqa: E402

DEFAULT_BATCH_SIZE = 500
MAX_BATCH_SIZE = 1000
HASH_LIKE_PATTERN = ARGON2_PREFIX + "%"

COUNT_KEYS = (
    "checked",
    "already_hashed",
    "unreadable_hash",
    "empty",
    "plaintext",
    "updated",
    "changed_meanwhile",
    "failed",
)


def new_counts() -> dict:
    return {key: 0 for key in COUNT_KEYS}


def _is_readable_hash(stored: str) -> bool:
    try:
        extract_parameters(stored)
    except (InvalidHashError, ValueError, TypeError):
        return False
    return True


def iter_user_pages(client, batch_size: int):
    """Yield pages of {id, password} rows ordered by id (keyset paging)."""
    last_id = None
    while True:
        query = client.table("users").select("id, password")
        if last_id is not None:
            query = query.gt("id", last_id)
        response = query.order("id").limit(batch_size).execute()
        rows = (response.data if response is not None else None) or []
        if not rows:
            return
        yield rows
        if len(rows) < batch_size:
            return
        last_id = rows[-1]["id"]


def _hash_one_row(client, row: dict, counts: dict) -> None:
    try:
        response = (
            client.table("users")
            .update({"password": hash_password(row["password"])})
            .eq("id", row["id"])
            # Compare-and-swap without putting the secret in the URL: only
            # write while the stored value is still not an argon2 hash.
            .not_.like("password", HASH_LIKE_PATTERN)
            .execute()
        )
    except Exception as exc:  # keep going; report only the error type
        counts["failed"] += 1
        print(f"Could not update one row ({type(exc).__name__})", file=sys.stderr)
        return

    if response is not None and response.data:
        counts["updated"] += 1
    else:
        counts["changed_meanwhile"] += 1


def hash_plaintext_passwords(client, apply: bool, batch_size: int = DEFAULT_BATCH_SIZE) -> dict:
    """Classify every row; with ``apply`` hash plaintext rows page by page.

    Returns counts plus ``aborted`` (True when reading a page failed, in
    which case the counts cover only the rows handled before the failure).
    """
    counts = new_counts()
    counts["aborted"] = False
    pages = iter_user_pages(client, batch_size)
    while True:
        try:
            rows = next(pages)
        except StopIteration:
            break
        except Exception as exc:
            counts["aborted"] = True
            print(f"Stopped: could not read the next page ({type(exc).__name__})", file=sys.stderr)
            break

        for row in rows:
            counts["checked"] += 1
            stored = row.get("password")
            if stored is None or stored == "":
                counts["empty"] += 1
            elif not isinstance(stored, str):
                counts["failed"] += 1
                print("Skipped one row with a non-text password value", file=sys.stderr)
            elif is_password_hash(stored):
                if _is_readable_hash(stored):
                    counts["already_hashed"] += 1
                else:
                    # Starts with "$argon2" but is not a valid hash. Never
                    # re-hashed automatically: needs a human look.
                    counts["unreadable_hash"] += 1
            else:
                counts["plaintext"] += 1
                if apply:
                    _hash_one_row(client, row, counts)
    return counts


def print_summary(counts: dict, mode: str) -> None:
    labels = {
        "apply": "APPLY",
        "verify": "VERIFY (read-only)",
        "dry-run": "DRY RUN (nothing written; pass --apply --i-have-a-backup to write)",
    }
    print(labels[mode])
    for key in COUNT_KEYS:
        if mode != "apply" and key in ("updated", "changed_meanwhile"):
            continue
        print(f"  {key}: {counts[key]}")
    if counts["checked"] == 0 and not counts.get("aborted"):
        print("  WARNING: no rows were visible. Check that SUPABASE_SERVICE_ROLE_KEY is the")
        print("  service-role key and that this is the right project before trusting this result.")
    if counts.get("aborted"):
        print("  STOPPED EARLY: the counts above cover only the rows handled before the stop.")
        print("  Rows already updated stay hashed. Run the same command again to finish.")
    if mode == "apply":
        remaining = counts["plaintext"] - counts["updated"] - counts["changed_meanwhile"]
        print(f"  not_done_this_run: {remaining}")
        print("Next: run with --verify and confirm plaintext: 0.")


def exit_code(counts: dict, mode: str, allow_empty: bool = False) -> int:
    if counts.get("aborted") or counts["failed"]:
        return 1
    if mode in ("verify", "apply") and counts["checked"] == 0 and not allow_empty:
        return 1
    if mode == "verify" and (counts["plaintext"] or counts["unreadable_hash"]):
        return 1
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Hash remaining plaintext passwords in public.users.")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", help="Only count rows (default).")
    mode.add_argument("--verify", action="store_true", help="Read-only; exit 1 if any plaintext rows remain.")
    mode.add_argument("--apply", action="store_true", help="Write argon2id hashes for plaintext rows.")
    parser.add_argument(
        "--i-have-a-backup",
        dest="have_backup",
        action="store_true",
        help="Required with --apply: confirms a restorable backup of public.users exists.",
    )
    parser.add_argument("--batch-size", type=int, default=DEFAULT_BATCH_SIZE, help="Rows per page (1-1000).")
    parser.add_argument(
        "--allow-empty",
        action="store_true",
        help="Let --verify/--apply exit 0 when no rows were visible (an empty table is expected).",
    )
    return parser


def password_guard_installed(client) -> bool:
    """True only if the database confirms the plain-text guard trigger is active."""
    try:
        response = client.rpc("luma_password_guard_installed", {}).execute()
    except Exception:
        return False
    return getattr(response, "data", None) is True


def main(argv=None, client=None) -> int:
    parser = build_parser()
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:  # argparse already printed usage
        return 2 if exc.code else 0

    if not 1 <= args.batch_size <= MAX_BATCH_SIZE:
        print(f"--batch-size must be between 1 and {MAX_BATCH_SIZE}.", file=sys.stderr)
        return 2
    if args.apply and not args.have_backup:
        print(
            "Refusing to write: take a backup of public.users first, then pass "
            "--apply --i-have-a-backup.",
            file=sys.stderr,
        )
        return 2
    mode = "apply" if args.apply else "verify" if args.verify else "dry-run"

    if client is None:
        from app.config import settings
        from app.supabase_client import get_supabase, is_supabase_configured

        if not is_supabase_configured():
            print("Supabase is not configured (SUPABASE_URL and a key are required).", file=sys.stderr)
            return 2
        if not settings.SUPABASE_SERVICE_ROLE_KEY:
            print(
                "Refusing to run: SUPABASE_SERVICE_ROLE_KEY is not set. The anon SUPABASE_KEY "
                "cannot see users rows under row-level security, so the counts would be wrong.",
                file=sys.stderr,
            )
            return 2
        client = get_supabase()

    if mode == "apply" and not password_guard_installed(client):
        print(
            "Refusing to write: the password hash guard is not installed. Deploy the new login "
            "code everywhere, then run backend/app/schemas/password_hash_guard.sql, then retry. "
            "(Without the guard, an old server could still save plain-text passwords.)",
            file=sys.stderr,
        )
        return 2

    counts = hash_plaintext_passwords(client, apply=(mode == "apply"), batch_size=args.batch_size)
    print_summary(counts, mode)
    return exit_code(counts, mode, allow_empty=args.allow_empty)


if __name__ == "__main__":
    raise SystemExit(main())
