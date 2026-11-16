from __future__ import annotations

import json
import os
import secrets
from dataclasses import dataclass
from typing import Any

DEFAULT_DEV_JWT_SECRET = "luma-development-jwt-secret-key-2026"
DEFAULT_API_BASE_URL = "http://127.0.0.1:8000"
DEFAULT_FRONTEND_APP_ORIGIN = "http://localhost:5173"
DEFAULT_FRONTEND_ORIGINS = [
    "http://localhost:5173",
    "https://*.vercel.app",
    "https://luma-frontend-ruby.vercel.app",
    "https://luma-frontend-dxgnch0h1-jabarimckinney213-7284s-projects.vercel.app",
]

_PRODUCTION_FALLBACK_JWT_SECRET = secrets.token_urlsafe(64)


def normalize_origin(value: str | None) -> str | None:
    if not isinstance(value, str):
        return None

    trimmed = value.strip().rstrip("/")
    if not trimmed:
        return None

    if not trimmed.lower().startswith(("http://", "https://")):
        return None

    return trimmed


def parse_origin_list(value: Any) -> list[str]:
    if value is None:
        return []

    if isinstance(value, str):
        trimmed = value.strip()
        if not trimmed:
            return []

        if trimmed.startswith("["):
            try:
                decoded = json.loads(trimmed)
            except json.JSONDecodeError:
                decoded = None

            if isinstance(decoded, list):
                return [
                    normalized
                    for normalized in (
                        normalize_origin(str(item)) for item in decoded
                    )
                    if normalized
                ]

        return [
            normalized
            for normalized in (
                normalize_origin(part) for part in trimmed.split(",")
            )
            if normalized
        ]

    if isinstance(value, (list, tuple, set)):
        return [
            normalized
            for normalized in (normalize_origin(str(item)) for item in value)
            if normalized
        ]

    return []


def _normalize_optional_string(value: Any) -> str | None:
    if value is None:
        return None

    if not isinstance(value, str):
        value = str(value)

    trimmed = value.strip()
    return trimmed or None


def _normalize_int(value: Any, default: int) -> int:
    normalized = _normalize_optional_string(value)
    if normalized is None:
        return default

    try:
        return int(normalized)
    except (TypeError, ValueError):
        return default


def _normalize_log_level(value: Any) -> str:
    normalized = _normalize_optional_string(value)
    if normalized is None:
        return "INFO"
    return normalized.upper()


def _normalize_app_env(value: Any) -> str:
    normalized = _normalize_optional_string(value)
    if normalized is None:
        return "development"
    return normalized.lower()


def _build_env_lookup() -> dict[str, str]:
    lookup: dict[str, str] = {}

    def merge_source(source: dict[str, Any]) -> None:
        items = list(source.items())

        for prefer_exact_uppercase in (True, False):
            for key, value in items:
                if not isinstance(key, str):
                    continue

                normalized_value = _normalize_optional_string(value)
                if normalized_value is None:
                    continue

                normalized_key = key.upper()
                is_exact_uppercase = key == normalized_key

                if prefer_exact_uppercase:
                    if is_exact_uppercase:
                        lookup[normalized_key] = normalized_value
                elif normalized_key not in lookup:
                    lookup[normalized_key] = normalized_value

    merge_source(dict(os.environ))

    return lookup


def _read_env(
    env_lookup: dict[str, str],
    *names: str,
    default: str | None = None,
) -> str | None:
    for name in names:
        value = env_lookup.get(name.upper())
        if value is not None:
            return value
    return default


