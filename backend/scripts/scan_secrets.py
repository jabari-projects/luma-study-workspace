"""Local, redacted secret scan for Luma. Never prints a secret value.

Usage (from the repository root):
    python backend/scripts/scan_secrets.py            # tracked + staged files
    python backend/scripts/scan_secrets.py --history  # also every commit reachable from any ref

Exit code 1 when something looks like a real credential. Output is "path:line: kind" only.
Runs fully offline: nothing is uploaded anywhere.
"""
from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

PATTERNS: dict[str, re.Pattern[bytes]] = {
    "openai_key": re.compile(rb"sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}"),
    "stripe_secret": re.compile(rb"\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}"),
    "stripe_webhook_secret": re.compile(rb"\bwhsec_[A-Za-z0-9]{16,}"),
    "resend_key": re.compile(rb"\bre_[A-Za-z0-9]{8,}_[A-Za-z0-9]{8,}"),
    "supabase_secret_key": re.compile(rb"\bsb_secret_[A-Za-z0-9_-]{16,}"),
    "supabase_jwt_key": re.compile(rb"\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}"),
    "postgres_url_with_password": re.compile(rb"postgres(?:ql)?://[^:\s/'\"]+:[^@\s'\"<>{}$]{8,}@"),
    "private_key": re.compile(rb"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----"),
    "github_token": re.compile(rb"\bgh[pousr]_[A-Za-z0-9]{30,}"),
    "google_api_key": re.compile(rb"\bAIza[0-9A-Za-z_-]{35}"),
    "deepgram_key_assignment": re.compile(rb"DEEPGRAM_API_KEY\s*[=:]\s*['\"]?[0-9a-f]{32,}"),
}

# Files that must never be committed, whatever their content.
FORBIDDEN_NAMES = re.compile(r"(^|/)\.env($|\.(?!example$)[^/]+$)|\.pem$|\.key$|(^|/)id_(rsa|ed25519)$")

# Test fixtures may hold obviously fake values; they are checked to be fake, not skipped.
FAKE_MARKERS = (b"fake", b"test", b"example", b"dummy", b"placeholder", b"xxxx", b"0000", b"your-")


def _git(*args: str) -> bytes:
    return subprocess.run(["git", *args], capture_output=True, check=True).stdout


def _looks_fake(match: bytes) -> bool:
    low = match.lower()
    return any(marker in low for marker in FAKE_MARKERS)


def scan_bytes(path: str, body: bytes) -> list[str]:
    findings: list[str] = []
    for kind, pattern in PATTERNS.items():
        for m in pattern.finditer(body):
            if _looks_fake(m.group(0)):
                continue
            # supabase anon JWTs are public by design; everything else is a finding
            if kind == "supabase_jwt_key" and _is_anon_jwt(m.group(0)):
                continue
            line = body.count(b"\n", 0, m.start()) + 1
            findings.append(f"{path}:{line}: {kind}")
    return findings


def _is_anon_jwt(token: bytes) -> bool:
    import base64
    import json

    try:
        seg = token.split(b".")[1]
        seg += b"=" * (-len(seg) % 4)
        return json.loads(base64.urlsafe_b64decode(seg)).get("role") == "anon"
    except Exception:
        return False


def scan_worktree() -> list[str]:
    findings: list[str] = []
    files = set(_git("ls-files", "-z").split(b"\0")) | set(_git("diff", "--cached", "--name-only", "-z").split(b"\0"))
    for raw in sorted(f for f in files if f):
        name = raw.decode(errors="replace")
        if FORBIDDEN_NAMES.search(name):
            findings.append(f"{name}:0: forbidden_file_tracked")
        path = Path(name)
        if not path.is_file() or path.stat().st_size > 2_000_000 or name.endswith("package-lock.json"):
            continue
        findings.extend(scan_bytes(name, path.read_bytes()))
    return findings


def scan_history() -> list[str]:
    findings: set[str] = set()
    objs = _git("rev-list", "--objects", "--all").decode(errors="replace").splitlines()
    paths = {o.split(" ", 1)[0]: o.split(" ", 1)[1] for o in objs if " " in o}
    proc = subprocess.run(["git", "cat-file", "--batch"], input=("\n".join(paths) + "\n").encode(), capture_output=True)
    data, pos = proc.stdout, 0
    for oid, name in paths.items():
        nl = data.index(b"\n", pos)
        header = data[pos:nl].split()
        size = int(header[2]) if len(header) == 3 else 0
        body = data[nl + 1 : nl + 1 + size]
        pos = nl + 1 + size + 1
        if header[1:2] != [b"blob"] or size > 2_000_000 or "node_modules/" in name or "site-packages/" in name:
            continue
        if FORBIDDEN_NAMES.search(name):
            findings.add(f"history {name}: forbidden_file_in_history")
        for f in scan_bytes(name, body):
            findings.add("history " + f.rsplit(":", 2)[0] + ": " + f.rsplit(": ", 1)[1])
    return sorted(findings)


def main(argv: list[str]) -> int:
    findings = scan_worktree()
    if "--history" in argv:
        findings += scan_history()
    for f in findings:
        print(f)
    print(f"secret scan: {len(findings)} finding(s)")
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
