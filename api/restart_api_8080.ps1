$ErrorActionPreference = 'Stop'

$apiDir = $PSScriptRoot
$root = Split-Path -Parent $apiDir
$py = Join-Path $root ".venv\Scripts\python.exe"

$port = 8081
if ($env:TREE_PORT) {
  try { $port = [int]$env:TREE_PORT } catch { throw "Invalid TREE_PORT: $($env:TREE_PORT)" }
}

if (-not (Test-Path $py)) {
  throw "Missing venv python: $py"
}

if (-not $env:DATABASE_URL) {
  $env:DATABASE_URL = "postgresql://postgres:polini@localhost:5432/genealogy"
}

# Stop current listener (if any)
$conn = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1
if ($conn -and $conn.OwningProcess -gt 0) {
  try { Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue } catch {}
}

$reports = Join-Path $root "reports"
if (-not (Test-Path $reports)) { New-Item -ItemType Directory -Path $reports | Out-Null }

$stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$outLog = Join-Path $reports ("uvicorn_" + $stamp + ".out.log")
$errLog = Join-Path $reports ("uvicorn_" + $stamp + ".err.log")

Start-Process -FilePath $py -WorkingDirectory $apiDir -ArgumentList @(
  '-m','uvicorn','main:app','--host','127.0.0.1','--port',$port
) -RedirectStandardOutput $outLog -RedirectStandardError $errLog -WindowStyle Hidden

Write-Output "Restarted API on http://127.0.0.1:$port"
Write-Output "Logs: $outLog"
Write-Output "      $errLog"
