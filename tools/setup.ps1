<#
.SYNOPSIS
    ICE RIOT host checklist for this Windows PC (read-only).

.DESCRIPTION
    Checks what you need to host ICE RIOT for friends on your Tailscale tailnet and prints
    the URLs to share:
      - Node.js >= 20
      - Tailscale installed and connected (BackendState)
      - this PC's tailnet IP and MagicDNS name, and the game URLs
      - whether the game port is free (or ICE RIOT is already running on it)
      - Windows Firewall: the "ICE RIOT (tailnet)" rule, and node.exe allow/block rules
      - Tailscale Serve status for the game port
    then explains the two hosting options.

    It changes nothing on the system. The only exception is -Shortcut, which creates one
    "ICE RIOT" shortcut on your desktop (preview it with -Shortcut -WhatIf).

.PARAMETER Port
    Game server port. Default: $env:PORT if set, else 8765.

.PARAMETER Shortcut
    Also create a desktop shortcut "ICE RIOT" that runs tools\ice-riot.cmd.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools\setup.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools\setup.ps1 -Shortcut
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [ValidateRange(1, 65535)]
    [int]$Port = $(if ($env:PORT -as [int]) { [int]$env:PORT } else { 8765 }),

    [switch]$Shortcut
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

# -WhatIf only matters for -Shortcut. Switch the preference off so auto-loading the
# networking modules does not print "What if: New Alias ..." noise.
$Preview = [bool]$WhatIfPreference
$WhatIfPreference = $false

$RuleDisplayName = 'ICE RIOT (tailnet)'
$DefaultPort     = 8765
$RepoRoot        = Split-Path -Parent $PSScriptRoot
$script:Fails    = 0
$script:Warns    = 0

# ----------------------------------------------------------------------------- output helpers
function Write-Section([string]$Title) {
    Write-Host ''
    Write-Host ("== $Title " + ('=' * [Math]::Max(3, 66 - $Title.Length))) -ForegroundColor Cyan
}
function Write-RunHint([string]$Cmd) {
    Write-Host '         run: ' -ForegroundColor Gray -NoNewline
    Write-Host $Cmd -ForegroundColor White
}
function Write-Ok([string]$Msg)   { Write-Host '  [ OK ] ' -ForegroundColor Green -NoNewline; Write-Host $Msg }
function Write-Warn([string]$Msg) { $script:Warns++; Write-Host '  [WARN] ' -ForegroundColor Yellow -NoNewline; Write-Host $Msg }
function Write-Bad([string]$Msg)  { $script:Fails++; Write-Host '  [FAIL] ' -ForegroundColor Red -NoNewline; Write-Host $Msg }
function Write-Info([string]$Msg) { Write-Host '  [INFO] ' -ForegroundColor DarkCyan -NoNewline; Write-Host $Msg }
function Write-Hint([string]$Msg) { Write-Host "         $Msg" -ForegroundColor Gray }
function Write-Cmd([string]$Cmd)  { Write-Host "         > $Cmd" -ForegroundColor White }
function Write-Url([string]$Label, [string]$Url) {
    Write-Host ("         {0,-22}" -f $Label) -ForegroundColor Gray -NoNewline
    Write-Host $Url -ForegroundColor Green
}

# Property of a parsed-JSON object, or $null if missing (tailscale's JSON varies by version).
function Get-Prop($Obj, [string]$Name) {
    if ($null -eq $Obj) { return $null }
    $p = $Obj.PSObject.Properties[$Name]
    if ($null -eq $p) { return $null }
    return $p.Value
}

# Run a native exe, return @{ Code; Out } without ever throwing on stderr / non-zero exit.
function Invoke-Native([string]$Exe, [string[]]$Arguments) {
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $out = & $Exe @Arguments 2>$null
        return @{ Code = $LASTEXITCODE; Out = (@($out) -join "`n") }
    }
    catch { return @{ Code = -1; Out = '' } }
    finally { $ErrorActionPreference = $old }
}

# Does the Windows firewall profile string ("Any", "Private", "Domain, Private", ...) cover $Category?
function Test-ProfileCovers([string]$RuleProfile, [string]$Category) {
    if ($RuleProfile -eq 'Any' -or [string]::IsNullOrEmpty($Category)) { return $true }
    return ($RuleProfile -split ',\s*') -contains $Category
}

