$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$manifest = Get-Content (Join-Path $projectRoot "package.json") -Raw | ConvertFrom-Json
$version = [string] $manifest.version
$semverPattern = '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$'
if ($version -notmatch $semverPattern) {
  throw "package.json version '$version' is not valid Semantic Versioning."
}

$runtimeExecutable = Join-Path $projectRoot ".runtime\electron.exe"
$runtimeVersionFile = Join-Path $projectRoot ".runtime\version"
if (-not (Test-Path $runtimeExecutable) -or -not (Test-Path $runtimeVersionFile)) {
  throw "The verified Electron runtime is missing. Run npm install first."
}

$compilerCandidates = @(
  (Join-Path $env:LOCALAPPDATA "Programs\Inno Setup 7\ISCC.exe"),
  (Join-Path $env:ProgramFiles "Inno Setup 7\ISCC.exe")
)
$compilerPath = $compilerCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $compilerPath) {
  throw "Inno Setup 7.1.1 is required. Install JRSoftware.InnoSetup.7 through WinGet."
}
$compilerVersion = (& $compilerPath --version | Select-Object -First 1).Trim()
if ($compilerVersion -ne "7.1.1") {
  throw "Expected Inno Setup 7.1.1 but found $compilerVersion."
}

$distDirectory = Join-Path $projectRoot "dist"
$installerName = "LocalContentManager-Setup-$version.exe"
$installerPath = Join-Path $distDirectory $installerName
$scriptPath = Join-Path $projectRoot "installer\LocalContentManager.iss"
New-Item -ItemType Directory -Path $distDirectory -Force | Out-Null
if (Test-Path $installerPath) {
  Remove-Item $installerPath -Force
}

& $compilerPath `
  "/DAppVersion=$version" `
  "/DSourceRoot=$projectRoot" `
  "/DOutputDir=$distDirectory" `
  $scriptPath
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $installerPath)) {
  throw "Inno Setup failed to create the installer."
}

$hash = (Get-FileHash $installerPath -Algorithm SHA256).Hash.ToLowerInvariant()
Set-Content -Path "$installerPath.sha256" -Value "$hash  $installerName" -Encoding ASCII
Write-Output "Created $installerPath"
Write-Output "SHA-256: $hash"
