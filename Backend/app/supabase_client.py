import os
from functools import lru_cache
from pathlib import Path

from dotenv import load_dotenv
from supabase import Client, create_client

load_dotenv(dotenv_path=Path(__file__).resolve().parents[1] / ".env")


@lru_cache(maxsize=1)
def get_supabase() -> Client:
    supabase_url = os.getenv("SUPABASE_URL")
    supabase_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv(
        "SUPABASE_KEY"
    )

    if not supabase_url or not supabase_key:
        raise RuntimeError("Supabase URL or KEY not set in environment")
    return create_client(supabase_url, supabase_key)
