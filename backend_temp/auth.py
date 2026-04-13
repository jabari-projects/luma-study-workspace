import os

import jwt
from dotenv import load_dotenv
from fastapi import HTTPException, Depends
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from supabase_client import get_supabase

load_dotenv()

security = HTTPBearer(auto_error=False)
APP_ENV = os.getenv("APP_ENV", os.getenv("ENV", "development")).lower()
DEFAULT_DEV_JWT_SECRET = "luma-development-jwt-secret-key-2026"
JWT_SECRET_KEY = os.getenv("JWT_SECRET_KEY")
JWT_ALGORITHM = "HS256"

if not JWT_SECRET_KEY and APP_ENV != "production":
    JWT_SECRET_KEY = DEFAULT_DEV_JWT_SECRET


def _get_user_from_custom_jwt(token: str) -> str | None:
    if not JWT_SECRET_KEY:
        return None

    try:
        payload = jwt.decode(token, JWT_SECRET_KEY, algorithms=[JWT_ALGORITHM])
    except jwt.PyJWTError:
        return None

    subject = payload.get("sub")
    token_type = payload.get("type")

    if token_type != "access" or not isinstance(subject, str) or not subject:
        return None

    return subject


def get_current_user(credentials: HTTPAuthorizationCredentials = Depends(security)) -> str:
    """
    Reads the Supabase access token from Authorization: Bearer <token>
    and returns the authenticated user's id.
    """
    if credentials is None:
        raise HTTPException(status_code=401, detail="Not authenticated")

    token = credentials.credentials

    custom_user_id = _get_user_from_custom_jwt(token)
    if custom_user_id:
        return custom_user_id

    supabase = get_supabase()

    try:
        res = supabase.auth.get_user(token)
        user = res.user
    except Exception:
        user = None

    if user:
        return user.id

    raise HTTPException(status_code=401, detail="Invalid or expired token")


def require_admin(user_id: str = Depends(get_current_user)):
    """
    Ensures the current user has role='admin' in the users table.
    """
    supabase = get_supabase()

    result = (
        supabase.table("users")
        .select("role")
        .eq("id", user_id)
        .single()
        .execute()
    )

    if not result.data or result.data.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")

    return user_id
