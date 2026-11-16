import socket

import httpx
import pytest

from app import link_import as li

PUBLIC_IP = "93.184.215.14"


def fake_resolver(mapping):
    def resolve(host, port, *args, **kwargs):
        if host not in mapping:
            raise socket.gaierror("no such host")
        return [
            (socket.AF_INET6 if ":" in ip else socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, port))
            for ip in mapping[host]
        ]

    return resolve


def no_dns(*args, **kwargs):  # pragma: no cover - must never be called
    raise AssertionError("DNS should not be used for this URL")


@pytest.mark.parametrize(
    "url",
    [
        "http://10.0.0.1/",
        "http://192.168.1.1/",
        "http://172.16.0.1/",
        "http://127.0.0.1/",
        "http://169.254.169.254/latest/meta-data/",
        "http://100.64.0.1/",
        "http://0.0.0.0/",
        "http://224.0.0.1/",
        "http://[::1]/",
        "http://[fc00::1]/",
        "http://[fe80::1]/",
        "http://[::ffff:127.0.0.1]/",
        "http://[::ffff:169.254.169.254]/",
        "http://[64:ff9b::a00:1]/",
        "http://2130706433/",
        "http://0x7f.0.0.1/",
        "http://0177.0.0.1/",
        "http://0x7f000001/",
        "http://127.1/",
        "http://user:pass@example.com/",
        "http://user@example.com/",
        "http://example.com@127.0.0.1/",
        "ftp://example.com/file",
        "file:///etc/passwd",
        "gopher://example.com/",
        "http://example.com:8080/",
        "https://example.com:22/",
        "http:///nohost",
        "http://localhost/",
        "http://foo.localhost/",
        "",
        "not a url",
    ],
)
def test_blocked_urls(url):
    with pytest.raises(li.BlockedURLError):
        li.validate_url(url, resolver=fake_resolver({"example.com": [PUBLIC_IP]}))


def test_hostname_resolving_to_private_ip_is_blocked():
    resolver = fake_resolver({"sneaky.example": ["10.0.0.5"]})
    with pytest.raises(li.BlockedURLError):
        li.validate_url("https://sneaky.example/page", resolver=resolver)


def test_any_private_address_in_dns_answer_blocks():
    resolver = fake_resolver({"mixed.example": [PUBLIC_IP, "127.0.0.1"]})
    with pytest.raises(li.BlockedURLError):
        li.validate_url("https://mixed.example/", resolver=resolver)


def test_ipv6_mapped_private_in_dns_answer_blocks():
    resolver = fake_resolver({"v6.example": ["::ffff:10.0.0.5"]})
    with pytest.raises(li.BlockedURLError):
        li.validate_url("https://v6.example/", resolver=resolver)


def test_unresolvable_host_is_blocked():
    with pytest.raises(li.BlockedURLError):
        li.validate_url("https://nope.example/", resolver=fake_resolver({}))


def test_monkeypatched_getaddrinfo_default_resolver(monkeypatch):
    monkeypatch.setattr(
        li.socket,
        "getaddrinfo",
        lambda host, port, *a, **k: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.0.0.5", port))],
    )
    with pytest.raises(li.BlockedURLError):
        li.validate_url("https://internal.example/")


def test_public_url_is_allowed():
    target = li.validate_url(
        "https://Example.com/a/b?q=1#frag",
        resolver=fake_resolver({"example.com": [PUBLIC_IP]}),
    )
    assert target.hostname == "example.com"
    assert target.port == 443
    assert target.addresses == (PUBLIC_IP,)
    assert target.url == "https://example.com/a/b?q=1"


def test_public_ip_literal_is_allowed_without_dns():
    target = li.validate_url("http://93.184.215.14/", resolver=no_dns)
    assert target.addresses == (PUBLIC_IP,)


def test_youtube_detection():
    assert li.is_youtube_url("https://www.youtube.com/watch?v=abc")
    assert li.is_youtube_url("https://youtu.be/abc")
    assert li.is_youtube_url("https://m.youtube.com/watch?v=abc")
    assert li.is_youtube_url("https://music.youtube.com/watch?v=abc")
    assert not li.is_youtube_url("https://notyoutube.com/")
    assert not li.is_youtube_url("https://youtube.com.evil.example/")


ARTICLE_HTML = (
    "<html><head><title>Plants and Light</title></head><body><article>"
    "<h1>Plants and Light</h1>"
    + "".join(
        f"<p>Paragraph {i}: plants use sunlight, water, and air to make their own food. "
        "This process is called photosynthesis and it happens in the leaves.</p>"
        for i in range(8)
    )
    + "</article></body></html>"
)


