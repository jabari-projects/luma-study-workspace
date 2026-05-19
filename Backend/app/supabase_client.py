from __future__ import annotations

from functools import lru_cache

from fastapi import HTTPException
from supabase import Client, create_client

from .config import settings

SUPABASE_UNAVAILABLE_MESSAGE = (
    "The database service is unavailable because Supabase is not configured."
)


class MissingSupabaseClient:
    configured = False

    def __getattr__(self, _name: str):
        return self

    def __call__(self, *_args, **_kwargs):
        raise HTTPException(status_code=503, detail=SUPABASE_UNAVAILABLE_MESSAGE)

    def __bool__(self) -> bool:
        return False


@lru_cache(maxsize=1)
def get_supabase() -> Client | MissingSupabaseClient:
    supabase_url = settings.SUPABASE_URL
    supabase_key = settings.supabase_key

    if not supabase_url or not supabase_key:
        return MissingSupabaseClient()

    return create_client(supabase_url, supabase_key)


def is_supabase_configured() -> bool:
    return bool(settings.SUPABASE_URL and settings.supabase_key)

