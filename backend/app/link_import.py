"""Safe server-side fetching and text extraction for "import from a link".

Security model (SSRF guard):
- Only http/https on ports 80/443, no userinfo, hostname required.
- Numeric-looking hosts (decimal/octal/hex IPv4 shorthands) are refused.
- IP-literal hosts and every address returned by DNS must be globally routable.
- DNS rebinding is prevented by connecting to the validated IP itself: the
  request URL uses the IP literal, the Host header carries the original
  hostname, and for HTTPS the TLS SNI / certificate hostname check uses the
  original hostname via httpcore's ``sni_hostname`` request extension.
- Redirects are followed manually (max 5) and every hop is re-validated.
- Bodies are streamed and capped; only HTML is accepted.

Nothing in this module logs page content or user-provided URLs' contents.
"""

from __future__ import annotations

import ipaddress
import logging
import re
import socket
import ssl
import time
import zlib
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeoutError
from dataclasses import dataclass
from typing import Callable, Optional
from urllib.parse import urljoin, urlsplit, urlunsplit

import certifi
import httpx

logger = logging.getLogger(__name__)

MAX_URL_LENGTH = 2048
MAX_REDIRECTS = 5
MAX_BODY_BYTES = 3 * 1024 * 1024
MAX_TEXT_CHARS = 60_000
MIN_TEXT_CHARS = 200
MAX_TITLE_CHARS = 300
FETCH_TIMEOUT = httpx.Timeout(10.0, connect=5.0)
# Wall-clock budget for one whole import (DNS + every redirect hop + body).
# httpx timeouts are per operation, so a server that drips a few bytes every
# 9 seconds would otherwise hold a worker thread for many minutes.
FETCH_DEADLINE_SECONDS = 20.0
DNS_TIMEOUT_SECONDS = 5.0
# Bounded pool for DNS lookups so a hung getaddrinfo cannot pin request threads.
_DNS_POOL = ThreadPoolExecutor(max_workers=4, thread_name_prefix="link-import-dns")
USER_AGENT = "LumaStudyBot/1.0 (+study notes import)"
ALLOWED_PORTS = {80, 443}
HTML_CONTENT_TYPES = {"text/html", "application/xhtml+xml"}
REDIRECT_STATUSES = {301, 302, 303, 307, 308}
MAX_ADDRESS_ATTEMPTS = 3

YOUTUBE_HOSTS = {
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtu.be",
    "www.youtu.be",
    "youtube-nocookie.com",
    "www.youtube-nocookie.com",
}
# Any subdomain of these is YouTube too (gaming., studio., tv., www.m., ...).
YOUTUBE_DOMAIN_SUFFIXES = ("youtube.com", "youtube-nocookie.com", "youtu.be")

_NUMERIC_HOST_LABEL = re.compile(r"^(0x[0-9a-f]*|[0-9]+)$")
_NAT64_PREFIX = ipaddress.ip_network("64:ff9b::/96")

Resolver = Callable[..., list]


class LinkImportError(Exception):
    """Base error. ``code`` and ``status_code`` map directly to the API response."""

    code = "fetch"
    status_code = 502
    message = "We couldn't open that link."


class BlockedURLError(LinkImportError):
    code = "blocked"
    status_code = 400
    message = "We couldn't open that link."


class FetchFailedError(LinkImportError):
    code = "fetch"
    status_code = 502
    message = "We couldn't open that link."


class PdfLinkError(LinkImportError):
    code = "pdf"
    status_code = 415
    message = "That link is a PDF. Download it, then upload the file."


class UnsupportedTypeError(LinkImportError):
    code = "type"
    status_code = 415
    message = "We can only read web pages."


class TooLittleTextError(LinkImportError):
    code = "too_short"
    status_code = 422
    message = "We couldn't read that page. Copy the words and paste them instead."


@dataclass(frozen=True)
class ValidatedTarget:
    url: str
    scheme: str
    hostname: str
    port: int
    addresses: tuple[str, ...]


@dataclass(frozen=True)
class ImportedPage:
    title: str
    text: str
    site_name: str
    url: str
    truncated: bool


# ---------- URL validation ----------


