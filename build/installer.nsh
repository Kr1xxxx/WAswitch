; Windows 安装向导：中文界面，有欢迎页和完成页（左侧图是 build/installerSidebar.bmp）。
; 总是只给当前用户安装，不问“为谁安装”，也不需要管理员权限——和以前的一键安装装在同一个位置，
; 老版本能直接覆盖升级。自动更新时是静默安装，不显示这些页面。

!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

; 第一次安装默认装到 D:\WAswitch\app（shen 2026-10-29）。
; 程序必须在 app 子文件夹里：卸载程序每次更新、卸载时都会清空安装文件夹，D:\WAswitch 里还放着译文，不能直接装在那里。
; 只在第一次安装时选：注册表里已经有安装位置（更新、重装、老电脑）或命令行给了 /D= 就不动，更新原地装，老电脑程序不挪。
; D 盘要是本机硬盘（GetDriveType = 3，U 盘 2、网络盘 4、光驱 5 都不用），并且能建文件夹、能写文件，否则用默认位置。
; 判断 D 盘可用的同时建好 D:\WAswitch：软件靠这个文件夹存在才把译文放 D 盘，自己不建。
; 打包卸载程序的那一遍也会展开这个宏，那一遍没有用到这些函数，NSIS 的「函数没用到」警告会被当成错误，所以只在安装程序里定义
!macro customHeader
!ifndef BUILD_UNINSTALLER
  Function WASwitchDFixed
    Push $1
    StrCpy $1 "0"
    System::Call 'kernel32::GetDriveTypeW(w "D:\") i .r0'
    ${if} $0 == 3
      CreateDirectory "D:\WAswitch"
      ClearErrors
      FileOpen $0 "D:\WAswitch\.setup-probe" w
      ${ifNot} ${Errors}
        FileClose $0
        Delete "D:\WAswitch\.setup-probe"
        StrCpy $1 "1"
      ${endif}
    ${endif}
    StrCpy $0 $1 ; 结果放 $0（"1" 可用）；调用的人自己保存 $0
    Pop $1
  FunctionEnd

  Function WASwitchPickDir
    Push $0
    Push $1
    ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${if} $0 == ""
      ReadRegStr $0 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${endif}
    ${if} $0 == ""
      !insertmacro GetDParameter $0
    ${endif}
    ${if} $0 == ""
      Call WASwitchDFixed
      ${if} $0 == "1"
        StrCpy $INSTDIR "D:\WAswitch\app"
      ${endif}
    ${endif}
    Pop $1
    Pop $0
  FunctionEnd

  ; 向导里「为谁安装」页之后会把 $INSTDIR 重置回默认位置，所以在它后面再选一次；这一页不显示（Abort）
  Function WASwitchDirPage
    Call WASwitchPickDir
    Abort
  FunctionEnd
!endif
!macroend

; 静默安装（/S，包括自动更新）没有页面，在这里选。initMultiUser 已经跑过。
!macro customInit
  Call WASwitchPickDir
!macroend

!macro customPageAfterChangeDir
  Page custom WASwitchDirPage
!macroend

; 老电脑自动更新到这一版时也建 D:\WAswitch，软件靠它判断译文能不能放 D 盘
!macro customInstall
  Push $0
  Call WASwitchDFixed
  Pop $0
!macroend

!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "欢迎安装 WAswitch"
  !define MUI_WELCOMEPAGE_TEXT "在一个窗口里同时登录多个 WhatsApp 账号，每个号互相隔离、各走各的代理。$\r$\n$\r$\n安装只要几秒钟，不需要管理员权限。已经装过旧版本的话，账号、聊天记录和设置都会保留。$\r$\n$\r$\n点「下一步」开始安装。"
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customFinishPage
  Function StartApp
    ${if} ${isUpdated}
      StrCpy $1 "--updated"
    ${else}
      StrCpy $1 ""
    ${endif}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  FunctionEnd

  !define MUI_FINISHPAGE_TITLE "WAswitch 已经装好了"
  !define MUI_FINISHPAGE_TEXT "桌面和开始菜单里都有 WAswitch。$\r$\n$\r$\n以后有新版本会在后台自动下载，下载好后在软件左下角提醒你更新。"
  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_TEXT "现在打开 WAswitch"
  !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !insertmacro MUI_PAGE_FINISH
!macroend