# ----------------------------------------------------------------------------- banner
$serverCmd = if ($Port -eq $DefaultPort) { 'npm start' } else { "node server/server.js --port $Port" }
$serveCmd  = if ($Port -eq $DefaultPort) { 'npm run serve' } else { "node server/server.js --serve --port $Port" }

Write-Host ''
Write-Host '  ICE RIOT - host checklist' -ForegroundColor Magenta
$modeNote = if ($Shortcut -and -not $Preview) { 'read-only, except the -Shortcut desktop link' } else { 'read-only: this script changes nothing' }
Write-Host "  repo: $RepoRoot   port: $Port   ($modeNote)" -ForegroundColor DarkGray

# ----------------------------------------------------------------------------- 1. Node.js
Write-Section 'Node.js'
$nodePath = $null
$nodeCmd = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -eq $nodeCmd) {
    Write-Bad 'Node.js was not found on PATH. ICE RIOT needs Node 20 or newer.'
    Write-Hint 'Install the LTS from https://nodejs.org (or: winget install OpenJS.NodeJS.LTS), then open a new terminal.'
}
else {
    $nodePath = $nodeCmd.Source
    $ver = (Invoke-Native $nodePath @('--version')).Out.Trim()
    if ($ver -match '^v?(\d+)\.(\d+)\.(\d+)') {
        if ([int]$Matches[1] -ge 20) { Write-Ok "Node $ver ($nodePath)" }
        else {
            Write-Bad "Node $ver is too old; ICE RIOT needs v20 or newer."
            Write-Hint 'Update from https://nodejs.org (or: winget upgrade OpenJS.NodeJS.LTS).'
        }
    }
    else { Write-Warn "Could not read the Node version from '$nodePath' (got '$ver')." }
}
if (Test-Path -LiteralPath (Join-Path $RepoRoot 'server\server.js')) {
    Write-Ok 'Game server found: server\server.js'
}
else {
    Write-Bad "server\server.js not found under $RepoRoot (run this script from the ICE RIOT folder's tools\)."
}

