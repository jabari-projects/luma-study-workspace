import base64
import binascii
import os
import secrets
import time
import uuid
import logging
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Literal, Optional, List

import anyio
import httpx
import stripe
from fastapi import FastAPI, HTTPException, Depends, UploadFile, File, Query, WebSocket, WebSocketDisconnect, status, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from openai import APIConnectionError, APIStatusError, AuthenticationError, OpenAI, OpenAIError
from pydantic import BaseModel, EmailStr, Field
from supabase import Client
from .analytics import router as analytics_router
from .auth import create_access_token, get_current_user, validate_access_token
from .config import settings
from .flashcards import router as flashcards_router
from .notes import router as notes_router
from .study_sessions import router as study_sessions_router
from .summaries import router as summaries_router
from .supabase_client import get_supabase, is_supabase_configured
from .transcripts import router as transcripts_router

# Deployment notes:
# - Backend platforms like Render, Railway, and Fly.io should set
#   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, JWT_SECRET_KEY, API_BASE_URL,
#   and FRONTEND_ORIGINS in environment settings.
# - For AI features, set OPENAI_API_KEY (optionally OPENAI_ENDPOINT).
# - Optional AI model overrides:
#   OPENAI_VISION_MODEL
#   OPENAI_EMBEDDING_MODEL
# - For Stripe Checkout, set STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
#   and STRIPE_PRICE_ID.
# - Frontend platforms like Vercel and Netlify should set VITE_API_BASE_URL
#   to the deployed backend URL so browser requests target this API.
# - Suggested start commands:
#   uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}
#   gunicorn -k uvicorn.workers.UvicornWorker main:app --bind 0.0.0.0:${PORT:-8000}
JWT_ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 24  # 24 hours
EMAIL_VERIFICATION_EXPIRE_HOURS = 24
RATE_LIMIT_MESSAGE = "Too many requests, please wait."

logging.basicConfig(
    level=getattr(logging, settings.LOG_LEVEL, logging.INFO),
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)

app = FastAPI()
logger = logging.getLogger(__name__)

if not settings.API_BASE_URL:
    logger.warning(
        "API_BASE_URL is not set; using development fallback %s for public URL generation.",
        settings.resolved_api_base_url,
    )

supabase: Client = get_supabase()

if settings.using_production_fallback_jwt_secret:
    logger.error(
        "JWT_SECRET_KEY is not set in production. "
        "Using an in-memory fallback secret for this process so the backend can boot, "
        "but tokens will rotate on restart until JWT_SECRET_KEY is configured."
    )
elif settings.using_fallback_jwt_secret:
    logger.warning(
        "JWT_SECRET_KEY is not set; using the shared development secret. "
        "Set JWT_SECRET_KEY in deployed environments."
    )

if not is_supabase_configured():
    logger.warning(
        "Supabase is not fully configured. "
        "Routes that require database or storage access will return 503 until "
        "SUPABASE_URL and a Supabase key are set."
    )

if not settings.OPENAI_API_KEY:
    logger.warning(
        "OPENAI_API_KEY is not configured. AI generation routes will return 503."
    )

if not settings.DEEPGRAM_API_KEY:
    logger.warning(
        "DEEPGRAM_API_KEY is not configured. Transcription routes will return 503."
    )

