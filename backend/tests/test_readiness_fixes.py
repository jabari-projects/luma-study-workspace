"""Launch-readiness fixes: true total deadlines on AI calls, the notes-turn precheck
before transcription, and safe picture uploads (random names, real image check, 5 MB)."""

import io
import time
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app import main
from app.deadline import DeadlineExceeded, run_with_deadline

PNG = bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) + b"fake-png-body"
JPEG = bytes([0xFF, 0xD8, 0xFF, 0xE0]) + b"fake-jpeg-body"


# ------------------------------------------------------------ deadlines


def test_run_with_deadline_returns_fast_results():
    assert run_with_deadline(lambda: 42, 1.0) == 42


def test_run_with_deadline_cuts_off_slow_calls():
    started = time.monotonic()
    with pytest.raises(DeadlineExceeded):
        run_with_deadline(lambda: time.sleep(2) or "late", 0.2)
    assert time.monotonic() - started < 1.0


def test_deadlines_fit_inside_the_browser_wait():
    # Browser waits: notes 120 s, transcription 180 s (frontend/src/capture/capture-api.ts).
    assert main.AI_NOTES_DEADLINE_SECONDS < 120
    assert main.AI_TRANSCRIBE_DEADLINE_SECONDS < 180
    assert main.AI_REQUEST_TIMEOUT_SECONDS <= main.AI_NOTES_DEADLINE_SECONDS
    assert main.AI_TRANSCRIBE_TIMEOUT_SECONDS <= main.AI_TRANSCRIBE_DEADLINE_SECONDS


def test_slow_transcription_answers_503_and_does_not_use_a_turn(usage_calls, monkeypatch):
    monkeypatch.setattr(main, "AI_TRANSCRIBE_DEADLINE_SECONDS", 0.2)
    monkeypatch.setattr(main, "get_openai_api_key", lambda: "sk-test")

    def slow_create(**kwargs):
        time.sleep(1.5)
        return SimpleNamespace(text="too late")

    monkeypatch.setattr(
        main, "get_ai_client", lambda: SimpleNamespace(audio=SimpleNamespace(transcriptions=SimpleNamespace(create=slow_create)))
    )
    client = TestClient(main.app)
    res = client.post("/api/transcribe", files={"audio": ("clip.webm", b"audio", "audio/webm")})
    assert res.status_code == 503, res.text
    assert usage_calls == []


def test_slow_notes_answer_503_and_do_not_use_a_turn(usage_calls, monkeypatch):
    monkeypatch.setattr(main, "AI_NOTES_DEADLINE_SECONDS", 0.2)

    def slow_create(**kwargs):
        time.sleep(1.5)
        return SimpleNamespace(output_text="{}")

    monkeypatch.setattr(main, "get_ai_client", lambda: SimpleNamespace(responses=SimpleNamespace(create=slow_create)))
    client = TestClient(main.app)
    res = client.post(
        "/api/notes-from-text",
        json={"text": "Plants make food from sunlight, water and air in their leaves.", "source_kind": "paste"},
    )
    assert res.status_code == 503, res.text
    assert usage_calls == []


def test_deadline_maps_to_friendly_ai_unavailable():
    with pytest.raises(main.AIServiceUnavailableError) as info:
        main.raise_openai_error(DeadlineExceeded("x"))
    assert "too long" in str(info.value)


# ------------------------------------------------------------ notes-turn precheck


def test_transcribe_refuses_when_no_notes_turns_left(usage_calls, monkeypatch):
    monkeypatch.setattr(main, "has_free_ai_daily_limit", lambda user_id, usage_type: usage_type == "notes")
    called = []
    monkeypatch.setattr(main, "transcribe_audio_bytes", lambda *a, **k: called.append(1) or "nope")
    client = TestClient(main.app)
    res = client.post("/api/transcribe", files={"audio": ("clip.webm", b"audio", "audio/webm")})
    assert res.status_code == 403
    assert "saved your talk-to-text turn" in res.json()["error"]
    assert called == [] and usage_calls == []


# ------------------------------------------------------------ picture uploads


class _FakeBucket:
    def __init__(self, store, name):
        self.store, self.name = store, name

    def upload(self, path, content, options):
        self.store.append((self.name, path, len(content), options.get("content-type")))

    def get_public_url(self, path):
        return f"https://example.test/storage/v1/object/public/{self.name}/{path}"

    def remove(self, path):
        self.store.append(("removed", self.name, path))


@pytest.fixture
def picture_client(monkeypatch):
    store = []
    profile = {"user_id": "user-123", "avatar_url": None, "custom_theme_image_url": None}
    monkeypatch.setattr(main, "supabase", SimpleNamespace(storage=SimpleNamespace(from_=lambda name: _FakeBucket(store, name))))
    monkeypatch.setattr(main, "get_profile", lambda user_id: dict(profile))
    monkeypatch.setattr(main, "create_profile", lambda *a, **k: None)
    monkeypatch.setattr(main, "update_profile", lambda user_id, data: {**profile, **data})
    main.app.dependency_overrides[main.get_current_user] = lambda: {"id": "user-123"}
    yield TestClient(main.app), store
    main.app.dependency_overrides.pop(main.get_current_user, None)


def test_avatar_gets_a_random_name_never_the_students(picture_client):
    client, store = picture_client
    res = client.post("/me/avatar", files={"file": ("../../Jabari secret photo.png", io.BytesIO(PNG), "image/png")})
    assert res.status_code == 200, res.text
    bucket, path, size, ctype = store[0]
    assert bucket == "avatars" and path.startswith("user-123/") and path.endswith(".png")
    assert "Jabari" not in path and ".." not in path
    assert ctype == "image/png"
    assert "Jabari" not in res.json()["avatar_url"]


