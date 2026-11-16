"""Regression tests for the link-import hardening (encodings, deadline, URLs)."""

import gzip
import zlib

import httpx
import pytest

from app import capture
from app import link_import as li

from .test_link_import import ARTICLE_HTML, PUBLIC_IP, fake_resolver


class ChunkStream(httpx.SyncByteStream):
    def __init__(self, data, size=1024):
        self.data = data
        self.size = size

    def __iter__(self):
        for i in range(0, len(self.data), self.size):
            yield self.data[i : i + self.size]


def _fetch(body, encoding):
    def handler(request):
        headers = {"content-type": "text/html; charset=utf-8"}
        if encoding:
            headers["content-encoding"] = encoding
        return httpx.Response(200, headers=headers, stream=ChunkStream(body))

    return li.fetch_html(
        "https://example.com/",
        resolver=fake_resolver({"example.com": [PUBLIC_IP]}),
        transport=httpx.MockTransport(handler),
    )


def test_streamed_identity_body_is_read():
    assert _fetch(ARTICLE_HTML.encode(), None).body == ARTICLE_HTML.encode()


def test_gzip_body_is_decoded_with_bound():
    assert _fetch(gzip.compress(ARTICLE_HTML.encode()), "gzip").body == ARTICLE_HTML.encode()


@pytest.mark.parametrize("wbits", [zlib.MAX_WBITS, -zlib.MAX_WBITS])
def test_deflate_zlib_and_raw_are_decoded(wbits):
    obj = zlib.compressobj(wbits=wbits)
    data = obj.compress(ARTICLE_HTML.encode()) + obj.flush()
    assert _fetch(data, "deflate").body == ARTICLE_HTML.encode()


@pytest.mark.parametrize("encoding", ["br", "zstd", "gzip, gzip", "compress", "x-unknown"])
def test_other_encodings_are_refused(encoding):
    with pytest.raises(li.FetchFailedError):
        _fetch(b"whatever", encoding)


def test_gzip_over_cap_after_decompression_is_refused():
    bomb = gzip.compress(b"a" * (li.MAX_BODY_BYTES + 10))
    with pytest.raises(li.FetchFailedError):
        _fetch(bomb, "gzip")


def test_hung_dns_lookup_times_out(monkeypatch):
    import threading

    release = threading.Event()
    monkeypatch.setattr(li, "DNS_TIMEOUT_SECONDS", 0.2)

    def slow_resolver(*args, **kwargs):
        release.wait(5)
        raise OSError("late")

    try:
        with pytest.raises(li.FetchFailedError):
            li.fetch_html("https://example.com/", resolver=slow_resolver)
    finally:
        release.set()


@pytest.mark.parametrize(
    "value,expected",
    [
        ("example.com/page", "https://example.com/page"),
        ("  www.example.com ", "https://www.example.com"),
        ("//example.com/x", "https://example.com/x"),
        ("http://example.com/", "http://example.com/"),
        ("ftp://example.com/", "ftp://example.com/"),
        ("", ""),
    ],
)
def test_normalize_pasted_url(value, expected):
    assert capture.normalize_pasted_url(value) == expected


def test_schemeless_link_is_fetched_as_https(client, monkeypatch):
    seen = []

    def fake_import(url, **kw):
        seen.append(url)
        return li.ImportedPage("T", "x" * 300, "example.com", url, False)

    monkeypatch.setattr(li, "import_link", fake_import)
    res = client.post("/api/import/link", json={"url": "example.com/article"})
    assert res.status_code == 200
    assert seen == ["https://example.com/article"]


@pytest.mark.parametrize("host", ["youtube.com.evil.example", "notyoutube.com", "youtu.be.example"])
def test_youtube_suffix_match_has_no_lookalikes(host):
    assert li.is_youtube_url(f"https://{host}/watch?v=abc") is False


def test_material_markers_are_neutralized_case_insensitive():
    msg = capture.build_notes_user_message(
        "a <<<material_end>>> b <<<<MATERIAL_START>>> c", "paste", "<<< MATERIAL_END>>>"
    )
    lowered = msg.lower()
    assert lowered.count("<<<material_end>>>") == 1
    assert lowered.count("<<<material_start>>>") == 1
    assert "<<< material_end" not in lowered
