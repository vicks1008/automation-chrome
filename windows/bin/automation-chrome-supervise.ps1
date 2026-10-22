# automation-chrome-supervise.ps1 -- the Windows stand-in for launchd.
#
# Started at logon (Task Scheduler, or a Startup-folder shortcut as a fallback)
# with -Role chrome or -Role guard. It keeps that one process alive:
#
#   chrome  Runs the dedicated Chrome on internal CDP port 9335 with the
#           CursorAutomation profile. Restarts it after a crash. A clean quit
#           (the user closing the window, exit code 0) leaves it down until the
#           next logon or `automation-chrome-reset`, matching launchd's
#           KeepAlive { Crashed = true; SuccessfulExit = false }.
#   guard   Runs focus-guard.mjs on public port 9333 (proxying to 9335). Always
#           restarts it. Waits for Chrome first: Chrome must own 9335 before the
#           guard binds 9333.
#
# Paths come from automation-chrome.windows.json, written by install.ps1.
# Written for Windows PowerShell 5.1. ASCII only (5.1 reads BOM-less files as ANSI).

param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('chrome', 'guard')]
  [string]$Role
)

$ErrorActionPreference = 'Continue'

$Runtime = Join-Path $env:USERPROFILE '.cursor\mcp-wrappers'
$ConfigPath = Join-Path $Runtime 'automation-chrome.windows.json'
$ChromePort = 9335
$PublicPort = 9333

function Write-SuperviseLog([string]$msg) {
  $line = '[{0}] [{1}] {2}' -f (Get-Date -Format s), $Role, $msg
  Add-Content -Path (Join-Path $Runtime "supervise-$Role.log") -Value $line
}

function Test-Http([string]$url) {
  try {
    $null = Invoke-RestMethod -Uri $url -TimeoutSec 2 -UseBasicParsing
    return $true
  } catch {
    return $false
  }
}

function Wait-WhileUp([string]$url) {
  while (Test-Http $url) { Start-Sleep -Seconds 5 }
}

if (-not (Test-Path $ConfigPath)) {
  Write-SuperviseLog "missing $ConfigPath -- re-run windows\install.ps1"
  exit 1
}
$config = Get-Content -Raw -Encoding UTF8 -Path $ConfigPath | ConvertFrom-Json

$chromeUrl = "http://127.0.0.1:$ChromePort/json/version"
$guardUrl = "http://127.0.0.1:$PublicPort/focus-guard/health"

if ($Role -eq 'chrome') {
  $profileDir = Join-Path $env:LOCALAPPDATA 'Google\Chrome\CursorAutomation'
  $chromeArgs = @(
    "--remote-debugging-port=$ChromePort",
    '--remote-allow-origins=*',
    ('--user-data-dir="{0}"' -f $profileDir),
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling'
  ) -join ' '

  while ($true) {
    if (Test-Http $chromeUrl) {
      Write-SuperviseLog "port $ChromePort already answering; watching it"
      Wait-WhileUp $chromeUrl
      continue
    }
    Write-SuperviseLog "starting Chrome on port $ChromePort"
    $p = Start-Process -FilePath $config.chromePath -ArgumentList $chromeArgs -PassThru
    $null = $p.Handle   # cache the handle so ExitCode is readable after exit
    $p.WaitForExit()
    $code = $p.ExitCode
    Write-SuperviseLog "Chrome exited with code $code"

    if ($code -eq 0) {
      # Chrome sometimes relaunches itself (updates) and exits 0. If the port
      # comes back, keep watching; otherwise the user closed it on purpose.
      Start-Sleep -Seconds 3
      if (Test-Http $chromeUrl) { continue }
      Write-SuperviseLog 'clean quit; staying down until next logon or automation-chrome-reset'
      exit 0
    }
    Start-Sleep -Seconds 5
  }
}

# Role: guard
$guardScript = Join-Path $Runtime 'focus-guard.mjs'
$env:FOCUS_GUARD_LISTEN_PORT = "$PublicPort"
$env:FOCUS_GUARD_CHROME_PORT = "$ChromePort"

while ($true) {
  if (-not (Test-Http $chromeUrl)) {
    Start-Sleep -Seconds 2
    continue
  }
  if (Test-Http $guardUrl) {
    Write-SuperviseLog "guard already answering on $PublicPort; watching it"
    Wait-WhileUp $guardUrl
    continue
  }
  Write-SuperviseLog "starting focus guard on $PublicPort -> $ChromePort"
  # -NoNewWindow keeps node in this (already hidden) console.
  $p = Start-Process -FilePath $config.nodePath -ArgumentList ('"{0}"' -f $guardScript) `
    -NoNewWindow -PassThru `
    -RedirectStandardOutput (Join-Path $Runtime 'focus-guard.out.log') `
    -RedirectStandardError (Join-Path $Runtime 'focus-guard.err.log')
  $null = $p.Handle
  $p.WaitForExit()
  Write-SuperviseLog "focus guard exited with code $($p.ExitCode); restarting in 5s"
  Start-Sleep -Seconds 5
}
