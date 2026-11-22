; Clipwave 2 (Tauri) replaces Clipwave 1.x (Electron). Before installing, uninstall the old app silently
; with "--updated" so it keeps the user's projects in %APPDATA%\Clipwave (both versions use that folder).
!define CW_OLD_KEY "28d8a5ff-cfff-519e-9ddc-fa4b1ebd6a86"

!macro CW_DEL_OLD FILE
  Delete "$R0\${FILE}"
!macroend

!macro NSIS_HOOK_PREINSTALL
  ReadRegStr $R0 HKCU "Software\${CW_OLD_KEY}" "InstallLocation"
  StrCmp $R0 "" 0 +2
    StrCpy $R0 "$LOCALAPPDATA\Programs\Clipwave"
  IfFileExists "$R0\Uninstall Clipwave.exe" 0 cw_no_old
    DetailPrint "Removing Clipwave 1.x from $R0"
    ; _?= runs the uninstaller in place and waits for it (otherwise it would race with this install)
    ExecWait '"$R0\Uninstall Clipwave.exe" /S /currentuser --updated _?=$R0'
    ; in "--updated" mode the old uninstaller keeps its program files: remove exactly the Electron app files
    !insertmacro CW_DEL_OLD "Uninstall Clipwave.exe"
    !insertmacro CW_DEL_OLD "Clipwave.exe"
    !insertmacro CW_DEL_OLD "LICENSE.electron.txt"
    !insertmacro CW_DEL_OLD "LICENSES.chromium.html"
    !insertmacro CW_DEL_OLD "chrome_100_percent.pak"
    !insertmacro CW_DEL_OLD "chrome_200_percent.pak"
    !insertmacro CW_DEL_OLD "d3dcompiler_47.dll"
    !insertmacro CW_DEL_OLD "dxcompiler.dll"
    !insertmacro CW_DEL_OLD "dxil.dll"
    !insertmacro CW_DEL_OLD "electron_wer.dll"
    !insertmacro CW_DEL_OLD "ffmpeg.dll"
    !insertmacro CW_DEL_OLD "icudtl.dat"
    !insertmacro CW_DEL_OLD "libEGL.dll"
    !insertmacro CW_DEL_OLD "libGLESv2.dll"
    !insertmacro CW_DEL_OLD "resources.pak"
    !insertmacro CW_DEL_OLD "snapshot_blob.bin"
    !insertmacro CW_DEL_OLD "v8_context_snapshot.bin"
    !insertmacro CW_DEL_OLD "vk_swiftshader.dll"
    !insertmacro CW_DEL_OLD "vk_swiftshader_icd.json"
    !insertmacro CW_DEL_OLD "vulkan-1.dll"
    RMDir /r "$R0\locales"
    IfFileExists "$R0\resources\app.asar" 0 +2
      RMDir /r "$R0\resources"
    RMDir "$R0"
    DeleteRegKey HKCU "Software\${CW_OLD_KEY}"
    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${CW_OLD_KEY}"
  cw_no_old:
  ; download cache of the old Electron auto-updater
  RMDir /r "$LOCALAPPDATA\clipwave-updater"
!macroend
