Unicode True
RequestExecutionLevel user
ManifestDPIAware true
SetCompressor /SOLID zlib

!include "MUI2.nsh"
!include "WinVer.nsh"
!include "x64.nsh"
!define UNINSTALL "Software\Microsoft\Windows\CurrentVersion\Uninstall\Arachne"
!define MUI_ICON "${APP_ICON}"
!define MUI_FINISHPAGE_RUN "$INSTDIR\Arachne.exe"
!define MUI_FINISHPAGE_RUN_TEXT "打开阿拉克涅"

Name "阿拉克涅 ${VERSION}"
OutFile "${OUTPUT}"
InstallDir "$LOCALAPPDATA\Programs\Arachne"
InstallDirRegKey HKCU "${UNINSTALL}" "InstallLocation"
VIProductVersion "${PRODUCT_VERSION}"
VIAddVersionKey /LANG=2052 "ProductName" "阿拉克涅"
VIAddVersionKey /LANG=2052 "FileDescription" "阿拉克涅 Windows 桌面版安装程序"
VIAddVersionKey /LANG=2052 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=2052 "LegalCopyright" "Arachne contributors"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

Function .onInit
  ${IfNot} ${AtLeastWin10}
  ${OrIfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "阿拉克涅需要 64 位 Windows 10 或更新版本。"
    SetErrorLevel 1
    Abort
  ${EndIf}
FunctionEnd

Section "阿拉克涅"
  SetShellVarContext current
  IfFileExists "$INSTDIR\Arachne.exe" 0 copy_files
  ClearErrors
  FileOpen $0 "$INSTDIR\Arachne.exe" a
  IfErrors running
  FileClose $0
  Goto copy_files
running:
  MessageBox MB_ICONSTOP "请先退出阿拉克涅，再继续安装。" /SD IDOK
  SetErrorLevel 1
  Abort
copy_files:
  SetOutPath "$INSTDIR"
  File /r "${BUNDLE_FILES}"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateDirectory "$SMPROGRAMS\阿拉克涅"
  CreateShortCut "$SMPROGRAMS\阿拉克涅\阿拉克涅.lnk" "$INSTDIR\Arachne.exe" "" "$INSTDIR\resources\app\arachne.ico"
  WriteRegStr HKCU "${UNINSTALL}" "DisplayName" "阿拉克涅"
  WriteRegStr HKCU "${UNINSTALL}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTALL}" "DisplayIcon" "$INSTDIR\resources\app\arachne.ico"
  WriteRegStr HKCU "${UNINSTALL}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL}" "UninstallString" '$\"$INSTDIR\Uninstall.exe$\"'
  WriteRegDWORD HKCU "${UNINSTALL}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  ClearErrors
  Delete "$INSTDIR\Arachne.exe"
  IfErrors 0 remove_files
  MessageBox MB_ICONSTOP "请先退出阿拉克涅，再卸载。" /SD IDOK
  SetErrorLevel 1
  Abort
remove_files:
  RMDir /r "$INSTDIR\resources"
  RMDir /r "$INSTDIR\locales"
  Delete "$INSTDIR\ArachneMCP.cmd"
  Delete "$INSTDIR\LICENSE"
  Delete "$INSTDIR\LICENSES.chromium.html"
  Delete "$INSTDIR\使用说明.md"
  Delete "$INSTDIR\chrome_100_percent.pak"
  Delete "$INSTDIR\chrome_200_percent.pak"
  Delete "$INSTDIR\d3dcompiler_47.dll"
  Delete "$INSTDIR\dxcompiler.dll"
  Delete "$INSTDIR\electron_wer.dll"
  Delete "$INSTDIR\ffmpeg.dll"
  Delete "$INSTDIR\icudtl.dat"
  Delete "$INSTDIR\resources.pak"
  Delete "$INSTDIR\snapshot_blob.bin"
  Delete "$INSTDIR\v8_context_snapshot.bin"
  Delete "$INSTDIR\version"
  Delete "$INSTDIR\vk_swiftshader.dll"
  Delete "$INSTDIR\vk_swiftshader_icd.json"
  Delete "$INSTDIR\vulkan-1.dll"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  Delete "$SMPROGRAMS\阿拉克涅\阿拉克涅.lnk"
  RMDir "$SMPROGRAMS\阿拉克涅"
  DeleteRegKey HKCU "${UNINSTALL}"
SectionEnd
