"""Runs the four PGlite migration checkers as part of a normal pytest run, so a migration
that loses or changes rows fails here, not only when someone remembers to run them by hand.

Each checker builds a throwaway in-memory Postgres (PGlite) shaped like the live database,
seeds synthetic rows and applies the migrations. Nothing connects to a real database.

Needs Node.js and PGLITE_DIR: a folder whose node_modules has @electric-sql/pglite 0.5.x
(on the owner's PC: J:/LumaOps/pglite). Without them the test is skipped with that reason.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
CHECKERS = [
    "check_live_migration.mjs",
    "check_feedback_migration.mjs",
    "check_maintenance_migration.mjs",
    "check_student_work_migration.mjs",
]


def _pglite_dir() -> str | None:
    value = os.environ.get("PGLITE_DIR")
    if value and (Path(value) / "node_modules" / "@electric-sql" / "pglite").is_dir():
        return value
    return None


@pytest.mark.parametrize("checker", CHECKERS)
def test_migration_keeps_every_row(checker):
    node = shutil.which("node")
    pglite = _pglite_dir()
    if node is None or pglite is None:
        pytest.skip("Set PGLITE_DIR to a folder with @electric-sql/pglite (e.g. J:/LumaOps/pglite) and install Node.js")
    env = {k: v for k, v in os.environ.items() if k != "MIGRATION_PATH"}
    env["PGLITE_DIR"] = pglite
    proc = subprocess.run([node, str(SCRIPTS / checker)], cwd=str(SCRIPTS.parent.parent), env=env,
                          capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=600)
    assert proc.returncode == 0, f"{checker} failed:\n{proc.stdout[-4000:]}\n{proc.stderr[-2000:]}"
