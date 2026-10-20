#requires -Version 5.1
<#
  setup-domain.ps1 - give the library a permanent address on a domain you own.

  Quick Tunnels hand out a new random https://...trycloudflare.com link on every
  start. A *named* tunnel instead attaches one of your own hostnames (for example
  movies.hafizr283.me) to this PC, permanently and for free.

  Run this once. It does the parts that can be scripted:
    1. finds cloudflared
    2. signs you in to Cloudflare (opens your browser, one time)
    3. creates a named tunnel
    4. points your hostname at that tunnel
    5. writes tunnel.yml next to this script

  What you must do first, in the Cloudflare dashboard:
    - add your domain as a zone            (Add a site -> your domain -> Free plan)
    - copy the two nameservers Cloudflare shows you into your registrar
      (for a .me domain from Namecheap: Domain List -> Manage -> Nameservers ->
       Custom DNS), then wait until Cloudflare says the zone is "Active"

  Then:
    powershell -ExecutionPolicy Bypass -File .\setup-domain.ps1 -Hostname movies.hafizr283.me

  And afterwards, to run the site:
    powershell -ExecutionPolicy Bypass -File .\go-live.ps1 -TunnelConfig .\tunnel.yml

  The tunnel itself runs only while go-live.ps1 runs; if this PC is off, the
  domain answers 1033 ("tunnel not found"). Nothing here costs money.
#>
param(
  [Parameter(Mandatory = $true)]
  [string]$Hostname,

  # Cloudflare-side name for the tunnel. Defaults to the first label of -Hostname.
  [string]$Name = "",

  # Must match what you later pass to go-live.ps1 -Port.
  [int]$Port = 8890,

  [switch]$Force
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

# ---- 1. arguments -------------------------------------------------------------

$Hostname = $Hostname.Trim().ToLowerInvariant()
$Hostname = $Hostname -replace "^https?://", ""
$Hostname = $Hostname.TrimEnd("/")

if ($Hostname -notmatch "^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$") {
  Fail "'$Hostname' does not look like a hostname. Pass just the name, for example: -Hostname movies.hafizr283.me"
}
if ($Hostname.Split(".").Count -eq 2) {
  Say "Note: $Hostname is your root domain. It works, but a subdomain such as" "DarkGray"
  Say "      movies.$Hostname keeps the root free for other things." "DarkGray"
  Write-Host ""
}

if (-not $Name) { $Name = $Hostname.Split(".")[0] }
$Name = ($Name -replace "[^a-z0-9-]", "-")
if ($Name -notmatch "^[a-z0-9]") { $Name = "mlbd-$Name" }

$configPath = Join-Path $here "tunnel.yml"

if ((Test-Path $configPath) -and -not $Force) {
  $existing = [regex]::Match((Get-Content -Path $configPath -Raw), "(?m)^\s*-\s*hostname:\s*([^\s]+)")
  if ($existing.Success -and $existing.Groups[1].Value -ne $Hostname) {
    Fail "tunnel.yml already points at $($existing.Groups[1].Value).`nRun again with -Force to replace it, or keep the existing hostname."
  }
}

# ---- 2. cloudflared -----------------------------------------------------------

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
  Fail "cloudflared was not found. Install it once, then run this again:`n`n    winget install --id Cloudflare.cloudflared`n"
}
Say "cloudflared: $cloudflared" "DarkGray"

# cloudflared logs to stderr even when it succeeds, and this script stops on
# errors - so capturing both streams together would turn an INFO line into a
# fatal error wrapped in PowerShell decoration. Keep stdout, drop the log noise,
# and treat the exit code as the signal.
function Invoke-Cloudflared([string[]]$Arguments) {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $text = (& $cloudflared @Arguments 2>$null | Out-String)
    return @{ text = $text; code = $LASTEXITCODE }
  } finally { $ErrorActionPreference = $previous }
}

# ---- 3. sign in ---------------------------------------------------------------

$certFile = Join-Path $env:USERPROFILE ".cloudflared\cert.pem"
if (-not (Test-Path $certFile)) {
  Write-Host ""
  Say "Cloudflare sign-in" "White"
  Say "A browser window is about to open. Pick the account that holds your domain,"
  Say "then click the domain in the list and press Authorize."
  Write-Host ""
  Read-Host "Press Enter when you are ready"
  & $cloudflared tunnel login
  if (-not (Test-Path $certFile)) {
    Fail "Sign-in did not finish - cloudflared writes $certFile when it does. Run this script again."
  }
} else {
  Say "Already signed in ($certFile)." "DarkGray"
}

# ---- 4. create the tunnel -----------------------------------------------------

