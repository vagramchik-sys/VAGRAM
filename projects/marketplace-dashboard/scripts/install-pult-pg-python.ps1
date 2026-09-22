param([string]$RuntimeRoot = (Join-Path $env:LOCALAPPDATA 'Pult/PostgreSQL'))
$ErrorActionPreference = 'Stop'
$RuntimeRoot = [IO.Path]::GetFullPath($RuntimeRoot)
$version = '3.13.15'
$expectedHash = 'd1f04d990aee1253d8569e8e5104e30fa9f5fa830899f14843448872d936a2cf'
$pgLib = Join-Path $RuntimeRoot '18.6/lib'
$pgBin = Join-Path $RuntimeRoot '18.6/bin'
$pythonRoot = Join-Path $RuntimeRoot ('python-' + $version)
$archive = Join-Path $RuntimeRoot ('python-' + $version + '-embed-amd64.zip')
if (-not (Test-Path -LiteralPath (Join-Path $pgLib 'plpython3.dll') -PathType Leaf)) { throw 'POSTGRES_PLPYTHON_MISSING' }
foreach ($target in @($RuntimeRoot,$pgLib,$pgBin,$pythonRoot,$archive)) {
  $cursor = $target
  while ($cursor) {
    if ((Test-Path -LiteralPath $cursor) -and ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'LINKED_RUNTIME_PATH' }
    $parent = Split-Path -Parent $cursor
    if ($parent -eq $cursor) { break }
    $cursor = $parent
  }
}
if (-not (Test-Path -LiteralPath $archive)) {
  Invoke-WebRequest -Uri "https://www.python.org/ftp/python/$version/python-$version-embed-amd64.zip" -OutFile $archive
}
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash) { throw 'PYTHON_ARCHIVE_HASH_MISMATCH' }
if (-not (Test-Path -LiteralPath $pythonRoot)) { Expand-Archive -LiteralPath $archive -DestinationPath $pythonRoot }
$dll = Join-Path $pythonRoot 'python313.dll'
$signature = Get-AuthenticodeSignature -LiteralPath $dll
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Python Software Foundation') { throw 'PYTHON_SIGNATURE_INVALID' }
# The dependent DLL lives beside postgres.exe. An isolated ._pth pins its stdlib
# and extension-module directory; no PATH, registry or system Python is changed.
$targetDll = Join-Path $pgBin 'python313.dll'
if (Test-Path -LiteralPath $targetDll) {
  if ((Get-FileHash -LiteralPath $targetDll).Hash -ne (Get-FileHash -LiteralPath $dll).Hash) { throw 'EXISTING_PYTHON_DLL_DIFFERS' }
} else { Copy-Item -LiteralPath $dll -Destination $targetDll }
$pth = Join-Path $pgBin 'python313._pth'
$content = (Join-Path $pythonRoot 'python313.zip') + "`n" + $pythonRoot + "`n"
if (Test-Path -LiteralPath $pth) {
  if ([IO.File]::ReadAllText($pth).Replace("`r`n","`n") -ne $content) { throw 'EXISTING_PYTHON_PATH_DIFFERS' }
} else { [IO.File]::WriteAllText($pth,$content,[Text.UTF8Encoding]::new($false)) }
& (Join-Path $pythonRoot 'python.exe') -I -c 'import sys,ssl,ctypes,json; print(json.dumps(dict(python=sys.version.split()[0],tls=ssl.OPENSSL_VERSION,isolated=bool(sys.flags.isolated))))'
if ($LASTEXITCODE -ne 0) { throw 'PYTHON_RUNTIME_CHECK_FAILED' }
Write-Output 'Verified Python runtime installed. PostgreSQL has not been restarted; databases are unchanged.'
