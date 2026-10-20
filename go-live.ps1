#requires -Version 5.1
<#
  go-live.ps1 - start the library and publish it through a Cloudflare Quick Tunnel.

  One command does all of it:
    1. finds a usable Node.js and cloudflared
    2. creates (or reuses) a long random admin token
    3. starts server.mjs in single-origin mirror mode, with the demo titles hidden
    4. starts cloudflared and waits for the public https URL
    5. prints the public site, the local admin, and the token

  By default the tunnel is a Quick Tunnel: free, no account, but the
  https://...trycloudflare.com address is new on every start. Pass -TunnelConfig
  or -TunnelToken to run a *named* tunnel on your own domain instead; the address
  then stays the same forever. .\setup-domain.ps1 creates that tunnel for you.

  The admin stays reachable only from this machine. Upload large files from
  http://127.0.0.1:<port>/admin - Cloudflare's free plan rejects request bodies
  over 100 MB.

  Stop with Ctrl+C, or run .\stop-live.ps1 from another window.

  Examples:
    powershell -ExecutionPolicy Bypass -File .\go-live.ps1
    powershell -ExecutionPolicy Bypass -File .\go-live.ps1 -Port 8900
    powershell -ExecutionPolicy Bypass -File .\go-live.ps1 -KeepSeeds
    powershell -ExecutionPolicy Bypass -File .\go-live.ps1 -AllowedMail you@example.com
    powershell -ExecutionPolicy Bypass -File .\go-live.ps1 -TunnelConfig .\tunnel.yml
    powershell -ExecutionPolicy Bypass -File .\go-live.ps1 -TunnelToken <token> -PublicUrl https://movies.example.com

  -TunnelConfig runs a tunnel defined by a local config file (what
  setup-domain.ps1 writes). -TunnelToken runs a tunnel whose hostname you set in
  the Cloudflare dashboard; add -PublicUrl so the script can verify it.
