param(
  [Parameter(Mandatory=$true)]
  [string]$InPath,

  [Parameter(Mandatory=$true)]
  [string]$OutDir,

  [int]$LivingCutoffYears = 110,

  [switch]$NoRedactLiving,
  [switch]$NoRedactPrivate
)

$repoRoot = Split-Path -Parent $PSScriptRoot | Split-Path -Parent
$venvPy = Join-Path $repoRoot ".venv\Scripts\python.exe"
$python = if (Test-Path $venvPy) { $venvPy } else { "python" }

Write-Host "Exporting Gramps package:" $InPath
Write-Host "Writing to:" $OutDir

$argsList = @(
  (Join-Path $PSScriptRoot "export_gramps_package.py"),
  "--in", $InPath,
  "--out-dir", $OutDir,
  "--living-cutoff-years", $LivingCutoffYears
)

if ($NoRedactLiving) { $argsList += "--no-redact-living" }
if ($NoRedactPrivate) { $argsList += "--no-redact-private" }

& $python @argsList

if ($LASTEXITCODE -ne 0) {
  throw "export_gramps_package.py failed with exit code $LASTEXITCODE"
}
