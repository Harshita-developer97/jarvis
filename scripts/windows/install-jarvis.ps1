# JARVIS — Windows 11 (8 GB RAM) Guided Installer & Local AI Setup
# Run in PowerShell: powershell -ExecutionPolicy Bypass -File .\scripts\windows\install-jarvis.ps1

$ErrorActionPreference = "Stop"
Write-Host "=== JARVIS Windows 11 Installer ===" -ForegroundColor Cyan

$RootDir = Resolve-Path (Join-Path $PSScriptRoot "..\..")
Set-Location $RootDir

# 1. Check Node.js 22+
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "Node.js not found. Installing Node.js LTS via winget..." -ForegroundColor Yellow
    winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
} else {
    Write-Host "Node.js detected: $(node -v)" -ForegroundColor Green
}

# 2. Install npm dependencies & build frontend
Write-Host "Installing npm packages..." -ForegroundColor Cyan
npm install
Write-Host "Building production frontend..." -ForegroundColor Cyan
npm run build

# 3. Check Ollama & pull 8GB-RAM quantized model
if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
    Write-Host "Ollama not found. Installing Ollama via winget..." -ForegroundColor Yellow
    winget install Ollama.Ollama --accept-package-agreements --accept-source-agreements
}

if (Get-Command ollama -ErrorAction SilentlyContinue) {
    Write-Host "Pulling lightweight 8GB-RAM model (qwen2.5:3b)..." -ForegroundColor Cyan
    Start-Process -FilePath "ollama" -ArgumentList "serve" -WindowStyle Hidden -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    ollama pull qwen2.5:3b
}

# 4. Optional Rust/Cargo check for Tauri native build
if (Get-Command cargo -ErrorAction SilentlyContinue) {
    Write-Host "Rust/Cargo detected. You can build the native Windows installer with: npx @tauri-apps/cli build" -ForegroundColor Green
} else {
    Write-Host "Rust/Cargo not installed (optional for native .msi/.exe). Browser/launcher mode is ready." -ForegroundColor DarkYellow
}

# 5. Create Desktop Launcher shortcut
$DesktopPath = [Environment]::GetFolderPath("Desktop")
$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut((Join-Path $DesktopPath "JARVIS.lnk"))
$Shortcut.TargetPath = (Join-Path $RootDir "scripts\windows\start-jarvis.bat")
$Shortcut.WorkingDirectory = $RootDir
$Shortcut.Description = "Launch JARVIS Local Autonomous AI OS"
$Shortcut.Save()

Write-Host "Installation complete! Double-click 'JARVIS' on your Desktop to start." -ForegroundColor Green