# ----------------------------------------------------------------------------- 2. Tailscale
Write-Section 'Tailscale'
$tsExe = $null
$tsCmd = Get-Command tailscale -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if ($tsCmd) { $tsExe = $tsCmd.Source }
elseif ($env:ProgramFiles -and (Test-Path -LiteralPath (Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'))) {
    $tsExe = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
}

$tsRunning = $false
$dnsName = $null
$ipv4 = $null
$ipv6 = $null
$httpsCerts = $false

if ($null -eq $tsExe) {
    Write-Bad 'Tailscale is not installed.'
    Write-Hint 'Install it from https://tailscale.com/download/windows, sign in, then re-run this script.'
}
else {
    Write-Ok "Tailscale CLI: $tsExe"
    $res = Invoke-Native $tsExe @('status', '--json')
    $st = $null
    if ($res.Out) { try { $st = $res.Out | ConvertFrom-Json } catch { $st = $null } }

    if ($null -eq $st) {
        Write-Bad 'Could not talk to the Tailscale service (tailscaled).'
        Write-Hint 'Start the Tailscale app from the Start menu (or: Start-Service Tailscale as admin), then:'
        Write-RunHint 'tailscale up'
    }
    else {
        $state = [string](Get-Prop $st 'BackendState')
        if ($state -eq 'Running') {
            $tsRunning = $true
            Write-Ok 'Connected to your tailnet (BackendState: Running)'
        }
        else {
            Write-Bad "Tailscale is not connected (BackendState: $state)."
            switch ($state) {
                'NeedsLogin'       { Write-Hint 'Sign in (tray icon > Log in, or the command below).' }
                'NeedsMachineAuth' { Write-Hint 'This device waits for approval: https://login.tailscale.com/admin/machines' }
                'Stopped'          { Write-Hint 'Tailscale is switched off (tray icon > Connect, or the command below).' }
                'Starting'         { Write-Hint 'Still starting; wait a few seconds and re-run this script.' }
                default            { Write-Hint 'Sign in / connect from the Tailscale tray icon, or with the command below.' }
            }
            Write-RunHint 'tailscale up'
            foreach ($h in @(Get-Prop $st 'Health') | Select-Object -First 3) {
                if ($h) { Write-Hint "tailscale says: $h" }
            }
        }

        if ($tsRunning) {
            $self = Get-Prop $st 'Self'
            foreach ($ip in @(Get-Prop $self 'TailscaleIPs')) {
                if (-not $ip) { continue }
                if ($ip -match '^\d{1,3}(\.\d{1,3}){3}$') { if (-not $ipv4) { $ipv4 = $ip } }
                elseif (-not $ipv6) { $ipv6 = $ip }
            }
            $dn = [string](Get-Prop $self 'DNSName')
            if ($dn) { $dnsName = $dn.TrimEnd('.') }
            $magic = Get-Prop (Get-Prop $st 'CurrentTailnet') 'MagicDNSEnabled'
            $httpsCerts = @(Get-Prop $st 'CertDomains' | Where-Object { $_ }).Count -gt 0

            if ($ipv4) { Write-Ok ("Tailnet IP: {0}{1}" -f $ipv4, $(if ($ipv6) { "  /  $ipv6" } else { '' })) }
            else { Write-Warn 'This PC has no Tailscale IPv4 address yet.' }

            if ($dnsName -and $magic -ne $false) {
                Write-Ok "MagicDNS name: $dnsName"
            }
            else {
                Write-Warn 'MagicDNS looks disabled: friends must use the 100.x IP instead of a name.'
                Write-Hint 'Enable it at https://login.tailscale.com/admin/dns (also needed for Tailscale Serve HTTPS).'
            }
            if ($httpsCerts) { Write-Ok 'HTTPS certificates are enabled for your tailnet (Tailscale Serve can use https://).' }
            else {
                Write-Info 'HTTPS certificates are not enabled for your tailnet (only needed for option B).'
                Write-Hint 'Enable at https://login.tailscale.com/admin/dns > HTTPS Certificates.'
            }
        }
    }
}

# ----------------------------------------------------------------------------- 3. Port
Write-Section "Port $Port"
$listeners = @()
try { $listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) } catch { $listeners = @() }
$gameRunning = $false
if ($listeners.Count -eq 0) {
    Write-Ok "TCP $Port is free."
}
else {
    $pids = @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)
    $names = @()
    foreach ($procId in $pids) {
        $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
        $names += $(if ($p) { "$($p.ProcessName) (PID $procId)" } else { "PID $procId" })
    }
    $addrs = (@($listeners | Select-Object -ExpandProperty LocalAddress -Unique)) -join ', '
    $body = ''
    try {
        $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -UseBasicParsing -TimeoutSec 3
        $body = [string]$resp.Content
    } catch { $body = '' }
    if ($body -match 'ICE RIOT') {
        $gameRunning = $true
        Write-Ok "ICE RIOT is already running on port $Port ($($names -join ', '); listening on $addrs)."
        if (@($listeners | Where-Object { $_.LocalAddress -notin @('127.0.0.1', '::1') }).Count -eq 0) {
            Write-Info 'It listens on localhost only: fine for Tailscale Serve (option B), not for direct access (option A).'
        }
    }
    else {
        Write-Warn "TCP $Port is already in use by $($names -join ', ') on $addrs."
        Write-Hint "Stop that program, or pick another port: node server/server.js --port $($Port + 1)"
    }
}

# ----------------------------------------------------------------------------- 4. Firewall
Write-Section 'Windows Firewall (only matters for option A)'
$tsCategory = $null
try {
    $tsAdapter = Get-NetAdapter -ErrorAction SilentlyContinue |
        Where-Object { $_.InterfaceDescription -like 'Tailscale*' -or $_.Name -like 'Tailscale*' } | Select-Object -First 1
    if ($tsAdapter) {
        $prof = Get-NetConnectionProfile -InterfaceIndex $tsAdapter.ifIndex -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($prof) {
            $tsCategory = [string]$prof.NetworkCategory
            if ($tsCategory -eq 'DomainAuthenticated') { $tsCategory = 'Domain' }
        }
    }
} catch { $tsCategory = $null }
if ($tsCategory) { Write-Info "Windows treats the Tailscale adapter as a '$tsCategory' network." }

