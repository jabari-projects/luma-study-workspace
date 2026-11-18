import base64
import binascii
import hashlib
import html
import os
import re
import secrets
import threading
import time
import uuid
import logging
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeoutError
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Literal, Optional, List, Union

import anyio
import httpx
import stripe
from fastapi import FastAPI, HTTPException, Depends, UploadFile, File, Form, Query, WebSocket, WebSocketDisconnect, status, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, PlainTextResponse
from starlette.datastructures import UploadFile as StarletteUploadFile
from openai import APIConnectionError, APIStatusError, AuthenticationError, OpenAI, OpenAIError
from pydantic import BaseModel, EmailStr, Field
from supabase import Client
from .analytics import router as analytics_router
from . import capture
from .capture import router as capture_router
from . import account_deletion
from . import email_codes as email_codes_module
from .ai_allowance import AllowanceLedger, allowance_key
from . import billing
from . import auth as auth_module
from .auth import StaleSessionError, create_access_token, get_current_user, validate_access_token
from .config import settings
from .deadline import DeadlineExceeded, run_with_deadline
from .flashcards import router as flashcards_router
from .notes import router as notes_router
from .passwords import (
    MAX_PASSWORD_LENGTH,
    MIN_PASSWORD_LENGTH,
    burn_verification_time,
    hash_password,
    verify_password,
)
from .rate_limits import SlidingWindowLimiter
from .public_search import router as public_search_router
from .reports import router as reports_router
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
LOGIN_TOO_MANY_TRIES_MESSAGE = "Too many tries. Wait a few minutes and try again."
EMAIL_SEND_FAILED_MESSAGE = "We couldn't send the email right now. Try again later."
PASSWORD_RESET_REQUEST_MESSAGE = "If an account with that email exists, a reset link has been sent"
PASSWORD_TOO_SHORT_MESSAGE = f"Use at least {MIN_PASSWORD_LENGTH} characters for your password."
PASSWORD_TOO_LONG_MESSAGE = f"Use {MAX_PASSWORD_LENGTH} characters or fewer for your password."

# In-memory, per-process limits (each worker/instance keeps its own counts and
# a restart clears them). See app/rate_limits.py.
LOGIN_FAILURE_LIMIT = 10
LOGIN_FAILURE_WINDOW_SECONDS = 15 * 60
# Per (client IP, email): one network cannot spam one inbox. Keyed with the IP
# so an attacker elsewhere cannot use up a victim's own budget.
PASSWORD_RESET_PER_EMAIL_LIMIT = 3
# Per-IP is higher so a shared school/home network is not locked out.
PASSWORD_RESET_PER_IP_LIMIT = 20
PASSWORD_RESET_REQUEST_WINDOW_SECONDS = 15 * 60
# Backstop across all IPs for one inbox. An attacker rotating IPs can still
# use this up, but only with many requests, and only for one hour.
PASSWORD_RESET_PER_EMAIL_GLOBAL_LIMIT = 10
PASSWORD_RESET_PER_EMAIL_GLOBAL_WINDOW_SECONDS = 60 * 60
# /auth/request-reset always takes this long so response time does not reveal
# whether the email has an account (the lookup and email send run in a worker
# thread; a slow send keeps going after the response).
PASSWORD_RESET_RESPONSE_SECONDS = 0.25
# Reset links work for 30 minutes and only once.
PASSWORD_RESET_EXPIRE_MINUTES = 30

# Signup, code checks and code resends (per process, like the limits above).
SIGNUP_PER_IP_LIMIT = 10
SIGNUP_WINDOW_SECONDS = 60 * 60
VERIFY_CODE_PER_IP_LIMIT = 30
VERIFY_CODE_PER_EMAIL_LIMIT = 10
VERIFY_CODE_WINDOW_SECONDS = 10 * 60
RESEND_CODE_PER_IP_LIMIT = 20
RESEND_CODE_WINDOW_SECONDS = 60 * 60
# "Someone tried to sign up with your email" notices: at most one per hour per inbox.
SIGNUP_NOTICE_PER_EMAIL_LIMIT = 1
SIGNUP_NOTICE_WINDOW_SECONDS = 60 * 60
# /signup and /auth/resend-code take at least this long so timing doesn't
# reveal whether an email already has an account.
AUTH_NEUTRAL_RESPONSE_SECONDS = 0.8

CODE_INCORRECT_MESSAGE = "That code doesn't match. Check your newest email."
CODE_EXPIRED_MESSAGE = "That code is too old. Send a new one."
CODE_LOCKED_MESSAGE = "Too many tries. Send a new code."
TOO_MANY_TRIES_SHORT_MESSAGE = "Too many tries. Wait a little and try again."
RESEND_COOLDOWN_MESSAGE = "Wait a moment before asking for another code."
USERNAME_TAKEN_MESSAGE = "That username is taken. Try another one."
ACCOUNT_EXISTS_MESSAGE = "You already have a Luma account with this email. Log in instead."
LOGIN_FAILED_MESSAGE = "That email or password is wrong."
RESET_INVALID_MESSAGE = "That reset link doesn't work anymore. Ask for a new one."
EMAIL_UNVERIFIED_AI_MESSAGE = "Check your email and enter your code to use AI tools."
ONE_AI_TASK_AT_A_TIME_MESSAGE = "One AI task at a time. Try again in a moment."
login_failure_limiter = SlidingWindowLimiter(LOGIN_FAILURE_LIMIT, LOGIN_FAILURE_WINDOW_SECONDS)
password_reset_email_limiter = SlidingWindowLimiter(
    PASSWORD_RESET_PER_EMAIL_LIMIT, PASSWORD_RESET_REQUEST_WINDOW_SECONDS
)
password_reset_ip_limiter = SlidingWindowLimiter(
    PASSWORD_RESET_PER_IP_LIMIT, PASSWORD_RESET_REQUEST_WINDOW_SECONDS
)
password_reset_email_global_limiter = SlidingWindowLimiter(
    PASSWORD_RESET_PER_EMAIL_GLOBAL_LIMIT, PASSWORD_RESET_PER_EMAIL_GLOBAL_WINDOW_SECONDS
)
_password_reset_executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="password-reset-email")
signup_ip_limiter = SlidingWindowLimiter(SIGNUP_PER_IP_LIMIT, SIGNUP_WINDOW_SECONDS)
verify_code_ip_limiter = SlidingWindowLimiter(VERIFY_CODE_PER_IP_LIMIT, VERIFY_CODE_WINDOW_SECONDS)
verify_code_email_limiter = SlidingWindowLimiter(VERIFY_CODE_PER_EMAIL_LIMIT, VERIFY_CODE_WINDOW_SECONDS)
resend_code_ip_limiter = SlidingWindowLimiter(RESEND_CODE_PER_IP_LIMIT, RESEND_CODE_WINDOW_SECONDS)
signup_notice_limiter = SlidingWindowLimiter(SIGNUP_NOTICE_PER_EMAIL_LIMIT, SIGNUP_NOTICE_WINDOW_SECONDS)
_auth_email_executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="auth-email")
_signup_locks: dict = {}
_signup_locks_guard = threading.Lock()

logging.basicConfig(
    level=getattr(logging, settings.LOG_LEVEL, logging.INFO),
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
# httpx/httpcore log every request URL at INFO. Supabase (PostgREST) query
# strings carry filter values such as email addresses and token digests, so
# those URLs must never reach the logs. Warnings and errors still show.
for _noisy_logger in ("httpx", "httpcore", "hpack"):
    logging.getLogger(_noisy_logger).setLevel(logging.WARNING)

app = FastAPI()
logger = logging.getLogger(__name__)


class RedactTokenQueryFilter(logging.Filter):
    """Hide ?token=... values (verification links) in access/HTTP client logs."""

    _pattern = re.compile(r"(?i)\b(token|access_token)=[^&\s\"']+")

    def _redact(self, value):
        if isinstance(value, str):
            return self._pattern.sub(r"\1=[redacted]", value)
        if value is None or isinstance(value, (int, float)):
            return value  # keep numbers for %d / %f placeholders
        # Objects such as httpx.URL render through %s: redact their text form.
        try:
            text = str(value)
        except Exception:
            return value
        redacted = self._pattern.sub(r"\1=[redacted]", text)
        return redacted if redacted != text else value

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.args, tuple) and record.args:
            # Redact inside the args and keep their shape: formatters such as
            # uvicorn's AccessFormatter unpack record.args positionally.
            record.msg = self._redact(record.msg)
            record.args = tuple(self._redact(arg) for arg in record.args)
            return True
        try:
            message = record.getMessage()
        except Exception:
            return True
        redacted = self._pattern.sub(r"\1=[redacted]", message)
        if redacted != message:
            record.msg = redacted
            record.args = ()
        return True


_token_redaction_filter = RedactTokenQueryFilter()
for _logger_name in ("uvicorn.access", "uvicorn.error", "httpx", __name__):
    logging.getLogger(_logger_name).addFilter(_token_redaction_filter)

if not settings.API_BASE_URL:
    logger.warning(
        "API_BASE_URL is not set; using development fallback %s for public URL generation.",
        settings.resolved_api_base_url,
    )

supabase: Client = get_supabase()


def _stored_password_for_user(user_id: str):
    """Stored password value for session versioning (see app/auth.py)."""
    response = (
        supabase.table("users")
        .select("password")
        .eq("id", user_id)
        .maybe_single()
        .execute()
    )
    row = getattr(response, "data", None) if response is not None else None
    if not isinstance(row, dict):
        return None  # no users row
    stored = row.get("password")
    return stored if isinstance(stored, str) else ""  # row exists, no password