logger.info(
    "Luma backend starting env=%s api_base=%s frontend_origins=%s supabase_configured=%s",
    settings.APP_ENV,
    settings.resolved_api_base_url,
    ",".join(settings.FRONTEND_ORIGINS),
    is_supabase_configured(),
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.FRONTEND_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(notes_router)
app.include_router(flashcards_router)
app.include_router(study_sessions_router)
app.include_router(summaries_router)
app.include_router(transcripts_router)
app.include_router(analytics_router)


class ConnectionManager:
    def __init__(self):
        self.active_connections: dict[str, List[WebSocket]] = {}

    async def connect(self, user_id: str, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.setdefault(user_id, []).append(websocket)

    async def disconnect(self, user_id: str, websocket: WebSocket):
        connections = self.active_connections.get(user_id, [])
        if websocket in connections:
            connections.remove(websocket)
        if not connections and user_id in self.active_connections:
            self.active_connections.pop(user_id, None)

    async def send_to_user(self, user_id: str, message: dict):
        connections = list(self.active_connections.get(user_id, []))
        stale_connections = []

        for websocket in connections:
            try:
                await websocket.send_json(message)
            except Exception:
                stale_connections.append(websocket)

        for websocket in stale_connections:
            await self.disconnect(user_id, websocket)


connection_manager = ConnectionManager()
AI_ROUTE_LIMITS = {
    "generate-notes": {"free": 6, "premium": 18},
    "transcribe": {"free": 6, "premium": 18},
    "semantic-search": {"free": 4, "premium": 16},
}
ai_rate_limit_windows: dict[tuple[str, str], list[float]] = defaultdict(list)


class AIServiceUnavailableError(RuntimeError):
    pass


def build_public_api_url(path: str):
    return f"{settings.resolved_api_base_url}{path}"


def has_premium_subscription(subscription_status: Optional[str]) -> bool:
    if not isinstance(subscription_status, str):
        return False

    return subscription_status.strip().lower() in {"premium", "active"}


def consume_ai_rate_limit_slot(
    user_id: str,
    route_key: Literal["generate-notes", "transcribe", "semantic-search"],
    subscription_status: Optional[str],
):
    tier = "premium" if has_premium_subscription(subscription_status) else "free"
    limit = AI_ROUTE_LIMITS[route_key][tier]
    now = time.time()
    bucket_key = (user_id, route_key)
    active_window = [
        timestamp
        for timestamp in ai_rate_limit_windows[bucket_key]
        if now - timestamp < settings.AI_RATE_LIMIT_WINDOW_SECONDS
    ]

    if len(active_window) >= limit:
        ai_rate_limit_windows[bucket_key] = active_window
        return False

    active_window.append(now)
    ai_rate_limit_windows[bucket_key] = active_window
    return True


def extract_token_from_authorization_header(authorization_header: Optional[str]):
    if not authorization_header:
        return None

    if authorization_header.lower().startswith("bearer "):
        return authorization_header.split(" ", 1)[1].strip()

    return authorization_header.strip() or None


def get_websocket_user(websocket: WebSocket):
    token = websocket.query_params.get("token")
    if not token:
        token = extract_token_from_authorization_header(websocket.headers.get("authorization"))
    if not token:
        raise HTTPException(status_code=401, detail="Missing token")
    return validate_access_token(token)


@app.middleware("http")
async def log_http_requests(request: Request, call_next):
    started_at = time.perf_counter()
    client_host = request.client.host if request.client else "-"
    request_id = request.headers.get("x-request-id") or str(uuid.uuid4())
    request.state.request_id = request_id

    try:
        response = await call_next(request)
        elapsed_ms = (time.perf_counter() - started_at) * 1000
        response.headers["X-Request-ID"] = request_id
        logger.info(
            "HTTP %s %s -> %s in %.2fms client=%s request_id=%s",
            request.method,
            request.url.path,
            response.status_code,
            elapsed_ms,
            client_host,
            request_id,
        )
        return response
    except Exception:
        elapsed_ms = (time.perf_counter() - started_at) * 1000
        logger.exception(
            "HTTP %s %s failed after %.2fms client=%s request_id=%s",
            request.method,
            request.url.path,
            elapsed_ms,
            client_host,
            request_id,
        )
        raise


# ---------- Models (Pydantic v2 style) ----------

class SignupRequest(BaseModel):
    email: EmailStr
    password: str = Field(..., min_length=6)
    username: str = Field(..., min_length=3, pattern=r"^[a-zA-Z0-9_]+$")


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class PasswordResetRequest(BaseModel):
    email: EmailStr


class PasswordResetConfirmRequest(BaseModel):
    token: str = Field(..., min_length=1)
    new_password: str = Field(..., min_length=6)


class UserResponse(BaseModel):
    id: str
    email: EmailStr
    username: str


class AuthSessionResponse(BaseModel):
    user: UserResponse
    access_token: str


class ProfileResponse(BaseModel):
    id: str
    email: EmailStr
    username: str
    display_name: Optional[str] = None
    avatar_url: Optional[str] = None
    theme_color: Optional[str] = None
    custom_theme_image_url: Optional[str] = None
    timezone: Optional[str] = None
    theme_mode: Optional[str] = None
    phone_number: Optional[str] = None
    birthday: Optional[str] = None
    subscription_status: str = "free"
    email_verified: bool = False


class UsernameUpdateRequest(BaseModel):
    new_username: str = Field(..., min_length=3, pattern=r"^[a-zA-Z0-9_]+$")


class ProfileUpdateRequest(BaseModel):
    display_name: Optional[str] = Field(default=None, min_length=2, max_length=50)
    timezone: Optional[str] = None
    theme_mode: Optional[str] = None
    phone_number: Optional[str] = None
    birthday: Optional[str] = None


class UserSearchResponse(BaseModel):
    id: str
    username: str
    display_name: Optional[str] = None
    avatar_url: Optional[str] = None


class VerificationStatusResponse(BaseModel):
    success: bool
    message: str


class NotificationResponse(BaseModel):
    id: str
    type: Literal["system"]
    actor_username: Optional[str] = None
    created_at: str
    read: bool
    payload: Optional[Any] = None
    human_readable: str


class NotificationReadRequest(BaseModel):
    ids: List[str] = Field(..., min_length=1)


class NotificationReadResponse(BaseModel):
    success: bool
    updated_count: int


class UsernameUpdateResponse(BaseModel):
    message: str
    username: str


class AvatarUploadResponse(BaseModel):
    avatar_url: Optional[str] = None


class ThemeImageUploadResponse(BaseModel):
    custom_theme_image_url: Optional[str] = None


class HealthResponse(BaseModel):
    status: Literal["ok"]
    timestamp: str


class GenerateNotesRequest(BaseModel):
    image: Optional[str] = None


class GenerateNotesResponse(BaseModel):
    notes: str


class TranscribeResponse(BaseModel):
    transcript: str


class BasicApiErrorResponse(BaseModel):
    error: str


class SemanticSearchRequest(BaseModel):
    query: str = Field(..., min_length=1, max_length=160)


class SemanticSearchResponse(BaseModel):
    keywords: List[str]
    embedding: Optional[List[float]] = None


class CheckoutSessionResponse(BaseModel):
    url: str


class WebhookStatusResponse(BaseModel):
    success: bool


# ---------- Helpers (Supabase) ----------

def get_user_by_email(email: str):
    response = (
        supabase.table("users")
        .select("*")
        .eq("email", email)
        .maybe_single()
        .execute()
    )
    if response is None:
        return None
    return response.data


def get_user_by_username(username: str):
    response = (
        supabase.table("users")
        .select("*")
        .eq("username", username)
        .maybe_single()
        .execute()
    )
    if response is None:
        return None
    return response.data


def get_user_by_id(user_id: str):
    response = (
        supabase.table("users")
        .select("*")
        .eq("id", user_id)
        .maybe_single()
        .execute()
    )
    if response is None:
        return None
    return response.data


def get_user_by_verification_token(token: str):
    response = (
        supabase.table("users")
        .select("*")
        .eq("email_verification_token", token)
        .maybe_single()
        .execute()
    )
    if response is None:
        return None
    return response.data


def get_user_by_password_reset_token(token: str):
    response = (
        supabase.table("users")
        .select("*")
        .eq("password_reset_token", token)
        .maybe_single()
        .execute()
    )
    if response is None:
        return None
    return response.data


def create_user(email: str, password: str, username: str):
    user_id = str(uuid.uuid4())
    response = (
        supabase.table("users")
        .insert(
            {
                "id": user_id,
                "email": email,
                "password": password,
                "username": username,
                "created_at": datetime.utcnow().isoformat(),
            }
        )
        .execute()
    )
    return response.data[0]


def update_user(user_id: str, data: dict):
    response = (
        supabase.table("users")
        .update(data)
        .eq("id", user_id)
        .execute()
    )
    return response.data[0] if response and response.data else None


def verify_user(email: str, password: str):
    response = (
        supabase.table("users")
        .select("*")
        .eq("email", email)
        .eq("password", password)
        .maybe_single()
        .execute()
    )
    if response is None:
        return None
    return response.data


def get_profile(user_id: str):
    response = (
        supabase.table("profiles")
        .select("*")
        .eq("user_id", user_id)
        .maybe_single()
        .execute()
    )
    if response is None:
        return None
    return response.data


def create_profile(user_id: str, username: str):
    response = (
        supabase.table("profiles")
        .insert(
            {
                "user_id": user_id,
                "username": username,
                "created_at": datetime.utcnow().isoformat(),
            }
        )
        .execute()
    )
    return response.data[0]


def update_profile(user_id: str, data: dict):
    response = (
        supabase.table("profiles")
        .update(data)
        .eq("user_id", user_id)
        .execute()
    )
    return response.data[0] if response.data else None


def set_subscription_status(user_id: str, subscription_status: str):
    profile = get_profile(user_id)
    if not profile:
        logger.warning(
            "Could not update subscription_status because profile is missing for user_id=%s",
            user_id,
        )
        return None

    return update_profile(user_id, {"subscription_status": subscription_status})


def create_notification(
    user_id: str,
    notification_type: Literal["system"],
    actor_user_id: Optional[str] = None,
    payload: Optional[Any] = None,
):
    response = (
        supabase.table("notifications")
        .insert(
            {
                "id": str(uuid.uuid4()),
                "user_id": user_id,
                "type": notification_type,
                "actor_user_id": actor_user_id,
                "created_at": datetime.utcnow().isoformat(),
                "read": False,
                "payload": payload,
            }
        )
        .execute()
    )

    return response.data[0] if response and response.data else None


def list_notification_rows_for_user(user_id: str):
    response = (
        supabase.table("notifications")
        .select("id, type, actor_user_id, created_at, read, payload")
        .eq("user_id", user_id)
        .eq("type", "system")
        .order("created_at", desc=True)
        .execute()
    )

    if response is None or response.data is None:
        return []

    return response.data


def mark_notification_rows_as_read(user_id: str, notification_ids: List[str]):
    unique_notification_ids = list(dict.fromkeys(notification_ids))
    if not unique_notification_ids:
        return []

    response = (
        supabase.table("notifications")
        .update({"read": True})
        .eq("user_id", user_id)
        .in_("id", unique_notification_ids)
        .execute()
    )

    return response.data or []


def generate_email_verification_token():
    return secrets.token_urlsafe(32)


def generate_password_reset_token():
    return secrets.token_urlsafe(32)


def parse_iso_datetime(value: Optional[str]):
    if not value:
        return None

    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is not None:
        return parsed.astimezone(timezone.utc).replace(tzinfo=None)
    return parsed


def is_email_verification_expired(sent_at: Optional[str]):
    parsed_sent_at = parse_iso_datetime(sent_at)
    if parsed_sent_at is None:
        return True

    return datetime.utcnow() - parsed_sent_at > timedelta(hours=EMAIL_VERIFICATION_EXPIRE_HOURS)


def is_password_reset_expired(sent_at: Optional[str]):
    parsed_sent_at = parse_iso_datetime(sent_at)
    if parsed_sent_at is None:
        return True

    return datetime.utcnow() - parsed_sent_at > timedelta(hours=EMAIL_VERIFICATION_EXPIRE_HOURS)


def log_verification_link(token: str):
    relative_path = f"/auth/verify?token={token}"
    logger.info("Email verification link: %s", relative_path)
    logger.info("Email verification absolute URL: %s", build_public_api_url(relative_path))


def log_password_reset_link(token: str):
    relative_path = f"/auth/reset?token={token}"
    logger.info("Password reset link: %s", relative_path)
    logger.info("Password reset absolute URL: %s", build_public_api_url(relative_path))


def send_email(to_email: str, subject: str, html_body: str):
    logger.info("Entered send_email()")
    resend_api_key = (settings.RESEND_API_KEY or "").strip()
    email_from = (settings.EMAIL_FROM or "").strip()
    logger.info(f"RESEND_API_KEY loaded? {bool(resend_api_key)}")
    logger.info(f"EMAIL_FROM loaded? {bool(email_from)}")

    if not resend_api_key:
        raise RuntimeError("RESEND_API_KEY is not configured.")

    if not email_from:
        raise RuntimeError("EMAIL_FROM is not configured.")

    logger.info("Calling Resend API now...")
    response = httpx.post(
        "https://api.resend.com/emails",
        headers={
            "Authorization": f"Bearer {resend_api_key}",
            "Content-Type": "application/json",
        },
        json={
            "from": email_from,
            "to": [to_email],
            "subject": subject,
            "html": html_body,
        },
        timeout=15.0,
    )

    if response.status_code != 200:
        raise RuntimeError(
            f"Resend email request failed with status {response.status_code}: {response.text}"
        )

    return response.json()


def build_verification_email_html(verification_url: str):
    return f"""
    <div style="font-family: Arial, sans-serif; color: #171717; line-height: 1.6;">
      <h2 style="margin-bottom: 12px;">Verify your Luma account</h2>
      <p style="margin-bottom: 16px;">
        Confirm your email address to finish setting up your Luma account.
      </p>
      <p style="margin-bottom: 24px;">
        <a
          href="{verification_url}"
          style="
            display: inline-block;
            padding: 12px 20px;
            background: #4f46e5;
            color: #ffffff;
            text-decoration: none;
            border-radius: 10px;
            font-weight: 700;
          "
        >
          Verify email
        </a>
      </p>
      <p style="margin-bottom: 8px;">
        If the button does not work, use this link:
      </p>
      <p>
        <a href="{verification_url}">{verification_url}</a>
      </p>
    </div>
    """


def issue_email_verification_token(user_id: str):
    token = generate_email_verification_token()
    sent_at = datetime.utcnow().isoformat()
    update_user(
        user_id,
        {
            "email_verified": False,
            "email_verification_token": token,
            "email_verification_sent_at": sent_at,
        },
    )
    log_verification_link(token)
    return token


def issue_email_verification_token_best_effort(user_id: str):
    try:
        return issue_email_verification_token(user_id)
    except Exception as exc:
        logger.warning("Email verification setup failed for user_id=%s: %s", user_id, exc)
        return None


def issue_password_reset_token(user_id: str):
    token = generate_password_reset_token()
    sent_at = datetime.utcnow().isoformat()
    update_user(
        user_id,
        {
            "password_reset_token": token,
            "password_reset_sent_at": sent_at,
        },
    )
    log_password_reset_link(token)
    return token


def issue_password_reset_token_best_effort(user_id: str):
    try:
        return issue_password_reset_token(user_id)
    except Exception as exc:
        logger.warning("Password reset setup failed for user_id=%s: %s", user_id, exc)
        return None


def build_human_readable_notification(
    notification_type: Literal["system"],
    actor_username: Optional[str] = None,
    payload: Optional[Any] = None,
):
    if isinstance(payload, dict) and payload.get("message"):
        return str(payload["message"])
    if isinstance(payload, str) and payload.strip():
        return payload
    return "You have a new notification"


def build_notification_items_from_rows(notification_rows: List[dict]):
    if not notification_rows:
        return []

    notifications = []
    for row in notification_rows:
        payload = row.get("payload")
        notifications.append(
            {
                "id": row["id"],
                "type": row["type"],
                "actor_username": None,
                "created_at": row["created_at"],
                "read": row.get("read", False),
                "payload": payload,
                "human_readable": build_human_readable_notification(
                    row["type"],
                    actor_username=None,
                    payload=payload,
                ),
            }
        )

    return notifications


def dispatch_realtime_event_best_effort(user_id: str, event_type: Literal["notification"], data: dict):
    try:
        anyio.from_thread.run(
            connection_manager.send_to_user,
            user_id,
            {"type": event_type, "data": data},
        )
    except Exception as exc:
        logger.warning(
            "Realtime dispatch failed for user_id=%s event_type=%s: %s",
            user_id,
            event_type,
            exc,
        )


def dispatch_notification_event_best_effort(notification_row: dict):
    notification_items = build_notification_items_from_rows([notification_row])
    if not notification_items:
        return

    dispatch_realtime_event_best_effort(notification_row["user_id"], "notification", notification_items[0])


def create_notification_best_effort(
    user_id: str,
    notification_type: Literal["system"],
    actor_user_id: Optional[str] = None,
    payload: Optional[Any] = None,
):
    try:
        notification_row = create_notification(
            user_id,
            notification_type,
            actor_user_id=actor_user_id,
            payload=payload,
        )
        if notification_row:
            dispatch_notification_event_best_effort(notification_row)
    except Exception as exc:
        logger.warning(
            "Notification creation failed for recipient=%s type=%s: %s",
            user_id,
            notification_type,
            exc,
        )


def upload_file_to_storage(file: UploadFile, bucket: str, path: str):
    try:
        content = file.file.read()
        supabase.storage.from_(bucket).upload(
            path,
            content,
            {"content-type": file.content_type},
        )
        return supabase.storage.from_(bucket).get_public_url(path)
    except Exception as exc:
        logger.warning(
            "Storage upload failed for bucket=%s path=%s: %s",
            bucket,
            path,
            exc,
        )
        raise HTTPException(
            status_code=503,
            detail="File storage is temporarily unavailable.",
        ) from exc


def delete_file_from_storage(bucket: str, path: str):
    try:
        supabase.storage.from_(bucket).remove(path)
    except Exception as exc:
        logger.warning(
            "Storage delete failed for bucket=%s path=%s: %s",
            bucket,
            path,
            exc,
        )


def is_valid_base64_data_url(value: Optional[str]):
    if not isinstance(value, str):
        return False

    normalized = value.strip()
    if not normalized:
        return False

    return normalized.startswith("data:") and "," in normalized


def count_ai_usage_today(user_id: str, usage_type: Literal["notes", "transcription"]):
    day_start = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
    try:
        response = (
            supabase.table("ai_usage")
            .select("id")
            .eq("user_id", user_id)
            .eq("type", usage_type)
            .gte("created_at", day_start.isoformat())
            .limit(settings.FREE_AI_DAILY_LIMIT)
            .execute()
        )
    except Exception as exc:
        logger.warning(
            "AI usage counting unavailable for user_id=%s type=%s: %s",
            user_id,
            usage_type,
            exc,
        )
        return 0

    if response is None or response.data is None:
        return 0

    return len(response.data)


def authenticate_ai_request(request: Request):
    token = extract_token_from_authorization_header(request.headers.get("authorization"))
    if not token:
        return None

    try:
        custom_user = validate_access_token(token)
        user_id = custom_user["id"]
    except HTTPException:
        user_id = None

    if not user_id:
        try:
            auth_response = supabase.auth.get_user(token)
        except Exception as exc:
            logger.warning("Supabase auth validation failed for AI route: %s", exc)
            return None

        user = getattr(auth_response, "user", None)
        user_id = getattr(user, "id", None)

    if not user_id:
        return None

    profile = get_profile(user_id)
    subscription_status = (
        profile.get("subscription_status")
        if isinstance(profile, dict) and isinstance(profile.get("subscription_status"), str)
        else "free"
    )

    return {
        "id": user_id,
        "token": token,
        "subscription_status": subscription_status or "free",
    }


def has_free_ai_daily_limit(user_id: str, usage_type: Literal["notes", "transcription"]):
    return count_ai_usage_today(user_id, usage_type) >= settings.FREE_AI_DAILY_LIMIT


def record_ai_usage(user_id: str, usage_type: Literal["notes", "transcription"]):
    try:
        supabase.table("ai_usage").insert(
            {
                "user_id": user_id,
                "type": usage_type,
                "created_at": datetime.utcnow().isoformat(),
            }
        ).execute()
    except Exception as exc:
        logger.warning(
            "AI usage tracking unavailable for user_id=%s type=%s: %s",
            user_id,
            usage_type,
            exc,
        )


def decode_base64_data_url(value: str):
    if not is_valid_base64_data_url(value):
        raise ValueError("Invalid request")

    normalized = value.strip()
    header, encoded = normalized.split(",", 1)

    if ";base64" not in header:
        raise ValueError("Invalid request")

    mime_type = header[5:].split(";", 1)[0].strip() or "application/octet-stream"

    try:
        decoded = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("Invalid request") from exc

    if not decoded:
        raise ValueError("Invalid request")

    return mime_type, decoded


def normalize_openai_base_url(value: Optional[str]):
    if not value or not value.strip():
        return None
    return value.strip().rstrip("/")


def get_openai_api_key():
    return (settings.OPENAI_API_KEY or "").strip()


def get_ai_client():
    api_key = get_openai_api_key()
    if not api_key:
        raise AIServiceUnavailableError(
            "AI service is unavailable. OPENAI_API_KEY is not configured."
        )

    client_kwargs = {"api_key": api_key}
    base_url = normalize_openai_base_url(settings.OPENAI_ENDPOINT)
    if base_url:
        client_kwargs["base_url"] = base_url

    return OpenAI(**client_kwargs)


def get_ai_model():
    return settings.OPENAI_VISION_MODEL


def get_embedding_model():
    return settings.OPENAI_EMBEDDING_MODEL


SUPPORTED_TRANSCRIBE_CONTENT_TYPES = {
    "audio/wav": "audio/wav",
    "audio/x-wav": "audio/wav",
    "audio/mpeg": "audio/mpeg",
    "audio/mp3": "audio/mpeg",
    "audio/mp4": "audio/mp4",
    "audio/x-m4a": "audio/mp4",
    "audio/webm": "audio/webm",
    "audio/ogg": "audio/ogg",
    "application/ogg": "audio/ogg",
}

SUPPORTED_TRANSCRIBE_EXTENSIONS = {
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".webm": "audio/webm",
    ".ogg": "audio/ogg",
}


def get_deepgram_api_key():
    return (settings.DEEPGRAM_API_KEY or "").strip()


def get_transcribe_content_type(file: UploadFile):
    content_type = (file.content_type or "").strip().lower()
    if content_type in SUPPORTED_TRANSCRIBE_CONTENT_TYPES:
        return SUPPORTED_TRANSCRIBE_CONTENT_TYPES[content_type]

    _, extension = os.path.splitext(file.filename or "")
    normalized_extension = extension.lower()
    if normalized_extension in SUPPORTED_TRANSCRIBE_EXTENSIONS:
        return SUPPORTED_TRANSCRIBE_EXTENSIONS[normalized_extension]

    raise ValueError("Invalid request")


def raise_openai_error(exc: Exception):
    if isinstance(exc, AuthenticationError):
        raise AIServiceUnavailableError(
            "AI service is unavailable. OPENAI_API_KEY is invalid."
        ) from exc

    if isinstance(exc, APIConnectionError):
        raise AIServiceUnavailableError(
            "AI service is temporarily unavailable. OpenAI could not be reached."
        ) from exc

    if isinstance(exc, APIStatusError):
        if exc.status_code in (401, 403):
            raise AIServiceUnavailableError(
                "AI service is unavailable. OPENAI_API_KEY is invalid."
            ) from exc
        raise RuntimeError("OpenAI request failed.") from exc

    if isinstance(exc, OpenAIError):
        raise RuntimeError("AI processing failed.") from exc

    raise exc


def generate_notes_with_ai(image_data_url: str):
    mime_type, decoded_image = decode_base64_data_url(image_data_url)
    client = get_ai_client()
    model = get_ai_model()

    reencoded_data_url = (
        f"data:{mime_type};base64,{base64.b64encode(decoded_image).decode('utf-8')}"
    )

    try:
        response = client.responses.create(
            model=model,
            input=[
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "input_text",
                            "text": (
                                "Analyze this image and turn it into concise study notes. "
                                "Use short headings and bullet points when helpful. "
                                "Extract visible text accurately and highlight the key ideas."
                            ),
                        },
                        {
                            "type": "input_image",
                            "image_url": reencoded_data_url,
                        },
                    ],
                }
            ],
            max_output_tokens=700,
        )
    except Exception as exc:
        raise_openai_error(exc)

    notes = (response.output_text or "").strip()
    if not notes:
        raise RuntimeError("AI returned an empty notes response")

    return notes