#>
param(
  [int]$Port = 8890,
  [switch]$KeepSeeds,
  [string[]]$AllowedMail = @(),
  [string]$TunnelToken = "",
  [string]$TunnelConfig = "",
  [string]$PublicUrl = "",
  [string]$Ffmpeg = "",
  [string]$TranscodeDir = "",
  [string]$TranscodeEncoder = "",
  [string]$StorageDir = ""
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

function Say($text, $color = "Gray") { Write-Host $text -ForegroundColor $color }
function Fail($text) {
  Write-Host ""
  Say $text "Red"
  Write-Host ""
  exit 1
}

function New-RandomHex([int]$Bytes) {
  $buf = New-Object byte[] $Bytes
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($buf)
  return -join ($buf | ForEach-Object { $_.ToString("x2") })
}

# ---- 1. tools ---------------------------------------------------------------

$node = $null
$nodeVersion = $null
$candidates = @()
$found = Get-Command node -ErrorAction SilentlyContinue
if ($found) { $candidates += $found.Source }
$candidates += @(
  "E:\Tools\node-v24.18.0-win-x64\node.exe",
  "$env:ProgramFiles\nodejs\node.exe"
)
foreach ($c in ($candidates | Select-Object -Unique)) {
  if (-not (Test-Path $c)) { continue }
  $v = $null
  try { $v = (& $c -p "process.versions.node" 2>$null) } catch { $v = $null }
  if ($v -and ($v -match "^\d+\.") -and [int]($v.Split(".")[0]) -ge 20) {
    $node = $c
    $nodeVersion = $v
    break
  }
}
if (-not $node) {
  Fail "Node.js 20 or newer was not found. Install the LTS build from https://nodejs.org/ and run this again."
}

$cloudflared = $null
$found = Get-Command cloudflared -ErrorAction SilentlyContinue
if ($found) { $cloudflared = $found.Source }
else {
  foreach ($c in @(
    "$env:ProgramFiles\cloudflared\cloudflared.exe",
    "$env:LOCALAPPDATA\Microsoft\WinGet\Links\cloudflared.exe",
    "E:\Tools\cloudflared\cloudflared.exe"
  )) {
    if (Test-Path $c) { $cloudflared = $c; break }
  }
}
if (-not $cloudflared) {
  Write-Host ""
  Say "cloudflared is not installed yet." "Yellow"
  Say "Install it once, then run this script again:"
  Write-Host ""
  Write-Host "    winget install --id Cloudflare.cloudflared"
  Write-Host ""
  Say "No winget? Download it from https://github.com/cloudflare/cloudflared/releases"
  Say "Take cloudflared-windows-amd64.exe, rename it to cloudflared.exe, and put it in E:\Tools\cloudflared\"
  Write-Host ""
  exit 1
}

# ---- 2. port ----------------------------------------------------------------

$inUse = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($inUse) {
  Fail "Port $Port is already in use. If an earlier run is still open, stop it with .\stop-live.ps1, or start with -Port 8900."
}

# ---- 3. tunnel settings -----------------------------------------------------
# Everything is checked here, before anything is started, so a bad argument
# cannot leave a stray server process behind.

$named = [bool]($TunnelToken -or $TunnelConfig)
$public = $null
$cfArgs = @()

if ($TunnelToken) {
  $cfArgs = @("tunnel", "--no-autoupdate", "run", "--token", $TunnelToken)
  if ($PublicUrl) {
    $public = $PublicUrl.Trim()
    if ($public -notmatch "^https?://") { Fail "-PublicUrl must start with http:// or https://" }
    $public = $public.TrimEnd("/")
  }
} elseif ($TunnelConfig) {
  if (-not (Test-Path $TunnelConfig)) {
    Fail "Tunnel config not found: $TunnelConfig`nRun .\setup-domain.ps1 -Hostname <your host> once to create it."
  }
  $TunnelConfig = (Resolve-Path $TunnelConfig).Path
  $cfgText = Get-Content -Path $TunnelConfig -Raw
  if ($cfgText -match "127\.0\.0\.1:(\d+)") {
    $cfgPort = [int]$Matches[1]
    if ($cfgPort -ne $Port) {
      Fail "tunnel.yml points the tunnel at port $cfgPort, but this run uses port $Port.`nStart with -Port $cfgPort, or re-run: .\setup-domain.ps1 -Port $Port"
    }
  } else {
    Fail "tunnel.yml has no 'service: http://127.0.0.1:<port>' line. Run .\setup-domain.ps1 again to rebuild it."
  }
  $hostMatch = [regex]::Match($cfgText, "(?m)^\s*-\s*hostname:\s*([^\s]+)")
  if ($hostMatch.Success) { $public = "https://" + $hostMatch.Groups[1].Value }
  $cfArgs = @("tunnel", "--no-autoupdate", "--config", $TunnelConfig, "run")
} else {
  $cfArgs = @("tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:$Port")
  foreach ($mail in @($AllowedMail)) {
    if ($mail) { $cfArgs += @("--allowed-mail", $mail) }
  }
}

if ($named -and @($AllowedMail).Count) {
  Say "Note: -AllowedMail only applies to quick tunnels. Use Cloudflare Access on the hostname instead." "Yellow"
}

# ---- 4. admin token ---------------------------------------------------------

# Media, the manifest, the admin token and the run records live together, so one
# path covers them. -StorageDir (or STORAGE_DIR) moves them to a roomier disk;
# the choice is remembered in .storage-path so stop-live.ps1 finds the same run
# without being told again.
if (-not $StorageDir) { $StorageDir = $env:STORAGE_DIR }
$storagePointer = Join-Path $here ".storage-path"
if (-not $StorageDir -and (Test-Path $storagePointer)) { $StorageDir = (Get-Content $storagePointer -Raw).Trim() }
if (-not $StorageDir) { $StorageDir = Join-Path $here "storage" }
$StorageDir = [System.IO.Path]::GetFullPath($StorageDir)
New-Item -ItemType Directory -Force -Path $StorageDir | Out-Null
Set-Content -Path $storagePointer -Value $StorageDir -NoNewline -Encoding ascii
$env:STORAGE_DIR = $StorageDir

$tokenFile = Join-Path $StorageDir ".admin-token"
$token = ""
if (Test-Path $tokenFile) { $token = (Get-Content $tokenFile -Raw).Trim() }
if (-not $token -or $token.Length -lt 32) {
  $token = New-RandomHex 24
  Set-Content -Path $tokenFile -Value $token -NoNewline -Encoding ascii
}

# ---- 5. server --------------------------------------------------------------

$runDir = Join-Path $StorageDir ".run"
New-Item -ItemType Directory -Force -Path $runDir | Out-Null
$srvOut = Join-Path $runDir "server.log"
$srvErr = Join-Path $runDir "server.err.log"
$cfOut = Join-Path $runDir "tunnel.log"
$cfErr = Join-Path $runDir "tunnel.err.log"
Remove-Item $srvOut, $srvErr, $cfOut, $cfErr -ErrorAction SilentlyContinue

$env:HOST = "127.0.0.1"
$env:PORT = "$Port"
$env:MIRROR_MODE = "path"
$env:ADMIN_TOKEN = $token
$env:ADMIN_LOCAL_ONLY = "1"
Remove-Item Env:PUBLIC_ORIGIN -ErrorAction SilentlyContinue
Remove-Item Env:DEV_PANEL -ErrorAction SilentlyContinue
# server.mjs ships demo defaults for these two; they are printed in the source,
# so a public site must not use them. Fresh values on every start are enough -
# the tokens they sign are short-lived by design.
$env:GATE_SECRET = New-RandomHex 32
$env:HEALTH_SECRET = New-RandomHex 32
if ($KeepSeeds) { $env:HIDE_SEEDS = "0" } else { $env:HIDE_SEEDS = "1" }

# Conversion is optional: without ffmpeg the admin still reports what a file is,
# it just cannot fix it. Prefer -Ffmpeg, then FFMPEG_PATH, then a portable
# ffmpeg kept in tools\ffmpeg next to this script, then ffmpeg on PATH.
$ffmpegPath = $Ffmpeg
if (-not $ffmpegPath) {
  $portable = Join-Path $here "tools\ffmpeg\bin\ffmpeg.exe"
  if (Test-Path $portable) { $ffmpegPath = $portable }
}
if (-not $ffmpegPath) {
  $onPath = Get-Command ffmpeg.exe -ErrorAction SilentlyContinue
  if ($onPath) { $ffmpegPath = $onPath.Source }
}
if ($ffmpegPath) { $env:FFMPEG_PATH = $ffmpegPath } else { Remove-Item Env:FFMPEG_PATH -ErrorAction SilentlyContinue }
if ($TranscodeDir) { $env:TRANSCODE_DIR = $TranscodeDir } else { Remove-Item Env:TRANSCODE_DIR -ErrorAction SilentlyContinue }
if ($TranscodeEncoder) { $env:TRANSCODE_ENCODER = $TranscodeEncoder } else { Remove-Item Env:TRANSCODE_ENCODER -ErrorAction SilentlyContinue }

# Blob storage is optional. Its signature is a credential, so it lives beside the
# admin token rather than in this script or in the project:
#
#   <storage>\.azure.env     (UTF-8, one setting per line, # starts a comment)
#   AZURE_CONTAINER_URL=https://<account>.blob.core.windows.net/<container>
#   AZURE_SAS=?sv=...&sr=c&sig=...
#   AZURE_ONLY=1            (optional: never stream a film from this PC)
#
# Absent or incomplete, the site simply keeps streaming from this PC; nothing
# fails. The SAS is never printed and never reaches a browser.
$azureEnvFile = Join-Path $StorageDir ".azure.env"
Remove-Item Env:AZURE_CONTAINER_URL -ErrorAction SilentlyContinue
Remove-Item Env:AZURE_SAS -ErrorAction SilentlyContinue
Remove-Item Env:AZURE_ONLY -ErrorAction SilentlyContinue
if (Test-Path $azureEnvFile) {
  foreach ($line in Get-Content $azureEnvFile -Encoding utf8) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith("#")) { continue }
    $split = $trimmed.IndexOf("=")
    if ($split -lt 1) { continue }
    $key = $trimmed.Substring(0, $split).Trim()
    $value = $trimmed.Substring($split + 1).Trim()
    if ($key -ieq "AZURE_CONTAINER_URL" -and $value) { $env:AZURE_CONTAINER_URL = $value }
    elseif ($key -ieq "AZURE_SAS" -and $value) { $env:AZURE_SAS = $value }
    elseif ($key -ieq "AZURE_ONLY" -and $value) { $env:AZURE_ONLY = $value }
  }
}
$azureOnly = $env:AZURE_ONLY -match "^(1|true|yes|on)$"
if ($env:AZURE_CONTAINER_URL -and $env:AZURE_SAS) {
  $where = if ($azureOnly) { "streaming from Blob storage only" } else { "films can be published there" }
  Say "Blob storage: $($env:AZURE_CONTAINER_URL) - $where."
} elseif ($azureOnly) {
  Say "Blob storage: AZURE_ONLY is set but there is no container SAS - nothing can play."
} else {
  Say "Blob storage: not configured - every film streams from this PC."
}

