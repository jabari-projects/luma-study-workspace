# Sets up the two Luma backup tasks in Windows Task Scheduler.
#
# Without -Register it ONLY prints the plan. Nothing changes.
# Use -Register only after the owner has approved the times and the retention.
#
#   .\register_tasks.ps1 -Time 21:30 -CheckTime 10:00             (shows the plan)
#   .\register_tasks.ps1 -Time 21:30 -CheckTime 10:00 -Register   (owner only, after approval)
#
# Times are this PC's local clock (Central time if the PC is set to Central).
# Both tasks run only while you are logged on, because the saved keys open only for you.
# A run missed because the PC was off happens at the next chance (StartWhenAvailable).

param(
    [Parameter(Mandatory = $true)][ValidatePattern('^([01]\d|2[0-3]):[0-5]\d$')][string]$Time,
    [Parameter(Mandatory = $true)][ValidatePattern('^([01]\d|2[0-3]):[0-5]\d$')][string]$CheckTime,
    [string]$Python = "",
    [ValidateRange(1, 168)][int]$IntervalHours = 24,
    [switch]$Register
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$ops = Split-Path -Parent $here

if (-not $Python) {
    $cmd = Get-Command python -ErrorAction SilentlyContinue
    if ($cmd) { $Python = $cmd.Source }
}
if (-not $Python -or -not (Test-Path -LiteralPath $Python)) {
    throw "Python was not found. Add -Python C:\path\to\python.exe"
}

$values = @{
    '__TIME__'       = $Time
    '__CHECK_TIME__' = $CheckTime
    '__PYTHON__'     = $Python
    '__OPS_DIR__'    = $ops
    '__USER__'       = "$env:USERDOMAIN\$env:USERNAME"
    '__DATE__'       = (Get-Date).ToString('yyyy-MM-dd')
}

function Get-TaskXml([string]$file) {
    $xml = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $here $file)
    foreach ($key in $values.Keys) {
        $xml = $xml.Replace($key, [Security.SecurityElement]::Escape($values[$key]))
    }
    if ($xml -match '__[A-Z_]+__') { throw "A placeholder was not filled in $file" }
    return $xml
}

$tasks = @(
    @{ Name = 'LumaBackup-Nightly'; File = 'LumaBackup-Nightly.xml' },
    @{ Name = 'LumaBackup-Check';   File = 'LumaBackup-Check.xml' }
)
foreach ($t in $tasks) { [void](Get-TaskXml $t.File) }   # fail early if a template is broken

Write-Output "Plan:"
Write-Output "  LumaBackup-Nightly: every day at $Time. Runs backup_run.py --production."
Write-Output "  LumaBackup-Check:   when you log on, and every day at $CheckTime. Runs check_status --notify."
Write-Output "  Both run only while you are logged on. A missed run happens at the next chance."
Write-Output "  Warn when the newest checked backup is older than $([math]::Round($IntervalHours * 1.5)) hours."
Write-Output "  Python: $Python"
Write-Output "  Folder: $ops"

if (-not $Register) {
    Write-Output "Nothing was registered. Add -Register to set this up (only after the owner approves the times)."
    exit 0
}

foreach ($t in $tasks) {
    Register-ScheduledTask -TaskName $t.Name -TaskPath '\Luma\' -Xml (Get-TaskXml $t.File) -Force | Out-Null
    Write-Output "Registered $($t.Name)."
}
Push-Location $ops
try {
    & $Python -B -m luma_backup.check_status --set-interval $IntervalHours
} finally {
    Pop-Location
}
