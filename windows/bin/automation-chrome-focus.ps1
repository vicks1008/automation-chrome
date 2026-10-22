# automation-chrome-focus.ps1 -- deliberately raise the automation Chrome window
# for a human hand-off (log in, enter an MFA code).
#
# The focus guard on 9333 blocks raises by design, so this talks straight to
# Chrome on its internal port 9335.
#
# Usage:
#   automation-chrome-focus                  raise the most recent page
#   automation-chrome-focus <targetId>       raise a specific target
#   automation-chrome-focus <url-substring>  raise the first page whose URL matches
#
# Windows may refuse to let a background process take focus; then the taskbar
# button flashes instead and the user clicks it. Windows PowerShell 5.1, ASCII only.

param([string]$Match = '')

$base = 'http://127.0.0.1:9335'
try {
  $targets = Invoke-RestMethod -Uri "$base/json" -TimeoutSec 3 -UseBasicParsing
} catch {
  Write-Error "[focus] cannot reach Chrome on $base. Try: automation-chrome-reset"
  exit 1
}

$pages = @($targets | Where-Object { $_.type -eq 'page' })
if ($pages.Count -eq 0) { Write-Error '[focus] no page targets to raise'; exit 1 }

$target = $null
if ($Match) {
  $target = $pages | Where-Object { $_.id -eq $Match } | Select-Object -First 1
  if (-not $target) { $target = $pages | Where-Object { $_.url -like "*$Match*" } | Select-Object -First 1 }
  if (-not $target) { Write-Error "[focus] no page target matching '$Match'"; exit 1 }
} else {
  $target = $pages[0]
}

# Select the tab inside Chrome (Chrome's own endpoint, not the guard's no-op).
try {
  $null = Invoke-WebRequest -Uri "$base/json/activate/$($target.id)" -TimeoutSec 3 -UseBasicParsing
} catch {
  Write-Verbose "tab activation failed: $($_.Exception.Message); raising the window anyway"
}

# Bring the CursorAutomation Chrome process to the front.
$main = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
  Where-Object { $_.CommandLine -like '*CursorAutomation*' -and $_.CommandLine -notlike '*--type=*' } |
  Select-Object -First 1
if ($main) {
  $shell = New-Object -ComObject WScript.Shell
  $null = $shell.AppActivate([int]$main.ProcessId)
}

Write-Output ("[focus] raised: {0} -- {1}" -f $target.title, $target.url)