Say "Starting the library on port $Port ..."
$server = Start-Process -FilePath $node -ArgumentList "server.mjs" -WorkingDirectory $here `
  -RedirectStandardOutput $srvOut -RedirectStandardError $srvErr -PassThru -WindowStyle Hidden

$healthy = $false
for ($i = 0; $i -lt 40; $i++) {
  if ($server.HasExited) { break }
  try {
    $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://127.0.0.1:$Port/api/catalogue.json"
    if ($r.StatusCode -eq 200) { $healthy = $true; break }
  } catch { Start-Sleep -Milliseconds 500 }
}
if (-not $healthy) {
  if (-not $server.HasExited) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue }
  Write-Host ""
  Get-Content $srvErr -ErrorAction SilentlyContinue | Select-Object -Last 15
  Get-Content $srvOut -ErrorAction SilentlyContinue | Select-Object -Last 15
  Fail "The server did not start. The log above usually says why."
}

# ---- 6. tunnel --------------------------------------------------------------

if ($named) { Say "Opening your named tunnel ..." } else { Say "Opening a quick tunnel ..." }

$tunnel = Start-Process -FilePath $cloudflared -ArgumentList $cfArgs -WorkingDirectory $here `
  -RedirectStandardOutput $cfOut -RedirectStandardError $cfErr -PassThru -WindowStyle Hidden