def transcribe_audio_with_deepgram(file: UploadFile):
    api_key = get_deepgram_api_key()
    if not api_key:
        raise AIServiceUnavailableError(
            "Transcription service is unavailable. DEEPGRAM_API_KEY is not configured."
        )

    content_type = get_transcribe_content_type(file)
    audio_bytes = file.file.read()
    if not audio_bytes:
        raise ValueError("Invalid request")

    try:
        response = httpx.post(
            "https://api.deepgram.com/v1/listen",
            content=audio_bytes,
            headers={
                "Authorization": f"Token {api_key}",
                "Content-Type": content_type,
            },
            timeout=60.0,
        )
    except httpx.HTTPError as exc:
        logger.warning("Deepgram request failed: %s", exc)
        raise RuntimeError("Transcription failed") from exc

    if response.status_code != 200:
        logger.warning(
            "Deepgram transcription failed status=%s body=%s",
            response.status_code,
            response.text[:500],
        )
        raise RuntimeError("Transcription failed")

    try:
        payload = response.json()
        transcript = (
            (((payload.get("results") or {}).get("channels") or [{}])[0].get("alternatives") or [{}])[0]
            .get("transcript", "")
            .strip()
        )
    except Exception as exc:
        raise RuntimeError("Transcription failed") from exc

    if not transcript:
        raise RuntimeError("Transcription failed")

    return transcript


