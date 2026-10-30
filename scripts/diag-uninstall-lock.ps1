# 诊断用，不合并：win-installer-test.ps1 第 3 步卸载后为什么偶尔剩下 WAswitch.exe，是谁占着它。
# 用法：pwsh scripts/diag-uninstall-lock.ps1 <安装包.exe> <repro|probe>
#   repro：和实测一样，更新完马上卸载；剩下了就看谁占着、多久放开
#   probe：每次装完、更新完先盯 30 秒，看文件被谁占、占多久，再卸载
# 后台一直每秒查一次：哪些进程有它的句柄（handle64）、哪些进程把它映射进内存（自己扫）。
param([Parameter(Mandatory = $true)][string]$Setup, [string]$Mode = 'repro')
$ErrorActionPreference = 'Continue'
$Setup = (Resolve-Path $Setup).Path
$DApp = 'D:\WAswitch\app'
$Exe = "$DApp\WAswitch.exe"
$Tr = 'D:\WAswitch\translations\A\x.json'
$T0 = Get-Date
$WLog = Join-Path $env:RUNNER_TEMP 'watch.log'
$Stop = Join-Path $env:RUNNER_TEMP 'watch.stop'
function Ts { '{0,7:N1}s' -f ((Get-Date) - $T0).TotalSeconds }
function Log($m) { Write-Host "$(Ts) $m" }

Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class Lk {
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr CreateFileW(string n, uint a, uint s, IntPtr sa, uint d, uint f, IntPtr t);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetFileInformationByHandle(IntPtr h, int c, ref byte v, uint n);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  // 开一下（写 + 删除权限，全共享）就关：0 能开；32 别人开着且不让写/删；5 等其它
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
public static class Maps {
  [StructLayout(LayoutKind.Sequential)]
  struct MBI { public IntPtr BaseAddress; public IntPtr AllocationBase; public uint AllocationProtect; public ushort PartitionId; public IntPtr RegionSize; public uint State; public uint Protect; public uint Type; }
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint a, bool i, int pid);
  [DllImport("kernel32.dll")] static extern IntPtr VirtualQueryEx(IntPtr h, IntPtr addr, out MBI m, IntPtr len);
  [DllImport("psapi.dll", CharSet = CharSet.Unicode)] static extern uint GetMappedFileNameW(IntPtr h, IntPtr addr, StringBuilder sb, uint n);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  // 哪些进程把这个文件映射进了内存（程序映像或数据）；打不开的进程（受保护的）记一笔
  public static string Find(string tail) {
    var sb = new StringBuilder();
    var denied = new StringBuilder();
    foreach (var p in System.Diagnostics.Process.GetProcesses()) {
      string pn = "?";
      try { pn = p.ProcessName; } catch { }
      IntPtr h = OpenProcess(0x0400 | 0x0010, false, p.Id);
      if (h == IntPtr.Zero) { if (p.Id > 4) denied.Append(pn + " "); continue; }
      try {
        long addr = 0; MBI m; var name = new StringBuilder(1024);
        int sz = Marshal.SizeOf(typeof(MBI));
        while (VirtualQueryEx(h, new IntPtr(addr), out m, new IntPtr(sz)) != IntPtr.Zero) {
          if ((m.Type == 0x40000 || m.Type == 0x1000000) && m.BaseAddress == m.AllocationBase) {
            name.Clear();
            if (GetMappedFileNameW(h, m.BaseAddress, name, 1024) > 0 && name.ToString().EndsWith(tail, StringComparison.OrdinalIgnoreCase))
              sb.Append(pn + "(" + p.Id + ")" + (m.Type == 0x1000000 ? ":image " : ":data "));
          }
          long next = m.BaseAddress.ToInt64() + m.RegionSize.ToInt64();
          if (next <= addr) break;
          addr = next;
        }
      } catch { } finally { CloseHandle(h); }
    }
    return sb.ToString() + "|denied: " + denied.ToString();
  }
}
'@

function InstallLocation {
  foreach ($k in Get-ChildItem HKCU:\Software -ErrorAction SilentlyContinue) {
    $p = Get-ItemProperty $k.PSPath -ErrorAction SilentlyContinue
    if ($p -and $p.InstallLocation -and $p.InstallLocation -match 'WAswitch') { return $p.InstallLocation }
  }
  return $null
}
function Run($exeArgs) { Start-Process -FilePath $Setup -ArgumentList $exeArgs -Wait }
function StopApp { Get-Process WAswitch -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue }

# handle64：列出有这个文件句柄的进程
$H = $null
try {
  $z = Join-Path $env:RUNNER_TEMP 'Handle.zip'
  Invoke-WebRequest https://download.sysinternals.com/files/Handle.zip -OutFile $z
  Expand-Archive $z (Join-Path $env:RUNNER_TEMP 'handle') -Force
  $H = Join-Path $env:RUNNER_TEMP 'handle\handle64.exe'
  & $H -accepteula -nobanner -v 'D:\nothing-here' | Out-Null
} catch { Write-Host "handle64 没下到：$_" }
function Handles {
  if (-not $H) { return '' }
  ((& $H -nobanner -v $Exe 2>&1) | Where-Object { $_ -and $_ -notmatch 'No matching handles' -and $_ -notmatch '^Process,' }) -join ' / '
}