$ruleOk = $false
$rules = @()
try { $rules = @(Get-NetFirewallRule -DisplayName $RuleDisplayName -ErrorAction SilentlyContinue) } catch { $rules = @() }
if ($rules.Count -eq 0) {
    Write-Info "No '$RuleDisplayName' rule yet."
}
foreach ($r in $rules) {
    $pf = $r | Get-NetFirewallPortFilter
    $ports = @($pf.LocalPort) -join ','
    $good = ([string]$r.Enabled -eq 'True') -and ([string]$r.Action -eq 'Allow') -and
            ([string]$r.Direction -eq 'Inbound') -and ([string]$pf.Protocol -eq 'TCP') -and ($ports -eq [string]$Port)
    if ($good) {
        $ruleOk = $true
        Write-Ok "'$RuleDisplayName' allows inbound TCP $Port from Tailscale addresses."
    }
    else {
        Write-Warn ("'{0}' exists but does not match (enabled: {1}, action: {2}, {3} port {4})." -f
            $RuleDisplayName, $r.Enabled, $r.Action, $pf.Protocol, $ports)
        Write-Hint "Fix it (elevated): powershell -ExecutionPolicy Bypass -File tools\firewall.ps1 -Port $Port"
    }
}

$nodeAllows = @()
$nodeBlocks = @()
if ($nodePath) {
    try {
        $appRules = @(Get-NetFirewallApplicationFilter -Program $nodePath -ErrorAction SilentlyContinue |
            Get-NetFirewallRule -ErrorAction SilentlyContinue |
            Where-Object { [string]$_.Direction -eq 'Inbound' -and [string]$_.Enabled -eq 'True' -and
                           (Test-ProfileCovers ([string]$_.Profile) $tsCategory) })
        $nodeAllows = @($appRules | Where-Object { [string]$_.Action -eq 'Allow' })
        $nodeBlocks = @($appRules | Where-Object { [string]$_.Action -eq 'Block' })
    } catch { }
}
if ($nodeBlocks.Count -gt 0) {
    Write-Warn "$($nodeBlocks.Count) inbound BLOCK rule(s) for node.exe cover the Tailscale network. Block beats allow,"
    Write-Hint 'so direct connections will fail. Windows adds these when its "allow Node.js" prompt is dismissed.'
    Write-Hint 'Remove them in an elevated PowerShell (or use option B, which is not affected):'
    Write-Cmd "Get-NetFirewallApplicationFilter -Program '$nodePath' | Get-NetFirewallRule | Where-Object Action -eq 'Block' | Remove-NetFirewallRule"
}
elseif ($nodeAllows.Count -gt 0 -and -not $ruleOk) {
    Write-Info ("node.exe already has an inbound allow rule for this network ('{0}', from the Windows prompt)." -f $nodeAllows[0].DisplayName)
    Write-Hint 'Direct access may already work, but that rule also admits your LAN. The tailnet-only rule is tighter.'
}

$directReady = ($ruleOk -or $nodeAllows.Count -gt 0) -and $nodeBlocks.Count -eq 0
if (-not $ruleOk) {
    Write-Hint "Create the tailnet-only rule (elevated): powershell -ExecutionPolicy Bypass -File tools\firewall.ps1 -Port $Port"
}

# ----------------------------------------------------------------------------- 5. Tailscale Serve
$serveActive = $false
$serveHttpsPort = 443
if ($tsRunning) {
    Write-Section 'Tailscale Serve (only matters for option B)'
    $sv = Invoke-Native $tsExe @('serve', 'status', '--json')
    $cfg = $null
    if ($sv.Code -eq 0 -and $sv.Out.Trim()) { try { $cfg = $sv.Out | ConvertFrom-Json } catch { $cfg = $null } }
    $web = Get-Prop $cfg 'Web'
    if ($null -ne $web) {
        foreach ($hp in $web.PSObject.Properties) {          # "<name>.ts.net:443" -> { Handlers: { "/": { Proxy } } }
            $proxy = [string](Get-Prop (Get-Prop (Get-Prop $hp.Value 'Handlers') '/') 'Proxy')
            if ($proxy -match ('^(https?://)?(127\.0\.0\.1|localhost|\[::1\]):{0}/?$' -f $Port) -and $hp.Name -match ':(\d+)$') {
                $serveActive = $true
                $serveHttpsPort = [int]$Matches[1]
                break
            }
        }
    }
    if ($serveActive) {
        Write-Ok "tailscale serve already forwards HTTPS port $serveHttpsPort to localhost:$Port."
    }
    elseif ($sv.Code -eq 0) {
        Write-Info "tailscale serve is not forwarding to port $Port (option B sets it up)."
    }
    else {
        Write-Info 'Could not read tailscale serve status.'
    }
}

