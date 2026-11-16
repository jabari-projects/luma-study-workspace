"""Tests for reviewer findings M1 (daily limit fails closed), M2 (size cap without
Content-Length) and M3 (AI timeouts shorter than the browser's)."""

from types import SimpleNamespace

from fastapi.testclient import TestClient

from app import main


# ---------------------------------------------------------------- M1


class _BrokenTable:
    def __getattr__(self, name):
        def chain(*args, **kwargs):
            return self

        return chain

    def execute(self):
        raise RuntimeError("database is down")


def test_daily_limit_fails_closed_when_usage_cannot_be_counted(monkeypatch):
    monkeypatch.setattr(main, "supabase", SimpleNamespace(table=lambda name: _BrokenTable()))
    assert main.count_ai_usage_today("user-1", "notes") is None
    assert main.has_free_ai_daily_limit("user-1", "notes") is True


def test_daily_limit_counts_normally(monkeypatch):
    rows = SimpleNamespace(data=[{"id": 1}, {"id": 2}])

    class _Table(_BrokenTable):
        def execute(self):
            return rows

    monkeypatch.setattr(main, "supabase", SimpleNamespace(table=lambda name: _Table()))
    # The per-email ledger (tested in test_account_flow.py) is checked too; keep it neutral here.
    monkeypatch.setattr(main, "_allowance_key_for_user", lambda user_id: "key-1")
    monkeypatch.setattr(main.allowance_ledger, "used", lambda key, usage_type: 0)
    used = main.count_ai_usage_today("user-1", "notes")
    assert used == 2
    assert main.has_free_ai_daily_limit("user-1", "notes") is (2 >= main.settings.FREE_AI_DAILY_LIMIT)


def test_daily_limit_treats_missing_response_as_unknown(monkeypatch):
    class _Table(_BrokenTable):
        def execute(self):
            return None

    monkeypatch.setattr(main, "supabase", SimpleNamespace(table=lambda name: _Table()))
    assert main.has_free_ai_daily_limit("user-1", "transcription") is True


# ---------------------------------------------------------------- M2


def _chunked_body(total_bytes, chunk=1024 * 1024):
    boundary = b"luma-test-boundary"
    head = (
        b"--" + boundary + b"\r\n"
        b'Content-Disposition: form-data; name="audio"; filename="big.webm"\r\n'
        b"Content-Type: audio/webm\r\n\r\n"
    )
    tail = b"\r\n--" + boundary + b"--\r\n"

    def generator():
        yield head
        sent = 0
        while sent < total_bytes:
            size = min(chunk, total_bytes - sent)
            sent += size
            yield b"a" * size
        yield tail

    return boundary, generator()


def test_upload_without_content_length_is_capped(usage_calls, monkeypatch):
    called = []
    monkeypatch.setattr(main, "transcribe_audio_bytes", lambda *a, **k: called.append(1) or "nope")
    boundary, body = _chunked_body(main.MAX_TRANSCRIBE_REQUEST_BYTES + 2 * 1024 * 1024)
    client = TestClient(main.app)
    res = client.post(
        "/api/transcribe",
        content=body,  # a generator: sent chunked, with no Content-Length header
        headers={"content-type": f"multipart/form-data; boundary={boundary.decode()}"},
    )
    assert res.status_code == 413, res.text
    assert res.json() == {"error": main.TRANSCRIBE_TOO_BIG_MESSAGE}
    assert called == []
    assert usage_calls == []


def test_small_chunked_upload_still_works(usage_calls, monkeypatch):
    monkeypatch.setattr(main, "get_openai_api_key", lambda: "sk-test")
    monkeypatch.setattr(
        main,
        "get_ai_client",
        lambda: SimpleNamespace(audio=SimpleNamespace(transcriptions=SimpleNamespace(create=lambda **k: SimpleNamespace(text="hi there")))),
    )
    boundary, body = _chunked_body(4096)
    client = TestClient(main.app)
    res = client.post(
        "/api/transcribe",
        content=body,
        headers={"content-type": f"multipart/form-data; boundary={boundary.decode()}"},
    )
    assert res.status_code == 200, res.text
    assert res.json() == {"transcript": "hi there"}


def test_upload_without_content_length_is_capped_before_login_check(monkeypatch):
    """The middleware alone must stop a huge chunked upload, even for a logged-out caller:
    413 (with CORS headers), and the login check never runs."""
    auth_calls = []
    monkeypatch.setattr(main, "authenticate_ai_request", lambda request: auth_calls.append(1) or None)
    boundary, body = _chunked_body(main.MAX_TRANSCRIBE_REQUEST_BYTES + 2 * 1024 * 1024)
    client = TestClient(main.app)
    res = client.post(
        "/api/transcribe",
        content=body,
        headers={
            "content-type": f"multipart/form-data; boundary={boundary.decode()}",
            "origin": "http://localhost:5173",
        },
    )
    assert res.status_code == 413, res.text
    assert res.headers.get("access-control-allow-origin") == "http://localhost:5173"
    assert auth_calls == []


def test_speech_provider_never_gets_the_students_file_name():
    assert main.build_transcribe_filename("Jabari's biology class 3.m4a", "audio/mp4") == "recording.m4a"
    assert main.build_transcribe_filename("secret.MP3", "audio/mpeg") == "recording.mp3"
    assert main.build_transcribe_filename("blob", "audio/mp4") == "recording.m4a"
    assert main.build_transcribe_filename("", "audio/webm") == "recording.webm"


def test_other_routes_are_not_capped():
    client = TestClient(main.app)
    res = client.get("/health")
    assert res.status_code == 200


# ---------------------------------------------------------------- M3


def test_ai_timeouts_are_shorter_than_the_browser():
    # Browser gives up at 120 s (notes) and 180 s (transcription), see frontend capture-api.ts.
    assert main.AI_REQUEST_TIMEOUT_SECONDS < 120
    assert main.AI_TRANSCRIBE_TIMEOUT_SECONDS < 180


def test_openai_client_uses_short_timeout_and_no_retry(monkeypatch):
    seen = {}

    class _FakeOpenAI:
        def __init__(self, **kwargs):
            seen.update(kwargs)

    monkeypatch.setattr(main, "OpenAI", _FakeOpenAI)
    monkeypatch.setattr(main, "get_openai_api_key", lambda: "sk-test")
    main.get_ai_client()
    assert seen["timeout"] == main.AI_REQUEST_TIMEOUT_SECONDS
    # No automatic retry: one try must end before the browser gives up.
    assert seen["max_retries"] == 0


def test_transcription_passes_its_own_timeout(monkeypatch):
    calls = []

    def create(**kwargs):
        calls.append(kwargs)
        return SimpleNamespace(text="ok words")

    monkeypatch.setattr(
        main, "get_ai_client", lambda: SimpleNamespace(audio=SimpleNamespace(transcriptions=SimpleNamespace(create=create)))
    )
    assert main.transcribe_audio_bytes_with_openai(b"x", "a.webm", "audio/webm") == "ok words"
    assert calls[0]["timeout"] == main.AI_TRANSCRIBE_TIMEOUT_SECONDS
