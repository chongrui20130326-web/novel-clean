$ErrorActionPreference = 'SilentlyContinue'

# 只允许一个看门狗实例。
$mutex = New-Object System.Threading.Mutex($false, 'Local\NovelCleanWatchdog')
if (-not $mutex.WaitOne(0)) { exit 0 }

$Root = Split-Path -Parent $PSScriptRoot
$Port = 4180
$RouterRoot = if ($env:MODEL_ROUTER_ROOT) { $env:MODEL_ROUTER_ROOT } else { 'J:\本地模型服务器' }
$RouterPort = 8090
$LogFile = Join-Path $PSScriptRoot 'watchdog.log'
$Node = (Get-Command node.exe).Source

function Write-WatchdogLog([string]$Message) {
  $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
  Add-Content -LiteralPath $LogFile -Value $line -Encoding utf8
}

if (-not $Node) {
  Write-WatchdogLog 'node.exe not found; watchdog stopped'
  exit 1
}

Write-WatchdogLog "watchdog started; root=$Root; node=$Node"

while ($true) {
  $listening = $false
  try {
    $listening = [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop)
  } catch {
    $listening = $false
  }

  if (-not $listening) {
    Write-WatchdogLog 'port 4180 is down; starting server.mjs'
    Start-Process -FilePath $Node `
      -ArgumentList 'server.mjs' `
      -WorkingDirectory $Root `
      -WindowStyle Hidden
    Start-Sleep -Seconds 6
  }

  # 本地模型路由也一起守护；模型路由未启动时，清洗会降级为规则模式。
  $routerListening = $false
  try {
    $routerListening = [bool](Get-NetTCPConnection -LocalPort $RouterPort -State Listen -ErrorAction Stop)
  } catch {
    $routerListening = $false
  }
  if (-not $routerListening -and (Test-Path (Join-Path $RouterRoot 'start.ps1'))) {
    Write-WatchdogLog "port $RouterPort is down; starting local model router"
    Start-Process -FilePath 'powershell.exe' `
      -ArgumentList '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $RouterRoot 'start.ps1') `
      -WorkingDirectory $RouterRoot `
      -WindowStyle Hidden
    Start-Sleep -Seconds 10
  }

  Start-Sleep -Seconds 4
}
