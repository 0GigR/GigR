param(
  [int]$BackendPort = 8000,
  [int]$FrontendPort = 5173
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$backendDir = Join-Path $root 'backend'
$frontendDir = Join-Path $root 'frontend'
$venvActivate = Join-Path $root '.venv\Scripts\Activate.ps1'

if (-not (Test-Path $backendDir)) {
  throw "Backend folder not found: $backendDir"
}

if (-not (Test-Path $frontendDir)) {
  throw "Frontend folder not found: $frontendDir"
}

if (-not (Test-Path $venvActivate)) {
  Write-Warning 'No backend virtual environment found at .venv. Falling back to the current shell environment.'
}

$backendCommand = @"
Set-Location '$backendDir';
if (Test-Path '$venvActivate') { . '$venvActivate' };
python -m uvicorn app.main:app --reload --port $BackendPort
"@

$frontendCommand = @"
Set-Location '$frontendDir';
npm run dev
"@

Write-Host 'Starting Gigr backend and frontend...' -ForegroundColor Cyan

Start-Process powershell -ArgumentList '-NoExit', '-Command', $backendCommand
Start-Process powershell -ArgumentList '-NoExit', '-Command', $frontendCommand

Write-Host ""
Write-Host "Backend:  http://localhost:$BackendPort/docs" -ForegroundColor Green
Write-Host "Frontend: http://localhost:$FrontendPort" -ForegroundColor Green
Write-Host ""
Write-Host 'Both processes were started in separate PowerShell windows.' -ForegroundColor Yellow
