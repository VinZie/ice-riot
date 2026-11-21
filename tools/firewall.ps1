<#
.SYNOPSIS
    Adds (or with -Remove deletes) the Windows Firewall rule "ICE RIOT (tailnet)".

.DESCRIPTION
    Creates one inbound rule that allows TCP <Port> (default 8765) ONLY from Tailscale
    addresses: 100.64.0.0/10 (IPv4) and fd7a:115c:a1e0::/48 (IPv6). It applies to every
    network profile, so it works whatever category Windows gave the Tailscale adapter, and
    it does not open the game to your LAN or the internet.

    Idempotent: running it again with the same settings changes nothing. Running it with a
    different -Port replaces the old rule. -Remove deletes it (and does nothing if absent).

    Requires an elevated (Administrator) PowerShell, except with -WhatIf, which only
    previews and never changes anything.

    You do NOT need this rule when you host with Tailscale Serve (npm run serve): then
    tailscaled forwards to the game on localhost and the firewall is not involved.

.PARAMETER Port
    TCP port of the game server. Default: $env:PORT if set, else 8765.

.PARAMETER Remove
    Delete the rule instead of adding it.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools\firewall.ps1 -WhatIf
    Preview what would change (works without admin).

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools\firewall.ps1
    Add the rule for port 8765 (run in an elevated terminal).

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools\firewall.ps1 -Remove
    Delete the rule.
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [ValidateRange(1, 65535)]
    [int]$Port = $(if ($env:PORT -as [int]) { [int]$env:PORT } else { 8765 }),

    [switch]$Remove
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$RuleName      = 'ICE-RIOT-tailnet'      # stable internal Name (unique key)
$DisplayName   = 'ICE RIOT (tailnet)'    # what you see in wf.msc
$RuleGroup     = 'ICE RIOT'
$TailnetRanges = @('100.64.0.0/10', 'fd7a:115c:a1e0::/48')

function Write-Ok([string]$Msg)   { Write-Host '  [ OK ] ' -ForegroundColor Green -NoNewline; Write-Host $Msg }
function Write-Warn([string]$Msg) { Write-Host '  [WARN] ' -ForegroundColor Yellow -NoNewline; Write-Host $Msg }
function Write-Bad([string]$Msg)  { Write-Host '  [FAIL] ' -ForegroundColor Red -NoNewline; Write-Host $Msg }
function Write-Info([string]$Msg) { Write-Host '  [INFO] ' -ForegroundColor Cyan -NoNewline; Write-Host $Msg }
function Write-Cmd([string]$Cmd)  { Write-Host "         > $Cmd" -ForegroundColor White }

# "100.64.0.0/255.192.0.0" (how Windows reports IPv4 subnets) -> "100.64.0.0/10"; lower-cases IPv6.
function ConvertTo-Cidr([string]$Address) {
    $a = $Address.Trim().ToLowerInvariant()
    if ($a -match '^(\d{1,3}(?:\.\d{1,3}){3})/(\d{1,3}(?:\.\d{1,3}){3})$') {
        $net = $Matches[1]
        $bits = 0
        foreach ($b in ([System.Net.IPAddress]::Parse($Matches[2])).GetAddressBytes()) {
            $bits += @([Convert]::ToString([int]$b, 2).ToCharArray() | Where-Object { $_ -eq '1' }).Count
        }
        return "$net/$bits"
    }
    return $a
}

function Get-IceRiotRule {
    $found = @()
    try { $found += @(Get-NetFirewallRule -Name $RuleName -ErrorAction SilentlyContinue) } catch { }
    try { $found += @(Get-NetFirewallRule -DisplayName $DisplayName -ErrorAction SilentlyContinue) } catch { }
    return @($found | Where-Object { $null -ne $_ } | Sort-Object -Property Name -Unique)
}

# Short human description of an existing rule.
function Format-Rule($Rule) {
    $pf = $Rule | Get-NetFirewallPortFilter
    $af = $Rule | Get-NetFirewallAddressFilter
    $remote = (@($af.RemoteAddress) | ForEach-Object { ConvertTo-Cidr $_ }) -join ', '
    return ('{0} {1} {2}/{3} from {4} (enabled: {5}, profile: {6})' -f
        $Rule.Direction, $Rule.Action, $pf.Protocol, (@($pf.LocalPort) -join ','), $remote, $Rule.Enabled, $Rule.Profile)
}

function Test-RuleMatch($Rule) {
    if ([string]$Rule.Direction -ne 'Inbound') { return $false }
    if ([string]$Rule.Action -ne 'Allow')      { return $false }
    if ([string]$Rule.Enabled -ne 'True')      { return $false }
    if ([string]$Rule.Profile -ne 'Any')       { return $false }
    $pf = $Rule | Get-NetFirewallPortFilter
    if ([string]$pf.Protocol -ne 'TCP')                  { return $false }
    if ((@($pf.LocalPort) -join ',') -ne [string]$Port)  { return $false }
    $app = $Rule | Get-NetFirewallApplicationFilter
    if ([string]$app.Program -ne 'Any')                  { return $false }
    $af = $Rule | Get-NetFirewallAddressFilter
    $have = (@($af.RemoteAddress) | ForEach-Object { ConvertTo-Cidr $_ } | Sort-Object) -join ','
    $want = (@($TailnetRanges)    | ForEach-Object { ConvertTo-Cidr $_ } | Sort-Object) -join ','
    return ($have -eq $want)
}

# --- banner -------------------------------------------------------------------------------
Write-Host ''
Write-Host '  ICE RIOT - Windows Firewall rule' -ForegroundColor Magenta
Write-Host ("  rule: '{0}'   port: TCP {1}   from: {2}" -f $DisplayName, $Port, ($TailnetRanges -join ', ')) -ForegroundColor DarkGray
Write-Host ''

