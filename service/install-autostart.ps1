$ErrorActionPreference = 'Stop'

$ServiceDir = $PSScriptRoot
$Root = Split-Path -Parent $ServiceDir
$Vbs = Join-Path $ServiceDir 'watchdog.vbs'
$Wscript = Join-Path $env:WINDIR 'System32\wscript.exe'

if (-not (Test-Path $Vbs)) { throw "watchdog.vbs not found: $Vbs" }

# 启动文件夹快捷方式：登录后自动拉起看门狗。
$appData = [Environment]::GetFolderPath('ApplicationData')
if (-not $appData) { $appData = $env:APPDATA }
if (-not $appData) { $appData = Join-Path $env:USERPROFILE 'AppData\Roaming' }
$startup = Join-Path $appData 'Microsoft\Windows\Start Menu\Programs\Startup'
$shortcutPath = Join-Path $startup 'NovelClean.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $Wscript
$shortcut.Arguments = '"' + $Vbs + '"'
$shortcut.WorkingDirectory = $ServiceDir
$shortcut.WindowStyle = 7
$shortcut.Description = 'Novel-clean local service auto-recovery'
$shortcut.Save()

# 立即启动一次，走 WMI，避免跟着当前终端/会话一起被结束。
$cmdLine = '"' + $Wscript + '" "' + $Vbs + '"'
$started = $false
try {
  $result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine = $cmdLine
    CurrentDirectory = $ServiceDir
  }
  $started = ($result.ReturnValue -eq 0)
} catch {
  $started = $false
}
if (-not $started) {
  Start-Process -FilePath $Wscript -ArgumentList ('"' + $Vbs + '"') -WorkingDirectory $ServiceDir -WindowStyle Hidden
}

Write-Host "Startup shortcut: $shortcutPath"
Write-Host "Watchdog: $Vbs"
Write-Host "Service root: $Root"
