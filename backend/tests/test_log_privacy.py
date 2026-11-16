"""Request URLs from the HTTP client must not reach the logs: Supabase query
strings contain email addresses and token digests."""

import logging

from app import main  # noqa: F401  (importing main applies the logging setup)


def test_http_client_request_urls_are_not_logged_at_info():
    for name in ("httpx", "httpcore"):
        logger = logging.getLogger(name)
        assert not logger.isEnabledFor(logging.INFO), name
        assert logger.isEnabledFor(logging.WARNING), name


def test_email_in_query_string_does_not_reach_logs(caplog):
    caplog.set_level(logging.INFO)
    logging.getLogger("httpx").info(
        'HTTP Request: GET https://x.supabase.co/rest/v1/users?email=eq.student%40example.com "HTTP/2 200 OK"'
    )
    assert "student%40example.com" not in caplog.text
