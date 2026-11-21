# ICE RIOT - run the end-to-end test (server + headless Vivaldi + bots).
# All arguments are passed straight to test/e2e.js, e.g.:
#   powershell -ExecutionPolicy Bypass -File test\e2e.ps1 --seconds 30 --bots 3
#   $env:BROWSER = 'C:\path\to\chrome.exe'; powershell -File test\e2e.ps1
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
  node (Join-Path $PSScriptRoot 'e2e.js') @args
  $code = $LASTEXITCODE
} finally {
  Pop-Location
}
exit $code
