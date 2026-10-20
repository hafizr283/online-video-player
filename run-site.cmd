@echo off
rem One place that knows how this site is published. Task Scheduler and the
rem watchdog both call this file, so the settings cannot drift apart.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0go-live.ps1" ^
  -TunnelConfig "%~dp0tunnel.yml" ^
  -PublicUrl https://movies.hafizr283.me ^
  -TranscodeDir H:\movielinkbd-transcode