def create_semantic_search_intelligence(query: str):
    normalized_query = query.strip()
    if not normalized_query:
        raise ValueError("Invalid request")

    client = get_ai_client()
    keyword_model = get_ai_model()
    try:
        keyword_response = client.responses.create(
            model=keyword_model,
            input=[
                {
                    "role": "system",
                    "content": [
                        {
                            "type": "input_text",
                            "text": (
                                "You expand private study-search queries. "
                                "Return up to 8 short semantic keywords or phrases "
                                "that help find the user's own notes, flashcards, "
                                "study sessions, summaries, and transcripts. "
                                "Do not mention other users or public content. "
                                "Return a plain comma-separated list only."
                            ),
                        }
                    ],
                },
                {
                    "role": "user",
                    "content": [{"type": "input_text", "text": normalized_query}],
                },
            ],
            max_output_tokens=120,
        )
    except Exception as exc:
        raise_openai_error(exc)

    raw_keywords = getattr(keyword_response, "output_text", "") or normalized_query
    parsed_keywords = [
        keyword.strip()
        for keyword in raw_keywords.replace("\n", ",").split(",")
        if keyword.strip()
    ]

    deduped_keywords: List[str] = []
    seen_keywords = set()
    for keyword in [normalized_query, *parsed_keywords]:
        lowered = keyword.lower()
        if lowered in seen_keywords:
            continue
        seen_keywords.add(lowered)
        deduped_keywords.append(keyword)
        if len(deduped_keywords) >= 8:
            break

    embedding: Optional[List[float]] = None
    try:
        embedding_response = client.embeddings.create(
            model=get_embedding_model(),
            input=normalized_query,
        )
        data = getattr(embedding_response, "data", None) or []
        first_item = data[0] if data else None
        candidate_embedding = getattr(first_item, "embedding", None)
        if isinstance(candidate_embedding, list) and candidate_embedding:
            embedding = [float(value) for value in candidate_embedding]
    except (AuthenticationError, APIConnectionError, APIStatusError, OpenAIError) as exc:
        raise_openai_error(exc)
    except Exception as exc:
        logger.warning("Semantic embedding generation failed, falling back to full-text only: %s", exc)

    return deduped_keywords, embedding


