# Windows 安装包实测（只在 CI 的 windows-latest 上跑，见 .github/workflows/installer-win.yml）。
# 验证：第一次安装默认装到 D:\WAswitch\app；自动更新（--updated /S）原地装、不动 D:\WAswitch 里的译文；
# 卸载只删程序（卸载前先等 WAswitch.exe 能删，跑完以注册表位置清掉为准）；已经装在 C 盘的老电脑更新后程序不挪；向导（有页面）安装同样装到 D 盘；
# 同一台电脑另一个用户已经装在 D:\WAswitch\app 时装到 C 盘。
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
# 刚装完、更新完约 1 秒内，系统外壳会短暂占住 WAswitch.exe（读新快捷方式的图标）。卸载程序删文件夹只删一次、不重试，
# 删不掉的跳过，所以卸载前先等 exe 能删，免得它被留下来。
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class Lk {
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr CreateFileW(string n, uint a, uint s, IntPtr sa, uint d, uint f, IntPtr t);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetFileInformationByHandle(IntPtr h, int c, ref byte v, uint n);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  // 开一下（写 + 删除权限，全共享）就关：0 能开；32 别人开着且不让写/删；2 文件不在
  public static int Open(string p) {
    IntPtr h = CreateFileW(p, 0x40000000u | 0x00010000u, 7, IntPtr.Zero, 3, 0, IntPtr.Zero);
    if (h == new IntPtr(-1)) return Marshal.GetLastWin32Error();
    CloseHandle(h); return 0;
  }
  // 标记删除再马上取消（不会真删）：0 能删；5 被映射着删不掉；32 别人开着不让删
  public static int Disp(string p) {
    IntPtr h = CreateFileW(p, 0x00010000u, 7, IntPtr.Zero, 3, 0, IntPtr.Zero);
    if (h == new IntPtr(-1)) return Marshal.GetLastWin32Error();
    try {
      byte y = 1;
      if (!SetFileInformationByHandle(h, 4, ref y, 1)) return Marshal.GetLastWin32Error();
      byte n = 0; SetFileInformationByHandle(h, 4, ref n, 1); return 0;
    } finally { CloseHandle(h); }
  }
}
'@
function Probe($exe) { "open=$([Lk]::Open($exe)) disp=$([Lk]::Disp($exe))" }
# 先等 2 秒，再每 100 毫秒探一次，连续 1 秒都能删才算；最多等 60 秒
function WaitDeletable($exe) {
  if (-not (Test-Path $exe)) { return }
  $t0 = Get-Date
  Start-Sleep -Seconds 2
  $okSince = $null
  while (((Get-Date) - $t0).TotalSeconds -lt 60) {
    if ((Probe $exe) -eq 'open=0 disp=0') {
      if (-not $okSince) { $okSince = Get-Date }
      if (((Get-Date) - $okSince).TotalSeconds -ge 1) { break }
    } else { $okSince = $null }
    Start-Sleep -Milliseconds 100
  }
  Write-Host ("卸载前等了 {0:N1} 秒，WAswitch.exe：{1}" -f ((Get-Date) - $t0).TotalSeconds, (Probe $exe))
}
function Uninstall($dir) {
  $u = Join-Path $dir 'Uninstall WAswitch.exe'
  if (-not (Test-Path $u)) { return }
  $exe = Join-Path $dir 'WAswitch.exe'
  StopApp
  WaitDeletable $exe
  Start-Process -FilePath $u -ArgumentList '/S' # 卸载程序会复制自己再退出，所以不能 -Wait；它最后一步清注册表位置，看这个判断跑完
  $done = WaitFor { $null -eq (InstallLocation) } 60 '注册表位置清掉（卸载程序最后一步）'
  if (-not $done -or (Test-Path $exe)) {
    Write-Host ($(if ($done) { '--- 卸载跑完了，WAswitch.exe 还在，' } else { '--- 卸载 60 秒没跑完，' }) + "探针：$(Probe $exe)，现场：")
    Get-Process | Sort-Object StartTime -Descending -ErrorAction SilentlyContinue | Select-Object -First 25 | Format-Table Id, ProcessName, StartTime, MainWindowTitle -AutoSize | Out-String | Write-Host
    Get-ChildItem $dir -Force -ErrorAction SilentlyContinue | Select-Object -First 20 | ForEach-Object { Write-Host "$($_.Name) $($_.Length)" }
    Fail "卸载 $dir 没删干净"
  }
  WaitFor { -not (Test-Path $dir) } 30 '安装文件夹删除' | Out-Null
}
function StopApp { Get-Process WAswitch -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue }

# 向导：不断点主按钮（NSIS 的下一步/安装/完成都是控件 ID 1），直到安装窗口关闭。
# 直接用 Win32 找安装程序进程的窗口再发 BM_CLICK，不依赖有没有桌面（runner 上 MainWindowHandle 可能是 0）
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class Wiz {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern IntPtr GetDlgItem(IntPtr h, int id);
  [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  public static List<IntPtr> Windows(uint pid) {
    var r = new List<IntPtr>();
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); if (p == pid) r.Add(h); return true; }, IntPtr.Zero);
    return r;
  }
  public static string Title(IntPtr h) { var sb = new StringBuilder(256); GetWindowText(h, sb, 256); return sb.ToString(); }
  // 点主按钮；返回按钮上的字，没点到返回 null
  public static string ClickMain(uint pid) {
    foreach (var h in Windows(pid)) {
      var b = GetDlgItem(h, 1);
      if (b != IntPtr.Zero && IsWindowEnabled(b)) { var t = Title(b); SendMessage(b, 0xF5, IntPtr.Zero, IntPtr.Zero); return t; }
    }
    return null;
  }
  public static string Dump(uint pid) {
    var sb = new StringBuilder();
    foreach (var h in Windows(pid)) sb.AppendLine(h + " visible=" + IsWindowVisible(h) + " title=" + Title(h) + " btn1=" + (GetDlgItem(h, 1) != IntPtr.Zero));
    return sb.ToString();
  }
}
'@
function DriveWizard {
  $p = Start-Process -FilePath $Setup -PassThru
  $until = (Get-Date).AddMinutes(4)
  $n = 0
  while (-not $p.HasExited -and (Get-Date) -lt $until) {
    Start-Sleep -Seconds 2
    $t = [Wiz]::ClickMain([uint32]$p.Id)
    if ($t) { Write-Host "点：$t" }
    elseif (($n++ % 5) -eq 0) { Write-Host '没找到可点的按钮，窗口：'; Write-Host ([Wiz]::Dump([uint32]$p.Id)) }
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

# 7. 同一台电脑另一个 Windows 用户已经装在 D:\WAswitch\app（这个用户的注册表里没有）：装到 C，不碰别人的
Check ($null -eq (InstallLocation)) '开始时这个用户没装过'
New-Item -ItemType Directory -Force $DApp | Out-Null
Set-Content "$DApp\WAswitch.exe" 'other-user'
Set-Content "$DApp\Uninstall WAswitch.exe" 'other-user'
Run '/S'
StopApp
Check (Test-Path "$CApp\WAswitch.exe") '别人装过 D 盘：这个用户装在 C 盘'
Check ((InstallLocation) -eq $CApp) '别人装过 D 盘：注册表位置是 C 盘'
Check ((Get-Content "$DApp\WAswitch.exe" -Raw).Trim() -eq 'other-user') '别人的 D:\WAswitch\app 没被覆盖'
Run '--updated /S'
StopApp
Check (Test-Path "$CApp\WAswitch.exe") '这个用户更新后还在 C 盘'
Check ((Get-Content "$DApp\WAswitch.exe" -Raw).Trim() -eq 'other-user') '更新也没碰别人的'
Uninstall $CApp
Check ((Get-Content "$DApp\WAswitch.exe" -Raw).Trim() -eq 'other-user') '卸载这个用户的，别人的还在'
Remove-Item $DApp -Recurse -Force
Write-Host '全部通过'
