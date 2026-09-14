# 用一张源图生成多尺寸的 .ico（Windows 图标需要包含多个尺寸才清晰）
# 源图默认取 build\icon-source.png（碧蓝幻想官方的触屏图标）
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root   = Split-Path -Parent $PSScriptRoot
$source = Join-Path $root 'build\icon-source.png'
$output = Join-Path $root 'Grancache.ico'

if (-not (Test-Path $source)) { throw "找不到源图：$source" }

$sizes = @(16, 24, 32, 48, 64, 128, 144, 256)
$src = [System.Drawing.Image]::FromFile($source)
Write-Host ("源图 {0}x{1}，生成 {2} 个尺寸..." -f $src.Width, $src.Height, $sizes.Count)

$entries = @()
foreach ($s in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap($s, $s)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.DrawImage($src, 0, 0, $s, $s)
    $g.Dispose()

    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $entries += [pscustomobject]@{ Size = $s; Data = $ms.ToArray() }
    $ms.Dispose()
    $bmp.Dispose()
}
$src.Dispose()

# 组装 ICO：6 字节头 + 每个尺寸 16 字节目录 + PNG 数据
$fs = [System.IO.File]::Create($output)
$bw = New-Object System.IO.BinaryWriter($fs)
$bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]$entries.Count)
$offset = 6 + 16 * $entries.Count
foreach ($e in $entries) {
    $dim = if ($e.Size -ge 256) { 0 } else { $e.Size }
    $bw.Write([byte]$dim); $bw.Write([byte]$dim)
    $bw.Write([byte]0); $bw.Write([byte]0)      # 调色板 / 保留
    $bw.Write([UInt16]1); $bw.Write([UInt16]32) # 平面数 / 位深
    $bw.Write([UInt32]$e.Data.Length)
    $bw.Write([UInt32]$offset)
    $offset += $e.Data.Length
}
foreach ($e in $entries) { $bw.Write($e.Data) }
$bw.Close(); $fs.Close()

Write-Host ("已生成 {0}（{1:N1} KB）" -f $output, ((Get-Item $output).Length / 1KB)) -ForegroundColor Green
