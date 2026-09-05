; Custom NSIS installer script for DSH Trading Desktop
; Includes:
; 1. Detection and silent installation of Microsoft Visual C++ 2015-2022 Redistributable (x64)
; 2. Uninstallation prompt asking the user whether to clean ~/.dsh and user app data

!macro customInstall
  DetailPrint "Checking Microsoft Visual C++ 2015-2022 Redistributable (x64)..."
  SetRegView 64
  ClearErrors
  ReadRegDWORD $0 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\X64" "Installed"
  ${If} ${Errors}
    StrCpy $0 0
  ${EndIf}

  ${If} $0 != 1
    DetailPrint "Visual C++ Redistributable not detected. Installing..."
    InitPluginsDir
    !if /FileExists "${BUILD_RESOURCES_DIR}\redist\vc_redist.x64.exe"
      File /oname=$PLUGINSDIR\vc_redist.x64.exe "${BUILD_RESOURCES_DIR}\redist\vc_redist.x64.exe"
      ExecWait '"$PLUGINSDIR\vc_redist.x64.exe" /install /quiet /norestart' $1
      DetailPrint "Visual C++ Redistributable install exited with code $1"
      Delete "$PLUGINSDIR\vc_redist.x64.exe"
    !else
      DetailPrint "Notice: Bundled vc_redist.x64.exe not found during build, skipping automatic install."
    !endif
  ${Else}
    DetailPrint "Visual C++ Redistributable is already installed."
  ${EndIf}
  SetRegView default
!macroend

!macro customUnInstall
  MessageBox MB_ICONQUESTION|MB_YESNO "是否同时清除用户交易数据与配置目录（包括 ~/.dsh 和本地缓存）？$\r$\n$\r$\n【是】完全删除数据与配置$\r$\n【否】保留用户数据以便重新安装" IDNO skipUserData
    DetailPrint "Cleaning user data directory (~/.dsh)..."
    RMDir /r "$PROFILE\.dsh"
    RMDir /r "$APPDATA\dsh-trading-desktop"
    RMDir /r "$LOCALAPPDATA\dsh-trading-desktop"
  skipUserData:
!macroend