def test_theme_image_type_comes_from_the_bytes_not_the_label(picture_client):
    client, store = picture_client
    res = client.post("/me/theme-image", files={"file": ("pic.png", io.BytesIO(JPEG), "image/png")})
    assert res.status_code == 200, res.text
    _, path, _, ctype = store[0]
    assert path.startswith("themes/user-123/") and path.endswith(".jpg")
    assert ctype == "image/jpeg"


@pytest.mark.parametrize("body", [b"<svg onload=alert(1)>", b"GIF89a....", b""])
def test_non_images_are_refused(picture_client, body):
    client, store = picture_client
    res = client.post("/me/avatar", files={"file": ("x.png", io.BytesIO(body), "image/png")})
    assert res.status_code == 400
    assert store == []


def test_pictures_over_5_mb_are_refused(picture_client):
    client, store = picture_client
    big = PNG + b"a" * (main.MAX_IMAGE_UPLOAD_BYTES + 10)
    res = client.post("/me/avatar", files={"file": ("big.png", io.BytesIO(big), "image/png")})
    assert res.status_code == 413
    assert store == []


# ------------------------------------------------------------ vendor privacy settings sent with each call


def test_notes_from_text_asks_openai_not_to_store(usage_calls, monkeypatch):
    calls = []

    def create(**kwargs):
        calls.append(kwargs)
        return SimpleNamespace(output_text='{"title":"t","summary":"s","notes":"n","key_terms":[],"flashcards":[]}')

    monkeypatch.setattr(main, "get_ai_client", lambda: SimpleNamespace(responses=SimpleNamespace(create=create)))
    client = TestClient(main.app)
    res = client.post("/api/notes-from-text", json={"text": "Plants make food from sunlight and water.", "source_kind": "paste"})
    assert res.status_code == 200, res.text
    assert calls[0]["store"] is False


def test_image_notes_ask_openai_not_to_store(monkeypatch):
    calls = []

    def create(**kwargs):
        calls.append(kwargs)
        return SimpleNamespace(output_text='{"title":"t","summary":"s","notes":"Some notes","key_terms":[],"flashcards":[]}')

    monkeypatch.setattr(main, "get_ai_client", lambda: SimpleNamespace(responses=SimpleNamespace(create=create)))
    png_data_url = "data:image/png;base64,iVBORw0KGgo="
    assert main.generate_notes_with_ai(png_data_url)["notes"] == "Some notes"
    assert calls[0]["store"] is False


def test_deepgram_requests_opt_out_of_model_improvement(monkeypatch):
    seen = {}

    def fake_post(url, **kwargs):
        seen["url"] = url
        return SimpleNamespace(status_code=200, json=lambda: {"results": {"channels": [{"alternatives": [{"transcript": "hello there"}]}]}})

    monkeypatch.setattr(main, "get_deepgram_api_key", lambda: "dg-test")
    monkeypatch.setattr(main.httpx, "post", fake_post)
    assert main.transcribe_audio_bytes_with_deepgram(b"audio", "audio/webm") == "hello there"
    assert "mip_opt_out=true" in seen["url"]


# ------------------------------------------------------------ liveness vs database readiness


def test_health_is_liveness_only_and_ignores_the_database(monkeypatch):
    def broken(*a, **k):
        raise RuntimeError("getaddrinfo failed")

    monkeypatch.setattr(main, "supabase", SimpleNamespace(table=broken))
    res = TestClient(main.app).get("/health")
    assert res.status_code == 200  # process is up, even though the database is not


def test_ready_is_503_when_database_unreachable(monkeypatch):
    def broken(*a, **k):
        raise RuntimeError("[Errno 11001] getaddrinfo failed for secret-project-ref.supabase.co")

    monkeypatch.setattr(main, "is_supabase_configured", lambda: True)
    monkeypatch.setattr(main, "supabase", SimpleNamespace(table=broken))
    res = TestClient(main.app).get("/health/ready")
    assert res.status_code == 503
    assert res.json()["database"] == "unreachable"
    assert "supabase.co" not in res.text and "getaddrinfo" not in res.text


def test_ready_is_503_when_not_configured(monkeypatch):
    monkeypatch.setattr(main, "is_supabase_configured", lambda: False)
    res = TestClient(main.app).get("/health/ready")
    assert res.status_code == 503
    assert res.json()["database"] == "not_configured"


def test_ready_is_503_when_database_hangs(monkeypatch):
    class Slow:
        def __getattr__(self, name):
            return lambda *a, **k: self

        def execute(self):
            time.sleep(1.5)

    monkeypatch.setattr(main, "is_supabase_configured", lambda: True)
    monkeypatch.setattr(main, "DB_READINESS_DEADLINE_SECONDS", 0.2)
    monkeypatch.setattr(main, "supabase", SimpleNamespace(table=lambda name: Slow()))
    res = TestClient(main.app).get("/health/ready")
    assert res.status_code == 503
    assert res.json()["database"] == "timeout"


def test_ready_is_200_when_database_answers(monkeypatch):
    class Ok:
        def __getattr__(self, name):
            return lambda *a, **k: self

        def execute(self):
            return SimpleNamespace(data=[])

    monkeypatch.setattr(main, "is_supabase_configured", lambda: True)
    monkeypatch.setattr(main, "supabase", SimpleNamespace(table=lambda name: Ok()))
    res = TestClient(main.app).get("/health/ready")
    assert res.status_code == 200
    assert res.json()["status"] == "ready"
