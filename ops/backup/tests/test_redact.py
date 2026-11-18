from __future__ import annotations

import logging

from luma_backup.redact import RedactingFilter, redact, register_secret


def test_patterns_hidden():
    samples = [
        "postgresql://postgres.abcd:hunter2@aws-0-us-east-1.pooler.supabase.com:5432/postgres",
        "key eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.c2lnbmF0dXJlc2ln",
        "sb_secret_AbCdEf123456",
        "Authorization: Bearer abc.def.ghi",
        "PGPASSWORD=supersecret",
        'password: "p4ss"',
        "passphrase=xyz-123",
        "student1@example.test wrote this",
    ]
    for text in samples:
        out = redact(text)
        for secret in ("hunter2", "eyJyb2xl", "AbCdEf123456", "abc.def.ghi", "supersecret", "p4ss", "xyz-123",
                       "student1@example.test"):
            assert secret not in out, (text, out)


def test_registered_secret_hidden_anywhere():
    register_secret("Zq9-very-random-value")
    assert "Zq9-very-random-value" not in redact("error near Zq9-very-random-value in line 3")


def test_short_values_are_not_registered():
    register_secret("ab")
    assert redact("about") == "about"


def test_logging_filter(jtmp):
    logger = logging.getLogger("redact-test")
    logger.handlers.clear()
    path = jtmp / "t.log"
    handler = logging.FileHandler(path, encoding="utf-8")
    handler.addFilter(RedactingFilter())
    logger.addHandler(handler)
    logger.propagate = False
    try:
        raise RuntimeError("password=topsecret")
    except RuntimeError:
        logger.exception("failed for %s", "kid@example.test")
    handler.close()
    text = path.read_text(encoding="utf-8")
    assert "kid@example.test" not in text and "topsecret" not in text and "Traceback" not in text
