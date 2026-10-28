# automation-chrome-update.ps1 -- run the guarded updater now. Same as the
# scheduled run; accepts --dry-run, --force, --min-idle <seconds>.
# Log: %LOCALAPPDATA%\automation-chrome\update.log
# Windows PowerShell 5.1, ASCII only.
$marker = Join-Path $env:USERPROFILE '.cursor\mcp-wrappers\bundle-dir'
$dir = if (Test-Path $marker) { (Get-Content -Raw $marker).Trim() } else { '' }
$script = Join-Path $dir 'mcp\update.mjs'
if (-not (Test-Path $script)) {
  Write-Error 'bundle dir not recorded; re-run windows\install.ps1 in the automation-chrome checkout'
  exit 1
}
& node $script @args
exit $LASTEXITCODE