if ($named) {
  Start-Sleep -Seconds 3
  if ($tunnel.HasExited) {
    Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
    Write-Host ""
    Get-Content $cfErr -ErrorAction SilentlyContinue | Select-Object -Last 20
    Fail "The tunnel stopped straight away. A wrong token, a missing DNS record for the hostname, or a tunnel that was deleted will do that."
  }
} else {
  for ($i = 0; $i -lt 80; $i++) {
    if ($tunnel.HasExited) { break }
    Start-Sleep -Milliseconds 500
    if (Test-Path $cfErr) {
      $m = Select-String -Path $cfErr -Pattern "https://[a-z0-9-]+\.trycloudflare\.com" -AllMatches -ErrorAction SilentlyContinue
      if ($m -and $m.Matches.Count) { $public = $m.Matches[0].Value; break }
    }
  }

  if (-not $public) {
    if (-not $tunnel.HasExited) { Stop-Process -Id $tunnel.Id -Force -ErrorAction SilentlyContinue }
    Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
    Write-Host ""
    Get-Content $cfErr -ErrorAction SilentlyContinue | Select-Object -Last 20
    Fail "The tunnel did not report a public URL. The log above is cloudflared's own output."
  }
}

# ---- 7. prove the public URL answers before promising it ---------------------

$reachable = $false
if ($public) {
  for ($i = 0; $i -lt 6; $i++) {
    try {
      $probe = Invoke-WebRequest -UseBasicParsing -TimeoutSec 15 "$public/api/catalogue.json"
      if ($probe.StatusCode -eq 200) { $reachable = $true; break }
    } catch { Start-Sleep -Seconds 3 }
  }
}