def is_youtube_url(url: str) -> bool:
    try:
        host = (urlsplit(url.strip()).hostname or "").rstrip(".").lower()
    except ValueError:
        return False
    if host in YOUTUBE_HOSTS:
        return True
    return any(host.endswith("." + suffix) for suffix in YOUTUBE_DOMAIN_SUFFIXES)


def _unwrap_ip(ip: ipaddress._BaseAddress) -> list[ipaddress._BaseAddress]:
    """Return the address plus any IPv4 address embedded in it."""
    found = [ip]
    if isinstance(ip, ipaddress.IPv6Address):
        if ip.ipv4_mapped is not None:
            found.append(ip.ipv4_mapped)
        if ip.sixtofour is not None:
            found.append(ip.sixtofour)
        if ip.teredo is not None:
            found.extend(ip.teredo)
        if ip in _NAT64_PREFIX:
            found.append(ipaddress.IPv4Address(int(ip) & 0xFFFFFFFF))
    return found


def is_public_ip(value: str | ipaddress._BaseAddress) -> bool:
    try:
        ip = value if not isinstance(value, str) else ipaddress.ip_address(value.split("%", 1)[0])
    except ValueError:
        return False

    for candidate in _unwrap_ip(ip):
        if (
            not candidate.is_global
            or candidate.is_private
            or candidate.is_loopback
            or candidate.is_link_local
            or candidate.is_multicast
            or candidate.is_reserved
            or candidate.is_unspecified
        ):
            return False
    return True


def _looks_numeric_host(hostname: str) -> bool:
    labels = hostname.split(".")
    return all(_NUMERIC_HOST_LABEL.match(label) for label in labels if label) and any(labels)


def _resolve(hostname: str, port: int, resolver: Resolver) -> tuple[str, ...]:
    try:
        infos = resolver(hostname, port, type=socket.SOCK_STREAM)
    except (OSError, UnicodeError) as exc:
        raise BlockedURLError() from exc

    addresses: list[str] = []
    for info in infos or []:
        try:
            address = str(info[4][0]).split("%", 1)[0]
        except (IndexError, TypeError):
            raise BlockedURLError()
        # Every resolved address must be public, not just the first one.
        if not is_public_ip(address):
            raise BlockedURLError()
        if address not in addresses:
            addresses.append(address)

    if not addresses:
        raise BlockedURLError()
    return tuple(addresses)


def validate_url(url: str, resolver: Optional[Resolver] = None) -> ValidatedTarget:
    """Validate a URL for fetching. Raises BlockedURLError if it is unsafe."""
    resolver = resolver or socket.getaddrinfo

    if not isinstance(url, str):
        raise BlockedURLError()
    url = url.strip()
    if not url or len(url) > MAX_URL_LENGTH:
        raise BlockedURLError()
    if any(ch.isspace() or ord(ch) < 32 or ch == "\\" for ch in url):
        raise BlockedURLError()

    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError as exc:
        raise BlockedURLError() from exc

    scheme = (parts.scheme or "").lower()
    if scheme not in {"http", "https"}:
        raise BlockedURLError()

    if "@" in parts.netloc or parts.username is not None or parts.password is not None:
        raise BlockedURLError()

    hostname = (parts.hostname or "").rstrip(".").lower()
    if not hostname:
        raise BlockedURLError()

    if port is None:
        port = 443 if scheme == "https" else 80
    if port not in ALLOWED_PORTS:
        raise BlockedURLError()

    try:
        literal = ipaddress.ip_address(hostname.split("%", 1)[0])
    except ValueError:
        literal = None

    if literal is not None:
        if not is_public_ip(literal):
            raise BlockedURLError()
        addresses: tuple[str, ...] = (str(literal),)
    else:
        if ":" in hostname or _looks_numeric_host(hostname):
            raise BlockedURLError()
        try:
            hostname = hostname.encode("idna").decode("ascii")
        except UnicodeError as exc:
            raise BlockedURLError() from exc
        if hostname in {"localhost"} or hostname.endswith(".localhost"):
            raise BlockedURLError()
        addresses = _resolve(hostname, port, resolver)

    netloc = hostname if literal is None else (
        f"[{literal}]" if literal.version == 6 else str(literal)
    )
    if parts.port is not None:
        netloc = f"{netloc}:{port}"
    normalized = urlunsplit((scheme, netloc, parts.path or "/", parts.query, ""))

    return ValidatedTarget(
        url=normalized,
        scheme=scheme,
        hostname=hostname,
        port=port,
        addresses=addresses,
    )


