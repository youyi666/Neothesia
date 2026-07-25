$ErrorActionPreference = 'Stop'

$AppId = 'neothesia-practice-app'
$Port = 3721
$HealthUri = "http://127.0.0.1:$Port/api/health"

try {
  $response = Invoke-WebRequest -UseBasicParsing -Uri $HealthUri -TimeoutSec 2
  $health = $response.Content | ConvertFrom-Json
} catch {
  throw "Piano Practice App is not responding on port $Port."
}

if ($health.appId -ne $AppId) {
  throw "Port $Port is not running the current Piano Practice App. No process was stopped."
}

$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Select-Object -First 1
$process = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)"
$commandLine = [string]$process.CommandLine
if ($process.Name -ine 'node.exe' -or $commandLine -notmatch '(?i)(^|[\\/\s])server\.cjs("|\s|$)') {
  throw "Port $Port belongs to an unexpected process. No process was stopped."
}

Stop-Process -Id $listener.OwningProcess -Force
Write-Host "Piano Practice App stopped."