@app.get("/health", response_model=HealthResponse)
def health_check():
    return {
        "status": "ok",
        "timestamp": datetime.utcnow().isoformat(),
    }


@app.post(
    "/api/create-checkout-session",
    response_model=CheckoutSessionResponse,
    responses={500: {"model": BasicApiErrorResponse}},
)
def create_checkout_session(user=Depends(get_current_user)):
    if not settings.STRIPE_SECRET_KEY or not settings.STRIPE_PRICE_ID:
        return JSONResponse(status_code=500, content={"error": "Stripe is not configured"})

    user_row = get_user_by_id(user["id"])
    if not user_row:
        raise HTTPException(status_code=404, detail="User not found")

    stripe.api_key = settings.STRIPE_SECRET_KEY

    try:
        session = stripe.checkout.Session.create(
            mode="subscription",
            line_items=[
                {
                    "price": settings.STRIPE_PRICE_ID,
                    "quantity": 1,
                }
            ],
            success_url=f"{settings.frontend_app_origin}/subscribe?checkout=success",
            cancel_url=f"{settings.frontend_app_origin}/subscribe?checkout=canceled",
            customer_email=user_row["email"],
            client_reference_id=user["id"],
            metadata={"user_id": user["id"]},
        )
    except Exception:
        logger.exception("Stripe checkout session creation failed")
        return JSONResponse(status_code=500, content={"error": "Stripe checkout failed"})

    if not getattr(session, "url", None):
        logger.error("Stripe checkout session did not return a redirect URL")
        return JSONResponse(status_code=500, content={"error": "Stripe checkout failed"})

    return {"url": session.url}


