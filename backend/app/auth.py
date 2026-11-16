import hashlib
import hmac
import logging
from datetime import datetime, timedelta
from typing import Callable, Optional

import jwt
from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from .config import settings
from .supabase_client import get_supabase

security = HTTPBearer(auto_error=False)
JWT_ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 24
CREDENTIAL_VERSION_CLAIM = "pv"

logger = logging.getLogger(__name__)


class CredentialLookupError(Exception):
    """The stored credential could not be read (database problem)."""


SESSION_EXPIRED_DETAIL = "Session expired. Please log in again."


class StaleSessionError(HTTPException):
    """A valid custom JWT issued before the user's last password change."""

    def __init__(self) -> None:
        super().__init__(status_code=401, detail=SESSION_EXPIRED_DETAIL)


def _default_credential_lookup(user_id: str) -> Optional[str]:
    response = (
        get_supabase()
        .table("users")
        .select("password")
        .eq("id", user_id)
        .maybe_single()
        .execute()
    )
    row = getattr(response, "data", None) if response is not None else None
    if not isinstance(row, dict):
        return None
    stored = row.get("password")
    return stored if isinstance(stored, str) else ""


# Returns the stored password value for a user id, "" when the users row exists
# but has no password, or None when there is no users row at all. main.py swaps
# in a lookup that uses its own Supabase client.
_credential_lookup: Callable[[str], Optional[str]] = _default_credential_lookup


def set_credential_lookup(lookup: Callable[[str], Optional[str]]) -> None:
    global _credential_lookup
    _credential_lookup = lookup


def get_jwt_secret_key() -> str | None:
    return settings.effective_jwt_secret_key


def _credential_fingerprint(stored_password: str) -> str:
    """Keyed fingerprint of the stored password value (a hash once migrated).

    Changing or resetting the password changes the stored value, so tokens
    issued before the change stop validating. Keyed with the JWT secret so the
    claim reveals nothing about the stored value.
    """
    secret = (get_jwt_secret_key() or "").encode("utf-8")
    message = b"luma-pv:" + stored_password.encode("utf-8", "surrogatepass")
    return hmac.new(secret, message, hashlib.sha256).hexdigest()[:32]


def _passwordless_fingerprint(user_id: str) -> str:
    """Fingerprint for a users row that has no password (ties tokens to the row)."""
    secret = (get_jwt_secret_key() or "").encode("utf-8")
    message = b"luma-pv-nopw:" + user_id.encode("utf-8", "surrogatepass")
    return hmac.new(secret, message, hashlib.sha256).hexdigest()[:32]


def _lookup_stored(user_id: str) -> Optional[str]:
    try:
        return _credential_lookup(user_id)
    except Exception as exc:  # noqa: BLE001 - any DB/client failure
        raise CredentialLookupError(type(exc).__name__) from exc


def _current_fingerprint(user_id: str) -> Optional[str]:
    """Fingerprint for the user's current credential, or None if there is no users row.

    Raises CredentialLookupError when the database cannot be read.
    """
    stored = _lookup_stored(user_id)
    if stored is None:
        return None
    if not isinstance(stored, str) or not stored:
        return _passwordless_fingerprint(user_id)
    return _credential_fingerprint(stored)


def _credential_version_ok(payload: dict) -> bool:
    """False when the token was issued for an older password or the user is gone.

    Tokens without the claim (issued before this check existed) are still
    checked: they are rejected once the users row no longer exists.
    """
    claimed = payload.get(CREDENTIAL_VERSION_CLAIM)
    subject = payload.get("sub")
    if not isinstance(subject, str) or not subject:
        return False
    if claimed is None:
        return _lookup_stored(subject) is not None
    if not isinstance(claimed, str):
        return False
    current = _current_fingerprint(subject)
    return current is not None and hmac.compare_digest(current, claimed)


def create_access_token(data: dict, expires_delta: timedelta | None = None):
    jwt_secret_key = get_jwt_secret_key()
    if not jwt_secret_key:
        raise HTTPException(status_code=500, detail="JWT secret is not configured")

    to_encode = data.copy()
    subject = to_encode.get("sub")
    if CREDENTIAL_VERSION_CLAIM not in to_encode and isinstance(subject, str) and subject:
        try:
            fingerprint = _current_fingerprint(subject)
        except CredentialLookupError:
            logger.warning("Could not read credential version while issuing a token")
            raise HTTPException(status_code=503, detail="Sign-in is unavailable right now. Try again later.")
        if fingerprint:
            to_encode[CREDENTIAL_VERSION_CLAIM] = fingerprint
    expire = datetime.utcnow() + (
        expires_delta or timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    )
    to_encode.update({"exp": expire, "type": "access"})
    return jwt.encode(to_encode, jwt_secret_key, algorithm=JWT_ALGORITHM)


def validate_access_token(token: str):
    jwt_secret_key = get_jwt_secret_key()
    if not jwt_secret_key:
        raise HTTPException(status_code=500, detail="JWT secret is not configured")

    try:
        payload = jwt.decode(token, jwt_secret_key, algorithms=[JWT_ALGORITHM])
        if payload.get("type") != "access":
            raise HTTPException(status_code=401, detail="Invalid token type")
        if not _credential_version_ok(payload):
            raise StaleSessionError()
        return {"id": payload["sub"]}
    except CredentialLookupError as exc:
        raise HTTPException(status_code=503, detail="Sign-in check is unavailable right now. Try again later.") from exc
    except jwt.ExpiredSignatureError as exc:
        raise HTTPException(status_code=401, detail="Token expired") from exc
    except jwt.InvalidTokenError as exc:
        raise HTTPException(status_code=401, detail="Invalid token") from exc


def _get_user_from_custom_jwt(token: str) -> str | None:
    jwt_secret_key = get_jwt_secret_key()
    if not jwt_secret_key:
        return None

    try:
        payload = jwt.decode(token, jwt_secret_key, algorithms=[JWT_ALGORITHM])
    except jwt.PyJWTError:
        return None

    subject = payload.get("sub")
    token_type = payload.get("type")

    if token_type != "access" or not isinstance(subject, str) or not subject:
        return None

    try:
        if not _credential_version_ok(payload):
            # A custom JWT for an old password must not fall through to the
            # Supabase Auth check either.
            raise StaleSessionError()
    except CredentialLookupError as exc:
        raise HTTPException(status_code=503, detail="Sign-in check is unavailable right now. Try again later.") from exc

    return subject


def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(security),
) -> dict[str, str]:
    if credentials is None:
        raise HTTPException(status_code=401, detail="Not authenticated")

    token = credentials.credentials

    custom_user_id = _get_user_from_custom_jwt(token)
    if custom_user_id:
        return {"id": custom_user_id}

    supabase = get_supabase()

    try:
        auth_response = supabase.auth.get_user(token)
        user = getattr(auth_response, "user", None)
        user_id = getattr(user, "id", None)
    except Exception:
        user_id = None

    if isinstance(user_id, str) and user_id:
        return {"id": user_id}

    raise HTTPException(status_code=401, detail="Invalid or expired token")


def get_current_user_id(user: dict[str, str] = Depends(get_current_user)) -> str:
    return user["id"]


def require_admin(user_id: str = Depends(get_current_user_id)):
    result = (
        get_supabase()
        .table("users")
        .select("role")
        .eq("id", user_id)
        .single()
        .execute()
    )

    if not result.data or result.data.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")

    return user_id
