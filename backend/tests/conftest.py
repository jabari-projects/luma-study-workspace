"""Test setup: safe env vars, no real Supabase/OpenAI/Deepgram/network."""

import os
import sys
from pathlib import Path

# Must run before app.config is imported.
for name in (
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_KEY",
    "OPENAI_API_KEY",
    "OPENAI_ENDPOINT",
    "DEEPGRAM_API_KEY",
    "STRIPE_SECRET_KEY",
    "RESEND_API_KEY",
):
    os.environ.pop(name, None)
os.environ["APP_ENV"] = "test"
os.environ["JWT_SECRET_KEY"] = "test-secret-key-for-pytest-only-0123456789"
os.environ["LOG_LEVEL"] = "WARNING"

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import main  # noqa: E402

FAKE_USER = {
    "id": "user-123",
    "token": "t",
    "subscription_status": "free",
    "email_verified": True,
    "allowance_key": "test-allowance-key",
}


@pytest.fixture
def usage_calls(monkeypatch):
    calls = []
    monkeypatch.setattr(main, "authenticate_ai_request", lambda request: dict(FAKE_USER))
    monkeypatch.setattr(main, "has_free_ai_daily_limit", lambda user_id, usage_type: False)
    monkeypatch.setattr(
        main, "record_ai_usage", lambda user_id, usage_type: calls.append(usage_type)
    )
    main.ai_rate_limit_windows.clear()
    yield calls
    main.ai_rate_limit_windows.clear()


@pytest.fixture
def client(usage_calls):
    return TestClient(main.app)


@pytest.fixture(autouse=True)
def auth_test_defaults(monkeypatch):
    """Account routes: run email jobs inline (deterministic) and reset the
    per-process limiters and in-process signup/AI locks between tests."""
    monkeypatch.setattr(main, "_run_email_job", lambda job, *args: job(*args))
    monkeypatch.setattr(main, "AUTH_NEUTRAL_RESPONSE_SECONDS", 0.0)
    limiters = (
        main.signup_ip_limiter,
        main.verify_code_ip_limiter,
        main.verify_code_email_limiter,
        main.resend_code_ip_limiter,
        main.signup_notice_limiter,
    )
    for limiter in limiters:
        limiter.clear()
    yield
    for limiter in limiters:
        limiter.clear()
