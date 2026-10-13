#!/usr/bin/env bash
# Builds a portable Windows folder: Sonika-windows/ with node.exe, ffmpeg,
# the app, fonts, a hidden launcher and a "Create Desktop Shortcut" helper.
# Usage: scripts/build-windows.sh [outdir]   → <outdir>/Sonika-windows.zip
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/dist}"
NODE_VERSION="${NODE_VERSION:-22.22.0}"
WORK="$OUT/work"
APP="$OUT/Sonika-windows"
rm -rf "$APP" "$WORK"
mkdir -p "$WORK" "$APP/bin" "$APP/app" "$APP/fonts"

LITE="${LITE:-0}"
if [ "$LITE" = "1" ]; then
echo "→ lite build: node/ffmpeg are downloaded by Setup.bat on first run"
else
echo "→ node $NODE_VERSION (win-x64)"
curl -fsSL -o "$WORK/node.zip" "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-win-x64.zip"
unzip -q -j "$WORK/node.zip" "node-v$NODE_VERSION-win-x64/node.exe" "node-v$NODE_VERSION-win-x64/LICENSE" -d "$WORK/node"
cp "$WORK/node/node.exe" "$APP/bin/node.exe"
cp "$WORK/node/LICENSE" "$APP/bin/LICENSE-node.txt"

echo "→ ffmpeg (gyan.dev release essentials)"
curl -fsSL -o "$WORK/ffmpeg.zip" "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"
unzip -q "$WORK/ffmpeg.zip" -d "$WORK/ffmpeg"
FFDIR="$(find "$WORK/ffmpeg" -maxdepth 1 -type d -name 'ffmpeg-*' | head -1)"
cp "$FFDIR/bin/ffmpeg.exe" "$FFDIR/bin/ffprobe.exe" "$APP/bin/"
cp "$FFDIR/LICENSE" "$APP/bin/LICENSE-ffmpeg.txt" 2>/dev/null || true
fi

echo "→ app + production dependencies"
cp -r "$ROOT/server" "$ROOT/web" "$ROOT/package.json" "$ROOT/package-lock.json" "$APP/app/"
(cd "$APP/app" && npm ci --omit=dev --no-audit --no-fund --silent)
rm -f "$APP/app/package-lock.json"

echo "→ font"
cp /usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf "$APP/fonts/DejaVuSans-Bold.ttf"

echo "→ icon"
python3 - "$APP/sonika.ico" <<'PY'
import sys
from PIL import Image, ImageDraw, ImageFont
out = sys.argv[1]
sizes = [256, 128, 64, 48, 32, 16]
imgs = []
for n in sizes:
    im = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    r = n * 0.22
    d.rounded_rectangle([0, 0, n - 1, n - 1], radius=r, fill=(10, 12, 17, 255))
    gold = (245, 185, 66, 255)
    w = max(1, round(n * 0.09))
    for i, (x0, x1) in enumerate([(0.28, 0.72), (0.28, 0.60), (0.28, 0.72)]):
        y = n * (0.34 + i * 0.16)
        d.line([(n * x0, y), (n * x1, y)], fill=gold, width=w)
    d.ellipse([n * 0.68, n * 0.43, n * 0.68 + n * 0.14, n * 0.43 + n * 0.14], fill=gold)
    imgs.append(im)
imgs[0].save(out, format="ICO", sizes=[(n, n) for n in sizes], append_images=imgs[1:])
PY

echo "→ setup (first-run download of node + ffmpeg)"
cat > "$APP/setup.ps1" <<PS1
\$ErrorActionPreference = "Stop"
\$root = Split-Path -Parent \$MyInvocation.MyCommand.Path
\$bin = Join-Path \$root "bin"
\$tmp = Join-Path \$env:TEMP "sonika-setup"
New-Item -ItemType Directory -Force \$bin | Out-Null
New-Item -ItemType Directory -Force \$tmp | Out-Null
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
function Get-File(\$url, \$dest, \$label) {
  Write-Host ""
  Write-Host "Downloading \$label ..." -ForegroundColor Yellow
  try { Import-Module BitsTransfer -ErrorAction Stop; Start-BitsTransfer -Source \$url -Destination \$dest -Description \$label }
  catch { \$ProgressPreference = "SilentlyContinue"; Invoke-WebRequest \$url -OutFile \$dest -UseBasicParsing }
}
if (!(Test-Path "\$bin\\node.exe")) {
  Get-File "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-win-x64.zip" "\$tmp\\node.zip" "Node.js runtime (about 30 MB)"
  Expand-Archive "\$tmp\\node.zip" -DestinationPath "\$tmp\\node" -Force
  Copy-Item "\$tmp\\node\\node-v$NODE_VERSION-win-x64\\node.exe" "\$bin\\node.exe"
}
if (!(Test-Path "\$bin\\ffmpeg.exe") -or !(Test-Path "\$bin\\ffprobe.exe")) {
  Get-File "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip" "\$tmp\\ffmpeg.zip" "FFmpeg video engine (about 90 MB)"
  Expand-Archive "\$tmp\\ffmpeg.zip" -DestinationPath "\$tmp\\ffmpeg" -Force
  \$ff = Get-ChildItem "\$tmp\\ffmpeg" -Directory | Select-Object -First 1
  Copy-Item (Join-Path \$ff.FullName "bin\\ffmpeg.exe") "\$bin\\ffmpeg.exe"
  Copy-Item (Join-Path \$ff.FullName "bin\\ffprobe.exe") "\$bin\\ffprobe.exe"
}
Remove-Item \$tmp -Recurse -Force -ErrorAction SilentlyContinue
Write-Host ""
Write-Host "Setup complete. Sonika will open in your browser." -ForegroundColor Green
Start-Sleep -Seconds 2
PS1

