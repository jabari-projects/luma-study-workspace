from functools import lru_cache

from supabase import Client, create_client

from .config import settings


@lru_cache(maxsize=1)
def get_supabase() -> Client:
    supabase_url = settings.SUPABASE_URL
    supabase_key = settings.SUPABASE_SERVICE_ROLE_KEY or settings.SUPABASE_KEY

    if not supabase_url or not supabase_key:
        raise RuntimeError("Supabase URL or KEY not set in environment")
    return create_client(supabase_url, supabase_key)