Write-Host "=== 环境 ($Mode)"
try { Get-MpComputerStatus | Format-List AMRunningMode, AntivirusEnabled, RealTimeProtectionEnabled, OnAccessProtectionEnabled, IoavProtectionEnabled, BehaviorMonitorEnabled, IsTamperProtected | Out-String | Write-Host } catch { Write-Host "Get-MpComputerStatus: $_" }
try { $mp = Get-MpPreference; Write-Host "DisableRealtimeMonitoring=$($mp.DisableRealtimeMonitoring) ExclusionPath=$($mp.ExclusionPath -join ';')" } catch { Write-Host "Get-MpPreference: $_" }
Get-Process explorer, StartMenuExperienceHost, SearchHost, SearchIndexer, SearchProtocolHost, MsMpEng, smartscreen -ErrorAction SilentlyContinue | Format-Table Id, ProcessName, StartTime, SessionId -AutoSize | Out-String | Write-Host
Get-Service WSearch, WinDefend, SysMain -ErrorAction SilentlyContinue | Format-Table Name, Status, StartType -AutoSize | Out-String | Write-Host
Write-Host ("D 盘：" + [System.IO.DriveInfo]::new('D').DriveType + "  当前会话：" + (Get-Process -Id $PID).SessionId)

# 后台：每秒查一次句柄和映射，有变化就记一行
Remove-Item $WLog, $Stop -ErrorAction SilentlyContinue
$watch = Start-ThreadJob -ArgumentList $T0, $WLog, $Stop, $Exe, $H -ScriptBlock {
  param($T0, $WLog, $Stop, $Exe, $H)
  $last = ''
  while (-not (Test-Path $Stop)) {
    $m = [Maps]::Find('\WAswitch\app\WAswitch.exe')
    $mm = ($m -split '\|')[0]
    $hh = ''
    if ($H -and (Test-Path $Exe)) { $hh = ((& $H -nobanner -v $Exe 2>&1) | Where-Object { $_ -and $_ -notmatch 'No matching handles' -and $_ -notmatch '^Process,' }) -join ' / ' }
    $cur = "映射=[$mm] 句柄=[$hh]"
    if ($cur -ne $last) {
      Add-Content $WLog ('{0,7:N1}s {1}' -f ((Get-Date) - $T0).TotalSeconds, $cur)
      $last = $cur
    }
    Start-Sleep -Milliseconds 700
  }
  Add-Content $WLog ('最后一次查不到的受保护进程：' + (($m -split '\|')[1]))
}

function Probe($secs, $what) {
  Log "盯 $secs 秒：$what"
  $until = (Get-Date).AddSeconds($secs)
  $last = ''; $lastScan = [datetime]::MinValue
  while ((Get-Date) -lt $until) {
    $s = "open=$([Lk]::Open($Exe)) disp=$([Lk]::Disp($Exe))"
    if ($s -ne $last) { Log "  $s"; $last = $s }
    if ($s -ne 'open=0 disp=0' -and ((Get-Date) - $lastScan).TotalSeconds -gt 2) {
      Log ("  映射：" + [Maps]::Find('\WAswitch\app\WAswitch.exe'))
      Log ("  句柄：" + (Handles))
      $lastScan = Get-Date
    }
    Start-Sleep -Milliseconds 100
  }
}

function Cycle($n) {
  Write-Host "=== 第 $n 轮"
  Log '装 /S 开始'; Run '/S'; Log '装完'
  if ($Mode -eq 'probe') { Probe 30 '装完以后' }
  New-Item -ItemType Directory -Force (Split-Path $Tr) | Out-Null
  Set-Content $Tr '{"k":1}'
  StopApp
  Log '更新 --updated /S 开始'; Run '--updated /S'; StopApp; Log '更新完'
  if ($Mode -eq 'probe') { Probe 30 '更新完以后' }
  $u = Join-Path $DApp 'Uninstall WAswitch.exe'
  StopApp
  Log '卸载开始'; Start-Process -FilePath $u -ArgumentList '/S'
  $until = (Get-Date).AddSeconds(60)
  while ((Get-Date) -lt $until -and $null -ne (InstallLocation)) { Start-Sleep -Milliseconds 200 }
  Log ("注册表位置：" + $(if ($null -eq (InstallLocation)) { '清掉了（卸载程序跑完）' } else { '60 秒还在' }))
  Start-Sleep -Milliseconds 500
  if (Test-Path $Exe) {
    Log "!!! 剩下 WAswitch.exe；文件夹里：$((Get-ChildItem $DApp -Force | ForEach-Object Name) -join ', ')"
    Log ("  映射：" + [Maps]::Find('\WAswitch\app\WAswitch.exe'))
    Log ("  句柄：" + (Handles))
    $until = (Get-Date).AddSeconds(120)
    $last = ''
    while ((Get-Date) -lt $until) {
      $s = "open=$([Lk]::Open($Exe)) disp=$([Lk]::Disp($Exe))"
      if ($s -ne $last) { Log "  $s"; $last = $s }
      if ($s -eq 'open=0 disp=0') { break }
      Start-Sleep -Milliseconds 200
    }
    Log ("  现在映射：" + [Maps]::Find('\WAswitch\app\WAswitch.exe'))
    Log ("  现在句柄：" + (Handles))
    Remove-Item $DApp -Recurse -Force -ErrorAction SilentlyContinue
    Log ("  测试自己删：" + $(if (Test-Path $Exe) { '删不掉' } else { '删掉了' }))
  } else {
    Log '干净'
  }
}

Cycle 1
Cycle 2
Cycle 3
New-Item -ItemType File $Stop | Out-Null
Wait-Job $watch -Timeout 30 | Out-Null
Receive-Job $watch | Out-Host
Write-Host '=== 后台记录（时间 映射 句柄）'
Get-Content $WLog -ErrorAction SilentlyContinue | Write-Host
