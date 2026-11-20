!macro customInstall
  ; remove leftovers of older installs / update caches
  RMDir /r "$LOCALAPPDATA\clipwave-updater"
!macroend

!macro customUnInstall
  RMDir /r "$LOCALAPPDATA\clipwave-updater"
!macroend
