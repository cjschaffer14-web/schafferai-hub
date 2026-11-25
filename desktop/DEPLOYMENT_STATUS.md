# Deployment status — November 25, 2026

Permanent relay **deployed successfully**, without a provider sign-in or temporary tunnel. Portal production path: https://schafferai.com/desktop/.

- Relay: https://schafferai-desktop-relay.cjschaffer14.chatgpt.site
- Managed Site: appgprj_6b07433805f48191885008eebf0ebd90, version 1.
- Source commit: 980177817014b2c73b20cc5ce69aa518a66e8ea5.
- Deployment: appgdep_6b0745e31438819198766c96199a4e25, succeeded.
- Public `/health` returns HTTP 200 with no visitor credentials and the correct CORS policy.
- Mac app is installed under the current user's Library/Application Support/SchafferDesktop and connected to the permanent relay.
- Login job: com.schafferai.desktop-portal. Configuration is owner-readable only. No real producer key is stored in source or browser code.

**Mac permissions approved:** the owner completed the local Touch ID approval, and Screen Recording plus Accessibility are enabled for the installed app. The restarted login job reports connected=true, ready=true, Screen Recording=true and Accessibility=true. A real production session displayed live 1440×930 Mac frames, and the portal Apps shortcut visibly opened Spotlight. Disconnect was verified to return the active viewer count to zero while leaving the Mac available. Further document text-entry testing was paused because another chat was controlling the same Mac; no input was retried into that other controller’s file dialog.

Validated: 42 frontend/HTTP transport and screen-fit tests, 8 managed HTTP/D1/R2 integration tests using real SQLite and generated migrations, prior work-account authorization regressions, native input/configuration/HTTPS/idle-state tests, signed app ZIP verification, and successful managed publication. The live browser test also found and corrected grid sizing that cropped the lower desktop: canvas dimensions now preserve the native aspect ratio within the available container on resize, orientation change and fullscreen.

The owner explicitly requires no portal authentication. Anyone reaching the portal can control an available Mac. A producer key only identifies the fixed Mac; it does not authenticate visitors. Existing private Google work-account tools remain separate.

The system must be awake and unlocked. The connection holds an AC-only sleep assertion while permitting display sleep; it does not bypass macOS lock or lid-close behavior. The native app never records audio. Stop access immediately with Pause, Disconnect or Quit in the Schaffer Desktop menu.