auth_module.set_credential_lookup(_stored_password_for_user)


def _sanitize_error_value(value):
    if isinstance(value, str):
        # Drop anything that cannot be UTF-8 encoded (lone surrogates).
        return value.encode("utf-8", "replace").decode("utf-8")
    if isinstance(value, (int, float, bool)) or value is None:
        return value
    return _sanitize_error_value(str(value))


@app.exception_handler(RequestValidationError)
async def request_validation_error_handler(request: Request, exc: RequestValidationError):
    """422 without echoing what was sent.

    FastAPI's default handler returns each error's ``input`` (and ``ctx``),
    which would send passwords back in the response and can crash on input
    that is not valid UTF-8. Only the location, message and type are kept.
    Nothing from the request body is logged.
    """
    detail = []
    for error in exc.errors():
        detail.append(
            {
                "loc": [_sanitize_error_value(part) for part in error.get("loc", ())],
                "msg": _sanitize_error_value(error.get("msg", "Invalid value")),
                "type": _sanitize_error_value(error.get("type", "value_error")),
            }
        )
    return JSONResponse(status_code=422, content={"detail": detail})

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

if not settings.OPENAI_API_KEY and not settings.DEEPGRAM_API_KEY:
    logger.warning(
        "Neither OPENAI_API_KEY nor DEEPGRAM_API_KEY is configured. "
        "Transcription routes will return 503."
    )

origins = [
    "http://localhost:5173",
    "https://*.vercel.app",
    "https://luma-frontend-ruby.vercel.app",
    "https://luma-frontend-dxgnch0h1-jabarimckinney213-7284s-projects.vercel.app",
]
VERCEL_ORIGIN_REGEX = r"https://.*\.vercel\.app"

logger.info(
    "Luma backend starting env=%s api_base=%s frontend_origins=%s supabase_configured=%s",
    settings.APP_ENV,
    settings.resolved_api_base_url,
    ",".join(origins),
    is_supabase_configured(),
)

MAX_TRANSCRIBE_UPLOAD_BYTES = 25 * 1024 * 1024
# Multipart framing adds a little overhead on top of the audio itself.
MAX_TRANSCRIBE_REQUEST_BYTES = 26 * 1024 * 1024
TRANSCRIBE_TOO_BIG_MESSAGE = "That recording is too big. Try one under 25 MB."
# Pictures arrive as base64 inside JSON. A 15 MB picture is about 20 MB of base64,
# so the request (and the "image" text) is capped a little above that.
MAX_NOTES_IMAGE_REQUEST_BYTES = 21 * 1024 * 1024
IMAGE_TOO_BIG_MESSAGE = "That picture is too big. Try one under 15 MB."


# Each HTTP step may take up to the TIMEOUT, but the whole call is also cut off at the
# DEADLINE (a true total), which is shorter than the browser's wait (notes 120 s,
# transcription 180 s; see frontend/src/capture/capture-api.ts).
AI_REQUEST_TIMEOUT_SECONDS = 90.0
AI_TRANSCRIBE_TIMEOUT_SECONDS = 140.0
AI_NOTES_DEADLINE_SECONDS = 100.0
AI_TRANSCRIBE_DEADLINE_SECONDS = 150.0


class _BodyTooLarge(Exception):
    pass


class RequestBodyLimitMiddleware:
    """Caps the /api/transcribe and /api/generate-notes request bodies by counting the
    bytes actually received.

    The Content-Length header is only a fast early check: a client can leave it out
    (chunked upload), so the real limit is enforced on the stream itself.
    Registered before CORSMiddleware so CORS stays the outer layer and the 413 still
    carries CORS headers.
    """

    LIMITS = {
        "/api/transcribe": (MAX_TRANSCRIBE_REQUEST_BYTES, TRANSCRIBE_TOO_BIG_MESSAGE),
        "/api/generate-notes": (MAX_NOTES_IMAGE_REQUEST_BYTES, IMAGE_TOO_BIG_MESSAGE),
    }

    def __init__(self, app_):
        self.app = app_

    async def __call__(self, scope, receive, send):
        limit = None
        if scope["type"] == "http" and scope.get("method") == "POST":
            limit = self.LIMITS.get(scope.get("path", ""))
        if limit is None:
            await self.app(scope, receive, send)
            return
        max_bytes, too_big_message = limit

        too_big_response = JSONResponse(status_code=413, content={"error": too_big_message})
        for name, value in scope.get("headers", []):
            if name == b"content-length":
                try:
                    if int(value) > max_bytes:
                        await too_big_response(scope, receive, send)
                        return
                except ValueError:
                    pass

        received = 0
        exceeded = False
        response_started = False

        async def limited_receive():
            nonlocal received, exceeded
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > max_bytes:
                    exceeded = True
                    raise _BodyTooLarge()
            return message

        async def tracking_send(message):
            nonlocal response_started
            if exceeded:
                # FastAPI turns the stopped upload into a generic 400 "error parsing the body".
                # Replace it with the friendly "too big" answer instead.
                if message["type"] == "http.response.start" and not response_started:
                    response_started = True
                    await too_big_response(scope, receive, send)
                return
            if message["type"] == "http.response.start":
                response_started = True
            await send(message)

        try:
            await self.app(scope, limited_receive, tracking_send)
        except _BodyTooLarge:
            if not response_started:
                await too_big_response(scope, receive, send)


app.add_middleware(RequestBodyLimitMiddleware)

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_origin_regex=VERCEL_ORIGIN_REGEX,
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
app.include_router(public_search_router)
app.include_router(reports_router)
app.include_router(capture_router)


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
    "import-link": {"free": 10, "premium": 30},
}
AIRouteKey = Literal["generate-notes", "transcribe", "import-link"]
ai_rate_limit_windows: dict[tuple[str, str], list[float]] = defaultdict(list)


class AIServiceUnavailableError(RuntimeError):
    pass


def build_public_api_url(path: str):
    return f"{settings.resolved_api_base_url}{path}"


def require_internal_webhook_secret(request: Request):
    if not settings.WEBHOOK_SECRET:
        raise HTTPException(status_code=503, detail="Webhook secret is not configured")

    secret = request.headers.get("authorization")
    if secret != f"Bearer {settings.WEBHOOK_SECRET}":
        raise HTTPException(status_code=401, detail="Unauthorized webhook")


def has_premium_subscription(subscription_status: Optional[str]) -> bool:
    if not isinstance(subscription_status, str):
        return False

    return subscription_status.strip().lower() in {"premium", "active"}


