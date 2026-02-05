$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
$restartScript = Join-Path $root 'api\restart_api_8080.ps1'
$py = Join-Path $root '.venv\Scripts\python.exe'

$port = 8081
if ($env:TREE_PORT) {
  try { $port = [int]$env:TREE_PORT } catch { throw "Invalid TREE_PORT: $($env:TREE_PORT)" }
}

if (-not (Test-Path $py)) {
  throw "Missing venv python: $py`nCreate it first, then install api/requirements.txt"
}

# If you already set DATABASE_URL elsewhere, we won't override it.
# Default matches your current local Postgres setup.
if (-not $env:DATABASE_URL) {
  $env:DATABASE_URL = 'postgresql://postgres:polini@localhost:5432/genealogy'
}

if (-not (Test-Path $restartScript)) {
  throw "Missing script: $restartScript"
}

Write-Output "Starting Tree API (DATABASE_URL=$($env:DATABASE_URL))"
& $restartScript

# Give the process a moment to bind the port, then open the UI
Start-Sleep -Milliseconds 800
Start-Process ("http://127.0.0.1:$port/demo/relationship")

Write-Output "Opened: http://127.0.0.1:$port/demo/relationship"
Write-Output "If it doesn't load, check the latest uvicorn logs in ./reports/" 
