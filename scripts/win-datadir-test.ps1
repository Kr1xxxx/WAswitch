# Windows 实测：账号数据放 D 盘（src/datadir.js），用真的安装包和打包好的 WAswitch.exe。
# 只在 CI 的 windows-latest 上跑（见 .github/workflows/installer-win.yml），在 win-installer-test.ps1 之后。
# 验证：新装的电脑数据直接在 D:\WAswitch\data；老电脑带 --move-data 启动会搬过去、隐藏重启、两分钟后删 C 盘旧的；
# 指针指的盘打不开时用 C 启动、指针不改；D 盘那份记着别的用户时不用。
# 用法：pwsh scripts/win-datadir-test.ps1 <安装包.exe>
param([Parameter(Mandatory = $true)][string]$Setup)
$ErrorActionPreference = 'Stop'
$Setup = (Resolve-Path $Setup).Path
$Exe = 'D:\WAswitch\app\WAswitch.exe'
$Home_ = Join-Path $env:APPDATA 'WAswitch'
$Data = 'D:\WAswitch\data'
$Pointer = Join-Path $Home_ 'data-dir.json'

function Fail($msg) { Write-Host "FAIL: $msg"; Dump; exit 1 }
function Check($ok, $msg) { if (-not $ok) { Fail $msg } else { Write-Host "ok: $msg" } }
function WaitFor($cond, $secs, $what) {
  $until = (Get-Date).AddSeconds($secs)
  while ((Get-Date) -lt $until) { if (& $cond) { return $true }; Start-Sleep -Milliseconds 500 }
  Write-Host "等了 $secs 秒：$what"
  return $false
}
function StopApp {
  Get-Process WAswitch -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  WaitFor { -not (Get-Process WAswitch -ErrorAction SilentlyContinue) } 30 '软件退出' | Out-Null
  Start-Sleep -Seconds 1
}
function Dump {
  Write-Host '--- 现场'
  foreach ($d in @($Home_, $Data)) {
    Write-Host "[$d]"
    Get-ChildItem $d -Force -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "  $($_.Name)" }
  }
  if (Test-Path $Pointer) { Write-Host "指针：$(Get-Content $Pointer -Raw)" }
  foreach ($log in @((Join-Path $Home_ 'logs'), (Join-Path $Data 'logs'))) {
    Get-ChildItem $log -Filter *.log -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "--- $($_.FullName)"; Get-Content $_.FullName -Tail 40 | Write-Host }
  }
}
function Pointer { if (Test-Path $Pointer) { return Get-Content $Pointer -Raw | ConvertFrom-Json } return $null }
function Reset {
  StopApp
  Remove-Item $Home_ -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $Data -Recurse -Force -ErrorAction SilentlyContinue
}
function Owner { $f = Join-Path $Data 'owner.json'; if (Test-Path $f) { return (Get-Content $f -Raw | ConvertFrom-Json).home } return $null }
function Launch($argsList) { Start-Process -FilePath $Exe -ArgumentList $argsList | Out-Null }