@app.post(
    "/api/stripe-webhook",
    response_model=WebhookStatusResponse,
    responses={400: {"model": BasicApiErrorResponse}, 500: {"model": BasicApiErrorResponse}},
)
async def stripe_webhook(request: Request):
    if not settings.STRIPE_SECRET_KEY or not settings.STRIPE_WEBHOOK_SECRET:
        return JSONResponse(status_code=500, content={"error": "Stripe is not configured"})

    stripe.api_key = settings.STRIPE_SECRET_KEY
    payload = await request.body()
    signature = request.headers.get("stripe-signature")

    if not signature:
        return JSONResponse(status_code=400, content={"error": "Invalid request"})

    try:
        event = stripe.Webhook.construct_event(
            payload=payload,
            sig_header=signature,
            secret=settings.STRIPE_WEBHOOK_SECRET,
        )
    except (ValueError, stripe.SignatureVerificationError):
        return JSONResponse(status_code=400, content={"error": "Invalid request"})
    except Exception:
        logger.exception("Stripe webhook verification failed")
        return JSONResponse(status_code=500, content={"error": "Stripe webhook failed"})

    if event["type"] == "checkout.session.completed":
        session = event["data"]["object"]
        metadata = session.get("metadata") or {}
        user_id = metadata.get("user_id") or session.get("client_reference_id")

        if user_id:
            try:
                set_subscription_status(user_id, "premium")
            except Exception:
                logger.exception(
                    "Failed to update subscription status from Stripe webhook for user_id=%s",
                    user_id,
                )
                return JSONResponse(status_code=500, content={"error": "Stripe webhook failed"})
        else:
            logger.warning("Stripe checkout.session.completed missing user_id metadata")

    return {"success": True}


@app.post(
    "/api/generate-notes",
    response_model=GenerateNotesResponse,
    responses={
        400: {"model": BasicApiErrorResponse},
        401: {"model": BasicApiErrorResponse},
        403: {"model": BasicApiErrorResponse},
        503: {"model": BasicApiErrorResponse},
        500: {"model": BasicApiErrorResponse},
    },
)
def generate_notes(payload: GenerateNotesRequest, request: Request):
    ai_user = authenticate_ai_request(request)
    if not ai_user:
        return JSONResponse(status_code=401, content={"error": "Unauthorized"})

    if not is_valid_base64_data_url(payload.image):
        return JSONResponse(status_code=400, content={"error": "Invalid request"})

    if not consume_ai_rate_limit_slot(
        ai_user["id"],
        "generate-notes",
        ai_user["subscription_status"],
    ):
        return JSONResponse(status_code=429, content={"error": RATE_LIMIT_MESSAGE})

    if (
        not has_premium_subscription(ai_user["subscription_status"])
        and has_free_ai_daily_limit(ai_user["id"], "notes")
    ):
        return JSONResponse(status_code=403, content={"error": "Upgrade to Premium"})

    try:
        notes = generate_notes_with_ai(payload.image)
        record_ai_usage(ai_user["id"], "notes")
        return {"notes": notes}
    except AIServiceUnavailableError as exc:
        logger.warning("AI note generation unavailable: %s", exc)
        return JSONResponse(status_code=503, content={"error": str(exc)})
    except Exception:
        logger.exception("AI note generation failed")
        return JSONResponse(status_code=500, content={"error": "AI processing failed"})


@app.post(
    "/api/transcribe",
    response_model=TranscribeResponse,
    responses={
        400: {"model": BasicApiErrorResponse},
        401: {"model": BasicApiErrorResponse},
        403: {"model": BasicApiErrorResponse},
        503: {"model": BasicApiErrorResponse},
        500: {"model": BasicApiErrorResponse},
    },
)
def transcribe_audio(request: Request, audio: UploadFile = File(...)):
    ai_user = authenticate_ai_request(request)
    if not ai_user:
        return JSONResponse(status_code=401, content={"error": "Unauthorized"})

    if not audio or not (audio.filename or "").strip():
        return JSONResponse(status_code=400, content={"error": "Invalid request"})

    if not consume_ai_rate_limit_slot(
        ai_user["id"],
        "transcribe",
        ai_user["subscription_status"],
    ):
        return JSONResponse(status_code=429, content={"error": RATE_LIMIT_MESSAGE})

    if (
        not has_premium_subscription(ai_user["subscription_status"])
        and has_free_ai_daily_limit(ai_user["id"], "transcription")
    ):
        return JSONResponse(status_code=403, content={"error": "Upgrade to Premium"})

    try:
        transcript = transcribe_audio_with_deepgram(audio)
        record_ai_usage(ai_user["id"], "transcription")
        return {"transcript": transcript}
    except ValueError:
        return JSONResponse(status_code=400, content={"error": "Invalid request"})
    except AIServiceUnavailableError as exc:
        logger.warning("AI transcription unavailable: %s", exc)
        return JSONResponse(status_code=503, content={"error": str(exc)})
    except Exception:
        logger.exception("AI transcription failed")
        return JSONResponse(status_code=500, content={"error": "Transcription failed"})


@app.post(
    "/api/semantic-search",
    response_model=SemanticSearchResponse,
    responses={
        400: {"model": BasicApiErrorResponse},
        401: {"model": BasicApiErrorResponse},
        403: {"model": BasicApiErrorResponse},
        503: {"model": BasicApiErrorResponse},
        500: {"model": BasicApiErrorResponse},
    },
)
def semantic_search_intelligence(payload: SemanticSearchRequest, user=Depends(get_current_user)):
    normalized_query = payload.query.strip()
    if not normalized_query:
        return JSONResponse(status_code=400, content={"error": "Invalid request"})

    profile = get_profile(user["id"])
    subscription_status = (
        profile.get("subscription_status")
        if isinstance(profile, dict) and isinstance(profile.get("subscription_status"), str)
        else "free"
    )

    if not has_premium_subscription(subscription_status):
        return JSONResponse(status_code=403, content={"error": "Upgrade to Premium"})

    if not consume_ai_rate_limit_slot(
        user["id"],
        "semantic-search",
        subscription_status,
    ):
        return JSONResponse(status_code=429, content={"error": RATE_LIMIT_MESSAGE})

    try:
        keywords, embedding = create_semantic_search_intelligence(normalized_query)
        return {"keywords": keywords, "embedding": embedding}
    except ValueError:
        return JSONResponse(status_code=400, content={"error": "Invalid request"})
    except AIServiceUnavailableError as exc:
        logger.warning("Semantic search unavailable: %s", exc)
        return JSONResponse(status_code=503, content={"error": str(exc)})
    except Exception:
        logger.exception("Semantic search preparation failed")
        return JSONResponse(status_code=500, content={"error": "AI processing failed"})


