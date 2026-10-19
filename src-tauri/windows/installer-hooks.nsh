; Installer hooks (bundle.windows.nsis.installerHooks).
;
; Earlier versions were installed under previous product names: BananaXterm
; (up to 0.7.26) and BananaTerm (0.7.27-0.7.28). The installer removes those
; copies so only one program, one Start menu entry and one uninstall entry
; remain. Sessions, settings and saved passwords are keyed by the unchanged app
; identifier and are not touched.

Var BtPreviousInstall

; Uninstall the copy registered under product name ${NAME}, if any.
!macro BT_REMOVE_PREVIOUS NAME
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${NAME}" "InstallLocation"
  ${If} $0 != ""
    ; InstallLocation is written in quotes.
    StrCpy $1 $0 1
    ${If} $1 == '"'
      StrCpy $0 $0 "" 1
      StrCpy $0 $0 -1
    ${EndIf}
  ${Else}
    StrCpy $0 "$LOCALAPPDATA\${NAME}"
  ${EndIf}
  ${If} ${FileExists} "$0\uninstall.exe"
  ${AndIf} $0 != $INSTDIR
    StrCpy $BtPreviousInstall $0
    ; _?= keeps the uninstaller in place so ExecWait really waits for it.
    ExecWait '"$0\uninstall.exe" /S _?=$0'
    Delete "$0\uninstall.exe"
    RMDir "$0"
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  StrCpy $BtPreviousInstall ""
  !insertmacro BT_REMOVE_PREVIOUS "BananaTerm"
  !insertmacro BT_REMOVE_PREVIOUS "BananaXterm"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; The previous version's updater restarts the program from its old folder,
  ; which no longer exists, so a silent update starts the new one here.
  ${If} $BtPreviousInstall != ""
  ${AndIf} ${Silent}
    ; Per-user install: the installer already runs as the user, not elevated.
    Exec '"$INSTDIR\${MAINBINARYNAME}.exe"'
  ${EndIf}
!macroend
