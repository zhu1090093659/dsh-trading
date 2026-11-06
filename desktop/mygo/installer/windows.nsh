; WebView2, the Visual C++ Runtime and the uninstall question about user data,
; for the mygo Windows installer.
;
; mygo includes this script after MUI2.nsh and the languages of mygo.json
; (cmd/mygo/nsis.go:nsisHooks) and inserts its macros at three points: customInit
; in .onInit, customInstall at the end of the install section, once the app's
; files are in $INSTDIR, and customUnInstall in the uninstall section, before
; $INSTDIR is removed. A macro this file does not define is left out, which is
; why there is no customInit here.
;
; The file is UTF-8 with a byte order mark: the prompt below is Chinese, and
; makensis reads a file without a BOM in the machine's code page (the installer
; itself says "Unicode true", which mygo writes, so its strings are UTF-16 inside).

!include "LogicLib.nsh"

; --- the files mygo leaves out: every name that starts with a dot -----------
;
; mygo v0.7.4 skips every name that starts with a dot while it copies the
; resources of an app (cmd/mygo/resources.go:551 hiddenName, applied at :643, so a
; dotted directory takes what is under it along), and the payload needs them:
; without @earendil-works/pi-ai/dist/providers/data/.manifest.json the host fails
; with ERR_MODULE_NOT_FOUND and reports an entry that did not activate.
;
; The mac build puts them back after mygo build and signs again; an installer is
; written inside that same build, so the files are copied at install time instead.
; desktop/scripts/stage-mygo-dotfiles.mjs writes build/installer-dotfiles.nsh from
; the staged payload on every build, and the macro it holds is inserted at the top
; of customInstall below, where the files of the app are already in $INSTDIR. A
; build with no such macro stops here rather than shipping an app that cannot
; start.
!if /FileExists "${__FILEDIR__}/../build/installer-dotfiles.nsh"
  !include "${__FILEDIR__}/../build/installer-dotfiles.nsh"
!else
  !if /FileExists "${__FILEDIR__}\..\build\installer-dotfiles.nsh"
    !include "${__FILEDIR__}\..\build\installer-dotfiles.nsh"
  !else
    !error "build/installer-dotfiles.nsh is missing: mygo leaves every name that starts with a dot out of the resources of an app, so an installer built without it ships an app that cannot start (desktop/scripts/build-mygo-win.sh writes that macro from the staged payload before the build)"
  !endif
!endif

; --- the Visual C++ 2015-2022 Redistributable, x64 -------------------------
;
; Kept from the Electron installer (desktop/resources/installer.nsh), whose steps
; this one takes over: the same registry test, the same silent run, the same
; notice instead of a failure when the file is not on the build machine.
;
; node.exe needs no CRT of its own: the payload's node.exe (v24.20.0) imports
; ADVAPI32, CRYPT32, dbghelp, IPHLPAPI, KERNEL32, ole32, SHELL32, USER32,
; USERENV, WINMM and WS2_32 only (its PE import table, read with objdump), and
; the shell is a CGO_ENABLED=0 Go binary, which is static. The native addons the
; payload also ships are the reason this stays: @img/sharp-win32-x64,
; @koromix/koffi-win32-x64, sherpa-onnx-win-x64 and
; node-addon-require-builtin-win32-x64-msvc are MSVC builds (see the platform
; table of desktop/scripts/prune-mygo-payload.mjs), and on a clean Windows they
; need vcruntime140.dll and friends, which the redistributable provides.
;
; The file is desktop/resources/redist/vc_redist.x64.exe, which
; desktop/scripts/fetch-redist.mjs downloads and desktop/.gitignore keeps out of
; the repository. It is not a build error when it is absent: the app installs and
; reports the missing runtime for the modules that need it.
!define VCREDIST_KEY_HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\X64"
!define VCREDIST_FILE "vc_redist.x64.exe"
!if /FileExists "${__FILEDIR__}/../../resources/redist/${VCREDIST_FILE}"
  !define VCREDIST_PATH "${__FILEDIR__}/../../resources/redist/${VCREDIST_FILE}"
!else
  !if /FileExists "${__FILEDIR__}\..\..\resources\redist\${VCREDIST_FILE}"
    !define VCREDIST_PATH "${__FILEDIR__}\..\..\resources\redist\${VCREDIST_FILE}"
  !endif
!endif

