# 把整个项目打包成单个 Grancache.exe（Node 官方的 SEA 方案）。
# 平时不需要跑；改了 src/main.js / lib 下的代码之后才需要重新打包。
#   -OutName <名字>  输出文件名（默认 Grancache.exe；用“Grancache.exe”这类名字时，
#                    exe 会按自己的文件名自动进控制面板模式）
#   -NoStop          不停掉正在运行的代理（单独出面板 exe 用，不打断正在玩的会话）
param(
    [string]$OutName = 'Grancache.exe',
    [switch]$NoStop
)
$ErrorActionPreference = 'Stop'

$root   = Split-Path -Parent $PSScriptRoot
$build  = Join-Path $root 'build'
New-Item -ItemType Directory -Force -Path $build | Out-Null

# 先把正在运行的实例停掉，否则 exe 被占用会导致最后一步覆盖失败
$running = Get-Process 'Grancache' -ErrorAction SilentlyContinue
if ($running -and -not $NoStop) {
    Write-Host '检测到代理正在运行，先停止它...' -ForegroundColor Yellow
    $running | Stop-Process -Force
    Start-Sleep -Seconds 3
} elseif ($running) {
    Write-Host '代理正在运行：-NoStop 生效，不碰它（输出到别的文件名）' -ForegroundColor Yellow
}

Write-Host '[1/4] 内联打包成单个 JS 文件...' -ForegroundColor Cyan
& node (Join-Path $PSScriptRoot 'bundle.mjs') (Join-Path $build 'bundle.js')
if ($LASTEXITCODE -ne 0) { throw '打包 JS 失败' }

Write-Host '[2/4] 生成 SEA 准备块...' -ForegroundColor Cyan
Push-Location $build
try {
    & node --experimental-sea-config sea-config.json
    if ($LASTEXITCODE -ne 0) { throw '生成 SEA 准备块失败' }

Write-Host '[3/4] 复制 Node 运行时并注入...' -ForegroundColor Cyan
    & node -e "require('fs').copyFileSync(process.execPath, 'Grancache.exe')"

    # 图标必须在注入 blob 之前设置，否则会被覆盖掉
    $icon = Join-Path $root 'Grancache.ico'
    $rcedit = Join-Path $build 'rcedit.exe'
    if ((-not (Test-Path $rcedit)) -and (Test-Path $icon)) {
        Write-Host '      下载 rcedit（只需要一次，之后用本地副本）...' -ForegroundColor Cyan
        & curl.exe -sSL -o $rcedit 'https://github.com/electron/rcedit/releases/download/v2.0.0/rcedit-x64.exe'
    }
    if ((Test-Path $rcedit) -and (Test-Path $icon)) {
        Write-Host '      设置图标...' -ForegroundColor Cyan
        & $rcedit Grancache.exe --set-icon $icon | Out-Null
    } else {
        Write-Host '      没找到图标或 rcedit，跳过图标设置。' -ForegroundColor Yellow
    }

    & npx --yes postject@1.0.0-alpha.6 Grancache.exe NODE_SEA_BLOB sea-prep.blob `
        --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
    if ($LASTEXITCODE -ne 0) { throw '注入失败（需要联网下载 postject）' }
} finally {
    Pop-Location
}

Write-Host '[4/4] 放到项目目录...' -ForegroundColor Cyan
$srcExe = Join-Path $build 'Grancache.exe'
$dstExe = Join-Path $root $OutName
# 直接覆盖；被占用时重试几次（刚停掉的进程可能还没完全释放文件）
for ($i = 1; $i -le 10; $i++) {
    try {
        if (Test-Path $dstExe) { Remove-Item -LiteralPath $dstExe -Force -ErrorAction Stop }
        Copy-Item -LiteralPath $srcExe -Destination $dstExe -Force -ErrorAction Stop
        break
    } catch {
        if ($i -eq 10) { throw "无法覆盖 $dstExe ：$($_.Exception.Message)" }
        Start-Sleep -Milliseconds 800
    }
}
$size = (Get-Item $dstExe).Length / 1MB
Write-Host ("完成：{0}（{1:N1} MB）" -f $OutName, $size) -ForegroundColor Green
