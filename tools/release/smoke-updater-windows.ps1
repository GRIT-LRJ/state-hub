param(
  [Parameter(Mandatory = $true)][string]$BaselineInstaller,
  [Parameter(Mandatory = $true)][string]$CandidateArtifact,
  [Parameter(Mandatory = $true)][string]$InvalidArtifact
)

$ErrorActionPreference = 'Stop'
$tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$installDir = Join-Path $tempRoot ('state-hub-updater-install-' + [guid]::NewGuid().ToString('N'))
try {
  $result = Start-Process -FilePath (Resolve-Path -LiteralPath $BaselineInstaller).Path -ArgumentList @('/S', "/D=$installDir") -WindowStyle Hidden -Wait -PassThru
  if ($result.ExitCode -ne 0) { throw 'Baseline NSIS installation failed' }
  $apps = @(Get-ChildItem -LiteralPath $installDir -Recurse -File -Filter '*.exe' |
    Where-Object { $_.Name -notmatch '^(unins|uninstall|state-hub-core)' })
  if ($apps.Count -ne 1) { throw "Expected one installed desktop app; found $($apps.Count)" }
  node tools/release/updater-smoke.mjs $apps[0].FullName $CandidateArtifact ($CandidateArtifact + '.sig') $InvalidArtifact ($InvalidArtifact + '.sig') $env:STATE_HUB_SMOKE_BASE_VERSION $env:STATE_HUB_SMOKE_CANDIDATE_VERSION
  if ($LASTEXITCODE -ne 0) { throw 'Windows updater smoke failed' }
  $uninstallers = @(Get-ChildItem -LiteralPath $installDir -Recurse -File -Filter '*.exe' |
    Where-Object { $_.Name -match '^(unins|uninstall)' })
  if ($uninstallers.Count -ne 1) { throw 'Updater smoke uninstaller missing' }
  $uninstall = Start-Process -FilePath $uninstallers[0].FullName -ArgumentList '/S' -WindowStyle Hidden -Wait -PassThru
  if ($uninstall.ExitCode -ne 0) { throw 'Updater smoke uninstall failed' }
  if (Test-Path -LiteralPath $apps[0].FullName) { throw 'Updated application remained after uninstall' }
} finally {
  $resolved = [System.IO.Path]::GetFullPath($installDir)
  if ($resolved.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase) -and
      [System.IO.Path]::GetFileName($resolved).StartsWith('state-hub-updater-install-')) {
    $cleanupUninstaller = Join-Path $resolved 'uninstall.exe'
    if (Test-Path -LiteralPath $cleanupUninstaller) {
      Start-Process -FilePath $cleanupUninstaller -ArgumentList '/S' -WindowStyle Hidden -Wait | Out-Null
    }
    if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
  } else { throw 'Unexpected updater smoke path; refusing cleanup' }
}
