; Windows 安装向导：中文界面，有欢迎页和完成页（左侧图是 build/installerSidebar.bmp）。
; 总是只给当前用户安装，不问“为谁安装”，也不需要管理员权限——和以前的一键安装装在同一个位置，
; 老版本能直接覆盖升级。自动更新时是静默安装，不显示这些页面。

!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
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
  !define MUI_FINISHPAGE_TEXT "桌面和开始菜单里都有 WAswitch。$\r$\n$\r$\n以后有新版本会在后台自动下载，下载好后在软件左下角提醒你重启更新。"
  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_TEXT "现在打开 WAswitch"
  !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !insertmacro MUI_PAGE_FINISH
!macroend
