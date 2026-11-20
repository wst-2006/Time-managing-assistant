!macro StopTimeManagingRuntime
  ; Ask the app to exit first so it can stop its local service normally.
  !insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "${PRODUCTNAME}"

  ; A forcibly closed older release can leave its bundled Node processes alive.
  ; Extract the new GUI executable as a native cleanup helper. It matches the
  ; complete node.exe path and never invokes an external command shell.
  InitPluginsDir
  File /oname=$PLUGINSDIR\tma-runtime-cleanup.exe "${MAINBINARYSRCPATH}"
  nsExec::ExecToStack '"$PLUGINSDIR\tma-runtime-cleanup.exe" --cleanup-installed-runtime "$INSTDIR\runtime\node.exe"'
  Pop $R0
  Pop $R1
  ${If} $R0 != 0
    DetailPrint "Unable to stop the previous bundled runtime: $R1"
    MessageBox MB_ICONSTOP|MB_OK "无法关闭旧版时间管理助手的后台服务。请退出软件后重新运行安装程序。"
    Abort
  ${EndIf}

  ; The bundled runtime is fully replaceable. Removing it after all matching
  ; processes have stopped prevents stale service files from surviving an
  ; in-place upgrade. Your data folder and settings live outside this folder.
  RMDir /r "$INSTDIR\runtime"
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro StopTimeManagingRuntime
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro StopTimeManagingRuntime
!macroend
