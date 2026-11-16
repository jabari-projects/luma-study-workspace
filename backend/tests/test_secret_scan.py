"""Guards against committing credentials. Offline; never prints secret values."""
import importlib.util
import os
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("scan_secrets", REPO / "backend" / "scripts" / "scan_secrets.py")
scan_secrets = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scan_secrets)


def test_tracked_files_hold_no_credentials():
    cwd = os.getcwd()
    os.chdir(REPO)
    try:
        findings = scan_secrets.scan_worktree()
    finally:
        os.chdir(cwd)
    assert findings == [], f"possible credentials in tracked files (values hidden): {findings}"


def test_detects_real_looking_values_but_not_fakes():
    real_like = b"OPENAI_API_KEY=sk-proj-" + b"Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv1Wx2" + b"\n"
    assert scan_secrets.scan_bytes("x.py", real_like) == ["x.py:1: openai_key"]
    assert scan_secrets.scan_bytes("x.py", b"key = 'sk-test-fake-key-for-unit-tests-only-000000'") == []
    assert scan_secrets.scan_bytes("x", b"whsec_" + b"Q" * 24) == ["x:1: stripe_webhook_secret"]
    assert scan_secrets.scan_bytes("x", b"postgres://luma:" + b"S3cretPassw0rd" + b"@db.host:5432/x")[0].endswith("postgres_url_with_password")


def test_env_files_are_forbidden_and_ignored():
    for name in ("backend/.env", ".env.local", "frontend/.env.production", "certs/server.pem"):
        assert scan_secrets.FORBIDDEN_NAMES.search(name), name
    assert not scan_secrets.FORBIDDEN_NAMES.search("backend/.env.example")
    for name in ("backend/.env", ".env.local", "frontend/.env"):
        ignored = subprocess.run(["git", "check-ignore", "-q", name], cwd=REPO).returncode == 0
        assert ignored, f"{name} must be git-ignored"
