#requires -Version 5.1
<#
  maintenance.ps1 - the scheduled look-over, and the task list that comes with it.

  Task Scheduler runs this every Sunday morning (task "MovieLinkBD-Maintenance").
  It is a *report*, not an operator: it measures the site, the library, the disks
  and the backups, then writes a dated markdown file whose last section is the
  list of what deserves attention next. Nothing is deleted, moved or restarted.

    -Backup   also run backup.ps1 when the last backup is older than
              $BackupEveryDays. Without the switch a stale backup is only
              reported, because a backup of 5 GB of media is not something to
              start silently.

  Report: <storage>\.run\maintenance\<yyyy-MM-dd>.md
  Log:    <storage>\.run\maintenance.log    one line per run

  Exit code 0 unless the local site is down or the manifest is unreadable.
#>
param(
  [string]$Project = "E:\job_project\movielinkbd-player",
  [switch]$Backup,
  [int]$BackupEveryDays = 7,
  [string]$BackupRoot = "H:\movielinkbd-backups",
  [string]$PublicUrl = "https://movies.hafizr283.me"
)

$ErrorActionPreference = "Continue"
$problems = New-Object System.Collections.ArrayList
$notes = New-Object System.Collections.ArrayList
$tasks = New-Object System.Collections.ArrayList

function Note($text) { [void]$notes.Add($text) }
function Problem($text) { [void]$problems.Add($text); [void]$tasks.Add($text) }
function Task($text) { [void]$tasks.Add($text) }
function Size($bytes) {
  if ($bytes -ge 1GB) { return ("{0:N2} GB" -f ($bytes / 1GB)) }
  if ($bytes -ge 1MB) { return ("{0:N1} MB" -f ($bytes / 1MB)) }
  return ("{0:N0} KB" -f ($bytes / 1KB))
}

# ---- where things are -------------------------------------------------------
$storage = Join-Path $Project "storage"
$pointer = Join-Path $Project ".storage-path"
if (Test-Path $pointer) {
  $remembered = (Get-Content $pointer -Raw).Trim()
  if ($remembered) { $storage = $remembered }
}
$runDir = Join-Path $storage ".run"
$pidsFile = Join-Path $runDir "pids.json"
$reportDir = Join-Path $runDir "maintenance"
New-Item -ItemType Directory -Force -Path $reportDir | Out-Null

$port = 8890
$publicMode = "unknown"
if (Test-Path $pidsFile) {
  try {
    $pids = Get-Content $pidsFile -Raw | ConvertFrom-Json
    if ($pids.port) { $port = [int]$pids.port }
    $publicMode = [string]$pids.mode
  } catch { Problem "pids.json is unreadable - the run records are damaged." }
}

# ---- 1. is the site up ------------------------------------------------------
$siteUp = $false
$catalogueCount = 0
try {
  $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 6 "http://127.0.0.1:$port/api/catalogue.json"
  if ($r.StatusCode -eq 200) {
    $siteUp = $true
    $catalogueCount = (@(($r.Content | ConvertFrom-Json).titles)).Count
  }
} catch { }
if (-not $siteUp) { Problem "The local site on port $port does not answer. The watchdog should restart it; if it stays down, run run-site.cmd." }

$serverPid = 0
$tunnelPid = 0
if (Test-Path $pidsFile) {
  try {
    $pids = Get-Content $pidsFile -Raw | ConvertFrom-Json
    $serverPid = [int]$pids.server
    $tunnelPid = [int]$pids.tunnel
  } catch { }
}
$serverAlive = $false
if ($serverPid) { $serverAlive = [bool](Get-Process -Id $serverPid -ErrorAction SilentlyContinue) }
$tunnelAlive = $false
if ($tunnelPid) { $tunnelAlive = [bool](Get-Process -Id $tunnelPid -ErrorAction SilentlyContinue) }
if ($siteUp -and -not $tunnelAlive) { Problem "The site answers locally but the tunnel process (pid $tunnelPid) is gone, so the public address is down. Restart with stop-live.ps1 then run-site.cmd." }

$publicUp = $false
try {
  $pub = Invoke-WebRequest -UseBasicParsing -TimeoutSec 12 "$PublicUrl/api/catalogue.json"
  $publicUp = ($pub.StatusCode -eq 200)
} catch { }
if (-not $publicUp) {
  if ($tunnelAlive) { Problem "The tunnel process is running but $PublicUrl does not answer." }
  else { Note "Public address not reachable (tunnel down); skipped." }
}

