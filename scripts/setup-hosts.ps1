<#
.SYNOPSIS
    Map the local study-clone hostnames to 127.0.0.1 in the Windows hosts file.

.DESCRIPTION
    The participant's Chrome runs on Windows, so the WINDOWS hosts file
    (C:\Windows\System32\drivers\etc\hosts) is what resolves these names --
    editing WSL's /etc/hosts does nothing for Chrome. This writes an idempotent,
    clearly-marked block; re-running replaces it, and -Remove deletes it.

    Needs admin (the hosts file is protected). If you launch it un-elevated it
    copies itself to %TEMP% and relaunches with a UAC prompt -- the copy step is
    so the elevated instance can read the script off the \wsl.localhost bridge,
    which an admin token sometimes cannot.

    THESE HOSTNAMES ARE NOT REAL. They resolve to your own machine only, are not
    registered or published, and are unreachable from the internet. They exist
    solely to test Layer 2 (domain-legitimacy) on realistic-looking domains.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\setup-hosts.ps1
    powershell -ExecutionPolicy Bypass -File scripts\setup-hosts.ps1 -Remove
#>
param([switch]$Remove)

# Mirrors test-pages/clone-map.tsv. If you add a clone there, add it here too.
$Hostnames = @(
    'paypa1.com',
    'glthub.com',
    'idfcfirst-secure.in',
    'shopify-billing.com'
)

$BeginMark = '# === phish_ext study clones (BEGIN) - local only, not real domains ==='
$EndMark   = '# === phish_ext study clones (END) ==='
$HostsPath = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Admin)) {
    Write-Host 'Not elevated - requesting administrator rights...' -ForegroundColor Yellow
    $tmp = Join-Path $env:TEMP 'phish-setup-hosts.ps1'
    Copy-Item -LiteralPath $PSCommandPath -Destination $tmp -Force
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $tmp)
    if ($Remove) { $argList += '-Remove' }
    try {
        Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $argList
    } catch {
        Write-Host 'Elevation was declined. Nothing changed.' -ForegroundColor Red
        Write-Host 'Fallback: open an elevated editor and paste this block into' -ForegroundColor Red
        Write-Host "  $HostsPath" -ForegroundColor Red
        $Hostnames | ForEach-Object { "127.0.0.1 $_" } | Write-Host
    }
    exit
}

# --- elevated from here ---
if (-not (Test-Path $HostsPath)) {
    Write-Host "hosts file not found at $HostsPath" -ForegroundColor Red
    exit 1
}

# Strip any previous block of ours, preserving everything else (Docker, etc.).
$lines = Get-Content -LiteralPath $HostsPath
$kept = New-Object System.Collections.Generic.List[string]
$inBlock = $false
foreach ($line in $lines) {
    if ($line -eq $BeginMark) { $inBlock = $true; continue }
    if ($line -eq $EndMark)   { $inBlock = $false; continue }
    if (-not $inBlock) { $kept.Add($line) }
}
# Drop trailing blank lines so we don't accumulate them across runs.
while ($kept.Count -gt 0 -and [string]::IsNullOrWhiteSpace($kept[$kept.Count - 1])) {
    $kept.RemoveAt($kept.Count - 1)
}

if (-not $Remove) {
    $kept.Add('')
    $kept.Add($BeginMark)
    foreach ($h in $Hostnames) { $kept.Add("127.0.0.1 $h") }
    $kept.Add($EndMark)
}

# ASCII: the hosts file is parsed as plain bytes and a UTF-8 BOM can break the
# first entry on some Windows builds.
Set-Content -LiteralPath $HostsPath -Value $kept -Encoding ASCII

ipconfig.exe /flushdns | Out-Null

if ($Remove) {
    Write-Host 'Removed the phish_ext clone hostnames from the hosts file.' -ForegroundColor Green
} else {
    Write-Host 'Mapped these hostnames to 127.0.0.1:' -ForegroundColor Green
    $Hostnames | ForEach-Object { Write-Host "    $_" }
    Write-Host ''
    Write-Host 'Next: start the server (Windows shell), then restart Chrome so it' -ForegroundColor Cyan
    Write-Host 'drops any cached DNS:  python scripts\serve-clones.py' -ForegroundColor Cyan
}
Write-Host ''
Write-Host 'Press Enter to close...'
[void][System.Console]::ReadLine()