@dataclass(frozen=True)
class AppSettings:
    APP_ENV: str = "development"
    API_BASE_URL: str | None = None
    FRONTEND_ORIGINS_RAW: str | None = None
    FRONTEND_ORIGIN: str | None = None
    PUBLIC_APP_URL: str | None = None
    JWT_SECRET_KEY: str | None = None
    SUPABASE_URL: str | None = None
    SUPABASE_SERVICE_ROLE_KEY: str | None = None
    SUPABASE_KEY: str | None = None
    LOG_LEVEL: str = "INFO"
    OPENAI_API_KEY: str | None = None
    OPENAI_ENDPOINT: str | None = None
    OPENAI_VISION_MODEL: str = "gpt-4.1-mini"
    OPENAI_TRANSCRIBE_MODEL: str = "gpt-4o-mini-transcribe"
    DEEPGRAM_API_KEY: str | None = None
    STRIPE_SECRET_KEY: str | None = None
    STRIPE_WEBHOOK_SECRET: str | None = None
    STRIPE_PRICE_ID: str | None = None
    WEBHOOK_SECRET: str | None = None
    FREE_AI_DAILY_LIMIT: int = 3
    AI_RATE_LIMIT_WINDOW_SECONDS: int = 60
    RESEND_API_KEY: str | None = None
    EMAIL_FROM: str | None = None
    # How many reverse proxies in front of the app append to X-Forwarded-For.
    # 0 (default) ignores the header and uses the socket peer address. On
    # Render/Railway set TRUSTED_PROXY_HOPS=1 so rate limits see the real
    # client (the entry the platform proxy appended, never a client-supplied one).
    TRUSTED_PROXY_HOPS: int = 0

    @property
    def FRONTEND_ORIGINS(self) -> list[str]:
        merged: list[str] = []
        dynamic_origins = [
            *parse_origin_list(self.FRONTEND_ORIGINS_RAW),
            normalize_origin(self.FRONTEND_ORIGIN),
            normalize_origin(self.PUBLIC_APP_URL),
        ]

        for origin in [*DEFAULT_FRONTEND_ORIGINS, *dynamic_origins]:
            normalized = normalize_origin(origin)
            if normalized and normalized not in merged:
                merged.append(normalized)

        return merged

    @property
    def effective_jwt_secret_key(self) -> str:
        if self.JWT_SECRET_KEY:
            return self.JWT_SECRET_KEY

        if self.APP_ENV == "production":
            return _PRODUCTION_FALLBACK_JWT_SECRET

        return DEFAULT_DEV_JWT_SECRET

    @property
    def using_fallback_jwt_secret(self) -> bool:
        return not bool(self.JWT_SECRET_KEY)

    @property
    def using_production_fallback_jwt_secret(self) -> bool:
        return self.APP_ENV == "production" and not bool(self.JWT_SECRET_KEY)

    @property
    def resolved_api_base_url(self) -> str:
        return normalize_origin(self.API_BASE_URL) or DEFAULT_API_BASE_URL

    @property
    def frontend_app_origin(self) -> str:
        for value in (self.FRONTEND_ORIGIN, self.PUBLIC_APP_URL):
            normalized = normalize_origin(value)
            if normalized:
                return normalized

        return DEFAULT_FRONTEND_APP_ORIGIN

    @property
    def supabase_key(self) -> str | None:
        return self.SUPABASE_SERVICE_ROLE_KEY or self.SUPABASE_KEY


def load_settings() -> AppSettings:
    env_lookup = _build_env_lookup()

    return AppSettings(
        APP_ENV=_normalize_app_env(_read_env(env_lookup, "APP_ENV", "ENV")),
        API_BASE_URL=normalize_origin(_read_env(env_lookup, "API_BASE_URL")),
        FRONTEND_ORIGINS_RAW=_read_env(env_lookup, "FRONTEND_ORIGINS"),
        FRONTEND_ORIGIN=normalize_origin(_read_env(env_lookup, "FRONTEND_ORIGIN")),
        PUBLIC_APP_URL=normalize_origin(_read_env(env_lookup, "PUBLIC_APP_URL")),
        JWT_SECRET_KEY=_read_env(env_lookup, "JWT_SECRET_KEY"),
        SUPABASE_URL=_read_env(env_lookup, "SUPABASE_URL"),
        SUPABASE_SERVICE_ROLE_KEY=_read_env(env_lookup, "SUPABASE_SERVICE_ROLE_KEY"),
        SUPABASE_KEY=_read_env(env_lookup, "SUPABASE_KEY"),
        LOG_LEVEL=_normalize_log_level(_read_env(env_lookup, "LOG_LEVEL")),
        OPENAI_API_KEY=_read_env(env_lookup, "OPENAI_API_KEY"),
        OPENAI_ENDPOINT=_read_env(env_lookup, "OPENAI_ENDPOINT"),
        OPENAI_VISION_MODEL=_read_env(
            env_lookup,
            "OPENAI_VISION_MODEL",
            default="gpt-4.1-mini",
        )
        or "gpt-4.1-mini",
        OPENAI_TRANSCRIBE_MODEL=_read_env(
            env_lookup,
            "OPENAI_TRANSCRIBE_MODEL",
            default="gpt-4o-mini-transcribe",
        )
        or "gpt-4o-mini-transcribe",
        DEEPGRAM_API_KEY=_read_env(env_lookup, "DEEPGRAM_API_KEY"),
        STRIPE_SECRET_KEY=_read_env(env_lookup, "STRIPE_SECRET_KEY"),
        STRIPE_WEBHOOK_SECRET=_read_env(env_lookup, "STRIPE_WEBHOOK_SECRET"),
        STRIPE_PRICE_ID=_read_env(env_lookup, "STRIPE_PRICE_ID"),
        WEBHOOK_SECRET=_read_env(env_lookup, "WEBHOOK_SECRET"),
        FREE_AI_DAILY_LIMIT=_normalize_int(
            _read_env(env_lookup, "FREE_AI_DAILY_LIMIT"),
            default=3,
        ),
        AI_RATE_LIMIT_WINDOW_SECONDS=_normalize_int(
            _read_env(env_lookup, "AI_RATE_LIMIT_WINDOW_SECONDS"),
            default=60,
        ),
        RESEND_API_KEY=_read_env(env_lookup, "RESEND_API_KEY"),
        EMAIL_FROM=_read_env(env_lookup, "EMAIL_FROM"),
        TRUSTED_PROXY_HOPS=max(
            0,
            _normalize_int(_read_env(env_lookup, "TRUSTED_PROXY_HOPS"), default=0),
        ),
    )


settings = load_settings()
