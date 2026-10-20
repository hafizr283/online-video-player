#requires -Version 5.1
<#
  watchdog.ps1 - put the library back on the internet if it stopped.

  go-live.ps1 runs in the foreground: close that window, log off, or let it
  crash, and the public address answers Cloudflare 530 because the tunnel went
  with it. Task Scheduler runs this at logon and every five minutes. While the
  local server answers, it does nothing at all.

  Log: .run\watchdog.log next to this script.
#>
param(
  [int]$Port = 0,
  [int]$WaitSeconds = 45
)

$ErrorActionPreference = "Continue"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

$logDir = Join-Path $here ".run"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir "watchdog.log"

function Write-Log($text) {
  $line = "{0}  {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $text
  Add-Content -Path $log -Value $line -Encoding utf8
  # it is a status line, not an archive - keep the last few hundred entries
  $lines = @(Get-Content $log -ErrorAction SilentlyContinue)
  if ($lines.Count -gt 400) { $lines[-200..-1] | Set-Content -Path $log -Encoding utf8 }
}

# The same storage pointer go-live.ps1 writes, so the run records are found
# even after the folder was moved to another disk.
$storage = Join-Path $here "storage"
$pointer = Join-Path $here ".storage-path"
if (Test-Path $pointer) {
  $remembered = (Get-Content $pointer -Raw).Trim()
  if ($remembered) { $storage = $remembered }
}

if (-not $Port) {
  $Port = 8890
  $pids = Join-Path $storage ".run\pids.json"
  if (Test-Path $pids) {
    try { $Port = [int](Get-Content $pids -Raw | ConvertFrom-Json).port } catch { $Port = 8890 }
  }
}

function Test-Site([int]$p) {
  try {
    # the same endpoint go-live.ps1 itself waits for
    $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 4 "http://127.0.0.1:$p/api/catalogue.json"
    return ($r.StatusCode -eq 200)
  } catch { return $false }
}

if (Test-Site $Port) { exit 0 }

# A start or a stop may be in progress. Giving it a moment means two starts
# never race for the same port and leave a half-open site behind.
$deadline = (Get-Date).AddSeconds($WaitSeconds)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 3
  if (Test-Site $Port) { exit 0 }
}

$listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($listening) {
  # Someone holds the port but does not answer: starting a second server would
  # only fail. Record it so the state is visible instead of silently looping.
  Write-Log "port $Port is held but the site does not answer; left it alone"
  exit 0
}

Write-Log "site on port $Port is down - starting it"

# Started through WMI so the launcher and the server are not children of this
# script: Task Scheduler closes a task's job when the script returns, which would
# take a normal Start-Process child down with it a second later.
$command = 'cmd.exe /c "' + (Join-Path $here "run-site.cmd") + '"'
try {
  $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $command }
  if ($created.ReturnValue -eq 0) { Write-Log "launcher started (pid $($created.ProcessId))" }
  else { Write-Log "launcher could not start: Win32_Process returned $($created.ReturnValue)" }
} catch {
  Write-Log "launcher could not start: $($_.Exception.Message)"
}
exit 0