Say "Looking for an existing tunnel named '$Name' ..."
$listJson = & $cloudflared tunnel list --output json 2>$null
$tunnelId = $null
if ($LASTEXITCODE -eq 0 -and $listJson) {
  try {
    $list = $listJson | ConvertFrom-Json
    $match = @($list) | Where-Object { $_.name -eq $Name } | Select-Object -First 1
    if ($match) { $tunnelId = $match.id }
  } catch { $tunnelId = $null }
}

if ($tunnelId) {
  Say "Reusing tunnel '$Name' ($tunnelId)." "DarkGray"
} else {
  Say "Creating tunnel '$Name' ..."
  $create = Invoke-Cloudflared @("tunnel", "create", $Name)
  $create.text -split "`r?`n" | Where-Object { $_.Trim() } | ForEach-Object { Write-Host "    $($_.Trim())" -ForegroundColor DarkGray }
  $m = [regex]::Match($create.text, "([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})")
  if ($m.Success) { $tunnelId = $m.Groups[1].Value }

  if (-not $tunnelId) {
    $listJson = & $cloudflared tunnel list --output json 2>$null
    try {
      $match = @($listJson | ConvertFrom-Json) | Where-Object { $_.name -eq $Name } | Select-Object -First 1
      if ($match) { $tunnelId = $match.id }
    } catch { $tunnelId = $null }
  }
  if (-not $tunnelId) { Fail "Could not create or find the tunnel. cloudflared's own message is above." }
}

# ---- 5. point the hostname at the tunnel --------------------------------------

Say "Routing $Hostname to tunnel '$Name' ..."
$route = Invoke-Cloudflared @("tunnel", "route", "dns", $Name, $Hostname)
$route.text -split "`r?`n" | Where-Object { $_.Trim() } | ForEach-Object { Write-Host "    $($_.Trim())" -ForegroundColor DarkGray }

if ($route.code -ne 0) {
  if ($route.text -match "(?i)already exists|already configured") {
    Say "The DNS record already exists - keeping it." "DarkGray"
  } else {
    Write-Host ""
    Say "Cloudflare refused the DNS record." "Yellow"
    Say "That almost always means the domain is not a zone in the account you just"
    Say "signed in to. Add the site in the dashboard, copy the two nameservers into"
    Say "your registrar, wait for the zone to show Active, then run this again."
    Write-Host ""
    exit 1
  }
}

# ---- 6. write the config ------------------------------------------------------

$credentials = Join-Path $env:USERPROFILE ".cloudflared\$tunnelId.json"
if (-not (Test-Path $credentials)) {
  Say "Note: the credentials file was not found at $credentials" "Yellow"
  Say "      Edit tunnel.yml if cloudflared stored it somewhere else." "Yellow"
}

$stamp = (Get-Date).ToString("yyyy-MM-dd HH:mm")
$config = @"
# Written by setup-domain.ps1 on $stamp
# Start the site with:  .\go-live.ps1 -TunnelConfig .\tunnel.yml
tunnel: $tunnelId
credentials-file: $credentials

ingress:
  - hostname: $Hostname
    service: http://127.0.0.1:$Port
  - service: http_status:404
"@ -replace "`r`n", "`n"

[System.IO.File]::WriteAllText($configPath, $config, (New-Object System.Text.UTF8Encoding($false)))

# ---- 7. done ------------------------------------------------------------------

Write-Host ""
Write-Host "============================================================" -ForegroundColor DarkCyan
Write-Host "  Your domain is pointed at this PC" -ForegroundColor White
Write-Host "============================================================" -ForegroundColor DarkCyan
Write-Host ""
Write-Host "  Address        " -NoNewline; Write-Host "https://$Hostname" -ForegroundColor Cyan
Write-Host "  Tunnel         " -NoNewline; Write-Host "$Name ($tunnelId)" -ForegroundColor Gray
Write-Host "  Config         " -NoNewline; Write-Host "tunnel.yml" -ForegroundColor Gray
Write-Host "  Mirror port    " -NoNewline; Write-Host "$Port" -ForegroundColor Gray
Write-Host ""
Say "  Start it now:" "White"
Write-Host ""
Write-Host "    powershell -ExecutionPolicy Bypass -File .\go-live.ps1 -TunnelConfig .\tunnel.yml"
Write-Host ""
Say "  DNS can take a few minutes the first time. If https://$Hostname shows"
Say "  Cloudflare error 1033, the tunnel is simply not running yet - that is what"
Say "  a powered-off PC looks like. Any other error, check tunnel.err.log."
Write-Host ""
Say "  The certificate is free and automatic. Nothing here costs money." "DarkGray"
Write-Host ""
