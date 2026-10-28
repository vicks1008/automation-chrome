# automation-chrome-health.ps1 -- is Chrome (9335) and the focus guard (9333) answering?
# Exit 0 when both are up. Windows PowerShell 5.1, ASCII only.

$rc = 0
try {
  $null = Invoke-RestMethod -Uri 'http://127.0.0.1:9335/json/version' -TimeoutSec 3 -UseBasicParsing
  Write-Output 'chrome (9335): ok'
} catch {
  Write-Output 'chrome (9335): DOWN'
  $rc = 1
}
try {
  $v = Invoke-RestMethod -Uri 'http://127.0.0.1:9333/json/version' -TimeoutSec 3 -UseBasicParsing
  if ($v.webSocketDebuggerUrl) {
    Write-Output 'guard  (9333): ok'
  } else {
    Write-Output 'guard  (9333): DOWN or upstream error'
    $rc = 1
  }
} catch {
  Write-Output 'guard  (9333): DOWN or upstream error'
  $rc = 1
}
# Tab hygiene: many open pages usually means sessions are leaking tabs.
# Informational only; nothing is closed automatically.
try {
  $pages = @(Invoke-RestMethod -Uri 'http://127.0.0.1:9333/json/list' -TimeoutSec 3 -UseBasicParsing | Where-Object { $_.type -eq 'page' }).Count
  if ($pages -gt 15) {
    Write-Output "tabs         : $pages open (more than 15; sessions may be leaking tabs, close the ones you own by pageId)"
  } else {
    Write-Output "tabs         : $pages open"
  }
  $h = Invoke-RestMethod -Uri 'http://127.0.0.1:9333/focus-guard/health' -TimeoutSec 3 -UseBasicParsing
  if ($null -ne $h.idleSeconds) { Write-Output "agent idle   : $($h.idleSeconds)s since last command" }
} catch { }
exit $rc