def consume_ai_rate_limit_slot(
    user_id: str,
    route_key: AIRouteKey,
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


# Nothing the API serves belongs in a search engine: shared study sets are for
# signed-in students only (owner decision, 2026-11-16).
ROBOTS_HEADER_VALUE = "noindex, nofollow"


@app.middleware("http")
async def add_robots_header(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Robots-Tag"] = ROBOTS_HEADER_VALUE
    return response


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
    # Length rules (8-128) are checked in the route so the message stays friendly.
    password: str
    username: str = Field(..., min_length=3, pattern=r"^[a-zA-Z0-9_]+$")


class LoginRequest(BaseModel):
    email: EmailStr
    # No minimum: older accounts may still have short passwords.
    password: str = Field(..., max_length=1024)


class PasswordResetRequest(BaseModel):
    email: EmailStr


class PasswordResetConfirmRequest(BaseModel):
    token: str = Field(..., min_length=1, max_length=512)
    # Length rules (8-128) are checked in the route so the message stays friendly.
    new_password: str


class UserResponse(BaseModel):
    id: str
    email: EmailStr
    username: str
    email_verified: bool = False


class SignupPendingResponse(BaseModel):
    status: Literal["check_email"] = "check_email"
    email: str
    # Random value only this browser knows. It is needed with the emailed code
    # to finish the signup, so a code can't finish someone else's signup.
    ticket: str
    resend_after_seconds: int
    code_expires_in_seconds: int


class VerifyEmailCodeRequest(BaseModel):
    # Pending signup: email + ticket + code. Logged-in account: code only (Bearer token).
    email: Optional[EmailStr] = None
    ticket: Optional[str] = Field(default=None, max_length=128)
    code: str = Field(..., min_length=1, max_length=32)


class ResendCodeRequest(BaseModel):
    email: EmailStr
    ticket: Optional[str] = Field(default=None, max_length=128)


class ResendCodeResponse(BaseModel):
    status: Literal["sent_if_possible"] = "sent_if_possible"
    resend_after_seconds: int


class AuthSessionResponse(BaseModel):
    user: UserResponse
    access_token: str


# Light, Dark or Automatic (light from 7 am to 7 pm). New saves must be one of these.
ThemeMode = Literal["light", "dark", "auto"]
THEME_MODES = ("light", "dark", "auto")


def read_theme_mode(value) -> Optional[str]:
    """The saved theme mode as the app should see it.

    Empty stays empty (the app shows Light). Anything else that is not one of the
    three choices, such as an old or hand-edited value, reads as Light so older
    profiles keep loading.
    """
    if value is None:
        return None
    return value if value in THEME_MODES else "light"


class ProfileResponse(BaseModel):
    id: str
    email: EmailStr
    username: str
    display_name: Optional[str] = None
    avatar_url: Optional[str] = None
    theme_color: Optional[str] = None
    custom_theme_image_url: Optional[str] = None
    timezone: Optional[str] = None
    theme_mode: Optional[ThemeMode] = None
    phone_number: Optional[str] = None
    birthday: Optional[str] = None
    subscription_status: str = "free"
    email_verified: bool = False
    is_admin: bool = False


class UsernameUpdateRequest(BaseModel):
    new_username: str = Field(..., min_length=3, pattern=r"^[a-zA-Z0-9_]+$")


class ProfileUpdateRequest(BaseModel):
    display_name: Optional[str] = Field(default=None, min_length=2, max_length=50)
    theme_color: Optional[str] = Field(default=None, max_length=32)
    timezone: Optional[str] = None
    theme_mode: Optional[ThemeMode] = None
    phone_number: Optional[str] = None
    birthday: Optional[str] = None


class EmailUpdateRequest(BaseModel):
    new_email: EmailStr


class AccountDeleteResponse(BaseModel):
    success: bool
    message: str
    retained: Optional[List[str]] = None


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


class GenerateNotesResponse(capture.NotesFromTextResponse):
    """Picture to notes answers with the same notes shape as the other note tools.

    "notes" stays a Markdown string, so an older page that only reads it still works.
    """


class TranscribeResponse(BaseModel):
    transcript: str


class BasicApiErrorResponse(BaseModel):
    error: str


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


def hash_token(token: str) -> str:
    """SHA-256 hex digest of a reset/verification token.

    Only the digest is stored in the database; the raw token exists only in the
    emailed link. Rows saved before this change held raw tokens and simply stop
    matching (the user asks for a new link).
    """
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def get_user_by_verification_token(token: str):
    response = (
        supabase.table("users")
        .select("*")
        .eq("email_verification_token", hash_token(token))
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
        .eq("password_reset_token", hash_token(token))
        .maybe_single()
        .execute()
    )
    if response is None:
        return None
    return response.data


def create_user(email: str, password: str, username: str):
    """Create a user. ``password`` is the plain password; only its hash is stored."""
    user_id = str(uuid.uuid4())
    response = (
        supabase.table("users")
        .insert(
            {
                "id": user_id,
                "email": email,
                "password": hash_password(password),
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
    """Return the user row when the password matches, else None.

    Looks the user up by email only (the database is never filtered by
    password). Legacy plaintext passwords and outdated hashes are upgraded to a
    fresh argon2id hash on a successful login (best effort).
    """
    user_row = find_user_by_email(email)
    stored = user_row.get("password") if isinstance(user_row, dict) else None
    if not user_row or not stored:
        # Spend about the same time as a real check so unknown emails are not faster.
        burn_verification_time(password)
        return None

    ok, needs_rehash = verify_password(stored, password)
    if not ok:
        return None

    if needs_rehash:
        try:
            update_user(user_row["id"], {"password": hash_password(password)})
        except Exception as exc:
            logger.warning(
                "Could not upgrade password hash for user_id=%s (%s)",
                user_row.get("id"),
                type(exc).__name__,
            )

    return user_row


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


def build_profile_response(user_id: str):
    profile = get_profile(user_id)
    if not profile:
        profile = create_profile(user_id, "")

    user_data_response = (
        supabase.table("users")
        .select("email, username, email_verified, role")
        .eq("id", user_id)
        .maybe_single()
        .execute()
    )
    if user_data_response is None or user_data_response.data is None:
        raise HTTPException(status_code=404, detail="User not found")

    user_data = user_data_response.data
    return {
        "id": user_id,
        "email": user_data["email"],
        "username": user_data["username"],
        "display_name": profile.get("display_name"),
        "avatar_url": profile.get("avatar_url"),
        "theme_color": profile.get("theme_color"),
        "custom_theme_image_url": profile.get("custom_theme_image_url"),
        "timezone": profile.get("timezone"),
        "theme_mode": read_theme_mode(profile.get("theme_mode")),
        "phone_number": profile.get("phone_number"),
        "birthday": profile.get("birthday"),
        "subscription_status": profile.get("subscription_status") or "free",
        "email_verified": user_data.get("email_verified", False),
        "is_admin": user_data.get("role") == "admin",
    }


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

    return datetime.utcnow() - parsed_sent_at > timedelta(minutes=PASSWORD_RESET_EXPIRE_MINUTES)


def log_verification_link(token: Optional[str] = None):
    # Never log the token or the link: anyone with log access could use it.
    logger.info("Email verification link issued")


def log_password_reset_link(token: Optional[str] = None):
    # Never log the token or the link: anyone with log access could use it.
    logger.info("Password reset link issued")


def build_verification_url(token: str) -> str:
    return build_public_api_url(f"/auth/verify?token={token}")


def build_password_reset_url(token: str) -> str:
    return f"{settings.frontend_app_origin}/reset-password?token={token}"


def send_email(to_email: str, subject: str, html_body: str):
    logger.info("Entered send_email()")
    resend_api_key = (settings.RESEND_API_KEY or "").strip()
    email_from = (settings.EMAIL_FROM or "").strip()
    logger.info("RESEND_API_KEY loaded? %s", bool(resend_api_key))
    logger.info("EMAIL_FROM loaded? %s", bool(email_from))

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
        # Keep the response body out of the error: it can echo the address.
        raise RuntimeError(f"Resend email request failed with status {response.status_code}")

    return response.json()


def build_verification_email_html(verification_url: str):
    verification_url = html.escape(verification_url, quote=True)
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


def build_password_reset_email_html(reset_url: str):
    reset_url = html.escape(reset_url, quote=True)
    return f"""
    <div style="font-family: Arial, sans-serif; color: #171717; line-height: 1.6;">
      <h2 style="margin-bottom: 12px;">Reset your Luma password</h2>
      <p style="margin-bottom: 16px;">
        Someone asked to reset the password for your Luma account.
        If it was you, pick a new password with the button below.
        The link works for {EMAIL_VERIFICATION_EXPIRE_HOURS} hours.
      </p>
      <p style="margin-bottom: 24px;">
        <a
          href="{reset_url}"
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
          Pick a new password
        </a>
      </p>
      <p style="margin-bottom: 8px;">
        If the button does not work, use this link:
      </p>
      <p style="margin-bottom: 16px;">
        <a href="{reset_url}">{reset_url}</a>
      </p>
      <p>If you did not ask for this, you can ignore this email. Your password will not change.</p>
    </div>
    """


def issue_email_verification_token(user_id: str):
    """Create a verification token, store only its digest, return the raw token."""
    token = generate_email_verification_token()
    sent_at = datetime.utcnow().isoformat()
    update_user(
        user_id,
        {
            "email_verified": False,
            "email_verification_token": hash_token(token),
            "email_verification_sent_at": sent_at,
        },
    )
    log_verification_link()
    return token


def issue_email_verification_token_best_effort(user_id: str):
    try:
        return issue_email_verification_token(user_id)
    except Exception as exc:
        logger.warning(
            "Email verification setup failed for user_id=%s (%s)", user_id, type(exc).__name__
        )
        return None


def issue_password_reset_token(user_id: str):
    """Create a reset token, store only its digest, return the raw token."""
    token = generate_password_reset_token()
    sent_at = datetime.utcnow().isoformat()
    update_user(
        user_id,
        {
            "password_reset_token": hash_token(token),
            "password_reset_sent_at": sent_at,
        },
    )
    log_password_reset_link()
    return token


def issue_password_reset_token_best_effort(user_id: str):
    try:
        return issue_password_reset_token(user_id)
    except Exception as exc:
        logger.warning("Password reset setup failed for user_id=%s (%s)", user_id, type(exc).__name__)
        return None


def send_verification_email_best_effort(user_id: str, to_email: str) -> bool:
    """Issue a token and email the link. Never raises; logs no address or token."""
    try:
        token = issue_email_verification_token(user_id)
        send_email(
            to_email,
            "Verify your Luma account",
            build_verification_email_html(build_verification_url(token)),
        )
        return True
    except Exception as exc:
        logger.warning(
            "Verification email could not be sent for user_id=%s (%s)", user_id, type(exc).__name__
        )
        return False


def auth_error(status_code: int, message: str, error_code: str, retry_after: Optional[int] = None):
    """Error body for the account routes: a friendly message plus a stable code."""
    content: dict = {"detail": message, "error_code": error_code}
    headers = None
    if retry_after is not None:
        content["retry_after"] = int(retry_after)
        headers = {"Retry-After": str(int(retry_after))}
    return JSONResponse(status_code=status_code, content=content, headers=headers)


def normalize_account_email(email: str) -> str:
    return str(email).strip().lower()


def find_user_by_email(email: str):
    """Look an account up by email (lowercase).

    Accounts are stored lowercase, and the migration adds a unique index on
    lower(email). The exact-case fallback only matters for a raw, mixed-case
    argument; live data had no mixed-case emails on 2026-11-16.
    """
    normalized = normalize_account_email(email)
    row = get_user_by_email(normalized)
    if not row and str(email).strip() != normalized:
        row = get_user_by_email(str(email).strip())
    return row


def _signup_lock(key: str) -> threading.Lock:
    with _signup_locks_guard:
        lock = _signup_locks.get(key)
        if lock is None:
            lock = _signup_locks[key] = threading.Lock()
        return lock


def _code_secret() -> str:
    return settings.effective_jwt_secret_key or ""


email_code_store = email_codes_module.EmailCodeStore(lambda: supabase, _code_secret)
allowance_ledger = AllowanceLedger(lambda: supabase)


def build_verification_code_email_html(code: str) -> str:
    code = html.escape(code, quote=True)
    minutes = email_codes_module.CODE_TTL_SECONDS // 60
    return f"""
    <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #222;">
      <h2>Your Luma code</h2>
      <p>Type this code in Luma to finish setting up your account:</p>
      <p style="font-size: 28px; font-weight: bold; letter-spacing: 6px;">{code}</p>
      <p>It works for {minutes} minutes, one time.</p>
      <p>If you didn't make a Luma account, you can ignore this email.</p>
    </div>
    """


def build_signup_notice_email_html() -> str:
    login_url = html.escape(f"{settings.frontend_app_origin}/login", quote=True)
    reset_url = html.escape(f"{settings.frontend_app_origin}/forgot-password", quote=True)
    return f"""
    <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #222;">
      <h2>Someone tried to make a Luma account with your email</h2>
      <p>You already have a Luma account with this email.</p>
      <p>If it was you, <a href="{login_url}">log in</a> or
         <a href="{reset_url}">reset your password</a>.</p>
      <p>If it wasn't you, you can ignore this email. Nothing changed.</p>
    </div>
    """


def issue_and_send_verification_code(user_id: str, to_email: str):
    """Make a new code for an existing account's current address and email it.

    Returns the IssueResult. Raises when the email provider refuses (callers
    decide whether to hide that). Never logs the code or the address.
    """
    email = normalize_account_email(to_email)
    code = email_codes_module.generate_code()
    result = email_code_store.issue_for_user(user_id, email, code)
    if result.status != "ok":
        return result
    logger.info("Email verification code issued")
    send_email(to_email, "Your Luma code", build_verification_code_email_html(code))
    return result


def _send_code_best_effort(user_id: str, to_email: str) -> None:
    try:
        issue_and_send_verification_code(user_id, to_email)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Verification code email could not be sent (%s)", type(exc).__name__)


def _send_signup_code_best_effort(email: str, ticket: str, password_hash: Optional[str], username: Optional[str]) -> None:
    """Start or restart a pending signup and email its code. Never raises."""
    try:
        code = email_codes_module.generate_code()
        if password_hash is None:
            result = email_code_store.reissue_signup(email, ticket, code)
        else:
            result = email_code_store.issue_signup(email, ticket, code, password_hash, username or "")
        if result.status != "ok":
            return
        logger.info("Signup code issued")
        send_email(email, "Your Luma code", build_verification_code_email_html(code))
    except Exception as exc:  # noqa: BLE001
        logger.warning("Signup code email could not be sent (%s)", type(exc).__name__)


def _run_email_job(job, *args) -> None:
    """Start an email send in the background; the response never waits for it."""
    try:
        _auth_email_executor.submit(job, *args)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Auth email job failed to start (%s)", type(exc).__name__)


def _pad_response_time(started_at: float) -> None:
    remaining = AUTH_NEUTRAL_RESPONSE_SECONDS - (time.monotonic() - started_at)
    if remaining > 0:
        time.sleep(remaining)


def optional_user_id(request: Request) -> Optional[str]:
    """User id from a valid Bearer token, or None (never raises)."""
    token = extract_token_from_authorization_header(request.headers.get("authorization"))
    if not token:
        return None
    try:
        return validate_access_token(token)["id"]
    except Exception:  # noqa: BLE001 - expired, stale or invalid: treat as logged out
        return None


def create_user_with_hash(email: str, password_hash: str, username: str, email_verified: bool):
    """Create an account from a finished signup. ``password_hash`` is argon2id."""
    response = (
        supabase.table("users")
        .insert(
            {
                "id": str(uuid.uuid4()),
                "email": email,
                "password": password_hash,
                "username": username,
                "email_verified": email_verified,
                "created_at": datetime.utcnow().isoformat(),
            }
        )
        .execute()
    )
    return response.data[0]


def session_response(user_row: dict) -> dict:
    return {
        "user": {
            "id": user_row["id"],
            "email": user_row["email"],
            "username": user_row["username"],
            "email_verified": bool(user_row.get("email_verified")),
        },
        "access_token": create_access_token({"sub": user_row["id"]}),
    }


def _allowance_key_for_user(user_id: str) -> Optional[str]:
    row = get_user_by_id(user_id)
    email = row.get("email") if isinstance(row, dict) else None
    return allowance_key(_code_secret(), email) if email else None


def ai_email_gate(ai_user: dict):
    """403 for AI routes when the account's email isn't verified yet, else None."""
    if ai_user.get("email_verified") is True:
        return None
    return JSONResponse(
        status_code=403,
        content={
            "error": EMAIL_UNVERIFIED_AI_MESSAGE,
            "detail": EMAIL_UNVERIFIED_AI_MESSAGE,
            "error_code": "email_unverified",
        },
    )


class _AlwaysYourTurn:
    def __enter__(self):
        return True

    def __exit__(self, *_exc):
        return False


def free_ai_turn(ai_user: dict):
    """Context manager: True if this free request may run now.

    Free users get one AI request at a time per email (per server), so parallel
    requests can't all pass the daily check before any of them is counted.
    Premium users are not limited here.
    """
    if has_premium_subscription(ai_user.get("subscription_status")):
        return _AlwaysYourTurn()
    key = ai_user.get("allowance_key") or f"user:{ai_user.get('id')}"
    return allowance_ledger.single_flight(key)


def validate_new_password(password: str) -> None:
    try:
        password.encode("utf-8")
    except UnicodeEncodeError:
        raise HTTPException(status_code=400, detail="That password has characters we can't use. Try another one.")
    if len(password) < MIN_PASSWORD_LENGTH:
        raise HTTPException(status_code=400, detail=PASSWORD_TOO_SHORT_MESSAGE)
    if len(password) > MAX_PASSWORD_LENGTH:
        raise HTTPException(status_code=400, detail=PASSWORD_TOO_LONG_MESSAGE)


def get_client_ip(request: Optional[Request]) -> str:
    """Client IP for rate limits.

    With TRUSTED_PROXY_HOPS=0 (default) X-Forwarded-For is ignored, so clients
    cannot spoof it. With N trusted proxies in front, the Nth entry from the
    right is the address the outermost trusted proxy saw; entries further left
    are client-controlled and never used.
    """
    if request is None:
        return "-"
    hops = settings.TRUSTED_PROXY_HOPS
    if hops > 0:
        forwarded = ",".join(request.headers.getlist("x-forwarded-for"))
        entries = [part.strip() for part in forwarded.split(",") if part.strip()]
        if len(entries) >= hops:
            candidate = entries[-hops]
            if re.fullmatch(r"[0-9A-Fa-f:.\[\]]{2,64}", candidate):
                return candidate
    if request.client is None:
        return "-"
    return request.client.host or "-"


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


MAX_IMAGE_UPLOAD_BYTES = 5 * 1024 * 1024
IMAGE_EXTENSIONS = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}


def detect_image_type(content: bytes) -> Optional[str]:
    """The image type from the file's first bytes. The browser's label can't be trusted."""
    if content.startswith(bytes([0xFF, 0xD8, 0xFF])):
        return "image/jpeg"
    if content.startswith(bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])):
        return "image/png"
    if len(content) >= 12 and content[:4] == b"RIFF" and content[8:12] == b"WEBP":
        return "image/webp"
    return None


def read_image_upload(file: UploadFile) -> tuple[bytes, str]:
    """Read an uploaded picture safely: at most 5 MB, and it must really be JPEG, PNG or WebP."""
    content = file.file.read(MAX_IMAGE_UPLOAD_BYTES + 1)
    if len(content) > MAX_IMAGE_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="That picture is too big. Try one under 5 MB.")
    image_type = detect_image_type(content)
    if not content or image_type is None:
        raise HTTPException(status_code=400, detail="Please pick a JPG, PNG or WebP picture.")
    return content, image_type


def new_image_storage_path(prefix: str, image_type: str) -> str:
    # A random name: never the student's own file name, and no way to reach other folders.
    return f"{prefix}/{uuid.uuid4().hex}{IMAGE_EXTENSIONS[image_type]}"


def upload_file_to_storage(file: UploadFile, bucket: str, path: str, content: Optional[bytes] = None, content_type: Optional[str] = None):
    try:
        if content is None:
            content = file.file.read()
        supabase.storage.from_(bucket).upload(
            path,
            content,
            {"content-type": content_type or file.content_type},
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
            type(exc).__name__,
        )
        return None

    if response is None or response.data is None:
        return None

    return len(response.data)


def authenticate_ai_request(request: Request):
    token = extract_token_from_authorization_header(request.headers.get("authorization"))
    if not token:
        return None

    try:
        custom_user = validate_access_token(token)
        user_id = custom_user["id"]
    except StaleSessionError:
        # Our own token, issued before a password change: do not fall back.
        return None
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

    try:
        user_row = get_user_by_id(user_id)
    except Exception as exc:  # noqa: BLE001 - treat as unverified (fail closed)
        logger.warning("AI route could not read the account (%s)", type(exc).__name__)
        user_row = None
    email = user_row.get("email") if isinstance(user_row, dict) else None

    return {
        "id": user_id,
        "token": token,
        "subscription_status": subscription_status or "free",
        "email_verified": bool(user_row.get("email_verified")) if isinstance(user_row, dict) else False,
        "allowance_key": allowance_key(_code_secret(), email) if email else None,
    }


def has_free_ai_daily_limit(user_id: str, usage_type: Literal["notes", "transcription"]):
    """True when a free user may not use AI right now.

    Fails closed: if today's usage can't be counted (database down, table missing),
    free users are treated as having reached the limit instead of getting unlimited AI.
    """
    used = count_ai_usage_today(user_id, usage_type)
    if used is None:
        return True
    if used >= settings.FREE_AI_DAILY_LIMIT:
        return True

    # The same count kept per (normalized) email, so a deleted and re-created
    # account doesn't start from zero.
    try:
        key = _allowance_key_for_user(user_id)
    except Exception as exc:  # noqa: BLE001
        logger.warning("AI allowance key unavailable (%s)", type(exc).__name__)
        return True
    if key is None:
        return True
    by_email = allowance_ledger.used(key, usage_type)
    if by_email is None:
        return True
    return by_email >= settings.FREE_AI_DAILY_LIMIT


def record_ai_usage(user_id: str, usage_type: Literal["notes", "transcription"]):
    try:
        key = _allowance_key_for_user(user_id)
        if key and not allowance_ledger.add_use(key, usage_type):
            logger.warning("AI allowance ledger did not count a use (type=%s)", usage_type)
    except Exception as exc:  # noqa: BLE001
        logger.warning("AI allowance ledger not updated (%s)", type(exc).__name__)
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

    # Give up before the browser does (notes: 120 s, transcription: 180 s), so a
    # student never loses a free AI turn on a request whose answer they never see.
    client_kwargs = {"api_key": api_key, "timeout": AI_REQUEST_TIMEOUT_SECONDS, "max_retries": 0}
    base_url = normalize_openai_base_url(settings.OPENAI_ENDPOINT)
    if base_url:
        client_kwargs["base_url"] = base_url

    return OpenAI(**client_kwargs)


def get_ai_model():
    return settings.OPENAI_VISION_MODEL


SUPPORTED_TRANSCRIBE_CONTENT_TYPES = {
    "audio/wav": "audio/wav",
    "audio/x-wav": "audio/wav",
    "audio/mpeg": "audio/mpeg",
    "audio/mp3": "audio/mpeg",
    "audio/mp4": "audio/mp4",
    "audio/x-m4a": "audio/mp4",
    "audio/m4a": "audio/mp4",
    "audio/webm": "audio/webm",
    "video/webm": "audio/webm",
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


TRANSCRIBE_EXTENSION_FOR_CONTENT_TYPE = {
    "audio/wav": ".wav",
    "audio/mpeg": ".mp3",
    "audio/mp4": ".m4a",
    "audio/webm": ".webm",
    "audio/ogg": ".ogg",
}


def normalize_content_type(value: Optional[str]) -> str:
    # "audio/webm;codecs=opus" -> "audio/webm"
    return (value or "").split(";", 1)[0].strip().lower()


def get_transcribe_content_type(file: UploadFile):
    content_type = normalize_content_type(file.content_type)
    if content_type in SUPPORTED_TRANSCRIBE_CONTENT_TYPES:
        return SUPPORTED_TRANSCRIBE_CONTENT_TYPES[content_type]

    _, extension = os.path.splitext(file.filename or "")
    normalized_extension = extension.lower()
    if normalized_extension in SUPPORTED_TRANSCRIBE_EXTENSIONS:
        return SUPPORTED_TRANSCRIBE_EXTENSIONS[normalized_extension]

    raise ValueError("Invalid request")


def raise_openai_error(exc: Exception):
    if isinstance(exc, DeadlineExceeded):
        raise AIServiceUnavailableError("The AI took too long. Please try again.") from exc

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


# Picture types the AI can read. The page offers PNG, JPG and WEBP.
NOTES_IMAGE_TYPES = ("image/png", "image/jpeg", "image/webp", "image/gif")
IMAGE_NOTES_BAD_PICTURE_MESSAGE = "We couldn't open that picture. Try a PNG, JPG or WEBP photo."


def read_notes_image(image_data_url: Optional[str]) -> str:
    """Check the picture and return a clean data URL. Raises ValueError if it isn't one."""
    mime_type, decoded_image = decode_base64_data_url(image_data_url or "")
    mime_type = mime_type.lower()
    if mime_type == "image/jpg":
        mime_type = "image/jpeg"
    if mime_type not in NOTES_IMAGE_TYPES:
        raise ValueError("Invalid request")
    return f"data:{mime_type};base64,{base64.b64encode(decoded_image).decode('utf-8')}"


def generate_notes_with_ai(image_data_url: str) -> dict[str, Any]:
    """One AI call: title, summary, Markdown notes, key terms and flashcards, cleaned."""
    return capture.generate_study_notes_from_image(read_notes_image(image_data_url))


class AudioTooLargeError(ValueError):
    pass


class EmptyAudioError(ValueError):
    pass


def read_upload_bytes_capped(file: UploadFile, max_bytes: int = MAX_TRANSCRIBE_UPLOAD_BYTES) -> bytes:
    # Read at most max_bytes + 1 so an oversized upload is never fully loaded.
    try:
        file.file.seek(0)
    except Exception:
        pass
    audio_bytes = file.file.read(max_bytes + 1)
    if len(audio_bytes) > max_bytes:
        raise AudioTooLargeError("Audio too large")
    if not audio_bytes:
        raise EmptyAudioError("Empty audio")
    return audio_bytes


def build_transcribe_filename(filename: Optional[str], content_type: str) -> str:
    # The speech provider needs a file extension to know the format, but never the
    # student's own file name: always send "recording.<ext>".
    _, extension = os.path.splitext(os.path.basename((filename or "").strip()))
    if extension.lower() in SUPPORTED_TRANSCRIBE_EXTENSIONS:
        return "recording" + extension.lower()
    return "recording" + TRANSCRIBE_EXTENSION_FOR_CONTENT_TYPE.get(content_type, ".webm")


MAX_TRANSCRIBE_HINT_CHARS = 300


def clean_transcribe_hint(hint: Optional[str]) -> Optional[str]:
    """Names or words a student expects to hear (e.g. "Ms. Okafor, Nkrumah").

    One short line only: it is passed to the speech model as a spelling hint,
    which in the 2026-11-16 Whisper pilot raised correct names from 38/64 to
    56/64. Returns None when there is nothing useful.
    """
    if not isinstance(hint, str):
        return None
    text = " ".join(hint.split())[:MAX_TRANSCRIBE_HINT_CHARS].strip()
    return text or None


def transcribe_audio_bytes_with_openai(audio_bytes: bytes, filename: str, content_type: str, hint: Optional[str] = None):
    client = get_ai_client()
    extra = {"prompt": hint} if hint else {}
    try:
        response = run_with_deadline(
            lambda: client.audio.transcriptions.create(
                model=settings.OPENAI_TRANSCRIBE_MODEL,
                file=(filename, audio_bytes, content_type),
                timeout=AI_TRANSCRIBE_TIMEOUT_SECONDS,
                **extra,
            ),
            AI_TRANSCRIBE_DEADLINE_SECONDS,
        )
    except Exception as exc:
        raise_openai_error(exc)

    transcript = (getattr(response, "text", None) or "").strip()
    if not transcript:
        raise EmptyAudioError("Empty transcript")
    return transcript


def transcribe_audio_bytes(audio_bytes: bytes, filename: str, content_type: str, hint: Optional[str] = None):
    """Use OpenAI speech-to-text when configured, otherwise Deepgram.

    ``hint`` (names/words to listen for) is used by OpenAI only; the Deepgram
    fallback ignores it.
    """
    if get_openai_api_key():
        return transcribe_audio_bytes_with_openai(
            audio_bytes,
            build_transcribe_filename(filename, content_type),
            content_type,
            **({"hint": hint} if hint else {}),
        )

    if get_deepgram_api_key():
        return transcribe_audio_bytes_with_deepgram(audio_bytes, content_type)

    raise AIServiceUnavailableError(
        "Transcription service is unavailable. Set OPENAI_API_KEY or DEEPGRAM_API_KEY."
    )


def transcribe_audio_with_deepgram(file: UploadFile):
    content_type = get_transcribe_content_type(file)
    audio_bytes = read_upload_bytes_capped(file)
    return transcribe_audio_bytes_with_deepgram(audio_bytes, content_type)


def transcribe_audio_bytes_with_deepgram(audio_bytes: bytes, content_type: str):
    api_key = get_deepgram_api_key()
    if not api_key:
        raise AIServiceUnavailableError(
            "Transcription service is unavailable. DEEPGRAM_API_KEY is not configured."
        )

    if not audio_bytes:
        raise EmptyAudioError("Empty audio")

    try:
        response = run_with_deadline(
            lambda: httpx.post(
                # mip_opt_out=true: don't let Deepgram keep or train on student audio
                # (its Model Improvement Program is on by default; opting out doesn't change price).
                "https://api.deepgram.com/v1/listen?mip_opt_out=true",
                content=audio_bytes,
                headers={
                    "Authorization": f"Token {api_key}",
                    "Content-Type": content_type,
                },
                timeout=60.0,
            ),
            AI_TRANSCRIBE_DEADLINE_SECONDS,
        )
    except DeadlineExceeded as exc:
        logger.warning("Deepgram request missed its deadline")
        raise AIServiceUnavailableError("Talk-to-text took too long. Please try again.") from exc
    except httpx.HTTPError as exc:
        logger.warning("Deepgram request failed: %s", type(exc).__name__)
        raise RuntimeError("Transcription failed") from exc

    if response.status_code != 200:
        logger.warning(
            "Deepgram transcription failed status=%s",
            response.status_code,
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
        raise EmptyAudioError("Empty transcript")

    return transcript


@app.get("/robots.txt", response_class=PlainTextResponse, include_in_schema=False)
def robots_txt():
    """Ask every crawler to stay out of the API."""
    return "User-agent: *\nDisallow: /\n"


@app.get("/health", response_model=HealthResponse)
def health_check():
    """Liveness only: the server process is up. It does NOT check the database, so a 200
    here is not proof that accounts, notes or search work. Use /health/ready for that."""
    return {
        "status": "ok",
        "timestamp": datetime.utcnow().isoformat(),
    }


DB_READINESS_DEADLINE_SECONDS = 5.0


@app.get("/health/ready")
def readiness_check():
    """Readiness: can the server actually reach the database? Returns 200 only if a tiny
    read-only query (no rows) succeeds within 5 seconds; otherwise 503. No details or
    error text are returned, so nothing about the setup leaks."""
    checked_at = datetime.utcnow().isoformat()
    if not is_supabase_configured():
        return JSONResponse(
            status_code=503,
            content={"status": "not_ready", "database": "not_configured", "timestamp": checked_at},
        )
    try:
        run_with_deadline(
            lambda: supabase.table("users").select("id").limit(0).execute(),
            DB_READINESS_DEADLINE_SECONDS,
        )
    except DeadlineExceeded:
        logger.warning("Readiness check: database did not answer in time")
        return JSONResponse(
            status_code=503,
            content={"status": "not_ready", "database": "timeout", "timestamp": checked_at},
        )
    except Exception as exc:
        logger.warning("Readiness check: database unreachable (%s)", type(exc).__name__)
        return JSONResponse(
            status_code=503,
            content={"status": "not_ready", "database": "unreachable", "timestamp": checked_at},
        )
    return {"status": "ready", "database": "ok", "timestamp": checked_at}


@app.post(
    "/api/create-checkout-session",
    response_model=CheckoutSessionResponse,
    responses={409: {"model": BasicApiErrorResponse}, 500: {"model": BasicApiErrorResponse}},
)
def create_checkout_session(user=Depends(get_current_user)):
    if not settings.STRIPE_SECRET_KEY or not settings.STRIPE_PRICE_ID:
        return JSONResponse(status_code=500, content={"error": "Stripe is not configured"})

    user_row = get_user_by_id(user["id"])
    if not user_row:
        raise HTTPException(status_code=404, detail="User not found")

    stripe.api_key = settings.STRIPE_SECRET_KEY

    try:
        # A Premium account with no billing link has a legacy subscription that
        # was never linked. A new checkout would add a second, linked customer
        # and hide the legacy one from status refresh and account deletion, so
        # stop here until it is linked by hand.
        if billing.is_unlinked_paid_account(supabase, user["id"]):
            logger.warning("Checkout refused: paid account has no billing link; needs manual review")
            return JSONResponse(
                status_code=409,
                content={"error": "Your existing subscription needs a quick check by support before you can check out again."},
            )
        # Reuse the linked Stripe customer when there is one, so ownership
        # never depends on the email address (which the student can change).
        customer_params = billing.checkout_customer_params(supabase, user["id"], user_row.get("email"))
    except Exception as exc:
        logger.error("Could not read billing link for checkout error=%s", type(exc).__name__)
        return JSONResponse(status_code=500, content={"error": "Stripe checkout failed"})

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
            client_reference_id=user["id"],
            metadata={"user_id": user["id"]},
            subscription_data={"metadata": {"luma_user_id": user["id"]}},
            **customer_params,
        )
    except Exception as exc:
        # Exception type only: Stripe messages can echo the customer email.
        logger.error("Stripe checkout session creation failed error=%s", type(exc).__name__)
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

    try:
        outcome = billing.handle_event(event, supabase, stripe, settings.STRIPE_SECRET_KEY)
    except Exception as exc:
        # Database or Stripe failure: answer 500 so Stripe retries. Exception
        # type only, because messages can carry ids or emails.
        logger.error("Stripe webhook handling failed error=%s", type(exc).__name__)
        return JSONResponse(status_code=500, content={"error": "Stripe webhook failed"})
    logger.info("Stripe webhook handled outcome=%s", outcome)

    return {"success": True}


@app.post(
    "/api/generate-notes",
    response_model=GenerateNotesResponse,
    responses={
        400: {"model": BasicApiErrorResponse},
        401: {"model": BasicApiErrorResponse},
        403: {"model": BasicApiErrorResponse},
        429: {"model": BasicApiErrorResponse},
        503: {"model": BasicApiErrorResponse},
        500: {"model": BasicApiErrorResponse},
    },
)
def generate_notes(payload: GenerateNotesRequest, request: Request):
    """Picture to notes. Same notes shape, cleaning and limits as /api/notes-from-text:
    one notes turn, counted only when the notes come back."""
    ai_user = authenticate_ai_request(request)
    if not ai_user:
        return JSONResponse(status_code=401, content={"error": capture.LOGIN_AGAIN_MESSAGE})

    gate = ai_email_gate(ai_user)
    if gate is not None:
        return gate

    # Check the picture before using a turn, so a bad file costs nothing. The size check
    # is cheap and comes first, so a huge picture is never decoded.
    if len(payload.image or "") > MAX_NOTES_IMAGE_REQUEST_BYTES:
        return JSONResponse(status_code=413, content={"error": IMAGE_TOO_BIG_MESSAGE})
    try:
        image_data_url = read_notes_image(payload.image)
    except ValueError:
        return JSONResponse(status_code=400, content={"error": IMAGE_NOTES_BAD_PICTURE_MESSAGE})

    if not consume_ai_rate_limit_slot(
        ai_user["id"],
        "generate-notes",
        ai_user["subscription_status"],
    ):
        return JSONResponse(status_code=429, content={"error": capture.SLOW_DOWN_MESSAGE})

    with free_ai_turn(ai_user) as my_turn:
        if not my_turn:
            return JSONResponse(status_code=429, content={"error": ONE_AI_TASK_AT_A_TIME_MESSAGE})
        if (
            not has_premium_subscription(ai_user["subscription_status"])
            and has_free_ai_daily_limit(ai_user["id"], "notes")
        ):
            return JSONResponse(status_code=403, content={"error": capture.DAILY_LIMIT_MESSAGE})

        logger.info("Image to notes request chars=%s", len(image_data_url))
        try:
            result = generate_notes_with_ai(image_data_url)
            record_ai_usage(ai_user["id"], "notes")
            return {**result, "truncated": False}
        except AIServiceUnavailableError as exc:
            logger.warning("Image to notes unavailable: %s", type(exc).__name__)
            return JSONResponse(status_code=503, content={"error": capture.NOTES_UNAVAILABLE_MESSAGE})
        except Exception as exc:
            # Exception type only: messages could carry the student's material.
            logger.warning("Image to notes failed: %s", type(exc).__name__)
            return JSONResponse(status_code=500, content={"error": capture.NOTES_FAILED_MESSAGE})


@app.post(
    "/api/transcribe",
    response_model=TranscribeResponse,
    responses={
        400: {"model": BasicApiErrorResponse},
        401: {"model": BasicApiErrorResponse},
        403: {"model": BasicApiErrorResponse},
        413: {"model": BasicApiErrorResponse},
        429: {"model": BasicApiErrorResponse},
        503: {"model": BasicApiErrorResponse},
        500: {"model": BasicApiErrorResponse},
    },
)
def transcribe_audio(
    request: Request,
    # Union with str: a multipart part without a filename arrives as a plain
    # text field. Accept it here so we can answer with a friendly 400 instead
    # of FastAPI's raw validation error.
    audio: Union[UploadFile, str, None] = File(None),
    hint: Optional[str] = Form(None, max_length=1000),
):
    ai_user = authenticate_ai_request(request)
    if not ai_user:
        return JSONResponse(status_code=401, content={"error": "Please log in again."})

    gate = ai_email_gate(ai_user)
    if gate is not None:
        return gate

    declared_length = request.headers.get("content-length")
    try:
        if declared_length and int(declared_length) > MAX_TRANSCRIBE_REQUEST_BYTES:
            return JSONResponse(status_code=413, content={"error": TRANSCRIBE_TOO_BIG_MESSAGE})
    except ValueError:
        pass

    if not isinstance(audio, StarletteUploadFile) or not (audio.filename or "").strip():
        return JSONResponse(
            status_code=400,
            content={"error": "We didn't get a recording. Try again."},
        )

    try:
        content_type = get_transcribe_content_type(audio)
    except ValueError:
        return JSONResponse(
            status_code=400,
            content={"error": "We can't use that kind of audio file. Try a different one."},
        )

    try:
        audio_bytes = read_upload_bytes_capped(audio)
    except AudioTooLargeError:
        return JSONResponse(status_code=413, content={"error": TRANSCRIBE_TOO_BIG_MESSAGE})
    except EmptyAudioError:
        return JSONResponse(status_code=400, content={"error": "We didn't hear anything. Try again."})

    if not consume_ai_rate_limit_slot(
        ai_user["id"],
        "transcribe",
        ai_user["subscription_status"],
    ):
        return JSONResponse(status_code=429, content={"error": RATE_LIMIT_MESSAGE})

    with free_ai_turn(ai_user) as my_turn:
        if not my_turn:
            return JSONResponse(status_code=429, content={"error": ONE_AI_TASK_AT_A_TIME_MESSAGE})
        if (
            not has_premium_subscription(ai_user["subscription_status"])
            and has_free_ai_daily_limit(ai_user["id"], "transcription")
        ):
            return JSONResponse(
                status_code=403,
                content={
                    "error": "You used all your free recordings for today. "
                    "Come back tomorrow."
                },
            )

        # Voice to Notes needs a notes turn right after this. Don't spend a free
        # talk-to-text turn if the student has no notes turns left today.
        if (
            not has_premium_subscription(ai_user["subscription_status"])
            and has_free_ai_daily_limit(ai_user["id"], "notes")
        ):
            return JSONResponse(
                status_code=403,
                content={
                    "error": "You made all your free notes for today, so we saved your talk-to-text turn. "
                    "Come back tomorrow."
                },
            )

        logger.info(
            "Transcription request bytes=%s content_type=%s",
            len(audio_bytes),
            content_type,
        )

        try:
            cleaned_hint = clean_transcribe_hint(hint)
            transcript = transcribe_audio_bytes(
                audio_bytes,
                audio.filename or "",
                content_type,
                **({"hint": cleaned_hint} if cleaned_hint else {}),
            )
            record_ai_usage(ai_user["id"], "transcription")
            return {"transcript": transcript}
        except EmptyAudioError:
            return JSONResponse(status_code=400, content={"error": "We didn't hear anything. Try again."})
        except ValueError:
            return JSONResponse(
                status_code=400,
                content={"error": "We can't use that kind of audio file. Try a different one."},
            )
        except AIServiceUnavailableError as exc:
            logger.warning("AI transcription unavailable: %s", exc)
            return JSONResponse(
                status_code=503,
                content={"error": "Talk-to-text is not working right now. Try again later."},
            )
        except Exception:
            logger.exception("AI transcription failed")
            return JSONResponse(
                status_code=500,
                content={"error": "We couldn't turn that into words. Try again."},
            )


# ---------- Auth routes ----------

@app.post(
    "/signup",
    status_code=202,
    response_model=SignupPendingResponse,
    responses={400: {"model": BasicApiErrorResponse}, 429: {"model": BasicApiErrorResponse}},
)
def signup(payload: SignupRequest, http_request: Request):
    """Start a signup. No account is made until the emailed code is entered.

    New email: a pending signup (username + password hash) is saved with a code
    and emailed. Email that already has an account: nothing is saved; the owner
    gets a short notice email (at most one per hour). The answer and its timing
    are the same either way, and it never says whether the email is in use.
    The returned ticket stays in this browser and is needed with the code.
    """
    started_at = time.monotonic()
    if not signup_ip_limiter.hit(get_client_ip(http_request)):
        return auth_error(429, TOO_MANY_TRIES_SHORT_MESSAGE, "rate_limited", SIGNUP_WINDOW_SECONDS)

    try:
        validate_new_password(payload.password)
    except HTTPException as exc:
        return auth_error(400, str(exc.detail), "password_invalid")

    email = normalize_account_email(payload.email)
    # Usernames are public, so saying one is taken reveals nothing about emails.
    if get_user_by_username(payload.username):
        return auth_error(400, USERNAME_TAKEN_MESSAGE, "username_taken")

    ticket = email_codes_module.generate_ticket()
    existing_user = find_user_by_email(email)
    if existing_user:
        # A decoy pending signup that can never succeed (its code is never sent)
        # so wrong tries on this ticket lock and expire exactly like a real one:
        # the code checks reveal nothing about whether the email has an account.
        decoy_hash = hash_password(payload.password)  # same hashing time as a new signup
        _run_email_job(_save_decoy_signup, email, ticket, decoy_hash, payload.username)
        if signup_notice_limiter.hit(email):
            _run_email_job(_send_signup_notice, existing_user["email"])
    else:
        password_hash = hash_password(payload.password)
        _run_email_job(_send_signup_code_best_effort, email, ticket, password_hash, payload.username)

    _pad_response_time(started_at)
    return JSONResponse(
        status_code=202,
        content={
            "status": "check_email",
            "email": email,
            "ticket": ticket,
            "resend_after_seconds": email_codes_module.RESEND_COOLDOWN_SECONDS,
            "code_expires_in_seconds": email_codes_module.CODE_TTL_SECONDS,
        },
    )


def _save_decoy_signup(email: str, ticket: str, password_hash: str, username: str) -> None:
    try:
        email_code_store.issue_signup(email, ticket, email_codes_module.generate_code(), password_hash, username)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Decoy signup row not saved (%s)", type(exc).__name__)


def _send_signup_notice(to_email: str) -> None:
    try:
        send_email(
            to_email,
            "Someone tried to make a Luma account with your email",
            build_signup_notice_email_html(),
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("Signup notice email could not be sent (%s)", type(exc).__name__)


def _code_error(status: str):
    if status == "expired":
        return auth_error(400, CODE_EXPIRED_MESSAGE, "code_expired")
    if status == "locked":
        return auth_error(400, CODE_LOCKED_MESSAGE, "code_locked")
    return auth_error(400, CODE_INCORRECT_MESSAGE, "code_incorrect")


@app.post(
    "/auth/verify-email",
    response_model=AuthSessionResponse,
    responses={400: {"model": BasicApiErrorResponse}, 429: {"model": BasicApiErrorResponse}},
)
def verify_email_code(payload: VerifyEmailCodeRequest, http_request: Request):
    """Check a 6-digit code and log the user in.

    - Pending signup: email + ticket + code. Creates the account (verified).
    - Logged-in account (Bearer token, no ticket): code for its current address.
    """
    if not verify_code_ip_limiter.hit(get_client_ip(http_request)):
        return auth_error(429, TOO_MANY_TRIES_SHORT_MESSAGE, "rate_limited", VERIFY_CODE_WINDOW_SECONDS)

    user_id = None if payload.ticket else optional_user_id(http_request)
    if user_id:
        if not verify_code_email_limiter.hit(f"user:{user_id}"):
            return auth_error(429, TOO_MANY_TRIES_SHORT_MESSAGE, "rate_limited", VERIFY_CODE_WINDOW_SECONDS)
        user_row = get_user_by_id(user_id)
        if not user_row:
            return _code_error("incorrect")
        if user_row.get("email_verified"):
            return session_response(user_row)
        result = email_code_store.check_for_user(user_id, normalize_account_email(user_row["email"]), payload.code)
        if result.status != "ok":
            return _code_error(result.status)
        update_user(
            user_id,
            {"email_verified": True, "email_verification_token": None, "email_verification_sent_at": None},
        )
        return session_response({**user_row, "email_verified": True})

    if not payload.email or not payload.ticket:
        return _code_error("incorrect")
    email = normalize_account_email(payload.email)
    if not verify_code_email_limiter.hit(email):
        return auth_error(429, TOO_MANY_TRIES_SHORT_MESSAGE, "rate_limited", VERIFY_CODE_WINDOW_SECONDS)

    result = email_code_store.check_signup(email, payload.ticket, payload.code)
    if result.status != "ok":
        return _code_error(result.status)

    row = result.row or {}
    with _signup_lock(email):
        if find_user_by_email(email):
            return auth_error(400, ACCOUNT_EXISTS_MESSAGE, "account_exists")
        username = row.get("pending_username") or ""
        if not username or get_user_by_username(username):
            return auth_error(400, "That username was just taken. Sign up again with another one.", "username_taken")
        try:
            user = create_user_with_hash(email, row.get("pending_password_hash") or "", username, True)
            create_profile(user["id"], username)
        except Exception as exc:  # noqa: BLE001 - e.g. a parallel signup won the unique index
            logger.warning("Account creation after code failed (%s)", type(exc).__name__)
            return auth_error(400, "We couldn't finish that signup. Try signing up again.", "signup_failed")
    verify_code_email_limiter.reset(email)
    return session_response({**user, "email_verified": True})


@app.post("/auth/resend-code", status_code=202, response_model=ResendCodeResponse)
def resend_verification_code(payload: ResendCodeRequest, http_request: Request):
    """New code for this browser's pending signup. Always the same answer."""
    started_at = time.monotonic()
    if resend_code_ip_limiter.hit(get_client_ip(http_request)):
        if payload.ticket:
            _run_email_job(
                _send_signup_code_best_effort,
                normalize_account_email(payload.email),
                payload.ticket,
                None,
                None,
            )
    else:
        logger.info("Resend code request skipped by rate limit")

    _pad_response_time(started_at)
    return JSONResponse(
        status_code=202,
        content={
            "status": "sent_if_possible",
            "resend_after_seconds": email_codes_module.RESEND_COOLDOWN_SECONDS,
        },
    )


@app.post("/login", response_model=AuthSessionResponse)
def login(request: LoginRequest, http_request: Request):
    limiter_key = (get_client_ip(http_request), normalize_account_email(request.email))
    # Reserve the attempt atomically before checking the password, so a
    # parallel burst cannot pass the check before any failure is recorded.
    # A failed attempt keeps its slot; a successful one clears the key.
    if not login_failure_limiter.hit(limiter_key):
        raise HTTPException(status_code=429, detail=LOGIN_TOO_MANY_TRIES_MESSAGE)

    user = verify_user(request.email, request.password)
    if not user:
        raise HTTPException(status_code=401, detail=LOGIN_FAILED_MESSAGE)

    login_failure_limiter.reset(limiter_key)
    # Unverified accounts get a session too (they proved the password), but AI
    # tools stay locked until they enter an email code.
    return session_response(user)


@app.post(
    "/auth/send-verification",
    response_model=VerificationStatusResponse,
    responses={429: {"model": BasicApiErrorResponse}, 503: {"model": BasicApiErrorResponse}},
)
def send_verification_email(user=Depends(get_current_user)):
    """Logged-in user asks for a new code."""
    user_row = get_user_by_id(user["id"])
    if not user_row:
        raise HTTPException(status_code=404, detail="User not found")

    if user_row.get("email_verified"):
        return {"success": True, "message": "Your email is already checked."}

    try:
        result = issue_and_send_verification_code(user["id"], user_row["email"])
    except Exception as exc:  # noqa: BLE001
        logger.warning("Verification code email could not be sent (%s)", type(exc).__name__)
        return auth_error(503, EMAIL_SEND_FAILED_MESSAGE, "email_send_failed")
    if result.status == "cooldown":
        return auth_error(429, RESEND_COOLDOWN_MESSAGE, "resend_cooldown", result.retry_after)
    if result.status == "cap":
        return auth_error(429, TOO_MANY_TRIES_SHORT_MESSAGE, "rate_limited", result.retry_after)
    return JSONResponse(
        status_code=200,
        content={
            "success": True,
            "message": "We sent a new code.",
            "resend_after_seconds": email_codes_module.RESEND_COOLDOWN_SECONDS,
        },
    )


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
def request_password_reset(payload: PasswordResetRequest, http_request: Request):
    generic_response = {"success": True, "message": PASSWORD_RESET_REQUEST_MESSAGE}
    started_at = time.monotonic()
    email_key = str(payload.email).strip().lower()
    client_ip = get_client_ip(http_request)

    # Silent limits: same answer either way so nobody learns anything from it.
    allowed = (
        password_reset_ip_limiter.hit(client_ip)
        and password_reset_email_limiter.hit((client_ip, email_key))
        and password_reset_email_global_limiter.hit(email_key)
    )
    if allowed:
        try:
            job = _password_reset_executor.submit(_send_password_reset_best_effort, payload.email)
            job.result(timeout=PASSWORD_RESET_RESPONSE_SECONDS)
        except FuturesTimeoutError:
            pass  # still running; the response must not wait for it
        except Exception as exc:  # noqa: BLE001 - never fail this route
            logger.warning("Password reset email could not be queued (%s)", type(exc).__name__)
    else:
        logger.info("Password reset request skipped by rate limit")

    # Same response time for known, unknown and rate-limited emails.
    remaining = PASSWORD_RESET_RESPONSE_SECONDS - (time.monotonic() - started_at)
    if remaining > 0:
        time.sleep(remaining)
    return generic_response


def _send_password_reset_best_effort(email: str) -> None:
    """Look the user up, issue a token and send the email. Never raises."""
    try:
        user_row = find_user_by_email(email)
        if not user_row:
            return

        token = issue_password_reset_token(user_row["id"])
        send_email(
            user_row["email"],
            "Reset your Luma password",
            build_password_reset_email_html(build_password_reset_url(token)),
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("Password reset email could not be sent (%s)", type(exc).__name__)


@app.post(
    "/auth/reset",
    response_model=VerificationStatusResponse,
    responses={400: {"model": BasicApiErrorResponse}},
)
def reset_password(payload: PasswordResetConfirmRequest):
    try:
        validate_new_password(payload.new_password)
    except HTTPException as exc:
        return auth_error(400, str(exc.detail), "password_invalid")

    user_row = get_user_by_password_reset_token(payload.token)
    if not user_row:
        return auth_error(400, RESET_INVALID_MESSAGE, "reset_invalid")

    if is_password_reset_expired(user_row.get("password_reset_sent_at")):
        update_user(
            user_row["id"],
            {
                "password_reset_token": None,
                "password_reset_sent_at": None,
            },
        )
        return auth_error(400, RESET_INVALID_MESSAGE, "reset_invalid")

    # Use the token up and set the new password in one conditional update, so
    # the same link can't be used twice even by two requests at once. The new
    # hash changes the session fingerprint ("pv"), which signs out every device.
    # Opening the emailed link also proves the person controls the inbox.
    claimed = (
        supabase.table("users")
        .update(
            {
                "password": hash_password(payload.new_password),
                "password_reset_token": None,
                "password_reset_sent_at": None,
                "email_verified": True,
            }
        )
        .eq("id", user_row["id"])
        .eq("password_reset_token", hash_token(payload.token))
        .execute()
    )
    if not claimed or not getattr(claimed, "data", None):
        return auth_error(400, RESET_INVALID_MESSAGE, "reset_invalid")
    return {"success": True, "message": "Password reset successful"}


# ---------- Profile routes ----------

@app.get("/me/profile", response_model=ProfileResponse)
def get_my_profile(user=Depends(get_current_user)):
    profile = get_profile(user["id"])
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")

    user_data_response = (
        supabase.table("users")
        .select("email, username, email_verified, role")
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
        "theme_mode": read_theme_mode(profile.get("theme_mode")),
        "phone_number": profile.get("phone_number"),
        "birthday": profile.get("birthday"),
        "subscription_status": profile.get("subscription_status") or "free",
        "email_verified": user_data.get("email_verified", False),
        "is_admin": user_data.get("role") == "admin",
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
        .select("email, username, email_verified, role")
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
        "theme_mode": read_theme_mode(updated_profile.get("theme_mode")),
        "phone_number": updated_profile.get("phone_number"),
        "birthday": updated_profile.get("birthday"),
        "subscription_status": updated_profile.get("subscription_status") or "free",
        "email_verified": user_data.get("email_verified", False),
        "is_admin": user_data.get("role") == "admin",
    }


# ---------- Avatar routes ----------

@app.post("/me/avatar", response_model=AvatarUploadResponse)
def upload_avatar(file: UploadFile = File(...), user=Depends(get_current_user)):
    content, image_type = read_image_upload(file)
    storage_path = new_image_storage_path(user["id"], image_type)
    avatar_url = upload_file_to_storage(file, "avatars", storage_path, content=content, content_type=image_type)

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
    content, image_type = read_image_upload(file)
    storage_path = new_image_storage_path(f"themes/{user['id']}", image_type)
    theme_url = upload_file_to_storage(file, "themes", storage_path, content=content, content_type=image_type)

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


@app.put("/me/email", response_model=ProfileResponse)
def update_email(payload: EmailUpdateRequest, user=Depends(get_current_user)):
    normalized_email = str(payload.new_email).strip().lower()
    existing_user = find_user_by_email(normalized_email)
    if existing_user and existing_user["id"] != user["id"]:
        raise HTTPException(status_code=400, detail="Email already registered")

    updated_user = update_user(
        user["id"],
        {
            "email": normalized_email,
            "email_verified": False,
            "email_verification_token": None,
            "email_verification_sent_at": None,
        },
    )
    if not updated_user:
        raise HTTPException(status_code=404, detail="User not found")

    # Codes sent to the old address stop working, and the new address must be
    # checked with a fresh code before AI tools unlock again.
    # (Codes are also bound to the address they were sent to, so this is a second lock.)
    try:
        email_code_store.retire_for_user(user["id"])
    except Exception as exc:  # noqa: BLE001
        logger.warning("Could not retire old email codes (%s)", type(exc).__name__)
    _send_code_best_effort(user["id"], normalized_email)

    return build_profile_response(user["id"])


def clear_user_memory_state(user_id: str) -> None:
    """Drop per-process state keyed by this user id (rate limits, websockets)."""
    for bucket_key in [key for key in list(ai_rate_limit_windows) if key and key[0] == user_id]:
        ai_rate_limit_windows.pop(bucket_key, None)
    connection_manager.active_connections.pop(user_id, None)


def build_account_deletion_deps() -> account_deletion.DeletionDeps:
    return account_deletion.DeletionDeps(
        db=supabase,
        stripe=stripe if settings.STRIPE_SECRET_KEY else None,
        stripe_secret_key=settings.STRIPE_SECRET_KEY,
        clear_memory=clear_user_memory_state,
        privileged_db=bool(settings.SUPABASE_SERVICE_ROLE_KEY),
    )


@app.delete(
    "/me/account",
    response_model=AccountDeleteResponse,
    responses={500: {"description": "Deletion incomplete; safe to retry"}},
)
def delete_account(user=Depends(get_current_user)):
    report = account_deletion.delete_account_data(user["id"], build_account_deletion_deps())
    if not report.succeeded:
        return JSONResponse(
            status_code=500,
            content={
                "detail": (
                    account_deletion.BILLING_REVIEW_DETAIL
                    if report.needs_billing_review
                    else account_deletion.FAILURE_DETAIL
                ),
                "failed_steps": report.failed_steps,
            },
        )

    return {
        "success": True,
        "message": account_deletion.SUCCESS_MESSAGE,
        "retained": report.retained,
    }


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

@app.post("/internal/supabase/user-updated")
async def supabase_user_updated(payload: dict, request: Request):
    require_internal_webhook_secret(request)

    # Do not log headers (they carry the webhook secret) or the payload (it can
    # carry user records).
    logger.info("Supabase webhook fired keys=%s", sorted(payload.keys()) if isinstance(payload, dict) else "-")

    return {"status": "ok"}


@app.post("/internal/supabase/user-updated-test")
async def supabase_user_updated_test(payload: dict, request: Request):
    require_internal_webhook_secret(request)
    logger.info("Test webhook hit keys=%s", sorted(payload.keys()) if isinstance(payload, dict) else "-")
    return {"status": "test-ok"}


@app.get("/internal/debug/file")
async def debug_file(request: Request):
    require_internal_webhook_secret(request)
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


if (settings.EMAIL_FROM or "").strip().lower().rstrip(">").endswith("@resend.dev"):
    # Resend's test sender only delivers to the Resend account owner's own inbox,
    # so students would never get codes or reset links.
    logger.warning(
        "EMAIL_FROM uses resend.dev (Resend's test sender): emails reach only the "
        "Resend account owner. Verify your own domain in Resend before launch."
    )

logger.info("MAIN.PY LOADED SUCCESSFULLY")