; --- the Microsoft Edge WebView2 Runtime ----------------------------------
;
; The shell's windows are Edge WebView2 (internal/windows/webview2.go), so an
; app installed without the runtime starts and shows no window. This is
; Microsoft's own detection: the runtime registers its version as "pv" under this
; client id, machine-wide under WOW6432Node or per-user in HKCU, and a non-empty
; pv means it is installed. The app has its own, file-system test of whether it
; can load the runtime (internal/preflight), which is why a machine whose files
; are gone but whose registry entry stays is caught by the app with a download
; page, while this installer only skips a runtime the registry says is there.
!define WEBVIEW2_CLIENT_ID "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
; The 64-bit registry view of that key, the path Microsoft documents.
!define WEBVIEW2_KEY_HKLM_WOW6432 "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\${WEBVIEW2_CLIENT_ID}"
; The same key in the view of this 32-bit installer. Its HKLM\SOFTWARE is
; WOW6432Node on Windows x64 and the plain SOFTWARE on 32-bit Windows, which is
; where the runtime registers in both cases: without this read, a 32-bit process
; asking for the WOW6432Node path is redirected under WOW6432Node again and
; finds nothing, and every install would run the bootstrapper over a runtime
; that is already there.
!define WEBVIEW2_KEY_HKLM_HERE "SOFTWARE\Microsoft\EdgeUpdate\Clients\${WEBVIEW2_CLIENT_ID}"
!define WEBVIEW2_KEY_HKCU "Software\Microsoft\EdgeUpdate\Clients\${WEBVIEW2_CLIENT_ID}"

; The Evergreen Bootstrapper, which desktop/scripts/fetch-webview2.mjs pins by
; SHA-256 and downloads into the project's resources/windows-amd64/.
; ${__FILEDIR__} is the directory of this file, so the installer works from any
; checkout, wherever it is built, and nothing here is an absolute path; the
; forward-slash form resolves a build on macOS or Linux, the backslash form a
; build on Windows. A build that finds neither stops here: an installer that
; silently shipped without the runtime its app needs would look complete and
; fail on the first launch, so a missing bootstrapper is a build error.
!define WEBVIEW2_BOOTSTRAPPER "MicrosoftEdgeWebview2Setup.exe"
!if /FileExists "${__FILEDIR__}/../resources/windows-amd64/${WEBVIEW2_BOOTSTRAPPER}"
  !define WEBVIEW2_BOOTSTRAPPER_PATH "${__FILEDIR__}/../resources/windows-amd64/${WEBVIEW2_BOOTSTRAPPER}"
!else
  !if /FileExists "${__FILEDIR__}\..\resources\windows-amd64\${WEBVIEW2_BOOTSTRAPPER}"
    !define WEBVIEW2_BOOTSTRAPPER_PATH "${__FILEDIR__}\..\resources\windows-amd64\${WEBVIEW2_BOOTSTRAPPER}"
  !else
    !error "the WebView2 bootstrapper is missing from resources/windows-amd64/ beside this file (run desktop/scripts/fetch-webview2.mjs)"
  !endif
!endif

