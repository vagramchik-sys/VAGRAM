param(
  [string]$RuntimeRoot = (Join-Path $env:LOCALAPPDATA 'Pult/PostgreSQL'),
  [string]$BootstrapDirectory = (Join-Path $PSScriptRoot '../.private/postgres-setup'),
  [ValidateRange(1024,65535)][int]$Port = 5441,
  [switch]$StartServer
)

# Explicit local setup, not called automatically by Pult or its migration importer.
# No live source files are touched; no firewall rule or Windows service is created.
$ErrorActionPreference = 'Stop'
$RuntimeRoot = [IO.Path]::GetFullPath($RuntimeRoot)
$BootstrapDirectory = [IO.Path]::GetFullPath($BootstrapDirectory)
$binDirectory = Join-Path $RuntimeRoot '18.6/bin'
$dataDirectory = Join-Path $RuntimeRoot 'data'
$adminFile = Join-Path $BootstrapDirectory 'admin.dpapi'
$passwordFile = Join-Path $BootstrapDirectory ('password-' + [guid]::NewGuid().ToString('N') + '.tmp')
foreach ($program in @('initdb.exe','pg_ctl.exe','postgres.exe')) {
  if (-not (Test-Path -LiteralPath (Join-Path $binDirectory $program) -PathType Leaf)) { throw 'Verified PostgreSQL 18.6 binaries are required.' }
}
if ((Test-Path -LiteralPath $dataDirectory) -or (Test-Path -LiteralPath $adminFile)) {
  throw 'Existing cluster or bootstrap detected. Inspect it instead of overwriting it.'
}
if (Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue) { throw 'The selected local port is occupied.' }
foreach ($folder in @($RuntimeRoot,$BootstrapDirectory)) {
  $cursor = $folder
  while ($cursor) {
    if (Test-Path -LiteralPath $cursor) {
      if ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked setup paths are not permitted.' }
    }
    $parent = Split-Path -Parent $cursor
    if ($parent -eq $cursor) { break }
    $cursor = $parent
  }
}
New-Item -ItemType Directory -Path $BootstrapDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $dataDirectory | Out-Null
$ownerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
foreach ($folder in @($BootstrapDirectory,$dataDirectory)) {
  & icacls.exe $folder /inheritance:r /grant:r ('*' + $ownerSid + ':(OI)(CI)F') '*S-1-5-18:(OI)(CI)F' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not restrict PostgreSQL setup permissions.' }
}
Add-Type -AssemblyName System.Security
$random = [Security.Cryptography.RandomNumberGenerator]::Create()
try { $bytes = New-Object byte[] 36; $random.GetBytes($bytes) } finally { $random.Dispose() }
$password = [Convert]::ToBase64String($bytes)
$configuration = @{host='127.0.0.1';port=$Port;user='pult_admin';database='postgres';password=$password} | ConvertTo-Json -Compress
$ciphertext = [Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($configuration),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
[IO.File]::WriteAllBytes($adminFile,$ciphertext)
[IO.File]::WriteAllText($passwordFile,$password,[Text.UTF8Encoding]::new($false))
try {
  & (Join-Path $binDirectory 'initdb.exe') --pgdata $dataDirectory --username=pult_admin --encoding=UTF8 --locale=C --locale-provider=builtin --builtin-locale=C.UTF-8 --auth=scram-sha-256 --data-checksums --pwfile=$passwordFile
  if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL initialization failed. Existing diagnostics are preserved for inspection.' }
} finally {
  # Only this exact disposable password file is removed; never delete a cluster.
  if (Test-Path -LiteralPath $passwordFile) { Remove-Item -LiteralPath $passwordFile -Force }
  $password = $null; $configuration = $null; $bytes = $null
}
$settings = @"

# Pult local cluster. Network access outside this machine remains disabled.
listen_addresses = '127.0.0.1'
port = $Port
password_encryption = 'scram-sha-256'
timezone = 'UTC'
shared_buffers = '256MB'
max_connections = 30
fsync = on
synchronous_commit = on
full_page_writes = on
log_statement = 'none'
log_min_error_statement = 'panic'
"@
[IO.File]::AppendAllText((Join-Path $dataDirectory 'postgresql.conf'),$settings,[Text.UTF8Encoding]::new($false))
$hba = "host all all 127.0.0.1/32 scram-sha-256`n"
[IO.File]::WriteAllText((Join-Path $dataDirectory 'pg_hba.conf'),$hba,[Text.UTF8Encoding]::new($false))
if ($StartServer) {
  $serverLog = Join-Path $dataDirectory 'postgresql.log'
  $arguments = @('-D',('"' + $dataDirectory + '"'),'-l',('"' + $serverLog + '"'),'-w','-t','30','start')
  # Start-Process -Wait also waits for the long-lived PostgreSQL descendants.
  # Wait only for pg_ctl, which independently confirms readiness with -w.
  $launch = Start-Process -FilePath (Join-Path $binDirectory 'pg_ctl.exe') -ArgumentList $arguments -WindowStyle Hidden -PassThru
  if (-not $launch.WaitForExit(45000)) { throw 'PostgreSQL startup confirmation timed out. Inspect the private server log before retrying.' }
  if ($launch.ExitCode -ne 0) { throw 'PostgreSQL did not confirm startup. Inspect the private server log.' }
  Write-Output 'PostgreSQL cluster started on loopback. Application migration has not run.'
} else {
  Write-Output 'PostgreSQL cluster initialized. Server startup and application migration have not run.'
}
