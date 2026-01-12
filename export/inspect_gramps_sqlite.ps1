param(
  [Parameter(Mandatory=$true)]
  [string]$DbPath,

  [Parameter(Mandatory=$true)]
  [string]$OutDir
)

$repoRoot = Split-Path -Parent $PSScriptRoot | Split-Path -Parent
$timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$outPath = Join-Path $OutDir ("gramps_schema_" + $timestamp + ".json")

Write-Host "Inspecting SQLite DB:" $DbPath
Write-Host "Writing report to:" $outPath

$venvPy = Join-Path $repoRoot ".venv\Scripts\python.exe"
$python = if (Test-Path $venvPy) { $venvPy } else { "python" }

& $python (Join-Path $PSScriptRoot "inspect_gramps_sqlite.py") --db $DbPath --out $outPath --print

if ($LASTEXITCODE -ne 0) {
  throw "inspect_gramps_sqlite.py failed with exit code $LASTEXITCODE"
}
