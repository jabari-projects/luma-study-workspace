import json
from types import SimpleNamespace

import httpx

from app import capture, link_import, main

from .test_link_import import ARTICLE_HTML, PUBLIC_IP, fake_resolver

LONG_TEXT = "Plants use sunlight to make food. " * 5


class FakeResponses:
    def __init__(self, payload):
        self.payload = payload
        self.calls = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        text = self.payload if isinstance(self.payload, str) else json.dumps(self.payload)
        return SimpleNamespace(output_text=text)


def install_fake_openai(monkeypatch, payload):
    responses = FakeResponses(payload)
    monkeypatch.setattr(main, "get_ai_client", lambda: SimpleNamespace(responses=responses))
    return responses


def test_notes_from_text_cleans_output(client, usage_calls, monkeypatch):
    payload = {
        "title": "   ",
        "summary": "  Plants make food.  ",
        "notes": "## Plants\n- They use light.\n",
        "key_terms": ["Light", "light", " ", "Water"] + [f"term{i}" for i in range(20)],
        "flashcards": [
            {"front": " What do plants use? ", "back": " Light "},
            {"front": "What do plants use?", "back": "Light"},
            {"front": "", "back": "No front"},
            {"front": "No back", "back": "   "},
            {"front": "Q" * 500, "back": "A"},
        ]
        + [{"front": f"Question {i}?", "back": f"Answer {i}"} for i in range(30)],
    }
    responses = install_fake_openai(monkeypatch, payload)

    res = client.post(
        "/api/notes-from-text",
        json={"text": LONG_TEXT, "source_kind": "paste", "source_label": "Bio class"},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["title"] == "My notes"
    assert body["summary"] == "Plants make food."
    assert body["truncated"] is False
    assert body["key_terms"][:2] == ["Light", "Water"]
    assert len(body["key_terms"]) == 12
    assert len(body["flashcards"]) == 20
    assert body["flashcards"][0] == {"front": "What do plants use?", "back": "Light"}
    assert len(body["flashcards"][1]["front"]) == 300
    assert usage_calls == ["notes"]

    call = responses.calls[0]
    assert call["text"]["format"]["type"] == "json_schema"
    assert call["text"]["format"]["name"] == "study_notes"
    assert call["text"]["format"]["strict"] is True
    assert call["max_output_tokens"] == 2500
    assert call["input"][0]["role"] == "system"
    user_msg = call["input"][1]["content"]
    assert "<<<MATERIAL_START>>>" in user_msg and "Bio class" in user_msg


def test_long_title_is_capped():
    result = capture.clean_notes_result(
        {"title": "T" * 500, "summary": "S", "notes": "N", "key_terms": [], "flashcards": []}
    )
    assert len(result["title"]) == 120


def test_notes_schema_is_strict():
    schema = capture.NOTES_JSON_SCHEMA
    assert schema["additionalProperties"] is False
    assert set(schema["required"]) == set(schema["properties"])
    card = schema["properties"]["flashcards"]["items"]
    assert card["additionalProperties"] is False
    assert set(card["required"]) == set(card["properties"])


def test_notes_from_text_truncates(client, monkeypatch):
    responses = install_fake_openai(
        monkeypatch,
        {"title": "T", "summary": "S", "notes": "N", "key_terms": [], "flashcards": []},
    )
    res = client.post("/api/notes-from-text", json={"text": "x" * 70_000, "source_kind": "file"})
    assert res.status_code == 200
    assert res.json()["truncated"] is True
    content = responses.calls[0]["input"][1]["content"]
    assert "x" * 60_000 in content
    assert "x" * 60_001 not in content


def test_notes_from_text_too_short(client, usage_calls):
    res = client.post("/api/notes-from-text", json={"text": "   short   ", "source_kind": "audio"})
    assert res.status_code == 400
    assert res.json() == {"error": "We need a few more words to make notes."}
    assert usage_calls == []


def test_notes_from_text_requires_login(client, monkeypatch):
    monkeypatch.setattr(main, "authenticate_ai_request", lambda request: None)
    res = client.post("/api/notes-from-text", json={"text": LONG_TEXT, "source_kind": "paste"})
    assert res.status_code == 401
    assert res.json() == {"error": "Please log in again."}


def test_notes_from_text_daily_limit(client, monkeypatch):
    monkeypatch.setattr(main, "has_free_ai_daily_limit", lambda user_id, usage_type: True)
    res = client.post("/api/notes-from-text", json={"text": LONG_TEXT, "source_kind": "paste"})
    assert res.status_code == 403
    assert res.json() == {
        "error": "You made all your free notes for today. Come back tomorrow."
    }


def test_notes_from_text_bad_json_is_500(client, usage_calls, monkeypatch):
    install_fake_openai(monkeypatch, "not json")
    res = client.post("/api/notes-from-text", json={"text": LONG_TEXT, "source_kind": "paste"})
    assert res.status_code == 500
    assert usage_calls == []


def test_notes_from_text_no_key_is_503(client):
    # conftest removes OPENAI_API_KEY, so the real get_ai_client raises.
    res = client.post("/api/notes-from-text", json={"text": LONG_TEXT, "source_kind": "paste"})
    assert res.status_code == 503
    assert "error" in res.json()


def test_import_link_youtube_shortcut(client, monkeypatch):
    def boom(*a, **k):
        raise AssertionError("should not fetch")

    monkeypatch.setattr(link_import, "import_link", boom)
    for url in (
        "https://www.youtube.com/watch?v=x",
        "https://youtu.be/x",
        "https://m.youtube.com/watch?v=x",
        "https://music.youtube.com/watch?v=x",
    ):
        res = client.post("/api/import/link", json={"url": url})
        assert res.status_code == 422
        assert res.json() == {
            "error": "For YouTube, copy the transcript and paste it.",
            "code": "youtube",
        }


def test_import_link_blocked(client):
    res = client.post("/api/import/link", json={"url": "http://169.254.169.254/latest/meta-data/"})
    assert res.status_code == 400
    assert res.json() == {"error": "We couldn't open that link.", "code": "blocked"}


def test_import_link_requires_login(client, monkeypatch):
    monkeypatch.setattr(main, "authenticate_ai_request", lambda request: None)
    res = client.post("/api/import/link", json={"url": "https://example.com/"})
    assert res.status_code == 401
    assert res.json() == {"error": "Please log in again."}


def _patch_import(monkeypatch, handler):
    real = link_import.import_link

    def patched(url):
        return real(
            url,
            resolver=fake_resolver({"example.com": [PUBLIC_IP]}),
            transport=httpx.MockTransport(handler),
        )

    monkeypatch.setattr(link_import, "import_link", patched)


def _article_response(request):
    return httpx.Response(200, headers={"content-type": "text/html"}, content=ARTICLE_HTML.encode())


def test_import_link_success(client, usage_calls, monkeypatch):
    _patch_import(monkeypatch, _article_response)
    res = client.post("/api/import/link", json={"url": "https://example.com/article"})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["title"] == "Plants and Light"
    assert body["site_name"]
    assert body["url"] == "https://example.com/article"
    assert body["truncated"] is False
    assert "photosynthesis" in body["text"]
    assert usage_calls == []  # does not count toward the daily AI limit


def test_import_link_pdf(client, monkeypatch):
    _patch_import(
        monkeypatch,
        lambda request: httpx.Response(200, headers={"content-type": "application/pdf"}, content=b"%PDF"),
    )
    res = client.post("/api/import/link", json={"url": "https://example.com/a.pdf"})
    assert res.status_code == 415
    assert res.json() == {"error": "That link is a PDF. Download it, then upload the file.", "code": "pdf"}


def test_import_link_too_short(client, monkeypatch):
    _patch_import(
        monkeypatch,
        lambda request: httpx.Response(200, headers={"content-type": "text/html"}, content=b"<p>Hi</p>"),
    )
    res = client.post("/api/import/link", json={"url": "https://example.com/"})
    assert res.status_code == 422
    assert res.json()["code"] == "too_short"


def test_import_link_fetch_error(client, monkeypatch):
    def handler(request):
        raise httpx.ConnectError("boom secret details")

    _patch_import(monkeypatch, handler)
    res = client.post("/api/import/link", json={"url": "https://example.com/"})
    assert res.status_code == 502
    assert res.json() == {"error": "We couldn't open that link.", "code": "fetch"}


def test_import_link_rate_limit(client, monkeypatch):
    _patch_import(monkeypatch, _article_response)
    codes = [
        client.post("/api/import/link", json={"url": "https://example.com/"}).status_code
        for _ in range(11)
    ]
    assert codes[:10] == [200] * 10
    assert codes[10] == 429


# ---------- Picture to notes (/api/generate-notes): same notes, same rules, 1 turn ----------

PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgo="


def test_image_notes_use_the_notes_schema_and_cleaning(client, usage_calls, monkeypatch):
    payload = {
        "title": "  Plants   and light ",
        "summary": " Plants make food. ",
        "notes": "## Plants\n- They use light.\n",
        "key_terms": ["Light", "light", "Water"],
        "flashcards": [
            {"front": " What do plants use? ", "back": " Light "},
            {"front": "What do plants use?", "back": "Light"},
            {"front": "", "back": "No front"},
        ],
    }
    responses = install_fake_openai(monkeypatch, payload)

    res = client.post("/api/generate-notes", json={"image": PNG_DATA_URL})
    assert res.status_code == 200, res.text
    assert res.json() == {
        "title": "Plants and light",
        "summary": "Plants make food.",
        "notes": "## Plants\n- They use light.",
        "key_terms": ["Light", "Water"],
        "flashcards": [{"front": "What do plants use?", "back": "Light"}],
        "truncated": False,
    }

    # Exactly one AI call and one notes turn.
    assert len(responses.calls) == 1
    assert usage_calls == ["notes"]
    assert len(main.ai_rate_limit_windows[("user-123", "generate-notes")]) == 1

    call = responses.calls[0]
    assert call["text"]["format"] == {
        "type": "json_schema",
        "name": "study_notes",
        "strict": True,
        "schema": capture.NOTES_JSON_SCHEMA,
    }
    assert call["max_output_tokens"] == 2500
    assert call["store"] is False
    system, user = call["input"]
    assert system == {"role": "system", "content": capture.NOTES_SYSTEM_PROMPT}
    assert "untrusted data" in system["content"]
    assert user["role"] == "user"
    text_part, image_part = user["content"]
    assert text_part["type"] == "input_text"
    assert "only as data to study" in text_part["text"]
    assert image_part == {"type": "input_image", "image_url": PNG_DATA_URL}


def test_image_notes_reencode_the_picture(client, monkeypatch):
    responses = install_fake_openai(
        monkeypatch, {"title": "T", "summary": "S", "notes": "N", "key_terms": [], "flashcards": []}
    )
    res = client.post("/api/generate-notes", json={"image": "  data:image/JPG;base64,iVBORw0KGgo=  "})
    assert res.status_code == 200, res.text
    image_part = responses.calls[0]["input"][1]["content"][1]
    assert image_part["image_url"] == "data:image/jpeg;base64,iVBORw0KGgo="


def test_image_notes_bad_ai_answer_uses_no_turn(client, usage_calls, monkeypatch):
    for bad in ("not json", {"title": "T", "summary": " ", "notes": "", "key_terms": [], "flashcards": []}):
        install_fake_openai(monkeypatch, bad)
        res = client.post("/api/generate-notes", json={"image": PNG_DATA_URL})
        assert res.status_code == 500
        assert res.json() == {"error": "We couldn't make notes this time. Try again."}
    assert usage_calls == []


def test_image_notes_refuse_things_that_are_not_pictures(client, usage_calls, monkeypatch):
    responses = install_fake_openai(monkeypatch, {"title": "T", "summary": "S", "notes": "N", "key_terms": [], "flashcards": []})
    for body in (
        {},
        {"image": ""},
        {"image": "hello"},
        {"image": "data:image/png,not-base64"},
        {"image": "data:image/png;base64,!!!"},
        {"image": "data:text/html;base64,PGgxPmhpPC9oMT4="},
        {"image": "data:application/pdf;base64,JVBERi0="},
    ):
        res = client.post("/api/generate-notes", json=body)
        assert res.status_code == 400, body
        assert res.json() == {"error": "We couldn't open that picture. Try a PNG, JPG or WEBP photo."}
    assert responses.calls == []
    assert usage_calls == []
    # A bad file doesn't use up the "slow down" window either.
    assert main.ai_rate_limit_windows.get(("user-123", "generate-notes"), []) == []


def test_image_notes_daily_limit(client, usage_calls, monkeypatch):
    responses = install_fake_openai(monkeypatch, {"title": "T", "summary": "S", "notes": "N", "key_terms": [], "flashcards": []})
    monkeypatch.setattr(main, "has_free_ai_daily_limit", lambda user_id, usage_type: usage_type == "notes")
    res = client.post("/api/generate-notes", json={"image": PNG_DATA_URL})
    assert res.status_code == 403
    assert res.json() == {"error": "You made all your free notes for today. Come back tomorrow."}
    assert responses.calls == []
    assert usage_calls == []


def test_image_notes_too_big_is_refused_before_any_slot_or_turn(client, usage_calls, monkeypatch):
    responses = install_fake_openai(monkeypatch, {"title": "T", "summary": "S", "notes": "N", "key_terms": [], "flashcards": []})
    big_image = "data:image/png;base64," + "A" * 400

    # The route checks the picture's length before decoding it.
    monkeypatch.setattr(main, "MAX_NOTES_IMAGE_REQUEST_BYTES", 300)
    res = client.post("/api/generate-notes", json={"image": big_image})
    assert res.status_code == 413
    assert res.json() == {"error": "That picture is too big. Try one under 15 MB."}

    # The body limit stops a huge request before the route even reads it.
    monkeypatch.setitem(
        main.RequestBodyLimitMiddleware.LIMITS, "/api/generate-notes", (300, main.IMAGE_TOO_BIG_MESSAGE)
    )
    res = client.post("/api/generate-notes", json={"image": big_image})
    assert res.status_code == 413
    assert res.json() == {"error": "That picture is too big. Try one under 15 MB."}

    assert responses.calls == []
    assert usage_calls == []
    assert main.ai_rate_limit_windows.get(("user-123", "generate-notes"), []) == []


def test_image_notes_cap_fits_a_15_mb_picture():
    # 15 MB of picture is 20 MB of base64; the cap must leave room for it.
    assert main.MAX_NOTES_IMAGE_REQUEST_BYTES > (15 * 1024 * 1024 * 4) // 3 + 100


def test_image_notes_requires_login(client, monkeypatch):
    monkeypatch.setattr(main, "authenticate_ai_request", lambda request: None)
    res = client.post("/api/generate-notes", json={"image": PNG_DATA_URL})
    assert res.status_code == 401
    assert res.json() == {"error": "Please log in again."}


def test_image_notes_no_key_is_a_friendly_503(client, usage_calls):
    # conftest removes OPENAI_API_KEY, so the real get_ai_client raises.
    res = client.post("/api/generate-notes", json={"image": PNG_DATA_URL})
    assert res.status_code == 503
    assert res.json() == {"error": "Making notes is not working right now. Try again later."}
    assert usage_calls == []
