# ICE RIOT - Windows launcher.
#   .\start.ps1                    start the server (same as npm start)
#   .\start.ps1 --serve            also publish over HTTPS on the tailnet (same as npm run serve)
#   .\start.ps1 --port 9000        any server/server.js option is passed through
# If scripts are blocked:  powershell -ExecutionPolicy Bypass -File .\start.ps1

$ErrorActionPreference = 'Stop'

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Host 'Node.js was not found on PATH. Install Node.js 20 or newer from https://nodejs.org and try again.' -ForegroundColor Red
    exit 1
}

$version = (& node --version).Trim()
$major = 0
if ($version -match '^v(\d+)') { $major = [int]$Matches[1] }
if ($major -lt 20) {
    Write-Host "ICE RIOT needs Node.js 20 or newer (found $version). Update from https://nodejs.org" -ForegroundColor Red
    exit 1
}

$server = Join-Path $PSScriptRoot 'server\server.js'
Push-Location $PSScriptRoot
try {
    & node $server @args
    $code = $LASTEXITCODE
} finally {
    Pop-Location
}
exit $code