# ---------- Fetching ----------


def build_ssl_context() -> ssl.SSLContext:
    context = ssl.create_default_context(cafile=certifi.where())
    try:
        context.load_default_certs()
    except Exception:  # pragma: no cover - platform specific
        pass
    return context


def _pinned_url(target: ValidatedTarget, address: str) -> str:
    parts = urlsplit(target.url)
    host = f"[{address}]" if ":" in address else address
    netloc = host if parts.port is None else f"{host}:{target.port}"
    return urlunsplit((parts.scheme, netloc, parts.path or "/", parts.query, ""))


def _host_header(target: ValidatedTarget) -> str:
    default_port = 443 if target.scheme == "https" else 80
    host = f"[{target.hostname}]" if ":" in target.hostname else target.hostname
    return host if target.port == default_port else f"{host}:{target.port}"


def send_pinned_request(
    client: httpx.Client,
    target: ValidatedTarget,
    address: str,
) -> httpx.Response:
    """Send a streaming GET to ``address`` while presenting ``target.hostname``.

    The TCP connection goes to the already-validated IP, so a second DNS
    lookup (rebinding) can never redirect us elsewhere. For HTTPS the
    ``sni_hostname`` extension makes httpcore use the real hostname for SNI
    and for certificate hostname verification.
    """
    extensions = {}
    if target.scheme == "https":
        extensions["sni_hostname"] = target.hostname

    request = client.build_request(
        "GET",
        _pinned_url(target, address),
        headers={
            "Host": _host_header(target),
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
            # Ask for uncompressed bodies so the size cap is close to the
            # bytes on the wire (limits decompression-bomb amplification).
            "Accept-Encoding": "identity",
        },
        extensions=extensions,
    )
    return client.send(request, stream=True, follow_redirects=False)


def _media_type(response: httpx.Response) -> str:
    return (response.headers.get("content-type") or "").split(";", 1)[0].strip().lower()


def _check_deadline(deadline: Optional[float]) -> None:
    if deadline is not None and time.monotonic() > deadline:
        logger.info("Link import hit the overall deadline")
        raise FetchFailedError()


class _BoundedDecoder:
    """Decode gzip/deflate without ever inflating more than ``limit`` bytes.

    httpx's own decoders (iter_bytes) inflate a whole chunk at once, so a tiny
    compressed body could balloon to hundreds of MB before any cap is checked.
    We read raw bytes and inflate with ``max_length`` instead.
    """

    def __init__(self, encoding: str, limit: int):
        self.encoding = encoding
        self.limit = limit
        self.total = 0
        self._first = True
        if encoding == "gzip":
            self._obj = zlib.decompressobj(16 + zlib.MAX_WBITS)
        elif encoding == "deflate":
            self._obj = zlib.decompressobj(zlib.MAX_WBITS)
        else:
            self._obj = None

    def _count(self, data: bytes) -> bytes:
        self.total += len(data)
        if self.total > self.limit:
            raise FetchFailedError()
        return data

    def feed(self, chunk: bytes) -> bytes:
        if self._obj is None:
            return self._count(chunk)
        try:
            return self._inflate(chunk)
        except zlib.error:
            # "deflate" is often sent as a raw stream without the zlib header.
            if self.encoding == "deflate" and self._first:
                self._obj = zlib.decompressobj(-zlib.MAX_WBITS)
                try:
                    return self._inflate(chunk)
                except zlib.error as exc:
                    raise FetchFailedError() from exc
            raise FetchFailedError()
        finally:
            self._first = False

    def _inflate(self, data: bytes) -> bytes:
        out: list[bytes] = []
        while data:
            remaining = self.limit - self.total
            piece = self._obj.decompress(data, remaining + 1)
            out.append(self._count(piece))
            data = self._obj.unconsumed_tail
            if self._obj.eof:
                break
        return b"".join(out)

    def flush(self) -> bytes:
        if self._obj is None:
            return b""
        try:
            remaining = self.limit - self.total
            return self._count(self._obj.flush(remaining + 1))
        except zlib.error as exc:
            raise FetchFailedError() from exc