# ---------- Auth routes ----------

@app.post("/signup", response_model=AuthSessionResponse)
def signup(payload: SignupRequest):
    logger.info("Entered signup route")
    existing_user = get_user_by_email(payload.email)
    if existing_user:
        raise HTTPException(status_code=400, detail="Email already registered")

    existing_username = get_user_by_username(payload.username)
    if existing_username:
        raise HTTPException(status_code=400, detail="Username already taken")

    user = create_user(payload.email, payload.password, payload.username)
    create_profile(user["id"], payload.username)
    verification_token = issue_email_verification_token_best_effort(user["id"])
    if verification_token:
        verification_url = build_public_api_url(f"/auth/verify?token={verification_token}")
        html_body = build_verification_email_html(verification_url)
        logger.info("Signup: about to call send_email()")
        send_email(user["email"], "Verify your Luma account", html_body)

    access_token = create_access_token({"sub": user["id"]})
    return {
        "user": {
            "id": user["id"],
            "email": user["email"],
            "username": user["username"],
        },
        "access_token": access_token,
    }


@app.post("/login", response_model=AuthSessionResponse)
def login(request: LoginRequest):
    user = verify_user(request.email, request.password)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid credentials")

    access_token = create_access_token({"sub": user["id"]})
    return {
        "user": {
            "id": user["id"],
            "email": user["email"],
            "username": user["username"],
        },
        "access_token": access_token,
    }


@app.post("/auth/send-verification", response_model=VerificationStatusResponse)
def send_verification_email(user=Depends(get_current_user)):
    logger.info("Entered send_verification_email route")
    user_row = get_user_by_id(user["id"])
    if not user_row:
        raise HTTPException(status_code=404, detail="User not found")

    if user_row.get("email_verified"):
        return {"success": True, "message": "Email is already verified"}

    token = issue_email_verification_token(user["id"])
    verify_url = build_public_api_url(f"/auth/verify?token={token}")
    html_body = build_verification_email_html(verify_url)
    logger.info("About to call send_email()")
    send_email(user_row["email"], "Verify your Luma account", html_body)
    return {"success": True, "message": "Verification email sent"}


@app.get("/auth/verify", response_model=VerificationStatusResponse)
def verify_email(token: str = Query(..., min_length=1)):
    user_row = get_user_by_verification_token(token)
    if not user_row:
        return {"success": False, "message": "Invalid verification token"}

    if is_email_verification_expired(user_row.get("email_verification_sent_at")):
        update_user(
            user_row["id"],
            {
                "email_verification_token": None,
                "email_verification_sent_at": None,
            },
        )
        return {"success": False, "message": "Verification token has expired"}

    update_user(
        user_row["id"],
        {
            "email_verified": True,
            "email_verification_token": None,
            "email_verification_sent_at": None,
        },
    )
    return {"success": True, "message": "Email verified successfully"}


@app.post("/auth/request-reset", response_model=VerificationStatusResponse)
def request_password_reset(payload: PasswordResetRequest):
    user_row = get_user_by_email(payload.email)
    if user_row:
        issue_password_reset_token_best_effort(user_row["id"])

    return {
        "success": True,
        "message": "If an account with that email exists, a reset link has been sent",
    }


@app.post("/auth/reset", response_model=VerificationStatusResponse)
def reset_password(payload: PasswordResetConfirmRequest):
    user_row = get_user_by_password_reset_token(payload.token)
    if not user_row:
        raise HTTPException(status_code=400, detail="Invalid or expired reset token")

    if is_password_reset_expired(user_row.get("password_reset_sent_at")):
        update_user(
            user_row["id"],
            {
                "password_reset_token": None,
                "password_reset_sent_at": None,
            },
        )
        raise HTTPException(status_code=400, detail="Invalid or expired reset token")

    update_user(
        user_row["id"],
        {
            "password": payload.new_password,
            "password_reset_token": None,
            "password_reset_sent_at": None,
        },
    )
    return {"success": True, "message": "Password reset successful"}


# ---------- Profile routes ----------

@app.get("/me/profile", response_model=ProfileResponse)
def get_my_profile(user=Depends(get_current_user)):
    profile = get_profile(user["id"])
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")

    user_data_response = (
        supabase.table("users")
        .select("email, username, email_verified")
        .eq("id", user["id"])
        .maybe_single()
        .execute()
    )
    if user_data_response is None or user_data_response.data is None:
        raise HTTPException(status_code=404, detail="User not found")

    user_data = user_data_response.data

    return {
        "id": user["id"],
        "email": user_data["email"],
        "username": user_data["username"],
        "display_name": profile.get("display_name"),
        "avatar_url": profile.get("avatar_url"),
        "theme_color": profile.get("theme_color"),
        "custom_theme_image_url": profile.get("custom_theme_image_url"),
        "timezone": profile.get("timezone"),
        "theme_mode": profile.get("theme_mode"),
        "phone_number": profile.get("phone_number"),
        "birthday": profile.get("birthday"),
        "subscription_status": profile.get("subscription_status") or "free",
        "email_verified": user_data.get("email_verified", False),
    }


@app.put("/me/profile", response_model=ProfileResponse)
def update_my_profile(payload: ProfileUpdateRequest, user=Depends(get_current_user)):
    profile = get_profile(user["id"])
    if not profile:
        profile = create_profile(user["id"], "")

    update_data = {k: v for k, v in payload.model_dump().items() if v is not None}
    updated_profile = update_profile(user["id"], update_data) if update_data else profile

    user_data_response = (
        supabase.table("users")
        .select("email, username, email_verified")
        .eq("id", user["id"])
        .maybe_single()
        .execute()
    )
    if user_data_response is None or user_data_response.data is None:
        raise HTTPException(status_code=404, detail="User not found")

    user_data = user_data_response.data

    return {
        "id": user["id"],
        "email": user_data["email"],
        "username": user_data["username"],
        "display_name": updated_profile.get("display_name"),
        "avatar_url": updated_profile.get("avatar_url"),
        "theme_color": updated_profile.get("theme_color"),
        "custom_theme_image_url": updated_profile.get("custom_theme_image_url"),
        "timezone": updated_profile.get("timezone"),
        "theme_mode": updated_profile.get("theme_mode"),
        "phone_number": updated_profile.get("phone_number"),
        "birthday": updated_profile.get("birthday"),
        "subscription_status": updated_profile.get("subscription_status") or "free",
        "email_verified": user_data.get("email_verified", False),
    }


