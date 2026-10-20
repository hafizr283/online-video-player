#requires -Version 5.1
<#
  stop-live.ps1 - stop whatever go-live.ps1 left running.

  Use this if you closed the go-live window with the X instead of pressing
  Ctrl+C. It reads storage\.run\pids.json, stops those two processes, and clears
  the file.

  Each PID is checked against its command line before it is stopped: Windows
  reuses PIDs, and killing a stranger because it inherited a number would be
  worse than leaving a stale process behind.
#>

param(
  [string]$StorageDir = ""
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

# Same resolution as go-live.ps1: -StorageDir, then STORAGE_DIR, then the folder
# go-live remembered in .storage-path, then ./storage.
if (-not $StorageDir) { $StorageDir = $env:STORAGE_DIR }
$pointer = Join-Path $here ".storage-path"
if (-not $StorageDir -and (Test-Path $pointer)) { $StorageDir = (Get-Content $pointer -Raw).Trim() }
if (-not $StorageDir) { $StorageDir = Join-Path $here "storage" }
$StorageDir = [System.IO.Path]::GetFullPath($StorageDir)
$pidFile = Join-Path $StorageDir ".run\pids.json"
if (-not (Test-Path $pidFile)) {
  Write-Host "Nothing is recorded as running."
  exit 0
}

$run = Get-Content $pidFile -Raw | ConvertFrom-Json

$entries = @(
  @{ name = "server"; id = $run.server; pattern = "server\.mjs" },
  @{ name = "tunnel"; id = $run.tunnel; pattern = "cloudflared" }
)

# Optional: additional processes recorded during a switch-over, for example a
# second cloudflared while a new address is warming up. Each one goes through the
# same command-line check, so a recycled PID is still never killed by mistake.
foreach ($extra in @($run.extra)) {
  if (-not $extra -or -not $extra.id) { continue }
  if (-not $extra.pattern) {
    Write-Host "extra process $($extra.id) has no command-line pattern - leaving it alone."
    continue
  }
  $entries += @{ name = $extra.name; id = $extra.id; pattern = $extra.pattern }
}

foreach ($entry in $entries) {
  if (-not $entry.id) { continue }

  $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $($entry.id)" -ErrorAction SilentlyContinue
  if (-not $proc) {
    Write-Host "$($entry.name) ($($entry.id)) is already gone."
    continue
  }

  # A shell wrapper around the real binary still carries the name in its
  # command line, so this accepts both the executable and a .cmd shim.
  if (-not ($proc.CommandLine -match $entry.pattern)) {
    Write-Host "$($entry.name) ($($entry.id)) now belongs to '$($proc.Name)' - leaving it alone."
    continue
  }

  Stop-Process -Id $entry.id -Force -ErrorAction SilentlyContinue
  Write-Host "Stopped $($entry.name) ($($entry.id))."
}

Remove-Item $pidFile -ErrorAction SilentlyContinue

# Otherwise the watchdog would bring the site back within five minutes, which is
# the opposite of what "stop" means. go-live.ps1 turns it on again.
& schtasks /Change /TN "MovieLinkBD-Watchdog" /DISABLE 2>&1 | Out-Null
Write-Host "Watchdog paused - the site stays down until go-live.ps1 runs again."
Write-Host "Done."