; Runs at the end of the install, in a silent install (/S) too, which is how
; install.ps1 installs. Every failure here is reported and none stops the
; install: the app's own files are in place by now, and an installer that aborts
; on a machine where a bootstrapper cannot run (no network, a locked-down policy,
; a runtime it cannot upgrade, a user who declines the elevation the
; redistributable asks for) would leave nothing installed and no app to say what
; is missing.
!macro customInstall
  ; What mygo left out of the app's own File commands, put where it belongs
  ; before anything below needs the app to be whole.
  !ifmacrodef RestoreDotfiles
    !insertmacro RestoreDotfiles
  !endif

  DetailPrint "Checking the Microsoft Visual C++ 2015-2022 Redistributable (x64)..."
  StrCpy $R0 ""
  SetRegView 64
  ClearErrors
  ReadRegDWORD $R0 HKLM "${VCREDIST_KEY_HKLM}" "Installed"
  SetRegView default
  ${If} $R0 == 1
    DetailPrint "The Visual C++ Runtime is installed."
  ${Else}
    !ifdef VCREDIST_PATH
      DetailPrint "The Visual C++ Runtime is missing: installing it silently..."
      InitPluginsDir
      File /oname=$PLUGINSDIR\${VCREDIST_FILE} "${VCREDIST_PATH}"
      ExecWait '"$PLUGINSDIR\${VCREDIST_FILE}" /install /quiet /norestart' $2
      Delete "$PLUGINSDIR\${VCREDIST_FILE}"
      ${If} $2 == 0
        DetailPrint "The Visual C++ Runtime was installed (exit code 0)."
      ${Else}
        DetailPrint "Installing the Visual C++ Runtime failed (exit code $2): the native modules of DSH Trading Mygo may not load"
      ${EndIf}
    !else
      DetailPrint "Notice: resources/redist/${VCREDIST_FILE} was not on the build machine, so the Visual C++ Runtime is not installed here."
    !endif
  ${EndIf}

  DetailPrint "Checking the Microsoft Edge WebView2 Runtime..."
  StrCpy $0 ""
  ClearErrors
  SetRegView 64
  ReadRegStr $0 HKLM "${WEBVIEW2_KEY_HKLM_WOW6432}" "pv"
  SetRegView 32
  ${If} $0 == ""
    ClearErrors
    ReadRegStr $0 HKLM "${WEBVIEW2_KEY_HKLM_HERE}" "pv"
  ${EndIf}
  SetRegView default
  ${If} $0 == ""
    ClearErrors
    ReadRegStr $0 HKCU "${WEBVIEW2_KEY_HKCU}" "pv"
  ${EndIf}
  ${If} $0 != ""
    DetailPrint "The WebView2 Runtime is installed (version $0)."
  ${Else}
    DetailPrint "The WebView2 Runtime is missing: installing it silently..."
    InitPluginsDir
    File /oname=$PLUGINSDIR\${WEBVIEW2_BOOTSTRAPPER} "${WEBVIEW2_BOOTSTRAPPER_PATH}"
    ExecWait '"$PLUGINSDIR\${WEBVIEW2_BOOTSTRAPPER}" /silent /install' $1
    Delete "$PLUGINSDIR\${WEBVIEW2_BOOTSTRAPPER}"
    ${If} $1 == 0
      DetailPrint "The WebView2 Runtime was installed (exit code 0)."
    ${Else}
      DetailPrint "Installing the WebView2 Runtime failed (exit code $1): DSH Trading Mygo needs it to show its windows"
    ${EndIf}
  ${EndIf}
!macroend

; --- uninstall: the user data question ------------------------------------
;
; The directories this app writes on Windows, and the only ones the uninstall
; offers to remove:
;
;   $PROFILE\.dsh-trading          the trading home the shell points the host at
;                                  (internal/launch/home.go: ~/.dsh-trading unless
;                                  DSH_HOME is a *-trading path): the profile, its
;                                  sessions and the trading data
;   $APPDATA\DSH Trading Mygo      the app's user data: mygo.App.Path(PathUserData)
;                                  is os.UserConfigDir(), %APPDATA%, plus the app
;                                  name the shell sets (main.go appName), and the
;                                  host log is written there (shell.go:logPath)
;   $LOCALAPPDATA\DSH Trading Mygo the cache, and the WebView2 profile under
;                                  WebView2\ (internal/windows/app.go:189)
;
; $PROFILE\.dsh is never touched here: it is the shared home of the dsh host and
; of the CLI, not this app's (the rule desktop/resources/installer.nsh follows, and
; the reason the trading home is separate in the first place). A DSH_HOME the user
; points somewhere else is not touched either: the shell adopts a *-trading path
; (internal/launch/home.go), and this script only knows the default.
;
; The question is the Electron installer's: YES removes the data, NO (the
; default button) keeps it for a reinstall. A silent uninstall (/S, what Settings
; > Apps and an update run) is answered NO by /SD: it must not wait for a box
; nobody sees, and it must not delete what the user did not agree to.
!macro customUnInstall
  IfSilent keep_user_data
  MessageBox MB_ICONQUESTION|MB_YESNO|MB_DEFBUTTON2 "是否同时清除用户交易数据与配置目录？$\r$\n$\r$\n【是】删除 ~/.dsh-trading（交易数据、会话、profile）与 DSH Trading Mygo 的应用数据$\r$\n【否】保留这些数据，重装后可继续使用$\r$\n$\r$\n（不会删除 ~/.dsh：那是 dsh 宿主与 CLI 的共享 home）" /SD IDNO IDNO keep_user_data
  DetailPrint "Removing ~/.dsh-trading and the app's data..."
  RMDir /r "$PROFILE\.dsh-trading"
  RMDir /r "$APPDATA\DSH Trading Mygo"
  RMDir /r "$LOCALAPPDATA\DSH Trading Mygo"
  keep_user_data:
!macroend