cat > "$APP/Setup.bat" <<'BAT'
@echo off
title Sonika setup
echo This one-time setup downloads the video engine (about 120 MB). Please wait...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1"
if errorlevel 1 (
  echo.
  echo Setup failed. Check your internet connection and run Setup.bat again.
  pause
  exit /b 1
)
BAT

echo "→ launchers"
cat > "$APP/Sonika.vbs" <<'VBS'
' Sonika launcher: starts the editor silently and opens it in your browser.
Option Explicit
Dim sh, fso, root, env, dataDir, port, logFile, http, i, running
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
port = "8080"
dataDir = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Sonika\data"
If Not fso.FolderExists(sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Sonika") Then fso.CreateFolder(sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Sonika")
logFile = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Sonika\sonika.log"

Function IsUp()
  On Error Resume Next
  Set http = CreateObject("MSXML2.XMLHTTP")
  http.Open "GET", "http://localhost:" & port & "/api/health", False
  http.Send
  IsUp = (Err.Number = 0 And http.Status = 200)
  Err.Clear
End Function

If Not (fso.FileExists(root & "\bin\node.exe") And fso.FileExists(root & "\bin\ffmpeg.exe") And fso.FileExists(root & "\bin\ffprobe.exe")) Then
  If sh.Run("""" & root & "\Setup.bat""", 1, True) <> 0 Then WScript.Quit 1
End If

If Not IsUp() Then
  Set env = sh.Environment("PROCESS")
  env("PORT") = port
  env("DATA_DIR") = dataDir
  env("FFMPEG_PATH") = root & "\bin\ffmpeg.exe"
  env("FFPROBE_PATH") = root & "\bin\ffprobe.exe"
  env("FONT_FILE") = root & "\fonts\DejaVuSans-Bold.ttf"
  sh.Run "cmd /c """"" & root & "\bin\node.exe"" """ & root & "\app\server\index.js"" > """ & logFile & """ 2>&1""", 0, False
  running = False
  For i = 1 To 60
    WScript.Sleep 500
    If IsUp() Then
      running = True
      Exit For
    End If
  Next
  If Not running Then
    MsgBox "Sonika did not start. Check the log at:" & vbCrLf & logFile, 48, "Sonika"
    WScript.Quit 1
  End If
End If
sh.Run "http://localhost:" & port, 1, False
VBS

cat > "$APP/Sonika (show console).bat" <<'BAT'
@echo off
rem Starts Sonika with a visible window so you can see what it is doing.
setlocal
set "ROOT=%~dp0"
set "PORT=8080"
set "DATA_DIR=%LOCALAPPDATA%\Sonika\data"
set "FFMPEG_PATH=%ROOT%bin\ffmpeg.exe"
set "FFPROBE_PATH=%ROOT%bin\ffprobe.exe"
set "FONT_FILE=%ROOT%fonts\DejaVuSans-Bold.ttf"
echo Starting Sonika on http://localhost:%PORT% ...
start "" /b cmd /c "timeout /t 3 >nul & start http://localhost:%PORT%"
"%ROOT%bin\node.exe" "%ROOT%app\server\index.js"
pause
BAT

cat > "$APP/Stop Sonika.bat" <<'BAT'
@echo off
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*app\server\index.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
echo Sonika stopped.
timeout /t 2 >nul
BAT

cat > "$APP/Create Desktop Shortcut.bat" <<'BAT'
@echo off
setlocal
set "ROOT=%~dp0"
powershell -NoProfile -Command ^
  "$s = (New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Desktop') + '\Sonika.lnk');" ^
  "$s.TargetPath = 'wscript.exe';" ^
  "$s.Arguments = '\"%ROOT%Sonika.vbs\"';" ^
  "$s.WorkingDirectory = '%ROOT%';" ^
  "$s.IconLocation = '%ROOT%sonika.ico';" ^
  "$s.Description = 'Sonika - Claude cuts, you adjust';" ^
  "$s.Save()"
echo A "Sonika" shortcut is now on your Desktop. You can also pin it to the taskbar or Start menu.
timeout /t 4 >nul
BAT

cat > "$APP/README.txt" <<'TXT'
SONIKA - Claude cuts, you adjust, it renders
============================================

FIRST TIME
  1. Unzip this folder anywhere (for example C:\Sonika). Don't unzip into a OneDrive folder.
  2. Double-click "Create Desktop Shortcut.bat"  -> a Sonika icon appears on your Desktop.
  3. Double-click the Sonika icon. The first time, a black window downloads the video
     engine (about 120 MB, one time only). Then your browser opens the editor.
  4. A Settings window appears: paste your Claude API key (console.anthropic.com -> API keys)
     and confirm your Google Drive folder. Click Save.

EVERY DAY
  Sonika icon -> New project -> "+ Add footage" -> pick the clips from your Drive folder
  -> Claude tab -> write the brief -> "Build the first cut" -> adjust -> Render final.
  Renders are saved under %LOCALAPPDATA%\Sonika\data and can be downloaded from the Renders tab.

IF SOMETHING LOOKS WRONG
  "Sonika (show console).bat" starts it with a visible window that shows what it is doing.
  The log is at %LOCALAPPDATA%\Sonika\sonika.log.
  "Stop Sonika.bat" closes the background server.

Windows SmartScreen may warn the first time because the launcher is not code-signed:
click "More info" -> "Run anyway".
TXT

echo "→ zip"
rm -rf "$WORK"
ZIP="Sonika-windows.zip"; [ "$LITE" = "1" ] && ZIP="Sonika-windows-setup.zip"
(cd "$OUT" && rm -f "$ZIP" && zip -qr "$ZIP" Sonika-windows)
du -sh "$OUT/$ZIP" "$APP"
echo "done: $OUT/$ZIP"
