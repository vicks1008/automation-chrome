# verify.ps1 -- prove the Windows stack works end to end. Exit 0 only if every
# check passes. Same checks as verify.sh, with the supervisor in place of launchd.
# Windows PowerShell 5.1, ASCII only.

$ErrorActionPreference = 'Continue'

$Runtime = Join-Path $env:USERPROFILE '.cursor\mcp-wrappers'
$BinDir = Join-Path $env:USERPROFILE '.local\bin'
$ConfigPath = Join-Path $Runtime 'automation-chrome.windows.json'
$TaskPath = '\AutomationChrome\'
$PublicUrl = 'http://127.0.0.1:9333'
$ChromeUrl = 'http://127.0.0.1:9335'
$script:Failed = $false

function Pass([string]$m) { Write-Host "  [ok]   $m" -ForegroundColor Green }
function Fail([string]$m) { Write-Host "  [FAIL] $m" -ForegroundColor Red; $script:Failed = $true }
function Info([string]$m) { Write-Host "         $m" }

function Get-Json([string]$url) {
  try { return Invoke-RestMethod -Uri $url -TimeoutSec 3 -UseBasicParsing } catch { return $null }
}

Write-Host 'Verifying automation Chrome stack (guard 9333 -> Chrome 9335)'

# 1. Supervisors are installed and running.
$mode = 'task'
if (Test-Path $ConfigPath) {
  $mode = (Get-Content -Raw -Encoding UTF8 -Path $ConfigPath | ConvertFrom-Json).supervisor
} else {
  Fail "missing $ConfigPath -- re-run windows\install.ps1"
}
foreach ($pair in @(@('Chrome', 'chrome'), @('FocusGuard', 'guard'))) {
  if ($mode -eq 'task') {
    $task = Get-ScheduledTask -TaskPath $TaskPath -TaskName $pair[0] -ErrorAction SilentlyContinue
    if (-not $task) { Fail "scheduled task $TaskPath$($pair[0]) is not registered"; continue }
  }
  $running = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
    Where-Object { $_.CommandLine -like '*automation-chrome-supervise.ps1*' -and $_.CommandLine -like "*-Role $($pair[1])*" }
  if ($running) { Pass "supervisor '$($pair[1])' running (pid $(@($running)[0].ProcessId))" }
  else { Fail "supervisor '$($pair[1])' not running"; Info 'run: automation-chrome-reset' }
}

# 2. Chrome answers on its internal port.
if (Get-Json "$ChromeUrl/json/version") { Pass 'Chrome answering on 9335' } else { Fail 'nothing answering on 9335' }

# 3. The focus guard answers its health endpoint (so 9333 is the guard, not a raw Chrome).
$health = Get-Json "$PublicUrl/focus-guard/health"
if ($health -and $health.ok) { Pass 'focus guard health endpoint ok' }
else { Fail 'focus guard health endpoint silent -- a raw Chrome may be bound to 9333' }

# 4. CDP answers through the guard, and still answers a few seconds later.
$version = Get-Json "$PublicUrl/json/version"
if ($version) {
  Pass "CDP responds through guard: $($version.Browser)"
  Start-Sleep -Seconds 3
  if (Get-Json "$PublicUrl/json/version") { Pass 'still alive 3s later' } else { Fail 'Chrome died within 3s' }

  # 5. The guard is really proxying: the advertised WebSocket URL is rewritten to 9333.
  if ($version.webSocketDebuggerUrl -like '*:9333/*') { Pass 'guard rewrites advertised WebSocket URL to :9333' }
  else { Fail "WebSocket URL is '$($version.webSocketDebuggerUrl)' -- the guard is not rewriting" }
} else {
  Fail "no response from $PublicUrl/json/version"
}

# 6. The MCP boots with the installed flag set and exposes the full tool surface.
$argsFile = Join-Path $Runtime 'mcp-args.json'
$probe = Join-Path $Runtime 'probe-mcp.mjs'
if ((Test-Path $argsFile) -and (Test-Path $probe)) {
  # Index 0 is the wrapper path, which probe-mcp.mjs supplies itself.
  $flags = @(Get-Content -Raw -Encoding UTF8 -Path $argsFile | ConvertFrom-Json) | Select-Object -Skip 1
  Push-Location $Runtime
  $out = (& node $probe @flags 2>&1 | Out-String)
  Pop-Location
  $m = [regex]::Match($out, 'tools:\s+(\d+)')
  if ($m.Success -and [int]$m.Groups[1].Value -ge 50) { Pass "MCP exposes $($m.Groups[1].Value) tools" }
  elseif ($m.Success) { Fail "MCP exposed only $($m.Groups[1].Value) tools (expected ~55)"; Info $out }
  else { Fail 'MCP did not report a tool list'; Info $out }
} else {
  Fail "missing $argsFile or $probe -- re-run windows\install.ps1"
}

# 7. Client registration.
$mcpJson = Join-Path $env:USERPROFILE '.cursor\mcp.json'
if (Test-Path $mcpJson) {
  $cfg = Get-Content -Raw -Encoding UTF8 -Path $mcpJson | ConvertFrom-Json
  if ($cfg.mcpServers.'chrome-devtools') { Pass 'registered with Cursor' } else { Fail "not registered in $mcpJson" }
}
if (Get-Command claude -ErrorAction SilentlyContinue) {
  $claudeList = & claude mcp list 2>&1 | Out-String
  if ($claudeList -match 'chrome-devtools') { Pass 'registered with Claude Code' }
  else { Fail 'not registered with Claude Code (claude mcp list)' }
}

# 8. Helper commands are installed.
foreach ($c in 'automation-chrome-health', 'automation-chrome-reset', 'automation-chrome-focus') {
  if ((Test-Path (Join-Path $BinDir "$c.cmd")) -and (Test-Path (Join-Path $BinDir "$c.ps1"))) { Pass "$c installed" }
  else { Fail "$c missing from $BinDir" }
}
foreach ($t in 'gd-cookies.mjs', 'kasada-ab-test.mjs') {
  if (Test-Path (Join-Path $Runtime $t)) { Pass "$t installed" } else { Fail "$t missing" }
}

# 9. Skills are discoverable.
foreach ($root in (Join-Path $env:USERPROFILE '.cursor\skills'), (Join-Path $env:USERPROFILE '.claude\skills')) {
  foreach ($name in 'automation-chrome', 'razz-website-editor-automation') {
    $skill = Join-Path $root "$name\SKILL.md"
    if (Test-Path $skill) { Pass "skill installed: $skill" }
  }
}

Write-Host ''
if ($script:Failed) {
  Write-Host 'VERIFY FAILED -- fix the [FAIL] items above and re-run windows\verify.ps1' -ForegroundColor Red
  exit 1
}
Write-Host 'VERIFY OK' -ForegroundColor Green
exit 0