def _content_encoding(response: httpx.Response) -> str:
    """Return '' (identity), 'gzip' or 'deflate'. Anything else is refused."""
    raw = (response.headers.get("content-encoding") or "").strip().lower()
    if raw in {"", "identity"}:
        return ""
    if raw in {"gzip", "x-gzip"}:
        return "gzip"
    if raw == "deflate":
        return "deflate"
    # br, zstd, stacked encodings ("gzip, gzip"), unknown values: we asked for
    # identity, and we will not hand these to an unbounded decoder.
    logger.info("Link import refused content-encoding")
    raise FetchFailedError()


def _read_capped_body(response: httpx.Response, deadline: Optional[float] = None) -> bytes:
    encoding = _content_encoding(response)

    declared = response.headers.get("content-length")
    if declared:
        try:
            declared_size = int(declared)
        except ValueError:
            declared_size = None
        if declared_size is not None and declared_size > MAX_BODY_BYTES:
            raise FetchFailedError()

    if response.is_stream_consumed:
        # Only in-memory responses (e.g. httpx.MockTransport with bytes
        # content) arrive pre-read and already decoded. Network responses are
        # always streamed with stream=True, so they take the bounded path below.
        body = response.content
        if len(body) > MAX_BODY_BYTES:
            raise FetchFailedError()
        _check_deadline(deadline)
        return body

    decoder = _BoundedDecoder(encoding, MAX_BODY_BYTES)
    chunks: list[bytes] = []
    raw_total = 0
    _check_deadline(deadline)
    # iter_raw: bytes exactly as sent, so httpx never decompresses for us.
    for chunk in response.iter_raw():
        _check_deadline(deadline)
        raw_total += len(chunk)
        if raw_total > MAX_BODY_BYTES:
            raise FetchFailedError()
        decoded = decoder.feed(chunk)
        if decoded:
            chunks.append(decoded)
    tail = decoder.flush()
    if tail:
        chunks.append(tail)
    _check_deadline(deadline)
    return b"".join(chunks)


def _resolver_with_timeout(resolver: Resolver, deadline: float) -> Resolver:
    """Run DNS lookups in a small pool so they cannot outlive the deadline."""

    def resolve(*args, **kwargs):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise FetchFailedError()
        future = _DNS_POOL.submit(resolver, *args, **kwargs)
        try:
            return future.result(timeout=min(DNS_TIMEOUT_SECONDS, remaining))
        except FutureTimeoutError as exc:
            future.cancel()
            logger.info("Link import DNS lookup timed out")
            raise FetchFailedError() from exc

    return resolve


@dataclass(frozen=True)
class FetchedPage:
    url: str
    hostname: str
    body: bytes
    charset: Optional[str]


