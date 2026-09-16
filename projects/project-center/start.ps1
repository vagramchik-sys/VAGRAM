$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$ozonNode = Get-Command node -ErrorAction SilentlyContinue
if (-not $ozonNode) { throw 'Установите Node.js 22 или новее и повторите запуск.' }
Write-Host 'Откройте http://127.0.0.1:8787. Для остановки нажмите Ctrl+C.'
& $ozonNode.Source (Join-Path $PSScriptRoot 'server.cjs')
