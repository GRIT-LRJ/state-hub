param([Parameter(Mandatory = $true)][string]$Installer)

$ErrorActionPreference = 'Stop'
$candidate = (Resolve-Path -LiteralPath $Installer).Path
$signature = Get-AuthenticodeSignature -LiteralPath $candidate
if ($signature.Status -ne 'Valid' -or -not $signature.SignerCertificate) {
  throw 'Windows stable installer has no valid Authenticode signature'
}
if ($signature.SignerCertificate.NotAfter -le (Get-Date)) { throw 'Windows signing certificate expired' }
if (-not $signature.TimeStamperCertificate) { throw 'Windows stable installer has no trusted timestamp' }

$tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$tampered = Join-Path $tempRoot ('state-hub-signature-check-' + [guid]::NewGuid().ToString('N') + '.exe')
try {
  Copy-Item -LiteralPath $candidate -Destination $tampered
  $stream = [System.IO.File]::Open($tampered, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite)
  try {
    $offset = [Math]::Min([int64]4096, [Math]::Floor($stream.Length / 2))
    [void]$stream.Seek($offset, [System.IO.SeekOrigin]::Begin)
    $byte = $stream.ReadByte()
    if ($byte -lt 0) { throw 'Installer is empty' }
    [void]$stream.Seek($offset, [System.IO.SeekOrigin]::Begin)
    $stream.WriteByte([byte]($byte -bxor 1))
  } finally { $stream.Dispose() }
  if ((Get-AuthenticodeSignature -LiteralPath $tampered).Status -eq 'Valid') {
    throw 'Authenticode verifier accepted a tampered installer'
  }
} finally {
  $checked = [System.IO.Path]::GetFullPath($tampered)
  if ($checked.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase) -and
      [System.IO.Path]::GetFileName($checked).StartsWith('state-hub-signature-check-')) {
    if (Test-Path -LiteralPath $checked) { Remove-Item -LiteralPath $checked -Force }
  } else { throw 'Unexpected signature test path; refusing cleanup' }
}
Write-Output 'Windows installer signature, timestamp, and tamper rejection verified'