# ---- 8. banner --------------------------------------------------------------

# The five-minute watchdog (watchdog.ps1) brings the site back after a crash,
# a closed window or a logoff. stop-live.ps1 pauses it, so starting the site is
# what turns it back on.
& schtasks /Change /TN "MovieLinkBD-Watchdog" /ENABLE 2>&1 | Out-Null

@{
  server  = $server.Id
  tunnel  = $tunnel.Id
  url     = $public
  port    = $Port
  mode    = $(if ($named) { "named" } else { "quick" })
  started = (Get-Date).ToString("s")
} | ConvertTo-Json | Set-Content -Path (Join-Path $runDir "pids.json") -Encoding ascii

Write-Host ""
Write-Host "============================================================" -ForegroundColor DarkCyan
Write-Host "  MovieLinkBD is live" -ForegroundColor White
Write-Host "============================================================" -ForegroundColor DarkCyan
Write-Host ""
Write-Host "  Public site    " -NoNewline
if ($public) { Write-Host $public -ForegroundColor Cyan }
else { Write-Host "(the hostname you configured in the Cloudflare dashboard)" -ForegroundColor Cyan }
Write-Host "  Admin (local)  " -NoNewline; Write-Host "http://127.0.0.1:$Port/admin" -ForegroundColor Cyan
Write-Host "  Admin token    " -NoNewline; Write-Host $token -ForegroundColor Yellow
Write-Host "  Storage        " -NoNewline; Write-Host $StorageDir -ForegroundColor Cyan
Write-Host "  Conversion     " -NoNewline
if ($ffmpegPath) {
  $encoderName = if ($TranscodeEncoder) { $TranscodeEncoder } else { "libx264" }
  Write-Host "ffmpeg ($encoderName) - unplayable uploads are converted automatically" -ForegroundColor Green
} else {
  Write-Host "off - no ffmpeg found (uploads are only checked, not converted)" -ForegroundColor Yellow
}
Write-Host ""
if (-not $public) {
  Say "  Open your own https:// link in a browser - the tunnel usually answers within a few seconds." "Yellow"
} elseif ($reachable) { Say "  Public URL answered the library request - it is live." "Green" }
else { Say "  The public URL has not answered yet. It can take a few seconds to come up, or DNS may not have spread." "Yellow" }
Write-Host ""
Say "  Upload videos from the local admin address above, not the public URL."
Say "  Cloudflare's free plan rejects request bodies over 100 MB."
Say "  Closing this window is not a disaster: a five-minute watchdog starts it again."
Say "  To stop the site for good, run .\stop-live.ps1 (it pauses the watchdog)."
Write-Host ""
if ($named) { Say "  Node $nodeVersion - named tunnel (the address stays the same on every start)" "Green" }
else { Say "  Node $nodeVersion - quick tunnel (the public URL changes on every start)" }
Say "  Gate and health signing secrets are new for this run." "DarkGray"
Write-Host ""

try {
  while (-not $server.HasExited -and -not $tunnel.HasExited) {
    Start-Sleep -Seconds 2
  }
  Write-Host ""
  if ($server.HasExited) { Say "The local server stopped." "Yellow" }
  if ($tunnel.HasExited) { Say "The tunnel stopped. The public URL is no longer reachable." "Yellow" }
  Say "Recent server log:"
  Get-Content $srvOut -ErrorAction SilentlyContinue | Select-Object -Last 5
} finally {
  if ($tunnel -and -not $tunnel.HasExited) { Stop-Process -Id $tunnel.Id -Force -ErrorAction SilentlyContinue }
  if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue }
  Remove-Item (Join-Path $runDir "pids.json") -ErrorAction SilentlyContinue
}
