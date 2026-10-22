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
exit $rc
