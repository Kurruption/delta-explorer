; Delta Explorer installer hooks.
; On uninstall, remove the optional Win+E override so Win+E goes back to File Explorer.
!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey HKCU "Software\Classes\CLSID\{52205fd8-5dfb-447d-801a-d0b52f2e83e1}"
!macroend
