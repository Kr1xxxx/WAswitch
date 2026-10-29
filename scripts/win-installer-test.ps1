# Windows 安装包实测（只在 CI 的 windows-latest 上跑，见 .github/workflows/installer-win.yml）。
# 验证：第一次安装默认装到 D:\WAswitch\app；自动更新（--updated /S）原地装、不动 D:\WAswitch 里的译文；
# 卸载只删程序；已经装在 C 盘的老电脑更新后程序不挪；向导（有页面）安装同样装到 D 盘。
# 用法：pwsh scripts/win-installer-test.ps1 <安装包.exe>
param([Parameter(Mandatory = $true)][string]$Setup)
$ErrorActionPreference = 'Stop'
$Setup = (Resolve-Path $Setup).Path
$DApp = 'D:\WAswitch\app'
$CApp = Join-Path $env:LOCALAPPDATA 'Programs\WAswitch'
$Tr = 'D:\WAswitch\translations\A\x.json'

function Fail($msg) { Write-Host "FAIL: $msg"; exit 1 }
function Check($ok, $msg) { if (-not $ok) { Fail $msg } else { Write-Host "ok: $msg" } }
function InstallLocation {
  foreach ($k in Get-ChildItem HKCU:\Software -ErrorAction SilentlyContinue) {
    $p = Get-ItemProperty $k.PSPath -ErrorAction SilentlyContinue
    if ($p -and $p.InstallLocation -and $p.InstallLocation -match 'WAswitch') { return $p.InstallLocation }
  }
  return $null
}
function WaitFor($cond, $secs, $what) {
  $until = (Get-Date).AddSeconds($secs)
  while ((Get-Date) -lt $until) { if (& $cond) { return $true }; Start-Sleep -Milliseconds 500 }
  Write-Host "等了 $secs 秒：$what"
  return $false
}
function Run($exeArgs) { Start-Process -FilePath $Setup -ArgumentList $exeArgs -Wait }
function Uninstall($dir) {
  $u = Join-Path $dir 'Uninstall WAswitch.exe'
  if (-not (Test-Path $u)) { return }
  Start-Process -FilePath $u -ArgumentList '/S' # 卸载程序会复制自己再退出，所以不能 -Wait，轮询等程序文件夹消失
  WaitFor { -not (Test-Path (Join-Path $dir 'WAswitch.exe')) } 90 '卸载' | Out-Null
  WaitFor { -not (Test-Path $dir) } 30 '安装文件夹删除' | Out-Null
  WaitFor { $null -eq (InstallLocation) } 30 '注册表位置清掉（卸载程序最后一步）' | Out-Null
}
function StopApp { Get-Process WAswitch -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue }

# 向导：不断点主按钮（NSIS 的下一步/安装/完成都是控件 ID 1），直到安装窗口关闭
function DriveWizard {
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
  $p = Start-Process -FilePath $Setup -PassThru
  $until = (Get-Date).AddMinutes(4)
  while (-not $p.HasExited -and (Get-Date) -lt $until) {
    Start-Sleep -Seconds 2
    $p.Refresh()
    if ($p.MainWindowHandle -eq 0) { continue }
    $win = [System.Windows.Automation.AutomationElement]::FromHandle($p.MainWindowHandle)
    $cond = New-Object System.Windows.Automation.AndCondition(
      (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, '1')),
      (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)))
    $btn = $win.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
    if ($btn -and $btn.Current.IsEnabled) {
      Write-Host "点：$($btn.Current.Name)"
      try { $btn.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() } catch { Write-Host "点不了：$($_.Exception.Message)" }
    }
  }
  if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force; Fail '向导 4 分钟没走完' }
}

# 要有 D 盘，而且 GetDriveType 是本机硬盘；runner 没有就 subst 一个
if (-not (Test-Path 'D:\')) {
  $backing = Join-Path $env:RUNNER_TEMP 'fake-d'
  New-Item -ItemType Directory -Force $backing | Out-Null
  subst D: $backing
  Write-Host "用 subst 造了 D 盘：$backing"
}
Write-Host ("D 盘类型：" + [System.IO.DriveInfo]::new('D').DriveType)
Check ([System.IO.DriveInfo]::new('D').DriveType -eq 'Fixed') 'D 盘是本机硬盘'
Check ($null -eq (InstallLocation)) '开始时没装过'

# 1. 第一次静默安装 -> D 盘
Run '/S'
Check (Test-Path "$DApp\WAswitch.exe") '静默安装：D:\WAswitch\app\WAswitch.exe 在'
Check ((InstallLocation) -eq $DApp) "注册表 InstallLocation 是 $DApp"
Check (Test-Path 'D:\WAswitch') 'D:\WAswitch 在'
Check (-not (Test-Path "$CApp\WAswitch.exe")) 'C 盘没有装'

# 2. 自动更新：原地装，译文还在
New-Item -ItemType Directory -Force (Split-Path $Tr) | Out-Null
Set-Content $Tr '{"k":1}'
StopApp
Run '--updated /S'
StopApp
Check (Test-Path "$DApp\WAswitch.exe") '自动更新后程序还在 D:\WAswitch\app'
Check (Test-Path $Tr) '自动更新后 D:\WAswitch\translations 里的译文还在'
Check ((InstallLocation) -eq $DApp) '自动更新后位置没变'

# 3. 卸载：删程序，不删译文
Uninstall $DApp
Check (-not (Test-Path "$DApp\WAswitch.exe")) '卸载后程序没了'
Check (Test-Path $Tr) '卸载后译文还在'
Check ($null -eq (InstallLocation)) '卸载后注册表位置清掉'

# 4. 向导安装（有页面）-> D 盘
DriveWizard
StopApp
Check (Test-Path "$DApp\WAswitch.exe") '向导安装：D:\WAswitch\app\WAswitch.exe 在'
Check ((InstallLocation) -eq $DApp) '向导安装：注册表位置是 D 盘'
Check (-not (Test-Path "$CApp\WAswitch.exe")) '向导安装：C 盘没有装'
Uninstall $DApp
Check ($null -eq (InstallLocation)) '向导装的卸载干净'

# 5. 老电脑：装在 C 盘，之后更新和不带 /D 重装都留在 C 盘；更新时顺便建 D:\WAswitch
Run "/S /D=$CApp"
Check (Test-Path "$CApp\WAswitch.exe") '老电脑：装在 C 盘'
Remove-Item 'D:\WAswitch' -Recurse -Force
StopApp
Run '--updated /S'
StopApp
Check (Test-Path "$CApp\WAswitch.exe") '老电脑自动更新后程序还在 C 盘'
Check (-not (Test-Path "$DApp\WAswitch.exe")) '老电脑更新没有往 D 盘装'
Check (Test-Path 'D:\WAswitch') '老电脑更新后建了 D:\WAswitch（软件靠它判断译文能不能放 D 盘）'
Check ((InstallLocation) -eq $CApp) '老电脑位置没变'
Run '/S'
StopApp
Check (-not (Test-Path "$DApp\WAswitch.exe")) '老电脑不带 /D 重装也留在 C 盘'
Uninstall $CApp

# 6. D 盘不能用（命令行指定了位置）时按指定的装
Run '/S /D=D:\Elsewhere\WAswitch'
Check (Test-Path 'D:\Elsewhere\WAswitch\WAswitch.exe') '/D= 指定的位置优先'
Uninstall 'D:\Elsewhere\WAswitch'
Write-Host '全部通过'
