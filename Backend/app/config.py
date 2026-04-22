from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from pydantic.v1 import BaseSettings, Field, validator

DEFAULT_DEV_JWT_SECRET = "luma-development-jwt-secret-key-2026"
DEFAULT_API_BASE_URL = "http://127.0.0.1:8000"
DEFAULT_FRONTEND_APP_ORIGIN = "http://localhost:5173"
DEFAULT_FRONTEND_ORIGINS = [
    "https://luma-frontend-ruby.vercel.app",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
]


def normalize_origin(value: str | None) -> str | None:
    if not isinstance(value, str):
        return None

    trimmed = value.strip().rstrip("/")
    return trimmed or None


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


class AppSettings(BaseSettings):
    APP_ENV: str = Field("development", env=["APP_ENV", "ENV"])
    API_BASE_URL: str | None = Field(default=None, env="API_BASE_URL")
    FRONTEND_ORIGINS: list[str] = Field(
        default_factory=lambda: DEFAULT_FRONTEND_ORIGINS.copy(),
        env=["FRONTEND_ORIGINS", "FRONTEND_ORIGIN", "PUBLIC_APP_URL"],
    )
    FRONTEND_ORIGIN: str | None = Field(default=None, env="FRONTEND_ORIGIN")
    PUBLIC_APP_URL: str | None = Field(default=None, env="PUBLIC_APP_URL")
    JWT_SECRET_KEY: str | None = Field(default=None, env="JWT_SECRET_KEY")
    SUPABASE_URL: str | None = Field(default=None, env="SUPABASE_URL")
    SUPABASE_SERVICE_ROLE_KEY: str | None = Field(
        default=None,
        env="SUPABASE_SERVICE_ROLE_KEY",
    )
    SUPABASE_KEY: str | None = Field(default=None, env="SUPABASE_KEY")
    LOG_LEVEL: str = Field("INFO", env="LOG_LEVEL")
    OPENAI_API_KEY: str | None = Field(default=None, env="OPENAI_API_KEY")
    OPENAI_ENDPOINT: str | None = Field(default=None, env="OPENAI_ENDPOINT")
    OPENAI_VISION_MODEL: str = Field(
        "gpt-4.1-mini",
        env="OPENAI_VISION_MODEL",
    )
    OPENAI_EMBEDDING_MODEL: str = Field(
        "text-embedding-3-small",
        env="OPENAI_EMBEDDING_MODEL",
    )
    DEEPGRAM_API_KEY: str | None = Field(default=None, env="DEEPGRAM_API_KEY")
    STRIPE_SECRET_KEY: str | None = Field(default=None, env="STRIPE_SECRET_KEY")
    STRIPE_WEBHOOK_SECRET: str | None = Field(
        default=None,
        env="STRIPE_WEBHOOK_SECRET",
    )
    STRIPE_PRICE_ID: str | None = Field(default=None, env="STRIPE_PRICE_ID")
    WEBHOOK_SECRET: str | None = Field(default=None, env="WEBHOOK_SECRET")
    FREE_AI_DAILY_LIMIT: int = Field(3, env="FREE_AI_DAILY_LIMIT")
    AI_RATE_LIMIT_WINDOW_SECONDS: int = Field(
        60,
        env="AI_RATE_LIMIT_WINDOW_SECONDS",
    )
    RESEND_API_KEY: str | None = Field(default=None, env="RESEND_API_KEY")
    EMAIL_FROM: str | None = Field(default=None, env="EMAIL_FROM")

    @validator("APP_ENV", pre=True)
    def normalize_app_env(cls, value: Any) -> str:
        if not isinstance(value, str) or not value.strip():
            return "development"
        return value.strip().lower()

    @validator(
        "API_BASE_URL",
        "FRONTEND_ORIGIN",
        "PUBLIC_APP_URL",
        "JWT_SECRET_KEY",
        "SUPABASE_URL",
        "SUPABASE_SERVICE_ROLE_KEY",
        "SUPABASE_KEY",
        "OPENAI_API_KEY",
        "OPENAI_ENDPOINT",
        "STRIPE_SECRET_KEY",
        "STRIPE_WEBHOOK_SECRET",
        "STRIPE_PRICE_ID",
        "WEBHOOK_SECRET",
        "RESEND_API_KEY",
        "EMAIL_FROM",
        pre=True,
    )
    def normalize_optional_string(cls, value: Any) -> str | None:
        if not isinstance(value, str):
            return None

        trimmed = value.strip()
        return trimmed or None

    @validator("API_BASE_URL", "FRONTEND_ORIGIN", "PUBLIC_APP_URL")
    def normalize_url_fields(cls, value: str | None) -> str | None:
        return normalize_origin(value)

    @validator("LOG_LEVEL", pre=True)
    def normalize_log_level(cls, value: Any) -> str:
        if not isinstance(value, str) or not value.strip():
            return "INFO"
        return value.strip().upper()

    @validator("FRONTEND_ORIGINS", pre=True)
    def normalize_frontend_origins(cls, value: Any) -> list[str]:
        merged: list[str] = []
        for origin in [*DEFAULT_FRONTEND_ORIGINS, *parse_origin_list(value)]:
            normalized = normalize_origin(origin)
            if normalized and normalized not in merged:
                merged.append(normalized)
        return merged

    @property
    def effective_jwt_secret_key(self) -> str | None:
        return self.JWT_SECRET_KEY or (
            DEFAULT_DEV_JWT_SECRET if self.APP_ENV != "production" else None
        )

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

    class Config:
        env_file = str(Path(__file__).resolve().parents[1] / ".env")
        env_file_encoding = "utf-8"
        case_sensitive = False


settings = AppSettings()
