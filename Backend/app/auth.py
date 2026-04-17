import os
from datetime import datetime, timedelta
from pathlib import Path

import jwt
from dotenv import load_dotenv
from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from .supabase_client import get_supabase

load_dotenv(dotenv_path=Path(__file__).resolve().parents[1] / ".env")

security = HTTPBearer(auto_error=False)
APP_ENV = os.getenv("APP_ENV", os.getenv("ENV", "development")).lower()
DEFAULT_DEV_JWT_SECRET = "luma-development-jwt-secret-key-2026"
JWT_SECRET_KEY = os.getenv("JWT_SECRET_KEY")
JWT_ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 24

if not JWT_SECRET_KEY and APP_ENV != "production":
    JWT_SECRET_KEY = DEFAULT_DEV_JWT_SECRET


def create_access_token(data: dict, expires_delta: timedelta | None = None):
    if not JWT_SECRET_KEY:
        raise HTTPException(status_code=500, detail="JWT secret is not configured")

    to_encode = data.copy()
    expire = datetime.utcnow() + (
        expires_delta or timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    )
    to_encode.update({"exp": expire, "type": "access"})
    return jwt.encode(to_encode, JWT_SECRET_KEY, algorithm=JWT_ALGORITHM)


def validate_access_token(token: str):
    if not JWT_SECRET_KEY:
        raise HTTPException(status_code=500, detail="JWT secret is not configured")

    try:
        payload = jwt.decode(token, JWT_SECRET_KEY, algorithms=[JWT_ALGORITHM])
        if payload.get("type") != "access":
            raise HTTPException(status_code=401, detail="Invalid token type")
        return {"id": payload["sub"]}
    except jwt.ExpiredSignatureError as exc:
        raise HTTPException(status_code=401, detail="Token expired") from exc
    except jwt.InvalidTokenError as exc:
        raise HTTPException(status_code=401, detail="Invalid token") from exc


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
