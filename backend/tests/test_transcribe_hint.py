"""Optional names/words hint for transcription (fake AI client; no network)."""

from types import SimpleNamespace

from app import main


def test_hint_is_cleaned_and_capped():
    assert main.clean_transcribe_hint("  Ms. Okafor,\n Nkrumah  ") == "Ms. Okafor, Nkrumah"
    assert main.clean_transcribe_hint("   ") is None
    assert main.clean_transcribe_hint(None) is None
    assert len(main.clean_transcribe_hint("x" * 900)) == main.MAX_TRANSCRIBE_HINT_CHARS


def test_hint_reaches_openai_as_prompt(monkeypatch):
    seen = {}

    def create(**kwargs):
        seen.update(kwargs)
        return SimpleNamespace(text="Ms. Okafor said hello")

    fake = SimpleNamespace(audio=SimpleNamespace(transcriptions=SimpleNamespace(create=create)))
    monkeypatch.setattr(main, "get_ai_client", lambda: fake)
    out = main.transcribe_audio_bytes_with_openai(b"x", "recording.webm", "audio/webm", hint="Ms. Okafor")
    assert out == "Ms. Okafor said hello"
    assert seen["prompt"] == "Ms. Okafor"


def test_no_hint_sends_no_prompt(monkeypatch):
    seen = {}

    def create(**kwargs):
        seen.update(kwargs)
        return SimpleNamespace(text="hello")

    fake = SimpleNamespace(audio=SimpleNamespace(transcriptions=SimpleNamespace(create=create)))
    monkeypatch.setattr(main, "get_ai_client", lambda: fake)
    main.transcribe_audio_bytes_with_openai(b"x", "recording.webm", "audio/webm")
    assert "prompt" not in seen


def test_route_passes_hint_through(client, monkeypatch):
    calls = []

    def fake_transcribe(audio_bytes, filename, content_type, hint=None):
        calls.append(hint)
        return "Ms. Okafor"

    monkeypatch.setattr(main, "transcribe_audio_bytes", fake_transcribe)
    r = client.post(
        "/api/transcribe",
        files={"audio": ("a.webm", b"\x1aE\xdf\xa3" + b"0" * 400, "audio/webm")},
        data={"hint": "  Ms. Okafor  "},
    )
    assert r.status_code == 200, r.text
    assert calls == ["Ms. Okafor"]
