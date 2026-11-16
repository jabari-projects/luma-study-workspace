"""Password hashing helpers (argon2id).

Stored values that start with ``$argon2`` are argon2 hashes. Anything else is a
legacy plaintext value from before hashing was added: it is compared in
constant time and, on success, flagged for an upgrade to a real hash.

Never log the password or the stored value.
"""

from __future__ import annotations

import hmac

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError

ARGON2_PREFIX = "$argon2"
MIN_PASSWORD_LENGTH = 8
MAX_PASSWORD_LENGTH = 128

_hasher = PasswordHasher()  # argon2id with library defaults

# Used so a login for an unknown email still spends about the same time.
_DUMMY_HASH = _hasher.hash("luma-dummy-password-for-timing-only")


def _secret_bytes(value: str) -> bytes:
    # "surrogatepass" so odd input (lone surrogates) never raises mid-check.
    return value.encode("utf-8", "surrogatepass")


def is_password_hash(stored: object) -> bool:
    return isinstance(stored, str) and stored.startswith(ARGON2_PREFIX)


def hash_password(password: str) -> str:
    return _hasher.hash(_secret_bytes(password))


def verify_password(stored: object, candidate: str) -> tuple[bool, bool]:
    """Return ``(ok, needs_rehash)``.

    ``needs_rehash`` is True when the stored value is legacy plaintext or an
    argon2 hash with outdated parameters.
    """
    if not isinstance(candidate, str) or not isinstance(stored, str) or not stored:
        return False, False

    if is_password_hash(stored):
        try:
            _hasher.verify(stored, _secret_bytes(candidate))
        except (VerifyMismatchError, VerificationError, InvalidHashError):
            return False, False
        try:
            needs_rehash = _hasher.check_needs_rehash(stored)
        except (InvalidHashError, ValueError):
            needs_rehash = True
        return True, needs_rehash

    # Legacy plaintext value. Also spend one argon2 verification so a legacy
    # account does not answer faster than an unknown email (timing oracle).
    burn_verification_time(candidate)
    ok = hmac.compare_digest(_secret_bytes(stored), _secret_bytes(candidate))
    return ok, ok


def burn_verification_time(candidate: str) -> None:
    """Spend roughly one hash verification so unknown emails are not faster."""
    try:
        _hasher.verify(_DUMMY_HASH, _secret_bytes(candidate if isinstance(candidate, str) else ""))
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        pass
