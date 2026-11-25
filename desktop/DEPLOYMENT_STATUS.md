# Deployment status — November 25, 2026

Permanent relay **deployed successfully**, without a provider sign-in or temporary tunnel. Portal production path: https://schafferai.com/desktop/.

- Relay: https://schafferai-desktop-relay.cjschaffer14.chatgpt.site
- Managed Site: appgprj_6b07433805f48191885008eebf0ebd90, version 2 (live audio transport).
- Source commit: 871bd3ba9257b11a691d5abf94be3921ec127a16.
- Deployment: appgdep_6b0759bf19588191b9ab897c5a301481, succeeded.
- Public `/health` returns HTTP 200 with no visitor credentials and the correct CORS policy.
- Mac app is installed under the current user's Library/Application Support/SchafferDesktop and connected to the permanent relay.
- Login job: com.schafferai.desktop-portal. Configuration is owner-readable only. No real producer key is stored in source or browser code.

**Mac permissions approved:** the owner completed the local Touch ID approval, and Screen Recording plus Accessibility are enabled for the installed app. The restarted login job reports connected=true, ready=true, Screen Recording=true and Accessibility=true. A real production session displayed live 1440×930 Mac frames, and the portal Apps shortcut visibly opened Spotlight. Disconnect was verified to return the active viewer count to zero while leaving the Mac available. Further document text-entry testing was paused because another chat was controlling the same Mac; no input was retried into that other controller’s file dialog.

Validated: 53 frontend/HTTP transport/audio/screen-fit tests, 13 managed HTTP/D1/R2 integration tests using real SQLite and generated migrations, native audio build/self-test and strict signature verification, prior work-account authorization regressions, native input/configuration/HTTPS/idle-state tests, and successful managed publication. Earlier live browser validation corrected grid sizing that cropped the lower desktop: canvas dimensions preserve the native aspect ratio within the available container on resize, orientation change and fullscreen.

**Audio setup:** the separate Schaffer Desktop Audio helper is installed with login job `com.schafferai.desktop-audio`. The user installed the official signed BlackHole 2ch 0.7.1 driver; its device is already active without a restart. Production health confirms the helper heartbeat and BlackHole availability. Screen & System Audio Recording approval for this new helper is pending. The existing video app's binary, signature and permissions were preserved. Synthetic checks do not prove audible playback, real browser microphone capture or delivery to a target Mac app; those remain distinct live checks.

The owner explicitly requires no portal authentication. Anyone reaching the portal can control an available Mac. A producer key only identifies the fixed Mac; it does not authenticate visitors. Existing private Google work-account tools remain separate.

The system must be awake and unlocked. The connection holds an AC-only sleep assertion while permitting display sleep; it does not bypass macOS lock or lid-close behavior. Optional Sound and Microphone controls begin off and require deliberate enablement. The audio helper never captures the Mac's physical microphone or selects its speakers for remote microphone output. Select BlackHole 2ch as the input in a target Mac app. Stop access immediately with Pause, Disconnect or Quit in the Schaffer Desktop menu; the audio helper also has Pause Audio and Quit controls.
