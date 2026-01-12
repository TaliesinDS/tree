param(
  [Parameter(Mandatory=$true)]
  [string]$ExportDir,

  [Parameter(Mandatory=$true)]
  [string]$DatabaseUrl,

  [switch]$Truncate
)

$repoRoot = Split-Path -Parent $PSScriptRoot | Split-Path -Parent
$venvPy = Join-Path $repoRoot ".venv\Scripts\python.exe"
$python = if (Test-Path $venvPy) { $venvPy } else { "python" }

$argsList = @(
  (Join-Path $PSScriptRoot "load_export_to_postgres.py"),
  "--export-dir", $ExportDir,
  "--database-url", $DatabaseUrl
)

if ($Truncate) { $argsList += "--truncate" }

& $python @argsList
if ($LASTEXITCODE -ne 0) {
  throw "load_export_to_postgres.py failed with exit code $LASTEXITCODE"
}
