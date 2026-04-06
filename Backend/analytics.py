from datetime import datetime, timezone
from typing import Any, Literal

from fastapi import APIRouter, Depends, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field, field_validator

from auth import _get_user_from_custom_jwt
from supabase_client import get_supabase

router = APIRouter(prefix="/analytics", tags=["analytics"])
TABLE_NAME = "analytics_events"
security = HTTPBearer(auto_error=False)


class AnalyticsEventRequest(BaseModel):
    event_name: Literal[
        "page_view",
        "feature_usage",
        "premium_modal_open",
        "study_tool_usage",
        "onboarding_completed",
    ]
    event_group: Literal["navigation", "feature", "premium", "study", "onboarding"]
    page_path: str | None = Field(default=None, max_length=200)
    feature_key: str | None = Field(default=None, max_length=80)
    subscription_tier: str | None = Field(default=None, max_length=24)
    surface: str | None = Field(default=None, max_length=80)
    metadata: dict[str, Any] = Field(default_factory=dict)
    occurred_at: datetime | None = None

    @field_validator("metadata", mode="before")
    @classmethod
    def sanitize_metadata(cls, value: Any):
        if not isinstance(value, dict):
            return {}

        sanitized: dict[str, Any] = {}
        for key, item in value.items():
            if not isinstance(key, str):
                continue

            trimmed_key = key.strip()[:48]
            if not trimmed_key:
                continue

            if isinstance(item, bool) or item is None:
                sanitized[trimmed_key] = item
            elif isinstance(item, (int, float)):
                sanitized[trimmed_key] = item
            elif isinstance(item, str):
                sanitized[trimmed_key] = item.strip()[:160]

        return sanitized


class AnalyticsBatchRequest(BaseModel):
    events: list[AnalyticsEventRequest] = Field(..., min_length=1, max_length=20)


class AnalyticsBatchResponse(BaseModel):
    success: bool
    accepted: int


def get_optional_user_id(
    credentials: HTTPAuthorizationCredentials | None = Depends(security),
):
    if credentials is None:
        return None

    token = credentials.credentials
    custom_user_id = _get_user_from_custom_jwt(token)
    if custom_user_id:
        return custom_user_id

    try:
        auth_response = get_supabase().auth.get_user(token)
        user = getattr(auth_response, "user", None)
        user_id = getattr(user, "id", None)
        if isinstance(user_id, str) and user_id:
            return user_id
    except Exception:
        return None

    return None


def _normalize_timestamp(value: datetime | None):
    if value is None:
        return datetime.now(timezone.utc).isoformat()

    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc).isoformat()

    return value.astimezone(timezone.utc).isoformat()


# TODO: Add retention policies, sampling controls, and abuse-rate monitoring
# before expanding analytics coverage more broadly in production.
@router.post("/events", response_model=AnalyticsBatchResponse, status_code=status.HTTP_202_ACCEPTED)
def record_analytics_events(
    payload: AnalyticsBatchRequest,
    user_id: str | None = Depends(get_optional_user_id),
):
    rows = [
        {
            "user_id": user_id,
            "event_name": event.event_name,
            "event_group": event.event_group,
            "page_path": event.page_path,
            "feature_key": event.feature_key,
            "subscription_tier": event.subscription_tier,
            "surface": event.surface,
            "metadata": event.metadata,
            "created_at": _normalize_timestamp(event.occurred_at),
        }
        for event in payload.events
    ]

    try:
        get_supabase().table(TABLE_NAME).insert(rows).execute()
    except Exception:
        # Analytics should never block the user flow. Fail closed and let the
        # caller continue without surfacing a visible error.
        return {"success": False, "accepted": 0}

    return {"success": True, "accepted": len(rows)}
