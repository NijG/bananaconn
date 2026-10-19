# Every icon size from the dot-less banana, with the red dot as exactly one
# pixel at the top of the fruit (drawn after resizing, so it stays 1x1 and red).
param([string]$Source, [string]$IconsDir, [string]$UiDir, [double]$DotX = 546.6, [double]$DotY = 93.6, [string]$PreviewDir = "")
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile($Source)
$red = [System.Drawing.Color]::FromArgb(255, 0xE8, 0x30, 0x2C)
# Dot centre in the 1024 source: ($DotX, $DotY).
function Make([int]$size, [string]$out) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $g.DrawImage($src, 0, 0, $size, $size)
  $g.Dispose()
  $x = [math]::Floor($DotX / 1024 * $size); $y = [math]::Floor($DotY / 1024 * $size)
  $bmp.SetPixel($x, $y, $red)
  $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  "$size -> ($x,$y) $out"
}
# Preview only: the UI sizes into PreviewDir, nothing else is written.
if ($PreviewDir) { foreach ($s in 24, 48, 96, 256) { Make $s (Join-Path $PreviewDir "new-$s.png") }; $src.Dispose(); return }
# Every PNG tauri generated, at its own size.
Get-ChildItem $IconsDir -Filter *.png | ForEach-Object {
  $img = [System.Drawing.Image]::FromFile($_.FullName); $n = $img.Width; $img.Dispose()
  Make $n $_.FullName
}
# icon.ico: PNG entries (Windows Vista and later read them for every size).
$sizes = 16, 24, 32, 48, 64, 128, 256
$pngs = foreach ($s in $sizes) { $f = Join-Path $env:TEMP "bx-ico-$s.png"; Make $s $f | Out-Null; ,[System.IO.File]::ReadAllBytes($f) }
$ms = New-Object System.IO.MemoryStream; $w = New-Object System.IO.BinaryWriter $ms
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $s = $sizes[$i]; $d = $pngs[$i]
  $w.Write([byte]($(if ($s -ge 256) { 0 } else { $s }))); $w.Write([byte]($(if ($s -ge 256) { 0 } else { $s })))
  $w.Write([byte]0); $w.Write([byte]0); $w.Write([uint16]1); $w.Write([uint16]32)
  $w.Write([uint32]$d.Length); $w.Write([uint32]$offset); $offset += $d.Length
}
foreach ($d in $pngs) { $w.Write($d) }
[System.IO.File]::WriteAllBytes((Join-Path $IconsDir "icon.ico"), $ms.ToArray())
"icon.ico: $($sizes -join ',')"
# The app's own UI (title bar 24 px, home 48 px), 1x and 2x.
foreach ($s in 24, 48, 96) { Make $s (Join-Path $UiDir "app-icon-$s.png") }
$src.Dispose()
