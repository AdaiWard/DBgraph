$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Test-Path -LiteralPath ".venv")) {
    Write-Host "Creating .venv..."
    python -m venv .venv
}

& .\.venv\Scripts\python.exe -m pip install -q -r requirements.txt

Write-Host ""
Write-Host "  DB Graph -> http://localhost:8123"
Write-Host ""
& .\.venv\Scripts\python.exe -m uvicorn backend.main:app --host 127.0.0.1 --port 8123