# ---- 2. the library ---------------------------------------------------------
$manifest = Join-Path $storage "library.json"
$titles = 0
$sources = 0
$missing = New-Object System.Collections.ArrayList
$referenced = @{}
if (Test-Path $manifest) {
  try {
    $doc = Get-Content $manifest -Raw -Encoding UTF8 | ConvertFrom-Json
    $list = @($doc.titles)
    $titles = $list.Count
    foreach ($t in $list) {
      foreach ($s in @($t.sources)) {
        if (-not $s -or -not $s.file) { continue }
        $sources++
        $referenced[[string]$s.file] = $true
        if (-not (Test-Path (Join-Path $storage ([string]$s.file)))) {
          [void]$missing.Add("$($t.id) -> $($s.file)")
        }
      }
    }
  } catch {
    Problem "library.json does not parse: $($_.Exception.Message)"
  }
} else {
  Note "No library.json: the site is running on the built-in demo titles."
}
if ($missing.Count -gt 0) {
  Problem ("$($missing.Count) source(s) point at files that are not on disk: " + (($missing | Select-Object -First 5) -join ", "))
}

$mediaFiles = @(Get-ChildItem -Path $storage -File -Filter *.mp4 -ErrorAction SilentlyContinue) +
              @(Get-ChildItem -Path $storage -File -Filter *.mkv -ErrorAction SilentlyContinue) +
              @(Get-ChildItem -Path $storage -File -Filter *.webm -ErrorAction SilentlyContinue)
