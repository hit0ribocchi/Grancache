# 把本地 CA 装进「当前用户」的受信任根证书（不需要管理员权限）。
# 只影响当前 Windows 账户，不会写系统级存储。
$ErrorActionPreference = 'Stop'

$root   = Split-Path -Parent $PSScriptRoot
$caFile = Join-Path $root 'runtime\certs\ca\ca.crt'
if (-not (Test-Path $caFile)) { throw "找不到 $caFile，请先运行 scripts\certs.ps1" }

$cert  = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($caFile)
$store = New-Object System.Security.Cryptography.X509Certificates.X509Store('Root', 'CurrentUser')
$store.Open('ReadWrite')

$exists = $store.Certificates | Where-Object { $_.Thumbprint -eq $cert.Thumbprint }
if ($exists) {
    Write-Host "CA 已经在受信任根证书里了（指纹 $($cert.Thumbprint)）" -ForegroundColor Yellow
} else {
    $store.Add($cert)
    Write-Host "已安装 CA 到 当前用户\受信任的根证书颁发机构" -ForegroundColor Green
    Write-Host "指纹：$($cert.Thumbprint)"
}
$store.Close()

Write-Host ''
Write-Host '如需卸载：运行 scripts\untrust.ps1'
