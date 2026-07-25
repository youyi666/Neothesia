param(
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'

$AppId = 'neothesia-practice-app'
$Port = 3721
$AppDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ServerPath = Join-Path $AppDir 'server.cjs'
$HealthUri = "http://127.0.0.1:$Port/api/health"
$AppUri = "http://localhost:$Port/"

function Get-ExpectedBuildId {
  $files = @(
    Get-Item -LiteralPath $ServerPath
    Get-Item -LiteralPath (Join-Path $AppDir 'score-data.cjs')
  ) + @(Get-ChildItem -LiteralPath (Join-Path $AppDir 'lib') -File -Filter '*.js' |
    Sort-Object Name)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    foreach ($file in $files) {
      $relativePath = $file.FullName.Substring($AppDir.Length).TrimStart([char[]]'\\/')
      $pathBytes = [System.Text.Encoding]::UTF8.GetBytes($relativePath)
      $zeroByte = [byte[]](0)
      $contentBytes = [System.IO.File]::ReadAllBytes($file.FullName)
      [void]$sha.TransformBlock($pathBytes, 0, $pathBytes.Length, $pathBytes, 0)
      [void]$sha.TransformBlock($zeroByte, 0, $zeroByte.Length, $zeroByte, 0)
      [void]$sha.TransformBlock($contentBytes, 0, $contentBytes.Length, $contentBytes, 0)
    }
    [void]$sha.TransformFinalBlock([byte[]]@(), 0, 0)
    return ([System.BitConverter]::ToString($sha.Hash) -replace '-', '').ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
}

$ExpectedBuildId = Get-ExpectedBuildId

function Get-AppHealth {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $HealthUri -TimeoutSec 2
    if ($response.StatusCode -ne 200) { return $null }
    return $response.Content | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Get-PortListener {
  return Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1
}

function Wait-ForPortRelease {
  $deadline = (Get-Date).AddSeconds(8)
  while ((Get-Date) -lt $deadline) {
    if (-not (Get-PortListener)) { return }
    Start-Sleep -Milliseconds 150
  }
  throw "Port $Port did not become available after stopping the old service."
}

function Wait-ForCurrentBuild {
  $deadline = (Get-Date).AddSeconds(15)
  while ((Get-Date) -lt $deadline) {
    $health = Get-AppHealth
    if ($health -and $health.appId -eq $AppId -and $health.buildId -eq $ExpectedBuildId) {
      return $health
    }
    Start-Sleep -Milliseconds 250
  }
  throw "The practice app did not become ready on port $Port. Check data\\practice-app-server-error.log."
}

$health = Get-AppHealth
if ($health -and $health.appId -eq $AppId -and $health.buildId -eq $ExpectedBuildId) {
  Write-Host "Piano Practice App is already running at $AppUri"
  if (-not $NoBrowser) { Start-Process $AppUri }
  exit 0
}

$listener = Get-PortListener
if ($listener) {
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)"
  $commandLine = [string]$process.CommandLine
  $isNodeServer = $process.Name -ieq 'node.exe' -and $commandLine -match '(?i)(^|[\\/\s])server\.cjs("|\s|$)'
  $isLegacyPracticeApp = $health -and $health.ok -eq $true -and $health.PSObject.Properties.Name -contains 'scores'
  $isKnownPracticeApp = ($health -and $health.appId -eq $AppId) -or $isLegacyPracticeApp

  if (-not ($isNodeServer -and $isKnownPracticeApp)) {
    throw "Port $Port is already used by an unrecognized service (PID $($listener.OwningProcess)). No process was stopped."
  }

  Write-Host "Replacing the previous Piano Practice App service..."
  Stop-Process -Id $listener.OwningProcess -Force
  Wait-ForPortRelease
}

$dataDir = Join-Path $AppDir 'data'
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
$stdoutLog = Join-Path $dataDir 'practice-app-server.log'
$stderrLog = Join-Path $dataDir 'practice-app-server-error.log'
$node = Get-Command node.exe -ErrorAction Stop

$serverProcess = Start-Process -FilePath $node.Source -ArgumentList 'server.cjs' -WorkingDirectory $AppDir -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog
Wait-ForCurrentBuild | Out-Null

Write-Host "Piano Practice App is ready at $AppUri (PID $($serverProcess.Id))"
if (-not $NoBrowser) { Start-Process $AppUri }
