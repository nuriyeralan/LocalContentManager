$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression.FileSystem

$version = "45.1.0"
$archiveName = "electron-v$version-win32-x64.zip"
$expectedSha256 = "55eaba17abff7b5bba6c3bbc85068967379024fe742fe9c7fdba9118922ccbe2"
$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimeDirectory = Join-Path $projectRoot ".runtime"
$runtimeVersionFile = Join-Path $runtimeDirectory "version"
$electronExecutable = Join-Path $runtimeDirectory "electron.exe"

function Remove-DirectoryWithRetry([string] $path) {
  for ($attempt = 1; $attempt -le 6; $attempt += 1) {
    try {
      if (Test-Path $path) {
        Remove-Item $path -Recurse -Force
      }
      return
    }
    catch {
      if ($attempt -eq 6) {
        throw
      }
      Start-Sleep -Milliseconds 500
    }
  }
}

if ((Test-Path $electronExecutable) -and (Test-Path $runtimeVersionFile)) {
  $installedVersion = (Get-Content $runtimeVersionFile -Raw).Trim()
  if ($installedVersion -eq $version) {
    Write-Output "Electron $version is already installed."
    exit 0
  }
}

$downloadUri = "https://github.com/electron/electron/releases/download/v$version/$archiveName"
$temporaryArchive = Join-Path ([System.IO.Path]::GetTempPath()) "local-content-manager-$archiveName-$PID"
$stagingDirectory = "$runtimeDirectory.staging-$PID"

try {
  Write-Output "Downloading Electron $version from the official GitHub release..."
  Invoke-WebRequest -Uri $downloadUri -OutFile $temporaryArchive -UseBasicParsing

  $actualSha256 = (Get-FileHash $temporaryArchive -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualSha256 -ne $expectedSha256) {
    throw "Electron archive checksum mismatch. Expected $expectedSha256 but received $actualSha256."
  }

  Remove-DirectoryWithRetry $stagingDirectory
  [System.IO.Compression.ZipFile]::ExtractToDirectory($temporaryArchive, $stagingDirectory)

  $stagedExecutable = Join-Path $stagingDirectory "electron.exe"
  if (-not (Test-Path $stagedExecutable)) {
    throw "The verified Electron archive did not contain electron.exe."
  }

  Set-Content -Path (Join-Path $stagingDirectory "version") -Value $version -NoNewline
  if (Test-Path $runtimeDirectory) {
    Remove-DirectoryWithRetry $runtimeDirectory
  }
  Move-Item $stagingDirectory $runtimeDirectory
  Write-Output "Installed verified Electron $version runtime."
}
finally {
  if (Test-Path $temporaryArchive) {
    Remove-Item $temporaryArchive -Force
  }
  if (Test-Path $stagingDirectory) {
    try {
      Remove-DirectoryWithRetry $stagingDirectory
    }
    catch {
      Write-Warning "Could not remove temporary staging directory: $stagingDirectory"
    }
  }
}