# ---------- Avatar routes ----------

@app.post("/me/avatar", response_model=AvatarUploadResponse)
def upload_avatar(file: UploadFile = File(...), user=Depends(get_current_user)):
    if file.content_type not in ["image/jpeg", "image/png", "image/webp"]:
        raise HTTPException(status_code=400, detail="Invalid file type")

    filename = f"{int(time.time())}_{file.filename}"
    storage_path = f"{user['id']}/{filename}"
    avatar_url = upload_file_to_storage(file, "avatars", storage_path)

    profile = get_profile(user["id"])
    if not profile:
        create_profile(user["id"], "")
        profile = get_profile(user["id"])

    if profile.get("avatar_url"):
        old_path = profile["avatar_url"].split("/storage/v1/object/public/avatars/")[-1]
        delete_file_from_storage("avatars", old_path)

    updated_profile = update_profile(user["id"], {"avatar_url": avatar_url})
    return {"avatar_url": updated_profile["avatar_url"]}


@app.delete("/me/avatar", response_model=AvatarUploadResponse)
def delete_avatar(user=Depends(get_current_user)):
    profile = get_profile(user["id"])
    if not profile or not profile.get("avatar_url"):
        raise HTTPException(status_code=404, detail="No avatar to delete")

    old_path = profile["avatar_url"].split("/storage/v1/object/public/avatars/")[-1]
    delete_file_from_storage("avatars", old_path)

    updated_profile = update_profile(user["id"], {"avatar_url": None})
    return {"avatar_url": updated_profile["avatar_url"]}


# ---------- Theme image routes ----------

@app.post("/me/theme-image", response_model=ThemeImageUploadResponse)
def upload_theme_image(file: UploadFile = File(...), user=Depends(get_current_user)):
    if file.content_type not in ["image/jpeg", "image/png", "image/webp"]:
        raise HTTPException(status_code=400, detail="Invalid file type")

    filename = f"themes/{user['id']}/{int(time.time())}_{file.filename}"
    theme_url = upload_file_to_storage(file, "themes", filename)

    profile = get_profile(user["id"])
    if not profile:
        create_profile(user["id"], "")
        profile = get_profile(user["id"])

    if profile.get("custom_theme_image_url"):
        old_path = profile["custom_theme_image_url"].split("/storage/v1/object/public/themes/")[-1]
        delete_file_from_storage("themes", old_path)

    updated_profile = update_profile(user["id"], {"custom_theme_image_url": theme_url})
    return {"custom_theme_image_url": updated_profile["custom_theme_image_url"]}


@app.delete("/me/theme-image", response_model=ThemeImageUploadResponse)
def delete_theme_image(user=Depends(get_current_user)):
    profile = get_profile(user["id"])
    if not profile or not profile.get("custom_theme_image_url"):
        raise HTTPException(status_code=404, detail="No theme image to delete")

    old_path = profile["custom_theme_image_url"].split("/storage/v1/object/public/themes/")[-1]
    delete_file_from_storage("themes", old_path)

    updated_profile = update_profile(user["id"], {"custom_theme_image_url": None})
    return {"custom_theme_image_url": updated_profile["custom_theme_image_url"]}


# ---------- Username routes ----------

@app.put("/me/username", response_model=UsernameUpdateResponse)
def update_username(payload: UsernameUpdateRequest, user=Depends(get_current_user)):
    existing_username = get_user_by_username(payload.new_username)
    if existing_username and existing_username["id"] != user["id"]:
        raise HTTPException(status_code=400, detail="Username already taken")

    supabase.table("users").update({"username": payload.new_username}).eq("id", user["id"]).execute()
    update_profile(user["id"], {"username": payload.new_username})

    return {"message": "Username updated successfully", "username": payload.new_username}

@app.get("/notifications", response_model=List[NotificationResponse])
def get_notifications(user=Depends(get_current_user)):
    notification_rows = list_notification_rows_for_user(user["id"])
    return build_notification_items_from_rows(notification_rows)


@app.post("/notifications/read", response_model=NotificationReadResponse)
def mark_notifications_read(payload: NotificationReadRequest, user=Depends(get_current_user)):
    if not payload.ids:
        raise HTTPException(status_code=400, detail="At least one notification id is required")

    updated_notifications = mark_notification_rows_as_read(user["id"], payload.ids)
    return {
        "success": True,
        "updated_count": len(updated_notifications),
    }


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    try:
        user = get_websocket_user(websocket)
    except HTTPException:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    user_id = user["id"]
    await connection_manager.connect(user_id, websocket)

    try:
        while True:
            message = await websocket.receive()
            if message["type"] == "websocket.disconnect":
                break
    except WebSocketDisconnect:
        pass
    finally:
        await connection_manager.disconnect(user_id, websocket)

@app.get("/users/search", response_model=List[UserSearchResponse])
def search_users(query: str = Query(..., min_length=1, max_length=50)):
    response = (
        supabase.table("profiles")
        .select("user_id, username, display_name, avatar_url")
        .ilike("username", f"%{query}%")
        .limit(20)
        .execute()
    )

    if response is None or response.data is None:
        return []

    results = []
    for row in response.data:
        results.append(
            {
                "id": row["user_id"],
                "username": row["username"],
                "display_name": row.get("display_name"),
                "avatar_url": row.get("avatar_url"),
            }
        )

    return results


@app.post("/internal/supabase/user-updated")
async def supabase_user_updated(payload: dict, request: Request):
    secret = request.headers.get("authorization")
    if secret != f"Bearer {settings.WEBHOOK_SECRET}":
        raise HTTPException(status_code=401, detail="Unauthorized webhook")

    logger.info("🔥 Supabase webhook fired")
    logger.info("Headers: %s", dict(request.headers))
    logger.info("Payload: %s", payload)
    print("🔥 Supabase webhook fired:", payload)

    return {"status": "ok"}


@app.post("/internal/supabase/user-updated-test")
async def supabase_user_updated_test(payload: dict):
    logger.info("🧪 Test webhook hit with payload: %s", payload)
    print("🧪 Test webhook hit:", payload)
    return {"status": "test-ok"}


@app.get("/internal/debug/file")
async def debug_file():
    import os
    return {
        "cwd": os.getcwd(),
        "file": str(Path(__file__).resolve()),
        "listdir": os.listdir(),
    }


# ---------- Protected test route ----------

@app.get("/protected")
def protected_route(user=Depends(get_current_user)):
    return {"message": f"Hello, user {user['id']}"}


logger.info("MAIN.PY LOADED SUCCESSFULLY")
