$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$electronExecutable = Join-Path $projectRoot ".runtime\electron.exe"

if (-not (Test-Path $electronExecutable)) {
  throw "The verified Electron runtime is missing. Run npm install first."
}

& $electronExecutable $projectRoot
exit $LASTEXITCODE
