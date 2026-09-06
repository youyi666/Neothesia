# 开机启动 + 掉线重连轮询用的常驻检查脚本。注册成 Windows 计划任务后，一份触发器
# 挂"用户登录时"，另一份挂"此后每 5 分钟重复一次、一直重复下去"，两个触发器共用
# 这同一个脚本——脚本本身是幂等的（已经在正常跑就什么都不做），所以两种触发方式
# 混在一起调用是安全的，不会因为"登录"和"轮询"前后脚重复启动而冲突。
#
# 职责：
#   1. 确认 practice_app 服务器（node server.cjs）在跑——直接复用 start-practice-app.ps1
#      本来就有的"检查健康状态 → 不是当前版本才替换 → 起进程 → 等就绪"整套逻辑，
#      不重新发明一遍。
#   2. 确认 Cloudflare 快速隧道（cloudflared tunnel --url ...）在跑，而且是真的能连通
#      （不只是进程存在，是隧道当前这个地址真的能访问到 /api/health）——这就是"掉线
#      重连"的部分：进程还在但连接已经断了（比如网络抖动、Cloudflare 那头断开）的
#      情况下，只看"进程是否存在"是测不出来的，必须实际发一次请求验证。
#   3. 隧道地址是随机生成的、每次重启都会变，写到 data\current-tunnel-url.txt，
#      方便随时打开这个文件查当前地址，不用每次都问人。

$ErrorActionPreference = 'Stop'
$AppDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$DataDir = Join-Path $AppDir 'data'
New-Item -ItemType Directory -Path $DataDir -Force | Out-Null

$LogFile = Join-Path $DataDir 'keep-alive.log'
$TunnelLogFile = Join-Path $DataDir 'cloudflared-tunnel.log'
$UrlFile = Join-Path $DataDir 'current-tunnel-url.txt'
$CloudflaredExe = 'C:\Program Files (x86)\cloudflared\cloudflared.exe'

function Write-Log($message) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message
  Add-Content -LiteralPath $LogFile -Value $line
}

# ── 1. practice_app 服务器 ──────────────────────────────────────────────
try {
  & (Join-Path $AppDir 'start-practice-app.ps1') -NoBrowser
  Write-Log 'practice_app server: OK (start-practice-app.ps1 confirmed healthy or started it)'
} catch {
  Write-Log "practice_app server: FAILED - $($_.Exception.Message)"
}

# ── 2. Cloudflare 快速隧道，含健康检查（掉线重连） ──────────────────────
function Get-CloudflaredProcess {
  Get-CimInstance Win32_Process -Filter "Name = 'cloudflared.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'tunnel' -and $_.CommandLine -match '--url' }
}

function Test-TunnelHealthy {
  if (-not (Test-Path $UrlFile)) { return $false }
  $line = Get-Content -LiteralPath $UrlFile -First 1
  $match = [regex]::Match($line, 'https://\S+')
  if (-not $match.Success) { return $false }
  $url = $match.Value
  try {
    $resp = Invoke-WebRequest -UseBasicParsing -Uri "$url/api/health" -TimeoutSec 6
    return $resp.StatusCode -eq 200
  } catch {
    return $false
  }
}

$existing = Get-CloudflaredProcess
$healthy = $false
if ($existing) { $healthy = Test-TunnelHealthy }

if ($existing -and $healthy) {
  Write-Log 'cloudflared tunnel: OK (process running, health check passed)'
} else {
  if ($existing) {
    Write-Log "cloudflared tunnel: existing process found but health check failed - restarting (PID $($existing.ProcessId -join ','))"
    $existing | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 1
  } else {
    Write-Log 'cloudflared tunnel: not running - starting'
  }

  Remove-Item -LiteralPath $TunnelLogFile -Force -ErrorAction SilentlyContinue
  Start-Process -FilePath $CloudflaredExe -ArgumentList 'tunnel','--url','http://localhost:3721','--logfile',$TunnelLogFile -WindowStyle Hidden | Out-Null

  $deadline = (Get-Date).AddSeconds(20)
  $newUrl = $null
  while ((Get-Date) -lt $deadline -and -not $newUrl) {
    Start-Sleep -Milliseconds 500
    if (Test-Path $TunnelLogFile) {
      $match = Select-String -LiteralPath $TunnelLogFile -Pattern 'https://[a-zA-Z0-9.-]*\.trycloudflare\.com' -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($match) { $newUrl = $match.Matches[0].Value }
    }
  }

  if ($newUrl) {
    "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $newUrl" | Set-Content -LiteralPath $UrlFile
    Write-Log "cloudflared tunnel: started, new URL is $newUrl"
  } else {
    Write-Log 'cloudflared tunnel: started but could not read the new URL from the log within 20s - check cloudflared-tunnel.log'
  }
}
