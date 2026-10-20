#requires -Version 5.1
<#
  backup.ps1 - one dated backup of the whole MovieLinkBD build.

  Produces, under H:\movielinkbd-backups\<stamp>:
    movielinkbd-code-<stamp>.zip      the program: server, player, admin, docs, analysis
    movielinkbd-storage-<stamp>.zip   the library: library.json, posters, admin token
    SHA256SUMS.txt                    digests for everything written
    RESTORE.md                        how to put it back

  and copies the video files themselves to D:\movielinkbd-backups\<stamp>\media
  so the films are on a different disk from the originals.
#>
param(
  [string]$Project = "E:\job_project\movielinkbd-player",
  [string]$Storage = "H:\movielinkbd-storage",
  [string]$MetaRoot = "H:\movielinkbd-backups",
  [string]$MediaRoot = "D:\movielinkbd-backups"
)

$ErrorActionPreference = "Stop"
$stamp = Get-Date -Format "yyyy-MM-dd_HHmm"
$codeDir = Join-Path $MetaRoot $stamp
$mediaDir = Join-Path $MediaRoot (Join-Path $stamp "media")
New-Item -ItemType Directory -Force -Path $codeDir, $mediaDir | Out-Null

Write-Host "backup $stamp"
Write-Host "  code  -> $codeDir"
Write-Host "  media -> $mediaDir"

# ---- 1. the program, minus the videos and the run-time scratch -------------
$skip = @("storage", "node_modules", ".git", ".run", ".cache", "dist", ".transcode")
$items = Get-ChildItem -Path $Project -Force | Where-Object { $skip -notcontains $_.Name }
$codeZip = Join-Path $codeDir "movielinkbd-code-$stamp.zip"
Compress-Archive -Path $items.FullName -DestinationPath $codeZip -CompressionLevel Optimal -Force
Write-Host ("  code  : {0:N1} MB" -f ((Get-Item $codeZip).Length / 1MB))

# ---- 2. the library document and its artwork ------------------------------
$meta = @()
foreach ($name in @("library.json", "library.json.example", ".admin-token")) {
  $p = Join-Path $Storage $name
  if (Test-Path $p) { $meta += $p }
}
foreach ($name in @(".storage-path")) {
  $p = Join-Path $Project $name
  if (Test-Path $p) { $meta += $p }
}
$posters = Join-Path $Storage "posters"
$storageZip = Join-Path $codeDir "movielinkbd-storage-$stamp.zip"
if ($meta.Count) {
  $tmp = Join-Path $env:TEMP "mlbd-storage-$stamp"
  if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  foreach ($p in $meta) { Copy-Item $p -Destination $tmp -Force }
  if (Test-Path $posters) { Copy-Item $posters -Destination $tmp -Recurse -Force }
  Compress-Archive -Path (Join-Path $tmp "*") -DestinationPath $storageZip -CompressionLevel Optimal -Force
  Remove-Item $tmp -Recurse -Force
  Write-Host ("  meta  : {0:N1} MB" -f ((Get-Item $storageZip).Length / 1MB))
}

# ---- 3. the films, copied to another disk ---------------------------------
$videos = Get-ChildItem -Path $Storage -File | Where-Object { $_.Extension -in @(".mp4", ".mkv", ".webm", ".mov", ".m4v") }
$total = 0
foreach ($v in $videos) {
  $dest = Join-Path $mediaDir $v.Name
  if (-not (Test-Path $dest) -or (Get-Item $dest).Length -ne $v.Length) {
    Copy-Item $v.FullName $dest -Force
  }
  $total += $v.Length
  Write-Host ("  film  : {0,-28} {1,8:N2} GB" -f $v.Name, ($v.Length / 1GB))
}
Write-Host ("  media : {0:N2} GB in {1} file(s)" -f ($total / 1GB), $videos.Count)

# ---- 4. digests ------------------------------------------------------------
$sums = Join-Path $codeDir "SHA256SUMS.txt"
$lines = @()
foreach ($f in (@($codeZip, $storageZip) + (Get-ChildItem $mediaDir -File))) {
  if ($f -and (Test-Path $f)) {
    $h = (Get-FileHash -Path $f -Algorithm SHA256).Hash.ToLower()
    $rel = Split-Path $f -Leaf
    $lines += "$h  $rel"
  }
}
$lines | Set-Content -Path $sums -Encoding ascii
Copy-Item $sums -Destination (Join-Path $mediaDir "SHA256SUMS.txt") -Force

# ---- 5. how to put it back -------------------------------------------------
$restore = @"
# Restore $stamp

Code and documents
  1. Copy movielinkbd-code-$stamp.zip anywhere and extract it.
  2. The program has no dependencies: Node.js is enough (E:\Tools\node-v24.18.0-win-x64).

Library (titles, categories, admin token)
  1. Copy movielinkbd-storage-$stamp.zip contents into the storage folder.
  2. That is library.json, .admin-token, .storage-path and posters\.

Films
  - Restored from $mediaDir (or the original storage folder if that disk is alive).
  - Put them back next to library.json; file names must match the ones in library.json.

Start it again
  - From the code folder: powershell -NoProfile -ExecutionPolicy Bypass -File .\go-live.ps1 -TunnelConfig .\tunnel.yml -PublicUrl https://movies.hafizr283.me -TranscodeDir H:\movielinkbd-transcode
  - Health check: http://127.0.0.1:8890/api/catalogue.json

Verified with SHA256SUMS.txt (Get-FileHash -Algorithm SHA256 <file>).
"@
$restore | Set-Content -Path (Join-Path $codeDir "RESTORE.md") -Encoding utf8
Copy-Item (Join-Path $codeDir "RESTORE.md") -Destination (Join-Path $mediaDir "RESTORE.md") -Force

# ---- 6. what is where ------------------------------------------------------
$left = (Get-PSDrive H).Free / 1GB
$leftD = (Get-PSDrive D).Free / 1GB
Write-Host ""
Write-Host ("done. H: {0:N2} GB free, D: {1:N2} GB free" -f $left, $leftD)
Get-ChildItem $codeDir | Select-Object Name, @{n = "MB"; e = { [math]::Round($_.Length / 1MB, 1) } } | Format-Table -AutoSize
