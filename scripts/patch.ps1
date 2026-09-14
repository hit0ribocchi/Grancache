# Patch the unpacked Tarou extension so its asset URLs use the LIVE CDN host.
#
# Why: Tarou hardcodes https://prd-game-a1-granbluefantasy.akamaized.net/assets/img
# (and a5 elsewhere). Those host names no longer exist in DNS: the CDN answers 400,
# and local DNS returns nothing. With the cache proxy running, lib's hostAliases
# rewrites a1..a5 -> prd-game-a-granbluefantasy.akamaized.net and everything works;
# with the proxy stopped the browser has nothing to talk to, so plugin images break.
# Rewriting the constant removes that dependency entirely (works with AND without proxy).
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\patch.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\patch.ps1 -Path "E:\path\to\Chrome-Extension-Tarou" -Dry
#
# After patching: open chrome://extensions and click "Reload" on Tarou (unpacked
# extensions are re-read from disk on reload), or just restart Chrome.
param(
    [string]$Path = 'E:\GameHelper\Chrome-Extension-Tarou.v3.4.1\Chrome-Extension-Tarou',
    [switch]$Dry
)

$ErrorActionPreference = 'Stop'
$live = 'prd-game-a-granbluefantasy.akamaized.net'
$dead = 'prd-game-a[1-5]-granbluefantasy\.akamaized\.net'

if (-not (Test-Path -LiteralPath $Path)) {
    Write-Host "extension dir not found: $Path" -ForegroundColor Red
    exit 1
}

$enc = New-Object System.Text.UTF8Encoding($false)
$total = 0
$touched = 0

foreach ($f in (Get-ChildItem -LiteralPath $Path -Recurse -File -Include *.js, *.json, *.html, *.map)) {
    $text = [IO.File]::ReadAllText($f.FullName)
    $n = [regex]::Matches($text, $dead).Count
    if ($n -eq 0) { continue }
    $total += $n
    $touched++
    if ($Dry) {
        Write-Host ("[dry] {0}  x{1}" -f $f.FullName.Replace($Path + '\', ''), $n)
        continue
    }
    Copy-Item -LiteralPath $f.FullName -Destination ($f.FullName + '.orig-backup') -Force
    [IO.File]::WriteAllText($f.FullName, [regex]::Replace($text, $dead, $live), $enc)
    Write-Host ("patched {0}  x{1}" -f $f.FullName.Replace($Path + '\', ''), $n)
}

if ($Dry) {
    Write-Host ("[dry] would patch {0} occurrences in {1} files" -f $total, $touched)
    exit 0
}

$left = 0
foreach ($f in (Get-ChildItem -LiteralPath $Path -Recurse -File -Include *.js, *.json, *.html, *.map)) {
    if ($f.Name -like '*.orig-backup' -or $f.Name -like '*.orig-20260914') { continue }
    $left += [regex]::Matches([IO.File]::ReadAllText($f.FullName), $dead).Count
}
Write-Host ("done: patched {0} occurrences in {1} files; remaining dead hosts = {2}" -f $total, $touched, $left) -ForegroundColor Green
if ($left -ne 0) {
    Write-Host 'WARNING: some dead host references remain - check manually.' -ForegroundColor Yellow
    exit 2
}
Write-Host 'Now reload the extension at chrome://extensions (or restart Chrome).'
