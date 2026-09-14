# 卸载本地 CA（恢复原状）。
$ErrorActionPreference = 'Stop'

$root   = Split-Path -Parent $PSScriptRoot
$caFile = Join-Path $root 'runtime\certs\ca\ca.crt'
if (-not (Test-Path $caFile)) { throw "找不到 $caFile" }

$cert  = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($caFile)
$store = New-Object System.Security.Cryptography.X509Certificates.X509Store('Root', 'CurrentUser')
$store.Open('ReadWrite')
$found = $store.Certificates | Where-Object { $_.Thumbprint -eq $cert.Thumbprint }
if ($found) {
    foreach ($c in $found) { $store.Remove($c) }
    Write-Host "已从受信任根证书中移除（指纹 $($cert.Thumbprint)）" -ForegroundColor Green
} else {
    Write-Host '没找到对应的证书，无需卸载。' -ForegroundColor Yellow
}
$store.Close()
