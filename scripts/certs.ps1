# 生成一张本地专用的 CA（只在你这台机器上用），用于给缓存代理签发证书。
# 只需要跑一次。生成的私钥保存在 runtime\certs\ca\ 下，不要外传。
$ErrorActionPreference = 'Stop'

$root   = Split-Path -Parent $PSScriptRoot
$caDir  = Join-Path $root 'runtime\certs\ca'
New-Item -ItemType Directory -Force -Path $caDir | Out-Null

$openssl = 'C:\Program Files\Git\usr\bin\openssl.exe'
if (-not (Test-Path $openssl)) {
    $found = Get-ChildItem 'C:\Program Files\Git' -Recurse -Filter openssl.exe -ErrorAction SilentlyContinue |
             Select-Object -First 1
    if ($found) { $openssl = $found.FullName }
    else { throw '找不到 openssl.exe（一般随 Git for Windows 安装，路径在 C:\Program Files\Git\usr\bin\）' }
}

Push-Location $caDir
try {
    if ((Test-Path 'ca.key') -and (Test-Path 'ca.crt')) {
        Write-Host "CA 已存在，跳过生成：$caDir\ca.crt" -ForegroundColor Yellow
    } else {
        Write-Host "使用 openssl: $openssl"
        & $openssl genrsa -out ca.key 2048
        if ($LASTEXITCODE -ne 0) { throw 'openssl genrsa 失败' }

        & $openssl req -x509 -new -nodes -key ca.key -sha256 -days 3650 `
            -out ca.crt `
            -subj "/C=JP/O=GBF Local Cache Proxy/CN=GBF Local Cache Proxy CA" `
            -addext "basicConstraints=critical,CA:TRUE,pathlen:0" `
            -addext "keyUsage=critical,keyCertSign,cRLSign"
        if ($LASTEXITCODE -ne 0) { throw 'openssl req 失败' }

        & $openssl x509 -in ca.crt -outform der -out ca.der
        Write-Host "已生成 CA：$caDir\ca.crt" -ForegroundColor Green
    }
} finally {
    Pop-Location
}

Write-Host ''
Write-Host '正在预生成游戏域名证书（这样运行期不再需要 openssl，也方便打包成 exe）...'
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if ($node) {
    & $node (Join-Path $PSScriptRoot 'prepare.js')
} else {
    Write-Host '没找到 Node.js，跳过了预生成（首次访问域名时会现场签发，需要 openssl）。' -ForegroundColor Yellow
}

Write-Host ''
Write-Host '下一步：运行 scripts\trust.ps1 把这张 CA 装进 Windows 的“当前用户 > 受信任的根证书颁发机构”。'
