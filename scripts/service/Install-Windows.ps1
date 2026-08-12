param(
  [string]$HostAddress = $(if ($env:CODEX_TASK_SERVICE_HOST) { $env:CODEX_TASK_SERVICE_HOST } else { "0.0.0.0" }),
  [int]$Port = $(if ($env:CODEX_TASK_SERVICE_PORT) { [int]$env:CODEX_TASK_SERVICE_PORT } else { 7777 }),
  [int]$MaxConcurrency = $(if ($env:CODEX_TASK_SERVICE_CONCURRENCY) { [int]$env:CODEX_TASK_SERVICE_CONCURRENCY } else { 2 })
)

$ErrorActionPreference = "Stop"
$TaskName = "CodexTask"
$ServiceDir = Join-Path $env:APPDATA "codex-task\service"
$TokenFile = Join-Path $ServiceDir "token"
$Runner = Join-Path $ServiceDir "run.cmd"
$LogFile = Join-Path $ServiceDir "service.log"
$ServiceProxy = if ($env:CODEX_TASK_SERVICE_PROXY) {
  $env:CODEX_TASK_SERVICE_PROXY
} elseif ($env:CODEX_TASK_PROXY) {
  $env:CODEX_TASK_PROXY
} elseif ($env:CODEXERRAND_PROXY) {
  $env:CODEXERRAND_PROXY
} else {
  "auto"
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw "npm is required" }
if ($env:CODEX_TASK_SKIP_GLOBAL_INSTALL -ne "1") {
  npm install -g codex-task@latest
  if ($LASTEXITCODE -ne 0) { throw "npm install -g codex-task@latest failed" }
}
$CodexTask = (Get-Command codex-task.cmd -ErrorAction SilentlyContinue).Source
if (-not $CodexTask) { $CodexTask = (Get-Command codex-task -ErrorAction Stop).Source }

New-Item -ItemType Directory -Path $ServiceDir -Force | Out-Null
if (-not (Test-Path $TokenFile) -or (Get-Item $TokenFile).Length -eq 0) {
  $Token = node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))"
  [System.IO.File]::WriteAllText($TokenFile, $Token)
}
icacls $TokenFile /inheritance:r /grant:r "$env:USERNAME`:(R,W)" | Out-Null

if ($ServiceProxy -match '[\r\n"]') { throw "The proxy setting contains characters unsupported by the Windows service runner" }
$EscapedProxy = $ServiceProxy.Replace("%", "%%")
$ProxyLine = "set `"CODEX_TASK_PROXY=$EscapedProxy`""

$RunnerBody = @"
@echo off
$ProxyLine
"$CodexTask" serve --host "$HostAddress" --port "$Port" --token-file "$TokenFile" --max-concurrency "$MaxConcurrency" >> "$LogFile" 2>&1
"@
[System.IO.File]::WriteAllText($Runner, $RunnerBody)
icacls $Runner /inheritance:r /grant:r "$env:USERNAME`:(R,W)" | Out-Null

$UserId = if ($env:USERDOMAIN) { "$env:USERDOMAIN\$env:USERNAME" } else { $env:USERNAME }
$Action = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot "System32\cmd.exe") -Argument "/d /c `"$Runner`""
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $UserId
$Principal = New-ScheduledTaskPrincipal -UserId $UserId -LogonType Interactive -RunLevel Limited
$Settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
$Task = New-ScheduledTask -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings -Description "Authenticated CodexTask HTTP service"
Register-ScheduledTask -TaskName $TaskName -InputObject $Task -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

Write-Host "CodexTask scheduled task installed."
Write-Host "URL: http://${HostAddress}:$Port"
Write-Host "Token: $([System.IO.File]::ReadAllText($TokenFile))"
Write-Host "Token file: $TokenFile"
Write-Host "Log: $LogFile"
Write-Host "The task starts when $UserId logs in so it can reuse that user's Codex environment."
if ($ServiceProxy.ToLowerInvariant() -eq "auto") {
  Write-Host "Proxy: automatic environment/system detection."
} elseif ($ServiceProxy.ToLowerInvariant() -in "direct", "none", "off") {
  Write-Host "Proxy: disabled; Direct requests connect directly."
} else {
  Write-Host "Proxy: fixed URL stored in the protected service runner."
}
