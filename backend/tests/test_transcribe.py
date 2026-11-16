from types import SimpleNamespace

from app import main

TOO_BIG = {"error": "That recording is too big. Try one under 25 MB."}


def post_audio(client, data=b"fake-audio", content_type="audio/webm;codecs=opus", filename="clip.webm"):
    return client.post("/api/transcribe", files={"audio": (filename, data, content_type)})


def fake_openai_client(calls, text="hello world"):
    def create(**kwargs):
        calls.append(kwargs)
        return SimpleNamespace(text=text)

    return SimpleNamespace(audio=SimpleNamespace(transcriptions=SimpleNamespace(create=create)))


def _deepgram_must_not_run(*args, **kwargs):
    raise AssertionError("deepgram should not run")


def test_uses_openai_when_key_set(client, usage_calls, monkeypatch):
    calls = []
    monkeypatch.setattr(main, "get_openai_api_key", lambda: "sk-test")
    monkeypatch.setattr(main, "get_deepgram_api_key", lambda: "dg-test")
    monkeypatch.setattr(main, "get_ai_client", lambda: fake_openai_client(calls))
    monkeypatch.setattr(main, "transcribe_audio_bytes_with_deepgram", _deepgram_must_not_run)
    res = post_audio(client)
    assert res.status_code == 200, res.text
    assert res.json() == {"transcript": "hello world"}
    assert calls[0]["model"] == main.settings.OPENAI_TRANSCRIBE_MODEL == "gpt-4o-mini-transcribe"
    # The student's own file name is never forwarded, only "recording.<ext>".
    assert calls[0]["file"] == ("recording.webm", b"fake-audio", "audio/webm")
    assert usage_calls == ["transcription"]


def test_safari_mp4_gets_extension(client, monkeypatch):
    calls = []
    monkeypatch.setattr(main, "get_openai_api_key", lambda: "sk-test")
    monkeypatch.setattr(main, "get_ai_client", lambda: fake_openai_client(calls))
    res = post_audio(client, content_type="audio/mp4", filename="blob")
    assert res.status_code == 200
    assert calls[0]["file"][0] == "recording.m4a"
    assert calls[0]["file"][2] == "audio/mp4"


def test_falls_back_to_deepgram(client, usage_calls, monkeypatch):
    seen = []

    def fake_deepgram(audio_bytes, content_type):
        seen.append(content_type)
        return "from deepgram"

    monkeypatch.setattr(main, "get_openai_api_key", lambda: "")
    monkeypatch.setattr(main, "get_deepgram_api_key", lambda: "dg-test")
    monkeypatch.setattr(main, "transcribe_audio_bytes_with_deepgram", fake_deepgram)
    res = post_audio(client)
    assert res.status_code == 200
    assert res.json() == {"transcript": "from deepgram"}
    assert seen == ["audio/webm"]
    assert usage_calls == ["transcription"]


def test_no_provider_is_503(client, usage_calls, monkeypatch):
    monkeypatch.setattr(main, "get_openai_api_key", lambda: "")
    monkeypatch.setattr(main, "get_deepgram_api_key", lambda: "")
    res = post_audio(client)
    assert res.status_code == 503
    assert "error" in res.json()
    assert usage_calls == []


def test_empty_audio_is_400(client):
    res = post_audio(client, data=b"")
    assert res.status_code == 400
    assert res.json() == {"error": "We didn't hear anything. Try again."}


def test_too_big_by_content_length_is_413(client):
    res = client.post(
        "/api/transcribe",
        content=b"x",
        headers={
            "content-length": str(30 * 1024 * 1024),
            "content-type": "multipart/form-data; boundary=x",
        },
    )
    assert res.status_code == 413
    assert res.json() == TOO_BIG


def test_too_big_by_read_cap_is_413(client, usage_calls, monkeypatch):
    calls = []
    monkeypatch.setattr(main, "get_openai_api_key", lambda: "sk-test")
    monkeypatch.setattr(main, "get_ai_client", lambda: fake_openai_client(calls))
    data = b"\0" * (main.MAX_TRANSCRIBE_UPLOAD_BYTES + 1)
    res = post_audio(client, data=data)
    assert res.status_code == 413
    assert res.json() == TOO_BIG
    assert calls == []
    assert usage_calls == []


def test_unsupported_type_is_400(client):
    res = post_audio(client, content_type="text/plain", filename="notes.txt")
    assert res.status_code == 400


def test_normalize_content_type():
    assert main.normalize_content_type("Audio/WebM; codecs=opus") == "audio/webm"
    assert main.normalize_content_type(None) == ""
