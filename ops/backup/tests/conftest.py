"""Shared test setup. Every test folder lives on J: or G:, never C:.

Test sets go to G:/LumaBackups/_test/<run-id>. Clusters, sealed test keys and work folders go to
J:/LumaOps/backup-test/<run-id> and are deleted at the end. Set LUMA_BACKUP_KEEP_TEST=1 to keep
the encrypted synthetic sets under G:/LumaBackups/_test for a look afterwards.
"""

from __future__ import annotations

import os
import secrets
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
OPS = HERE.parent
sys.path.insert(0, str(OPS))

from luma_backup import config  # noqa: E402
from luma_backup.config import Paths, make_stamp, utc_now  # noqa: E402

RUN_ID = f"{make_stamp(utc_now())}-{secrets.token_hex(3)}"
J_BASE = Path("J:/LumaOps/backup-test") / RUN_ID
G_BASE = config.BACKUP_ROOT / "_test" / RUN_ID


def _drives_ok() -> bool:
    return Path("J:/").exists() and Path("G:/").exists()


@pytest.fixture(scope="session")
def j_base():
    if not _drives_ok():
        pytest.skip("drives J: and G: are needed for these tests")
    J_BASE.mkdir(parents=True, exist_ok=True)
    yield J_BASE
    shutil.rmtree(J_BASE, ignore_errors=True)


@pytest.fixture(scope="session")
def g_base():
    if not _drives_ok():
        pytest.skip("drives J: and G: are needed for these tests")
    G_BASE.mkdir(parents=True, exist_ok=True)
    yield G_BASE
    if os.environ.get("LUMA_BACKUP_KEEP_TEST") != "1":
        shutil.rmtree(G_BASE, ignore_errors=True)


@pytest.fixture(scope="session")
def pg_bin():
    if not (config.PG_BIN / "pg_dump.exe").is_file():
        pytest.skip(f"PostgreSQL 17 tools not found at {config.PG_BIN} (pg_dump.exe missing)")
    return config.PG_BIN


@pytest.fixture
def jtmp(j_base, request):
    """A fresh folder on J: for one test."""
    path = j_base / "unit" / f"{request.node.name[:40]}-{secrets.token_hex(2)}"
    path.mkdir(parents=True)
    return path


@dataclass
class Scenario:
    name: str
    paths: Paths

    def args(self) -> list[str]:
        p = self.paths
        return ["--root", str(p.backup_root), "--work-base", str(p.work_base), "--restore-base",
                str(p.restore_base), "--pg-bin", str(p.pg_bin), "--gnupg-home", str(p.gnupg_home),
                "--secrets", str(p.secrets_file)]


def make_scenario(name: str, j: Path, g: Path, pg: Path) -> Scenario:
    return Scenario(name, Paths(backup_root=g / name, work_base=j / name / "backup-work",
                                restore_base=j / name / "restore-work", pg_bin=pg,
                                gnupg_home=j / "gnupg", secrets_file=j / name / "secrets.dpapi"))


def run_script(script: str, args: list[str], timeout: int = 900) -> subprocess.CompletedProcess:
    """Run a command the way the owner would, in its own process, from a folder on J:."""
    if script.startswith("luma_backup."):
        cmd = [sys.executable, "-B", "-m", script, *args]
    else:
        cmd = [sys.executable, "-B", str(OPS / script), *args]
    return subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace",
                          timeout=timeout, cwd=str(OPS))
