# automation-chrome-reset.ps1 -- restart the automation Chrome and the focus guard
# through their supervisors (never by launching Chrome from a shell), then
# health-check. Windows PowerShell 5.1, ASCII only.

$ErrorActionPreference = 'Continue'
$BinDir = Join-Path $env:USERPROFILE '.local\bin'
$TaskPath = '\AutomationChrome\'

function Stop-Matching([string]$name, [string]$pattern) {
  Get-CimInstance Win32_Process -Filter "Name='$name'" |
    Where-Object { $_.CommandLine -like $pattern } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

function Test-Http([string]$url) {
  try { $null = Invoke-RestMethod -Uri $url -TimeoutSec 2 -UseBasicParsing; return $true } catch { return $false }
}

function Start-Supervisor([string]$role) {
  $task = Get-ScheduledTask -TaskPath $TaskPath -TaskName $role -ErrorAction SilentlyContinue
  if ($task) {
    Start-ScheduledTask -TaskPath $TaskPath -TaskName $role
  } else {
    # Fallback install (no scheduled tasks): start the supervisor hidden.
    $script = Join-Path $BinDir 'automation-chrome-supervise.ps1'
    $r = if ($role -eq 'Chrome') { 'chrome' } else { 'guard' }
    Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList @(
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
      '-File', ('"{0}"' -f $script), '-Role', $r)
  }
}

Write-Output 'stopping supervisors, Chrome, and the focus guard...'
foreach ($role in 'Chrome', 'FocusGuard') {
  Stop-ScheduledTask -TaskPath $TaskPath -TaskName $role -ErrorAction SilentlyContinue
}
Stop-Matching 'powershell.exe' '*automation-chrome-supervise.ps1*'
Stop-Matching 'chrome.exe' '*CursorAutomation*'
Stop-Matching 'node.exe' '*focus-guard.mjs*'
Start-Sleep -Seconds 2

Write-Output 'starting Chrome (9335)...'
Start-Supervisor 'Chrome'
for ($i = 0; $i -lt 30 -and -not (Test-Http 'http://127.0.0.1:9335/json/version'); $i++) { Start-Sleep -Seconds 1 }

Write-Output 'starting focus guard (9333)...'
Start-Supervisor 'FocusGuard'
for ($i = 0; $i -lt 30 -and -not (Test-Http 'http://127.0.0.1:9333/focus-guard/health'); $i++) { Start-Sleep -Seconds 1 }

& (Join-Path $BinDir 'automation-chrome-health.ps1')
exit $LASTEXITCODE
