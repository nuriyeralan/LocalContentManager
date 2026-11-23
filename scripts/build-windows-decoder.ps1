$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$framework = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319"
if (-not (Test-Path (Join-Path $framework "csc.exe"))) {
  $framework = Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319"
}
$compiler = Join-Path $framework "csc.exe"
$presentation = Join-Path $framework "WPF\PresentationCore.dll"
$windowsBase = Join-Path $framework "WPF\WindowsBase.dll"
$xaml = @(
  (Join-Path $framework "System.Xaml.dll"),
  (Join-Path $framework "WPF\System.Xaml.dll")
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not (Test-Path $compiler) -or -not (Test-Path $presentation) -or -not (Test-Path $windowsBase) -or -not $xaml) {
  throw "The Windows image decoder requires .NET Framework 4.x with WPF, included with supported Windows versions."
}

$outputDirectory = Join-Path $projectRoot ".runtime\wic"
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$staging = Join-Path $outputDirectory "WindowsImageDecoder-$PID.exe"
$output = Join-Path $outputDirectory "WindowsImageDecoder.exe"
try {
  & $compiler /nologo /target:exe /platform:anycpu /optimize+ /warnaserror+ `
    "/reference:$presentation" "/reference:$windowsBase" "/reference:$xaml" "/out:$staging" `
    (Join-Path $projectRoot "native\WindowsImageDecoder.cs")
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path $staging)) {
    throw "The Windows image decoder helper could not be compiled."
  }
  Move-Item -LiteralPath $staging -Destination $output -Force
  Write-Output "Built $output"
}
finally {
  if (Test-Path $staging) { Remove-Item -LiteralPath $staging -Force }
}