# ----------------------------------------------------------------------------- 6. Options
Write-Section 'Hosting options'
$hostName = if ($dnsName) { $dnsName } else { '<this-pc>.<your-tailnet>.ts.net' }

Write-Host ''
Write-Host '  A) Direct port' -ForegroundColor Yellow -NoNewline
$directTag = if ($ruleOk -and $directReady) { '  [firewall rule ready]' } elseif ($directReady) { '  [node.exe already allowed]' } else { '' }
Write-Host ("  - friends open http://...:{0}  (needs the firewall rule){1}" -f $Port, $directTag) -ForegroundColor Gray
if ($ruleOk) {
    Write-Hint "1. Firewall rule '$RuleDisplayName': already in place."
}
else {
    Write-Hint '1. Once, in an elevated terminal (Terminal (Admin)):'
    Write-Cmd  "powershell -ExecutionPolicy Bypass -File tools\firewall.ps1$(if ($Port -ne $DefaultPort) { " -Port $Port" })"
}
Write-Hint "2. Start the server ($(if ($gameRunning) { 'already running' } else { 'or double-click tools\ice-riot.cmd' })):"
Write-Cmd  $serverCmd
Write-Hint '3. Share one of:'
Write-Url  'MagicDNS URL' ("http://{0}:{1}/" -f $hostName, $Port)
if ($ipv4) { Write-Url 'IP URL' ("http://{0}:{1}/" -f $ipv4, $Port) }

Write-Host ''
Write-Host '  B) Tailscale Serve' -ForegroundColor Yellow -NoNewline
Write-Host ("  - friends open https://... ; no firewall change{0}" -f $(if ($serveActive) { '  [already serving]' } else { '' })) -ForegroundColor Gray
Write-Hint "1. Start the server with Serve (runs: tailscale serve --bg $Port):"
Write-Cmd  $serveCmd
Write-Hint '2. Share (the server prints the exact URL; it uses :8443 if 443 is taken):'
Write-Url  'HTTPS URL' $(if ($serveHttpsPort -eq 443) { "https://$hostName/" } else { "https://${hostName}:$serveHttpsPort/" })
Write-Hint 'Needs MagicDNS + HTTPS certificates (admin console > DNS). Tailnet-only, never public.'
Write-Hint "Serve stays on after the game stops. Check: tailscale serve status   Undo: tailscale serve --https=$serveHttpsPort off"

Write-Host ''
Write-Hint 'Friends need Tailscale on the same tailnet (or a node share of this PC): see docs\HOSTING.md'

# ----------------------------------------------------------------------------- 7. Shortcut
if ($Shortcut) {
    Write-Section 'Desktop shortcut'
    $launcher = Join-Path $PSScriptRoot 'ice-riot.cmd'
    if (-not (Test-Path -LiteralPath $launcher)) {
        Write-Bad "Launcher not found: $launcher"
    }
    else {
        $desktop = [Environment]::GetFolderPath('Desktop')
        $lnkPath = Join-Path $desktop 'ICE RIOT.lnk'
        if ($Preview) {
            Write-Info "WhatIf: would create $lnkPath -> $launcher"
        }
        else {
            $wsh = New-Object -ComObject WScript.Shell
            $lnk = $wsh.CreateShortcut($lnkPath)
            $lnk.TargetPath = $launcher
            $lnk.WorkingDirectory = $RepoRoot
            $lnk.Description = 'Start the ICE RIOT game server'
            if ($nodePath) { $lnk.IconLocation = "$nodePath,0" }
            $lnk.Save()
            Write-Ok "Created $lnkPath"
        }
    }
}
else {
    Write-Hint 'Tip: re-run with -Shortcut to put an "ICE RIOT" launcher on your desktop.'
}

# ----------------------------------------------------------------------------- summary
Write-Host ''
if ($script:Fails -gt 0) {
    Write-Host ("  {0} problem(s), {1} warning(s): fix the [FAIL] items above first." -f $script:Fails, $script:Warns) -ForegroundColor Red
}
elseif ($script:Warns -gt 0) {
    Write-Host ("  Ready, with {0} warning(s)." -f $script:Warns) -ForegroundColor Yellow
}
else {
    Write-Host '  All set. Pick option A or B above and share the URL.' -ForegroundColor Green
}
Write-Host ''
exit $(if ($script:Fails -gt 0) { 1 } else { 0 })
