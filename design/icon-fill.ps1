# Makes the 1024 px app icon from the supplied artwork
# (design/bananaconn-icon-source.png): the drawing is not changed; the empty
# background around it is trimmed so it fills the square like other taskbar
# icons, then the square is padded with the artwork's own background colour.
#   powershell -File design/icon-fill.ps1 [-Fill 0.94] [-Out design/bananaconn-icon-1024.png]
param([double]$Fill = 0.94, [string]$Out = "$PSScriptRoot\bananaconn-icon-1024.png")
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Bitmap]::new("$PSScriptRoot\bananaconn-icon-source.png")
$bg = $src.GetPixel(2, 2)
# Bounding box of everything that differs clearly from the background.
$minX = $src.Width; $minY = $src.Height; $maxX = -1; $maxY = -1
for ($y = 0; $y -lt $src.Height; $y++) {
  for ($x = 0; $x -lt $src.Width; $x++) {
    $c = $src.GetPixel($x, $y)
    if ([math]::Abs($c.R - $bg.R) + [math]::Abs($c.G - $bg.G) + [math]::Abs($c.B - $bg.B) -gt 60) {
      if ($x -lt $minX) { $minX = $x }; if ($x -gt $maxX) { $maxX = $x }
      if ($y -lt $minY) { $minY = $y }; if ($y -gt $maxY) { $maxY = $y }
    }
  }
}
$w = $maxX - $minX + 1; $h = $maxY - $minY + 1
"background $bg; drawing ${w}x${h} at ($minX,$minY) in $($src.Width)x$($src.Height)"
$size = 1024
$scale = $Fill * $size / [math]::Max($w, $h)
$dw = $w * $scale; $dh = $h * $scale
$canvas = [System.Drawing.Bitmap]::new($size, $size)
$g = [System.Drawing.Graphics]::FromImage($canvas)
$g.Clear($bg)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
# A one-pixel ring of background around the crop keeps the edges soft.
$srcRect = [System.Drawing.RectangleF]::new($minX - 1, $minY - 1, $w + 2, $h + 2)
$dstRect = [System.Drawing.RectangleF]::new(($size - $dw) / 2 - $scale, ($size - $dh) / 2 - $scale, $dw + 2 * $scale, $dh + 2 * $scale)
$g.DrawImage($src, $dstRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
$g.Dispose()
$canvas.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
"drawing fills $([math]::Round(100 * $dh / $size))% of the height, $([math]::Round(100 * $dw / $size))% of the width -> $Out"