# --- admin self-check ---------------------------------------------------------------------
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    if ($WhatIfPreference) {
        Write-Info 'Not elevated: preview only (-WhatIf). Applying it needs an Administrator PowerShell.'
    }
    else {
        $extra = "-Port $Port"
        if ($Remove) { $extra += ' -Remove' }
        Write-Bad 'Changing Windows Firewall rules needs Administrator rights.'
        Write-Host ''
        Write-Host '  Re-run it elevated. Either open "Terminal (Admin)" and run:' -ForegroundColor Gray
        Write-Cmd "powershell -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" $extra"
        Write-Host '  or launch an elevated window from here (accept the UAC prompt):' -ForegroundColor Gray
        Write-Cmd "Start-Process powershell -Verb RunAs -ArgumentList '-NoExit -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" $extra'"
        Write-Host '  Preview without changing anything: add -WhatIf' -ForegroundColor Gray
        Write-Host ''
        exit 1
    }
}

# --- do it --------------------------------------------------------------------------------
$existing = @(Get-IceRiotRule)
$changed = $false

if ($Remove) {
    if ($existing.Count -eq 0) {
        Write-Ok "No '$DisplayName' rule exists. Nothing to remove."
        exit 0
    }
    foreach ($r in $existing) {
        Write-Info ("Found [{0}]: {1}" -f $r.Name, (Format-Rule $r))
        if ($PSCmdlet.ShouldProcess("$($r.DisplayName) [$($r.Name)]", 'Remove inbound Windows Firewall rule')) {
            Remove-NetFirewallRule -Name $r.Name -Confirm:$false
            Write-Ok "Removed '$($r.DisplayName)' [$($r.Name)]."
            $changed = $true
        }
    }
    Write-Host ''
    if ($WhatIfPreference) { Write-Info 'WhatIf: nothing was changed.' }
    if ($changed) { Write-Info 'Direct-port hosting from other tailnet devices is closed again (Tailscale Serve still works).' }
    Write-Host ''
    exit 0
}

# Keep one rule that already matches (prefer our own Name); everything else is stale.
$keep = $null
$matching = @($existing | Where-Object { Test-RuleMatch $_ })
if ($matching.Count -gt 0) {
    $keep = @($matching | Where-Object { $_.Name -eq $RuleName }) + @($matching) | Select-Object -First 1
}
$stale = @($existing | Where-Object { $null -eq $keep -or $_.Name -ne $keep.Name })

foreach ($r in $stale) {
    Write-Info ("Replacing outdated rule [{0}]: {1}" -f $r.Name, (Format-Rule $r))
    if ($PSCmdlet.ShouldProcess("$($r.DisplayName) [$($r.Name)]", 'Remove outdated inbound Windows Firewall rule')) {
        Remove-NetFirewallRule -Name $r.Name -Confirm:$false
        $changed = $true
    }
}

if ($null -ne $keep) {
    Write-Ok ("Rule already in place: {0}" -f (Format-Rule $keep))
}
else {
    $action = "Create inbound rule: allow TCP $Port from $($TailnetRanges -join ', ') on all profiles"
    if ($PSCmdlet.ShouldProcess($DisplayName, $action)) {
        $params = @{
            Name          = $RuleName
            DisplayName   = $DisplayName
            Group         = $RuleGroup
            Description   = "ICE RIOT game server: allow TCP $Port only from Tailscale (tailnet) addresses. Created by tools\firewall.ps1; remove with tools\firewall.ps1 -Remove."
            Direction     = 'Inbound'
            Action        = 'Allow'
            Protocol      = 'TCP'
            LocalPort     = [string]$Port
            RemoteAddress = $TailnetRanges
            Profile       = 'Any'
            Enabled       = 'True'
        }
        New-NetFirewallRule @params -Confirm:$false | Out-Null
        Write-Ok "Created '$DisplayName': inbound TCP $Port from Tailscale addresses only."
        $changed = $true
    }
}

# Block rules beat allow rules. Dismissing the "Windows Defender Firewall has blocked some
# features of Node.js" prompt creates inbound BLOCK rules for node.exe that defeat this rule.
$nodeCmd = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if ($nodeCmd) {
    $blocks = @()
    try {
        $blocks = @(Get-NetFirewallApplicationFilter -Program $nodeCmd.Source -ErrorAction SilentlyContinue |
            Get-NetFirewallRule -ErrorAction SilentlyContinue |
            Where-Object { [string]$_.Direction -eq 'Inbound' -and [string]$_.Action -eq 'Block' -and [string]$_.Enabled -eq 'True' })
    } catch { }
    if ($blocks.Count -gt 0) {
        Write-Warn ("{0} enabled inbound BLOCK rule(s) for node.exe exist (profile: {1}). Block wins over allow." -f
            $blocks.Count, ((@($blocks | ForEach-Object { [string]$_.Profile }) | Sort-Object -Unique) -join '; '))
        Write-Host '         Remove them in an elevated PowerShell if friends still cannot connect:' -ForegroundColor Gray
        Write-Cmd "Get-NetFirewallApplicationFilter -Program '$($nodeCmd.Source)' | Get-NetFirewallRule | Where-Object Action -eq 'Block' | Remove-NetFirewallRule"
    }
}

Write-Host ''
if ($WhatIfPreference) {
    Write-Info 'WhatIf: nothing was changed.'
}
elseif (-not $changed) {
    Write-Info 'Nothing to change.'
}
if (-not $Remove) {
    Write-Info "While the server runs, tailnet devices can open http://<this-pc-magicdns-name>:$Port/"
    Write-Info 'Undo any time with: tools\firewall.ps1 -Remove'
}
Write-Host ''
exit 0
