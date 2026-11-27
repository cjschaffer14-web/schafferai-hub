# Deployment status — November 27, 2026

Restored the desktop behavior that was live at 3:45 PM at the owner's request. The portal uses the original JPEG/input transport and completed Sound implementation. Relay version 4 was redeployed successfully as `appgdep_6b09fcc2e47c81918d453a15a27f2ae9`. Cache versions were refreshed so browsers load the restored code. Additive migration 0004 and its two unused columns are retained; no database data or migration history was removed. The exact version 4 relay passes all 18 original integration tests against that expanded schema.

Permanent relay **deployed successfully**, without a provider sign-in or temporary tunnel. Portal production path: https://schafferai.com/desktop/.

- Relay: https://schafferai-desktop-relay.cjschaffer14.chatgpt.site
- Managed Site: appgprj_6b07433805f48191885008eebf0ebd90, version 4 (live audio transport).
- Source commit: 06732aeb318abd9467b6144385d970639977a25c.
- Deployment: appgdep_6b09fcc2e47c81918d453a15a27f2ae9, succeeded.
- Public `/health` returns HTTP 200 with no visitor credentials and the correct CORS policy.
- Mac app is installed under the current user's Library/Application Support/SchafferDesktop and connected to the permanent relay.
- Login job: com.schafferai.desktop-portal. Configuration is owner-readable only. No real producer key is stored in source or browser code.

**Mac permissions approved:** the owner completed the local Touch ID approval, and Screen Recording plus Accessibility are enabled for the installed app. The restarted login job reports connected=true, ready=true, Screen Recording=true and Accessibility=true. A real production session displayed live 1440×930 Mac frames, and the portal Apps shortcut visibly opened Spotlight. Disconnect was verified to return the active viewer count to zero while leaving the Mac available. Further document text-entry testing was paused because another chat was controlling the same Mac; no input was retried into that other controller’s file dialog.

Validated: 57 frontend/HTTP transport/audio/screen-fit tests, 18 managed HTTP/D1/R2 integration tests using real SQLite and generated migrations, native audio build/self-test (including stereo 44.1→48 kHz conversion) and strict signature verification, prior work-account authorization regressions, native input/configuration/HTTPS/idle-state tests, and successful managed publication. Earlier live browser validation corrected grid sizing that cropped the lower desktop: canvas dimensions preserve the native aspect ratio within the available container on resize, orientation change and fullscreen.

**Audio setup completed:** Schaffer Desktop Audio v1.1 build 4 is installed with login job `com.schafferai.desktop-audio`. Its dedicated **System Audio Recording Only** permission is enabled in macOS. It uses a private CoreAudio process tap rather than requesting screen recording. The official signed BlackHole 2ch 0.7.1 driver is active without a restart. The existing video app's binary, signature and permissions were preserved.

Live sound validation received 33 fresh 48 kHz stereo PCM packets during an eight-second run, including 11 nonzero packets from a short known test tone (peak 0.01999). The actual browser `DesktopAudio` player decoded and scheduled 30 packets while its audio clock advanced 8.61 seconds. Browser output was explicitly routed to a silent sink to prevent local feedback; this was a rendering check, not a remote speaker listening test. Muting rejected subsequent reads with HTTP 409, and test viewer leases were closed. No physical microphone was opened and no captured PCM was saved. Remote microphone transport previously accepted synthetic packets into the BlackHole path; real voice delivery into a chosen Mac app remains a separate check.

The relay now evaluates heartbeat freshness after asynchronous reads and clears stale capabilities atomically, preventing a newer heartbeat from incorrectly stopping Sound. Audio upload/read paths use three D1 round trips; helper state uses one. Browser freshness accounting includes server processing once. The helper permits three concurrent uploads with no queue, retaining the existing session and age fences.

The owner explicitly requires no portal authentication. Anyone reaching the portal can control an available Mac. A producer key only identifies the fixed Mac; it does not authenticate visitors. Existing private Google work-account tools remain separate.

The system must be awake and unlocked. The connection holds an AC-only sleep assertion while permitting display sleep; it does not bypass macOS lock or lid-close behavior. Optional Sound and Microphone controls begin off and require deliberate enablement. The audio helper never captures the Mac's physical microphone or selects its speakers for remote microphone output. Select BlackHole 2ch as the input in a target Mac app. Stop access immediately with Pause, Disconnect or Quit in the Schaffer Desktop menu; the audio helper also has Pause Audio and Quit controls.
