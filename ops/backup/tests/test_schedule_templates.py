"""The scheduled-task templates are valid and safe, and register_tasks.ps1 registers nothing
without -Register. (No test ever passes -Register.)"""

from __future__ import annotations

import re
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET

import pytest

from conftest import OPS, run_script
from luma_backup import manifest as mf

SCHEDULE = OPS / "schedule"
NS = {"t": "http://schemas.microsoft.com/windows/2004/02/mit/task"}
VALUES = {"__TIME__": "21:30", "__CHECK_TIME__": "10:00", "__PYTHON__": "C:/Python/python.exe",
          "__OPS_DIR__": "J:/x/ops/backup", "__USER__": "PC\\owner", "__DATE__": "2026-11-19"}


def filled(name: str) -> ET.Element:
    text = (SCHEDULE / name).read_text(encoding="utf-8")
    for k, v in VALUES.items():
        text = text.replace(k, v)
    assert not re.search(r"__[A-Z_]+__", text)
    return ET.fromstring(re.sub(r"^<\?xml[^>]*\?>", "", text.strip()))


@pytest.mark.parametrize("name", ["LumaBackup-Nightly.xml", "LumaBackup-Check.xml"])
def test_template_settings(name):
    root = filled(name)
    s = root.find("t:Settings", NS)
    assert s.findtext("t:StartWhenAvailable", namespaces=NS) == "true"
    assert s.findtext("t:WakeToRun", namespaces=NS) == "false"
    assert s.findtext("t:MultipleInstancesPolicy", namespaces=NS) == "IgnoreNew"
    assert s.findtext("t:ExecutionTimeLimit", namespaces=NS) == "PT2H"
    p = root.find("t:Principals/t:Principal", NS)
    assert p.findtext("t:LogonType", namespaces=NS) == "InteractiveToken", "run only when the user is logged on"
    assert root.find(".//t:Password", NS) is None


def test_nightly_runs_production_backup_at_the_approved_time():
    root = filled("LumaBackup-Nightly.xml")
    assert root.findtext(".//t:Exec/t:Arguments", namespaces=NS) == "-B backup_run.py --production"
    assert root.findtext(".//t:CalendarTrigger/t:StartBoundary", namespaces=NS) == "2026-11-19T21:30:00"


def test_check_runs_at_logon_and_daily():
    root = filled("LumaBackup-Check.xml")
    assert root.find(".//t:LogonTrigger", NS) is not None
    assert root.findtext(".//t:CalendarTrigger/t:StartBoundary", namespaces=NS) == "2026-11-19T10:00:00"
    assert "check_status --notify" in root.findtext(".//t:Exec/t:Arguments", namespaces=NS)


@pytest.mark.skipif(sys.platform != "win32" or not shutil.which("powershell"), reason="needs Windows PowerShell")
def test_register_script_only_prints_without_register():
    proc = subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
                           str(SCHEDULE / "register_tasks.ps1"), "-Time", "21:30", "-CheckTime", "10:00",
                           "-Python", sys.executable], capture_output=True, text=True, timeout=120)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "Nothing was registered" in proc.stdout
    assert "Registered" not in proc.stdout


def test_set_interval_records_warning_window(jtmp):
    args = ["--root", str(jtmp)]
    assert run_script("luma_backup.check_status", [*args, "--set-interval", "24"]).returncode == 0
    st = mf.load_status(jtmp / "status.json")
    assert st["expected_interval_hours"] == 24 and st["warn_after_hours"] == 36
    run_script("luma_backup.check_status", [*args, "--set-interval", "0"])
    st = mf.load_status(jtmp / "status.json")
    assert st["expected_interval_hours"] is None and st["warn_after_hours"] is None
