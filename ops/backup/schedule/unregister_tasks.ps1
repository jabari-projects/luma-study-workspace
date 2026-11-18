# Removes the two Luma backup tasks from Windows Task Scheduler (owner only).
# Without -Confirm:$false PowerShell asks before each one.

param([string]$Python = "")

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$ops = Split-Path -Parent $here

foreach ($name in @('LumaBackup-Nightly', 'LumaBackup-Check')) {
    $task = Get-ScheduledTask -TaskPath '\Luma\' -TaskName $name -ErrorAction SilentlyContinue
    if ($task) {
        Unregister-ScheduledTask -TaskPath '\Luma\' -TaskName $name
        Write-Output "Removed $name."
    } else {
        Write-Output "$name was not set up."
    }
}

if (-not $Python) {
    $cmd = Get-Command python -ErrorAction SilentlyContinue
    if ($cmd) { $Python = $cmd.Source }
}
if ($Python) {
    Push-Location $ops
    try { & $Python -B -m luma_backup.check_status --set-interval 0 } finally { Pop-Location }
}
Write-Output "Backups will no longer run on their own. Run backup_run.py --production by hand when you need one."
