"""gpg symmetric encrypt / decrypt / verify (design A.6). The passphrase only ever goes on stdin."""

from __future__ import annotations

import hashlib
import os
import re
import shutil
import subprocess
from pathlib import Path

from .errors import BackupError
from .redact import redact

GIT_GPG = Path("C:/Program Files/Git/usr/bin/gpg.exe")
ENCRYPT_ARGS = ["--symmetric", "--cipher-algo", "AES256", "--s2k-mode", "3", "--s2k-digest-algo", "SHA512",
                "--s2k-count", "65011712", "--compress-algo", "none"]


class CryptoFailure(Exception):
    pass


class Gpg:
    def __init__(self, homedir: Path, exe: str | None = None):
        found = exe or shutil.which("gpg") or (str(GIT_GPG) if GIT_GPG.is_file() else None)
        if not found:
            raise BackupError("tool_missing", "gpg is not installed.")
        self.exe = str(Path(found))
        self.homedir = Path(homedir)
        # Git for Windows ships an MSYS build of gpg. It only treats /x/... as an absolute
        # home folder, so translate J:/... for it. Native builds take Windows paths.
        self.msys = (Path(self.exe).parent / "msys-2.0.dll").is_file()
        self.homedir.mkdir(parents=True, exist_ok=True)
        proc = self._run(["--version"], None)
        m = re.search(r"gpg \(GnuPG\) (\d+)\.(\d+)\.(\d+)", proc.stdout.decode("utf-8", "replace"))
        if not m or (int(m.group(1)), int(m.group(2))) < (2, 4):
            raise BackupError("tool_missing", "gpg must be version 2.4 or newer.")
        self.version = ".".join(m.groups())

    def _home_arg(self) -> str:
        p = str(self.homedir.resolve()).replace("\\", "/")
        if self.msys and re.match(r"^[A-Za-z]:/", p):
            return "/" + p[0].lower() + p[2:]
        return p

    def _env(self) -> dict:
        return {"SYSTEMROOT": os.environ.get("SYSTEMROOT", r"C:\Windows"), "PATH": str(Path(self.exe).parent)}

    def _base(self) -> list[str]:
        return [self.exe, "--homedir", self._home_arg(), "--batch", "--yes", "--no-symkey-cache",
                "--pinentry-mode", "loopback", "--passphrase-fd", "0"]

    def _run(self, args: list[str], passphrase: str | None, timeout: int = 3600) -> subprocess.CompletedProcess:
        cmd = [self.exe, *args] if passphrase is None else [*self._base(), *args]
        data = (passphrase + "\n").encode("utf-8") if passphrase is not None else None
        return subprocess.run(cmd, input=data, capture_output=True, env=self._env(), timeout=timeout,
                              stdin=None if data is not None else subprocess.DEVNULL)

    def encrypt(self, src: Path, dst: Path, passphrase: str) -> None:
        dst.unlink(missing_ok=True)
        proc = self._run([*ENCRYPT_ARGS, "-o", str(dst), str(src)], passphrase)
        if proc.returncode != 0 or not dst.is_file():
            raise CryptoFailure(redact(proc.stderr.decode("utf-8", "replace"))[:500])

    def decrypt_to_file(self, src: Path, dst: Path, passphrase: str) -> None:
        dst.unlink(missing_ok=True)
        proc = self._run(["--decrypt", "-o", str(dst), str(src)], passphrase)
        if proc.returncode != 0 or not dst.is_file():
            dst.unlink(missing_ok=True)
            raise CryptoFailure(redact(proc.stderr.decode("utf-8", "replace"))[:500])

    def decrypt_hash(self, src: Path, passphrase: str, err_dir: Path) -> tuple[int, str]:
        """Decrypt to stdout and hash the stream, so no second plaintext copy is written."""
        err_dir.mkdir(parents=True, exist_ok=True)
        err_path = err_dir / "gpg-verify.err"
        digest = hashlib.sha256()
        size = 0
        with open(err_path, "wb") as err:
            proc = subprocess.Popen([*self._base(), "--decrypt", "-o", "-", str(src)], stdin=subprocess.PIPE,
                                    stdout=subprocess.PIPE, stderr=err, env=self._env())
            try:
                proc.stdin.write((passphrase + "\n").encode("utf-8"))
                proc.stdin.close()
                while chunk := proc.stdout.read(1024 * 256):
                    digest.update(chunk)
                    size += len(chunk)
                rc = proc.wait(timeout=3600)
            finally:
                if proc.poll() is None:
                    proc.kill()
                proc.stdout.close()
        text = err_path.read_text("utf-8", "replace")
        err_path.unlink(missing_ok=True)
        if rc != 0:
            raise CryptoFailure(redact(text)[:500])
        return size, digest.hexdigest()

    def kill_agent(self) -> None:
        gpgconf = Path(self.exe).with_name("gpgconf.exe" if os.name == "nt" else "gpgconf")
        if gpgconf.is_file():
            subprocess.run([str(gpgconf), "--homedir", self._home_arg(), "--kill", "all"], capture_output=True,
                           env=self._env(), timeout=60, stdin=subprocess.DEVNULL)


def sha256_file(path: Path) -> tuple[int, str]:
    digest = hashlib.sha256()
    size = 0
    with open(path, "rb") as fh:
        while chunk := fh.read(1024 * 1024):
            digest.update(chunk)
            size += len(chunk)
    return size, digest.hexdigest()


def looks_like_openpgp(path: Path) -> bool:
    """First byte of an OpenPGP message is a packet tag: bit 7 set. Symmetric sets start with SKESK (tag 3)."""
    with open(path, "rb") as fh:
        first = fh.read(1)
    if not first or not first[0] & 0x80:
        return False
    b = first[0]
    tag = (b & 0x3F) if b & 0x40 else ((b >> 2) & 0x0F)
    return tag == 3