$mediaBytes = 0
foreach ($f in $mediaFiles) { $mediaBytes += $f.Length }
$orphans = New-Object System.Collections.ArrayList
foreach ($f in $mediaFiles) {
  if (-not $referenced.ContainsKey($f.Name)) { [void]$orphans.Add($f.Name) }
}
if ($orphans.Count -gt 0) {
  Note ("$($orphans.Count) file(s) are not used by any title (kept, as designed): " + (($orphans | Select-Object -First 5) -join ", "))
}
$posterBytes = 0
$posterDir = Join-Path $storage "posters"
if (Test-Path $posterDir) {
  $posterBytes = (Get-ChildItem $posterDir -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
}

# ---- 3. disks ---------------------------------------------------------------
$diskLines = New-Object System.Collections.ArrayList
foreach ($d in (Get-PSDrive -PSProvider FileSystem -ErrorAction SilentlyContinue)) {
  if ($null -eq $d.Free -or $d.Free -le 0) { continue }
  if (-not $d.Used) { continue }
  $freeGb = $d.Free / 1GB
  $line = ("{0}: {1:N2} GB free" -f $d.Name, $freeGb)
  [void]$diskLines.Add($line)
  if ($freeGb -lt 2) {
    Problem ("Drive {0}: has only {1:N2} GB free - conversion and uploads need room." -f $d.Name, $freeGb)
  }
}

# ---- 4. backups -------------------------------------------------------------
$lastBackup = $null
$backupAge = $null
if (Test-Path $backupRoot) {
  $newest = Get-ChildItem $backupRoot -Directory | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($newest) {
    $lastBackup = $newest.Name
    $backupAge = [math]::Round(((Get-Date) - $newest.LastWriteTime).TotalDays, 1)
  }
}
if (-not $lastBackup) {
  Problem "No backup exists under $backupRoot."
} elseif ($backupAge -gt $BackupEveryDays) {
  if ($Backup) {
    Note "Last backup is $backupAge day(s) old; running backup.ps1."
    & (Join-Path $Project "backup.ps1")
    $newest = Get-ChildItem $backupRoot -Directory | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($newest) { $lastBackup = $newest.Name; $backupAge = 0 }
  } else {
    Task "The last backup is $backupAge day(s) old. Run backup.ps1 (or this script with -Backup)."
  }
}

# ---- 5. Blob storage --------------------------------------------------------
$azureEnv = Join-Path $storage ".azure.env"
$azureOn = $false
$azureExpiry = $null
if (Test-Path $azureEnv) {
  foreach ($line in (Get-Content $azureEnv -Encoding UTF8)) {
    $t = $line.Trim()
    if ($t.StartsWith("AZURE_SAS=") -and $t.Length -gt 20) {
      $azureOn = $true
      $m = [regex]::Match($t, "se=([0-9T:Z-]+)")
      if ($m.Success) { $azureExpiry = $m.Groups[1].Value }
    }
  }
}
if ($azureOn -and $azureExpiry) {
  try {
    $when = [datetime]::Parse($azureExpiry).ToUniversalTime()
    $days = [math]::Round(($when - (Get-Date).ToUniversalTime()).TotalDays, 1)
    if ($days -lt 0) { Problem "The Blob SAS expired $([math]::Abs($days)) day(s) ago; publishing is refused until it is replaced." }
    elseif ($days -lt 7) { Task "The Blob SAS expires in $days day(s). Generate a container SAS and paste it into .azure.env." }
  } catch { }
}

# ---- 6. scheduled tasks and repository --------------------------------------
$watchdog = (schtasks /Query /TN "MovieLinkBD-Watchdog" /FO LIST 2>$null | Out-String)
if ($watchdog -match "Disabled") {
  Task "The watchdog task is disabled: if the site stops, nothing brings it back. Enable it with: schtasks /Change /TN `"MovieLinkBD-Watchdog`" /ENABLE"
}
$gitDirty = 0
if (Test-Path (Join-Path $Project ".git")) {
  $status = git -C $Project status --porcelain 2>$null
  $gitDirty = @($status).Count
  if ($gitDirty -gt 0) { Note "$gitDirty file(s) in the project are not committed to git." }
}

# ---- 7. write the report ----------------------------------------------------
$stamp = Get-Date -Format "yyyy-MM-dd"
$report = Join-Path $reportDir "$stamp.md"
$lines = New-Object System.Collections.ArrayList
[void]$lines.Add("# Maintenance - $stamp")
[void]$lines.Add("")
[void]$lines.Add("| | |")
[void]$lines.Add("|---|---|")
[void]$lines.Add("| Local site | $(if ($siteUp) { 'up on port ' + $port } else { '**DOWN**' }) |")
[void]$lines.Add("| Public site | $(if ($publicUp) { 'up' } else { 'not reachable' }) ($publicMode mode) |")
[void]$lines.Add("| Tunnel process | $(if ($tunnelAlive) { 'alive (pid ' + $tunnelPid + ')' } else { 'not running' }) |")
[void]$lines.Add("| Titles / sources | $titles / $sources |")
[void]$lines.Add("| Media | $($mediaFiles.Count) file(s), $(Size $mediaBytes) |")
[void]$lines.Add("| Posters | $(Size $posterBytes) |")
[void]$lines.Add("| Last backup | $(if ($lastBackup) { "$lastBackup ($backupAge day(s) ago)" } else { 'none' }) |")
[void]$lines.Add("| Blob storage | $(if ($azureOn) { 'publishing enabled' } else { 'local only' }) |")
[void]$lines.Add("| Uncommitted files | $gitDirty |")
[void]$lines.Add("")
[void]$lines.Add("## Disks")
foreach ($l in $diskLines) { [void]$lines.Add("- $l") }
if ($problems.Count -gt 0) {
  [void]$lines.Add("")
  [void]$lines.Add("## Needs attention")
  foreach ($p in $problems) { [void]$lines.Add("- $p") }
}
if ($notes.Count -gt 0) {
  [void]$lines.Add("")
  [void]$lines.Add("## Worth knowing")
  foreach ($n in $notes) { [void]$lines.Add("- $n") }
}
[void]$lines.Add("")
[void]$lines.Add("## Next tasks")
if ($tasks.Count -eq 0) {
  [void]$lines.Add("- Nothing outstanding. The library is healthy.")
} else {
  foreach ($t in $tasks) { [void]$lines.Add("- [ ] $t") }
}
[void]$lines.Add("")
[void]$lines.Add("_Written by maintenance.ps1; nothing was changed._")
Set-Content -Path $report -Value ($lines -join "`r`n") -Encoding UTF8

$summary = "{0}  site={1} public={2} titles={3} media={4} problems={5} tasks={6}" -f `
  (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), `
  $(if ($siteUp) { "up" } else { "DOWN" }), `
  $(if ($publicUp) { "up" } else { "down" }), `
  $titles, (Size $mediaBytes), $problems.Count, $tasks.Count
Add-Content -Path (Join-Path $runDir "maintenance.log") -Value $summary -Encoding utf8

Write-Host $summary
Write-Host "report: $report"
if ($problems.Count -gt 0) {
  Write-Host ""
  Write-Host "needs attention:"
  foreach ($p in $problems) { Write-Host "  - $p" }
}

if (-not $siteUp -or ($titles -gt 0 -and $sources -eq 0)) { exit 1 }
exit 0