if (-not (Test-Path 'D:\')) {
  $backing = Join-Path $env:RUNNER_TEMP 'fake-d'
  New-Item -ItemType Directory -Force $backing | Out-Null
  subst D: $backing
}
StopApp
Start-Process -FilePath $Setup -ArgumentList '/S' -Wait
Check (Test-Path $Exe) '装到 D:\WAswitch\app'
Check (Test-Path 'D:\WAswitch') '安装包建了 D:\WAswitch'

# 1. 新装的电脑：C 盘没有数据 -> Chromium 直接写在 D:\WAswitch\data，C 盘只有指针
Reset
Launch @('--hidden')
Check (WaitFor { Test-Path (Join-Path $Data 'Local State') } 90 'D 盘出现 Local State') '新装：Local State 在 D:\WAswitch\data'
Check ((Pointer).dir -eq $Data) '新装：指针指向 D:\WAswitch\data'
Check ((Owner) -eq $Home_) '新装：D:\WAswitch\data 记上了这个用户'
Check (WaitFor { Test-Path (Join-Path $Data 'logs') } 30 'D 盘日志') '新装：日志也在 D'
StopApp
Check (-not (Test-Path (Join-Path $Home_ 'Local State'))) '新装：C 盘没有 Local State'
Check (-not (Test-Path (Join-Path $Home_ 'Partitions'))) '新装：C 盘没有分区'

# 2. 老电脑：C 盘有账号数据，没有指针 -> 正常启动留在 C
Reset
New-Item -ItemType Directory -Force $Home_ | Out-Null
Set-Content (Join-Path $Home_ 'accounts.json') '[]'
Launch @('--hidden')
Check (WaitFor { Test-Path (Join-Path $Home_ 'Local State') } 90 'C 盘出现 Local State') '老电脑：先留在 C'
StopApp
Check ($null -eq (Pointer)) '老电脑：没写指针'
New-Item -ItemType Directory -Force (Join-Path $Home_ 'Partitions\wa-x') | Out-Null
Set-Content (Join-Path $Home_ 'Partitions\wa-x\marker.txt') 'logged-in'
New-Item -ItemType Directory -Force (Join-Path $Home_ 'modules\mcp') | Out-Null
Set-Content (Join-Path $Home_ 'mcp-token.json') '{"token":"t"}'

# 3. 空闲时带 --move-data 重启：搬到 D、写指针、隐藏重启
Launch @('--move-data=0', '--hidden')
Check (WaitFor { $p = Pointer; $p -and $p.dir -eq $Data } 180 '指针') '搬家：写了指针'
Check ((Pointer).cleanC -eq $true) '搬家：等 D 盘启动成功后再删 C 盘的'
Check ((Get-Content (Join-Path $Data 'Partitions\wa-x\marker.txt') -Raw).Trim() -eq 'logged-in') '搬家：分区里的文件到了 D'
Check (Test-Path (Join-Path $Data 'Local State')) '搬家：Local State 到了 D'
Check (Test-Path (Join-Path $Data 'accounts.json')) '搬家：accounts.json 到了 D'
Check (-not (Test-Path (Join-Path $Data 'mcp-token.json'))) '搬家：MCP 的 token 留在 C'
Check (-not (Test-Path "$Data.tmp")) '搬家：没有留下 data.tmp'
Check ((Owner) -eq $Home_) '搬家：D 盘那份记着这个用户'
Check (WaitFor { Get-Process WAswitch -ErrorAction SilentlyContinue } 60 '重启') '搬完自己隐藏重启了'
Check (Test-Path (Join-Path $Home_ 'accounts.json')) '刚搬完 C 盘那份还在'
# 从 D 盘读到 accounts.json 两分钟后删 C 盘旧数据
Check (WaitFor { -not (Test-Path (Join-Path $Home_ 'accounts.json')) } 240 '删 C 盘旧数据') 'D 盘启动成功后删了 C 盘旧数据'
Check (WaitFor { -not (Pointer).cleanC } 30 'cleanC') '删完 cleanC 变成 false'
Check (Test-Path (Join-Path $Home_ 'mcp-token.json')) 'MCP 的 token 还在 C'
Check (Test-Path (Join-Path $Home_ 'modules\mcp')) 'MCP 模块文件夹还在 C'
Check (Test-Path (Join-Path $Data 'Partitions\wa-x\marker.txt')) 'D 盘那份还在'
StopApp

# 4. 指针指的盘打不开（用一个不存在的盘符代替拔掉 D 盘）-> 用 C 启动，软件照常打开，指针不改
$letter = @('Q', 'R', 'S', 'T') | Where-Object { -not (Test-Path "$($_):\") } | Select-Object -First 1
$gone = "$($letter):\WAswitch\data"
Set-Content $Pointer (@{ dir = $gone; cleanC = $false } | ConvertTo-Json)
Launch @('--hidden')
Check (WaitFor { Test-Path (Join-Path $Home_ 'Local State') } 90 'C 盘出现 Local State') 'D 盘打不开：用 C 启动'
Check (WaitFor { Get-Process WAswitch -ErrorAction SilentlyContinue } 10 '在运行') 'D 盘打不开：软件开着'
Start-Sleep -Seconds 5
Check (Get-Process WAswitch -ErrorAction SilentlyContinue) 'D 盘打不开：几秒后还开着'
Check ((Pointer).dir -eq $gone) 'D 盘打不开：指针没改'
StopApp

# 5. D 盘回来（指针改回 D）：回到 D，D 盘那份还在
Set-Content $Pointer (@{ dir = $Data; cleanC = $false } | ConvertTo-Json)
Remove-Item (Join-Path $Data 'logs') -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $Home_ 'logs') -Recurse -Force -ErrorAction SilentlyContinue
Launch @('--hidden')
Check (WaitFor { Test-Path (Join-Path $Data 'logs') } 90 'D 盘出现日志') 'D 盘回来：用 D'
Check (-not (Test-Path (Join-Path $Home_ 'logs'))) 'D 盘回来：C 盘没有新日志'
Check (Test-Path (Join-Path $Data 'Partitions\wa-x\marker.txt')) 'D 盘回来：数据还在'
StopApp

# 6. 同一台电脑另一个 Windows 用户的数据（1.0.1 时两人共用过）：记号是别人的 -> 去掉指针，用 C 启动，D 盘那份不动
Set-Content (Join-Path $Data 'owner.json') (@{ home = 'C:\Users\other-user\AppData\Roaming\WAswitch' } | ConvertTo-Json)
Remove-Item (Join-Path $Home_ 'Local State') -Force -ErrorAction SilentlyContinue
Launch @('--hidden')
Check (WaitFor { Test-Path (Join-Path $Home_ 'Local State') } 90 'C 盘出现 Local State') '别人的数据：用 C 启动'
Check (WaitFor { Get-Process WAswitch -ErrorAction SilentlyContinue } 10 '在运行') '别人的数据：软件开着'
StopApp
Check ($null -eq (Pointer)) '别人的数据：指针去掉了'
Check ((Owner) -eq 'C:\Users\other-user\AppData\Roaming\WAswitch') '别人的记号没改'
Check ((Get-Content (Join-Path $Data 'Partitions\wa-x\marker.txt') -Raw).Trim() -eq 'logged-in') '别人的数据没动'
Write-Host '全部通过'
