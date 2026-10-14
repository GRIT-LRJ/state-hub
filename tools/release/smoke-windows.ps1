param(
  [Parameter(Mandatory = $true)][string]$Installer,
  [int]$Samples = 20
)

$ErrorActionPreference = 'Stop'
$installerPath = (Resolve-Path -LiteralPath $Installer).Path
$tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$installDir = Join-Path $tempRoot ('state-hub-nsis-smoke-' + [guid]::NewGuid().ToString('N'))

try {
  $install = Start-Process -FilePath $installerPath -ArgumentList @('/S', "/D=$installDir") -WindowStyle Hidden -Wait -PassThru
  if ($install.ExitCode -ne 0) { throw "NSIS installation failed with exit code $($install.ExitCode)" }
  $apps = @(Get-ChildItem -LiteralPath $installDir -Recurse -File -Filter '*.exe' |
    Where-Object { $_.Name -notmatch '^(unins|uninstall|state-hub-core)' })
  if ($apps.Count -ne 1) { throw "Expected one installed desktop executable; found $($apps.Count)" }

  node tools/release/installed-smoke.mjs $apps[0].FullName $Samples
  if ($LASTEXITCODE -ne 0) { throw 'Installed application startup smoke failed' }

  $uninstallers = @(Get-ChildItem -LiteralPath $installDir -Recurse -File -Filter '*.exe' |
    Where-Object { $_.Name -match '^(unins|uninstall)' })
  if ($uninstallers.Count -ne 1) { throw "Expected one uninstaller; found $($uninstallers.Count)" }
  $uninstall = Start-Process -FilePath $uninstallers[0].FullName -ArgumentList '/S' -WindowStyle Hidden -Wait -PassThru
  if ($uninstall.ExitCode -ne 0) { throw "NSIS uninstallation failed with exit code $($uninstall.ExitCode)" }
  if (Test-Path -LiteralPath $apps[0].FullName) { throw 'Desktop executable remained after uninstall' }
  Write-Output 'Windows NSIS install, start, health, first paint and uninstall smoke passed'
} finally {
  $resolved = [System.IO.Path]::GetFullPath($installDir)
  if ($resolved.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase) -and
      [System.IO.Path]::GetFileName($resolved).StartsWith('state-hub-nsis-smoke-')) {
    $cleanupUninstaller = Join-Path $resolved 'uninstall.exe'
    if (Test-Path -LiteralPath $cleanupUninstaller) {
      Start-Process -FilePath $cleanupUninstaller -ArgumentList '/S' -WindowStyle Hidden -Wait | Out-Null
    }
    if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
  } else {
    throw 'Unexpected installer smoke path; refusing cleanup'
  }
}