def fetch_html(
    url: str,
    *,
    resolver: Optional[Resolver] = None,
    transport: Optional[httpx.BaseTransport] = None,
) -> FetchedPage:
    deadline = time.monotonic() + FETCH_DEADLINE_SECONDS
    bounded_resolver = _resolver_with_timeout(resolver or socket.getaddrinfo, deadline)
    current_url = url
    for _hop in range(MAX_REDIRECTS + 1):
        _check_deadline(deadline)
        target = validate_url(current_url, resolver=bounded_resolver)
        _check_deadline(deadline)
        remaining = max(0.5, deadline - time.monotonic())
        client_kwargs = {
            "timeout": httpx.Timeout(
                min(10.0, remaining),
                connect=min(5.0, remaining),
            ),
            "follow_redirects": False,
            "trust_env": False,
        }
        if transport is not None:
            client_kwargs["transport"] = transport
        else:
            client_kwargs["verify"] = build_ssl_context()

        # A fresh client per hop: no cookies carried over, and no pooled
        # connection is ever reused with a different SNI/Host.
        with httpx.Client(**client_kwargs) as client:
            response = None
            last_error: Optional[Exception] = None
            for address in target.addresses[:MAX_ADDRESS_ATTEMPTS]:
                _check_deadline(deadline)
                try:
                    response = send_pinned_request(client, target, address)
                    break
                except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
                    last_error = exc
                    continue
                except httpx.InvalidURL as exc:
                    # httpx parses a redirect's Location even with
                    # follow_redirects=False; a malformed one lands here.
                    # InvalidURL is not an httpx.HTTPError.
                    logger.info("Link import got an invalid URL")
                    raise BlockedURLError() from exc
                except httpx.HTTPError as exc:
                    logger.info("Link import request failed: %s", type(exc).__name__)
                    raise FetchFailedError() from exc
            if response is None:
                logger.info(
                    "Link import connect failed: %s",
                    type(last_error).__name__ if last_error else "none",
                )
                raise FetchFailedError() from last_error

            try:
                status = response.status_code
                if status in REDIRECT_STATUSES:
                    location = response.headers.get("location")
                    if not location:
                        raise FetchFailedError()
                    try:
                        current_url = urljoin(target.url, location.strip())
                    except ValueError as exc:
                        raise BlockedURLError() from exc
                    continue

                if status != 200:
                    logger.info("Link import got status=%s", status)
                    raise FetchFailedError()

                media_type = _media_type(response)
                if media_type == "application/pdf":
                    raise PdfLinkError()
                if media_type not in HTML_CONTENT_TYPES:
                    raise UnsupportedTypeError()

                try:
                    body = _read_capped_body(response, deadline)
                except httpx.HTTPError as exc:
                    logger.info("Link import read failed: %s", type(exc).__name__)
                    raise FetchFailedError() from exc

                logger.info("Link import fetched bytes=%s", len(body))
                return FetchedPage(
                    url=target.url,
                    hostname=target.hostname,
                    body=body,
                    charset=response.charset_encoding,
                )
            finally:
                response.close()

    raise FetchFailedError()


# ---------- Extraction ----------


def decode_html(body: bytes, charset: Optional[str]) -> str:
    if charset:
        try:
            return body.decode(charset)
        except (LookupError, UnicodeDecodeError):
            pass
    try:
        return body.decode("utf-8")
    except UnicodeDecodeError:
        pass
    try:
        from charset_normalizer import from_bytes

        best = from_bytes(body).best()
        if best is not None:
            return str(best)
    except Exception:  # pragma: no cover - defensive
        pass
    return body.decode("utf-8", errors="replace")


_TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.IGNORECASE | re.DOTALL)


def _fallback_title(html: str) -> str:
    match = _TITLE_RE.search(html[:200_000])
    if not match:
        return ""
    import html as html_lib

    return " ".join(html_lib.unescape(match.group(1)).split())


def _clean_line(value: Optional[str], limit: int) -> str:
    if not isinstance(value, str):
        return ""
    return " ".join(value.split())[:limit].strip()


def extract_page(html: str, url: str, hostname: str) -> ImportedPage:
    import trafilatura

    text = trafilatura.extract(
        html,
        url=url,
        include_comments=False,
        include_tables=True,
        favor_recall=True,
    ) or ""
    text = text.strip()

    title = ""
    site_name = ""
    try:
        metadata = trafilatura.extract_metadata(html, default_url=url)
    except Exception:
        metadata = None
    if metadata is not None:
        title = _clean_line(getattr(metadata, "title", None), MAX_TITLE_CHARS)
        site_name = _clean_line(getattr(metadata, "sitename", None), MAX_TITLE_CHARS)

    if not title:
        title = _clean_line(_fallback_title(html), MAX_TITLE_CHARS)
    if not site_name:
        site_name = hostname[4:] if hostname.startswith("www.") else hostname

    if len(text) < MIN_TEXT_CHARS:
        raise TooLittleTextError()

    truncated = len(text) > MAX_TEXT_CHARS
    if truncated:
        text = text[:MAX_TEXT_CHARS]

    return ImportedPage(
        title=title or site_name or "Imported page",
        text=text,
        site_name=site_name,
        url=url,
        truncated=truncated,
    )


def import_link(
    url: str,
    *,
    resolver: Optional[Resolver] = None,
    transport: Optional[httpx.BaseTransport] = None,
) -> ImportedPage:
    page = fetch_html(url, resolver=resolver, transport=transport)
    html = decode_html(page.body, page.charset)
    return extract_page(html, page.url, page.hostname)
