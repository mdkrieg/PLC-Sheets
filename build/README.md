# Build resources

`electron-builder` looks here for `icon.png`, `icon.ico` (Windows), and
optional `installerIcon.ico`. Drop your icon assets into this folder before
running `npm run package`. If absent, electron-builder uses Electron's
default icon — fine for development but not for shipping.

Recommended sizes:
- `icon.png`  — 512×512 (Linux AppImage / deb)
- `icon.ico`  — multi-size (16/24/32/48/64/128/256 px) for Windows installer/exe
