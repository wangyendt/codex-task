$ErrorActionPreference = "Stop"
$TaskName = "CodexTask"
$ServiceDir = Join-Path $env:APPDATA "codex-task\service"

Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $ServiceDir -Recurse -Force -ErrorAction SilentlyContinue

Write-Host "CodexTask scheduled task removed. The global npm package and Codex data were preserved."
