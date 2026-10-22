# install.ps1 -- set up the automation Chrome stack on Windows 10/11.
#
# Same architecture and fixed ports as the macOS install.sh:
#   9335  the dedicated Chrome itself (internal)
#   9333  the focus-guard proxy (public; mcp.json, Playwright, scripts use it)
# launchd is replaced by a small supervisor (bin\automation-chrome-supervise.ps1)
# started at logon by Task Scheduler, or by a Startup-folder shortcut if this
# account may not create scheduled tasks. No admin rights are needed.
#
# Idempotent: re-running is the supported way to apply changes.
#
# Usage (from the repo root):
#   powershell -NoProfile -ExecutionPolicy Bypass -File windows\install.ps1 [-NoCursor] [-NoClaude] [-Force]
#
# Not installed on Windows yet: stealth-cdp and automation-chrome-sync-cookies
# (both macOS-specific). Windows PowerShell 5.1, ASCII only.

param(
  [switch]$NoCursor,
  [switch]$NoClaude,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

$RepoDir = Split-Path -Parent $PSScriptRoot
$Runtime = Join-Path $env:USERPROFILE '.cursor\mcp-wrappers'
$BinDir = Join-Path $env:USERPROFILE '.local\bin'
$ConfigPath = Join-Path $Runtime 'automation-chrome.windows.json'
$TaskPath = '\AutomationChrome\'
$ChromePort = 9335
$PublicPort = 9333
$PublicUrl = "http://127.0.0.1:$PublicPort"

function Say([string]$m)  { Write-Host "==> $m" -ForegroundColor Cyan }
function Info([string]$m) { Write-Host "    $m" }
function Warn([string]$m) { Write-Host "[warn] $m" -ForegroundColor Yellow }
function Die([string]$m)  { Write-Host "[fail] $m" -ForegroundColor Red; exit 1 }

function Test-Http([string]$url) {
  try { $null = Invoke-RestMethod -Uri $url -TimeoutSec 2 -UseBasicParsing; return $true } catch { return $false }
}

function Wait-Http([string]$url, [int]$seconds) {
  for ($i = 0; $i -lt ($seconds * 2); $i++) {
    if (Test-Http $url) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

function Stop-Matching([string]$name, [string]$pattern) {
  Get-CimInstance Win32_Process -Filter "Name='$name'" |
    Where-Object { $_.CommandLine -like $pattern } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

# ---------------------------------------------------------------- preflight

Say 'Preflight'
if ($env:OS -ne 'Windows_NT') { Die 'Windows only. On macOS use ./install.sh.' }

$chromeCandidates = @(
  (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
  (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
)
$ChromePath = $chromeCandidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $ChromePath) { Die 'Google Chrome not found. Install it: winget install --id Google.Chrome -e' }
Info "chrome:  $ChromePath"

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) { Die 'node not found. Install it: winget install --id OpenJS.NodeJS.LTS -e' }
$NodePath = $nodeCmd.Source
$nodeMajor = [int](& node -p "process.versions.node.split('.')[0]")
if ($nodeMajor -lt 20) { Die "node >= 20 required (found $(& node -v))." }
Info "node:    $(& node -v) ($NodePath)"
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { Die 'npm not found (it ships with node).' }

$ffmpeg = Get-Command ffmpeg -ErrorAction SilentlyContinue
if ($ffmpeg) { Info "ffmpeg:  $($ffmpeg.Source)" } else { Warn 'ffmpeg not found -- screencast tools will be omitted. winget install --id Gyan.FFmpeg -e, then re-run.' }

if (-not $Force -and (Test-Path (Join-Path $Runtime 'razz-recorder'))) {
  Die "This looks like the machine that authors this bundle (found $Runtime\razz-recorder). Re-run with -Force."
}

# ------------------------------------------------- stop a previous install

Say 'Stopping any previous automation Chrome / focus guard'
foreach ($t in 'Chrome', 'FocusGuard') {
  Stop-ScheduledTask -TaskPath $TaskPath -TaskName $t -ErrorAction SilentlyContinue
}
Stop-Matching 'powershell.exe' '*automation-chrome-supervise.ps1*'
Stop-Matching 'chrome.exe' '*CursorAutomation*'
Stop-Matching 'node.exe' '*focus-guard.mjs*'
Start-Sleep -Seconds 2

# ------------------------------------------------------------------ scripts

Say "Installing commands to $BinDir"
New-Item -ItemType Directory -Force -Path $BinDir, $Runtime | Out-Null
Copy-Item -Force -Path (Join-Path $PSScriptRoot 'bin\*.ps1') -Destination $BinDir
foreach ($cmd in 'automation-chrome-health', 'automation-chrome-reset', 'automation-chrome-focus') {
  $shim = @(
    '@echo off',
    ('powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0{0}.ps1" %*' -f $cmd),
    'exit /b %ERRORLEVEL%'
  )
  Set-Content -Path (Join-Path $BinDir "$cmd.cmd") -Value $shim -Encoding ASCII
  Info $cmd
}

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not $userPath) { $userPath = '' }
if (($userPath -split ';') -notcontains $BinDir) {
  [Environment]::SetEnvironmentVariable('Path', (($userPath.TrimEnd(';') + ';' + $BinDir).TrimStart(';')), 'User')
  Info "added $BinDir to your user PATH (open a new terminal to use it)"
}
if (($env:Path -split ';') -notcontains $BinDir) { $env:Path = "$env:Path;$BinDir" }

# ------------------------------------------------- mcp wrapper + focus guard

Say "Installing MCP wrapper and focus guard to $Runtime"
foreach ($f in 'chrome-devtools-mcp-filtered.mjs', 'focus-guard.mjs', 'probe-mcp.mjs', 'package.json') {
  Copy-Item -Force -Path (Join-Path $RepoDir "mcp\$f") -Destination $Runtime
}
Copy-Item -Force -Path (Join-Path $RepoDir 'tools\*.mjs') -Destination $Runtime

Say 'Installing pinned dependencies (local install)'
Push-Location $Runtime
& npm install --no-audit --no-fund --loglevel=error
$npmCode = $LASTEXITCODE
Pop-Location
if ($npmCode -ne 0) { Die "npm install failed in $Runtime" }
$mcpVersion = & node -p "require(process.argv[1]).version" (Join-Path $Runtime 'node_modules\chrome-devtools-mcp\package.json')
Info "chrome-devtools-mcp@$mcpVersion + ws"

# ---------------------------------------------------------------- supervisors

$supervise = Join-Path $BinDir 'automation-chrome-supervise.ps1'
$user = "$env:USERDOMAIN\$env:USERNAME"
$mode = 'task'

function Get-SuperviseArgs([string]$role) {
  return ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -Role {1}' -f $supervise, $role)
}

Say 'Registering logon supervisors'
try {
  foreach ($pair in @(@('Chrome', 'chrome'), @('FocusGuard', 'guard'))) {
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument (Get-SuperviseArgs $pair[1])
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
      -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)
    Register-ScheduledTask -TaskPath $TaskPath -TaskName $pair[0] -Action $action -Trigger $trigger `
      -Principal $principal -Settings $settings -Force | Out-Null
    Info "scheduled task $TaskPath$($pair[0])"
  }
} catch {
  Warn "could not create scheduled tasks ($($_.Exception.Message)); using Startup-folder shortcuts instead."
  $mode = 'startup'
  $startup = [Environment]::GetFolderPath('Startup')
  $ws = New-Object -ComObject WScript.Shell
  foreach ($pair in @(@('Chrome', 'chrome'), @('FocusGuard', 'guard'))) {
    $lnk = $ws.CreateShortcut((Join-Path $startup "AutomationChrome-$($pair[0]).lnk"))
    $lnk.TargetPath = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $lnk.Arguments = Get-SuperviseArgs $pair[1]
    $lnk.WindowStyle = 7
    $lnk.Save()
    Info "startup shortcut AutomationChrome-$($pair[0]).lnk"
  }
}

$config = [ordered]@{ chromePath = $ChromePath; nodePath = $NodePath; supervisor = $mode }
Set-Content -Path $ConfigPath -Value ($config | ConvertTo-Json) -Encoding UTF8

function Start-Role([string]$taskName, [string]$role) {
  if ($mode -eq 'task') {
    Start-ScheduledTask -TaskPath $TaskPath -TaskName $taskName
  } else {
    Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList (Get-SuperviseArgs $role)
  }
}

# Boot order matters: Chrome must own 9335 before the guard binds 9333.
Say "Starting Chrome (internal port $ChromePort)"
Start-Role 'Chrome' 'chrome'
if (-not (Wait-Http "http://127.0.0.1:$ChromePort/json/version" 30)) {
  Die "Chrome never came up on $ChromePort. Check $Runtime\supervise-chrome.log"
}
Info "http://127.0.0.1:$ChromePort is up"

Say "Starting focus guard (public port $PublicPort)"
Start-Role 'FocusGuard' 'guard'
if (-not (Wait-Http "$PublicUrl/focus-guard/health" 30)) {
  Die "Focus guard never came up on $PublicPort. Check $Runtime\focus-guard.err.log and supervise-guard.log"
}
Info "$PublicUrl is proxying"

# --------------------------------------------------------------- mcp clients

$mcpArgs = @(
  (Join-Path $Runtime 'chrome-devtools-mcp-filtered.mjs'),
  '--browserUrl', $PublicUrl,
  '--logFile', (Join-Path $Runtime 'chrome-devtools-mcp.log'),
  '--memoryDebugging=true',
  '--experimentalVision=true'
)
if ($ffmpeg) { $mcpArgs += @('--experimentalScreencast=true', "--experimentalFfmpegPath=$($ffmpeg.Source)") }
$mcpArgs += @(
  '--categoryExperimentalThirdParty=true',
  '--categoryExperimentalWebmcp=true',
  '--categoryExtensions=true',
  '--allow-unrestricted-paths',
  '--no-page-id-routing',
  '--no-usage-statistics'
)

# Windows PowerShell 5.1 drops a bare -- when calling native programs, so it is quoted.
$mcpJson = if ($NoCursor) { '-' } else { Join-Path $env:USERPROFILE '.cursor\mcp.json' }
Say 'Registering MCP server'
& node (Join-Path $PSScriptRoot 'register-mcp.mjs') $Runtime $mcpJson '--' @mcpArgs
if ($LASTEXITCODE -ne 0) { Die 'MCP registration failed' }

if (-not $NoClaude -and (Get-Command claude -ErrorAction SilentlyContinue)) {
  Say 'Registering MCP with Claude Code (user scope)'
  # Relax 'Stop' around redirected native stderr; 5.1 would otherwise abort here.
  $ErrorActionPreference = 'Continue'
  & claude mcp remove chrome-devtools --scope user *> $null
  $ErrorActionPreference = 'Stop'
  & claude mcp add chrome-devtools --scope user -e CDM_PATCH_LOG=1 -e CDM_EXCLUDE_URL_PATTERNS=godaddy.com '--' node @mcpArgs
}

# ------------------------------------------------------------------- skills

function Install-Skill([string]$src, [string]$destRoot, [string]$label) {
  $dest = Join-Path $destRoot (Split-Path -Leaf $src)
  if ((Test-Path (Join-Path $dest 'SKILL.md')) -and -not $Force) {
    Info "$label -> kept existing $(Split-Path -Leaf $src) (pass -Force to overwrite)"
    return
  }
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  Copy-Item -Recurse -Force -Path (Join-Path $src '*') -Destination $dest
  Info "$label -> $dest\SKILL.md"
}

Say 'Installing skills'
foreach ($sk in Get-ChildItem -Directory -Path (Join-Path $RepoDir 'skills')) {
  if (-not $NoCursor) { Install-Skill $sk.FullName (Join-Path $env:USERPROFILE '.cursor\skills') 'Cursor' }
  if (-not $NoClaude -and (Test-Path (Join-Path $env:USERPROFILE '.claude'))) {
    Install-Skill $sk.FullName (Join-Path $env:USERPROFILE '.claude\skills') 'Claude Code'
  }
}
Copy-Item -Force -Path (Join-Path $RepoDir 'README.md') -Destination (Join-Path $Runtime 'README.md')

# ------------------------------------------------------------------- verify

Say 'Verifying'
& (Join-Path $PSScriptRoot 'verify.ps1')
$verifyCode = $LASTEXITCODE

Write-Host ''
Say 'Done'
Info "Runtime dir:  $Runtime"
Info "Public CDP:   $PublicUrl  (focus guard -> Chrome on $ChromePort)"
Info "Supervisor:   $mode"
Write-Host ''
Write-Host 'Restart your MCP client so it picks up the new server:'
Write-Host '    Cursor       Ctrl+Shift+P -> Developer: Reload Window'
Write-Host '    Claude Code  start a new session, then run /mcp'
exit $verifyCode
