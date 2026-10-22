# App icon

The Windows icons (taskbar, Start menu, shortcuts, installer) are the
project's own BananaConn. icon artwork, used as supplied
(design/bananaconn-icon-source.png, 175x197): the drawing itself is unchanged;
the empty background around it is trimmed so it fills 98% of the square (as
other taskbar icons do), the square is filled with the artwork's own
background colour (#0B0D10), and the result is scaled to each icon size
(design/icon-fill.ps1 → design/bananaconn-icon-1024.png → `npx tauri icon`). The in-app logo
(src/assets/app-icon-*.png) is the vector mark design/bananaconn-mark.svg.

Icons up to 0.7.28 used the Banana emoji of Microsoft Fluent Emoji (MIT
License); that artwork is no longer part of the icon.
