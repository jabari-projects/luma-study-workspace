from __future__ import annotations

import sys

import pytest

from luma_backup import dpapi, secrets_store
from luma_backup.config import DPAPI_ENTROPY

pytestmark = pytest.mark.skipif(sys.platform != "win32", reason="DPAPI is Windows only")


def test_round_trip():
    sealed = dpapi.protect(b"hello luma", DPAPI_ENTROPY)
    assert b"hello luma" not in sealed
    assert dpapi.unprotect(sealed, DPAPI_ENTROPY) == b"hello luma"


def test_wrong_entropy_refused():
    sealed = dpapi.protect(b"secret", DPAPI_ENTROPY)
    with pytest.raises(dpapi.DpapiError):
        dpapi.unprotect(sealed, b"some-other-app")


def test_damaged_blob_refused():
    sealed = bytearray(dpapi.protect(b"secret", DPAPI_ENTROPY))
    sealed[-5] ^= 0xFF
    with pytest.raises(dpapi.DpapiError):
        dpapi.unprotect(bytes(sealed), DPAPI_ENTROPY)


def _data():
    return {"db": {"host": "127.0.0.1", "port": 1, "user": "u", "dbname": "d", "password": "pw-xyz-123",
                   "sslmode": "disable"},
            "storage": {"url": "http://127.0.0.1:1", "service_key": "sb_secret_abc"},
            "passphrase": "pass-phrase-1", "passphrase_id": "lb-2026-11-a",
            "old_passphrases": {"lb-2026-10-a": "older-pass"}, "created_at": "2026-11-18T00:00:00Z"}


def test_secrets_file_round_trip(jtmp):
    path = jtmp / "s.dpapi"
    secrets_store.seal(_data(), path)
    raw = path.read_bytes()
    for text in (b"pw-xyz-123", b"sb_secret_abc", b"pass-phrase-1"):
        assert text not in raw
    s = secrets_store.load(path)
    assert s.db["password"] == "pw-xyz-123"
    assert s.passphrase_for("lb-2026-11-a") == "pass-phrase-1"
    assert s.passphrase_for("lb-2026-10-a") == "older-pass"
    with pytest.raises(secrets_store.SecretsUnavailable):
        s.passphrase_for("lb-1999-01-a")
    assert "pw-xyz" not in repr(s) and "pass-phrase" not in str(s)


def test_missing_or_damaged_file(jtmp):
    with pytest.raises(secrets_store.SecretsUnavailable):
        secrets_store.load(jtmp / "nope.dpapi")
    (jtmp / "bad.dpapi").write_bytes(b"not sealed")
    with pytest.raises(secrets_store.SecretsUnavailable) as err:
        secrets_store.load(jtmp / "bad.dpapi")
    assert "not sealed" not in str(err.value)