def test_fetch_pins_ip_and_sets_host_and_sni():
    seen = []

    def handler(request: httpx.Request):
        seen.append(request)
        return httpx.Response(
            200,
            headers={"content-type": "text/html; charset=utf-8"},
            content=ARTICLE_HTML.encode(),
        )

    page = li.import_link(
        "https://example.com/article",
        resolver=fake_resolver({"example.com": [PUBLIC_IP]}),
        transport=httpx.MockTransport(handler),
    )
    request = seen[0]
    # The connection goes to the validated IP, not the hostname (no second DNS lookup).
    assert request.url.host == PUBLIC_IP
    assert request.headers["host"] == "example.com"
    assert request.extensions.get("sni_hostname") == "example.com"
    assert request.headers["user-agent"] == li.USER_AGENT
    assert "cookie" not in request.headers
    assert page.title == "Plants and Light"
    assert "photosynthesis" in page.text
    assert page.url == "https://example.com/article"
    assert page.truncated is False


def test_redirect_to_private_host_is_revalidated_and_blocked():
    calls = []

    def handler(request: httpx.Request):
        calls.append(str(request.url))
        return httpx.Response(302, headers={"location": "http://internal.example/admin"})

    resolver = fake_resolver({"example.com": [PUBLIC_IP], "internal.example": ["10.0.0.5"]})
    with pytest.raises(li.BlockedURLError):
        li.fetch_html("https://example.com/", resolver=resolver, transport=httpx.MockTransport(handler))
    assert len(calls) == 1


def test_redirect_to_metadata_ip_is_blocked():
    def handler(request: httpx.Request):
        return httpx.Response(301, headers={"location": "http://169.254.169.254/latest"})

    with pytest.raises(li.BlockedURLError):
        li.fetch_html(
            "https://example.com/",
            resolver=fake_resolver({"example.com": [PUBLIC_IP]}),
            transport=httpx.MockTransport(handler),
        )


def test_relative_redirect_is_followed():
    def handler(request: httpx.Request):
        if request.url.path == "/start":
            return httpx.Response(302, headers={"location": "/final"})
        return httpx.Response(200, headers={"content-type": "text/html"}, content=b"<p>hi</p>")

    page = li.fetch_html(
        "https://example.com/start",
        resolver=fake_resolver({"example.com": [PUBLIC_IP]}),
        transport=httpx.MockTransport(handler),
    )
    assert page.url == "https://example.com/final"


def test_too_many_redirects_fails():
    def handler(request: httpx.Request):
        return httpx.Response(302, headers={"location": "/again"})

    with pytest.raises(li.FetchFailedError):
        li.fetch_html(
            "https://example.com/",
            resolver=fake_resolver({"example.com": [PUBLIC_IP]}),
            transport=httpx.MockTransport(handler),
        )


@pytest.mark.parametrize(
    "content_type,error",
    [
        ("application/pdf", li.PdfLinkError),
        ("image/png", li.UnsupportedTypeError),
        ("", li.UnsupportedTypeError),
    ],
)
def test_non_html_types_are_refused(content_type, error):
    def handler(request):
        return httpx.Response(200, headers={"content-type": content_type}, content=b"x")

    with pytest.raises(error):
        li.fetch_html(
            "https://example.com/",
            resolver=fake_resolver({"example.com": [PUBLIC_IP]}),
            transport=httpx.MockTransport(handler),
        )


def test_body_over_cap_is_refused():
    big = b"a" * (li.MAX_BODY_BYTES + 10)

    def handler(request):
        return httpx.Response(200, headers={"content-type": "text/html"}, content=big)

    with pytest.raises(li.FetchFailedError):
        li.fetch_html(
            "https://example.com/",
            resolver=fake_resolver({"example.com": [PUBLIC_IP]}),
            transport=httpx.MockTransport(handler),
        )


def test_non_200_is_fetch_error():
    def handler(request):
        return httpx.Response(404, headers={"content-type": "text/html"}, content=b"nope")

    with pytest.raises(li.FetchFailedError):
        li.fetch_html(
            "https://example.com/",
            resolver=fake_resolver({"example.com": [PUBLIC_IP]}),
            transport=httpx.MockTransport(handler),
        )


def test_short_page_is_too_short():
    with pytest.raises(li.TooLittleTextError):
        li.extract_page(
            "<html><body><p>Hi there.</p></body></html>", "https://example.com/", "example.com"
        )


def test_decode_uses_charset_and_fallback():
    assert li.decode_html("café".encode("latin-1"), "latin-1") == "café"
    assert li.decode_html("café".encode("utf-8"), None) == "café"
