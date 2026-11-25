# Deployment status — November 25, 2026

Permanent relay **deployed successfully**, without a provider sign-in or temporary tunnel. Portal production path: https://schafferai.com/desktop/.

- Relay: https://schafferai-desktop-relay.cjschaffer14.chatgpt.site
- Managed Site: appgprj_6b07433805f48191885008eebf0ebd90, version 1.
- Source commit: 980177817014b2c73b20cc5ce69aa518a66e8ea5.
- Deployment: appgdep_6b0745e31438819198766c96199a4e25, succeeded.
- Public `/health` returns HTTP 200 with no visitor credentials and the correct CORS policy.
- Mac app is installed under the current user's Library/Application Support/SchafferDesktop and connected to the permanent relay.
- Login job: com.schafferai.desktop-portal. Configuration is owner-readable only. No real producer key is stored in source or browser code.

**Mac permissions still required:** macOS currently reports Screen Recording=false and Accessibility=false for the installed app. Consequently the relay reports connected=true, ready=false, state=permissions_required. Capture and input remain blocked. This is the actual current state, not a simulated desktop. A live frame/input acceptance test remains pending those system approvals.

Validated: 37 frontend/HTTP transport tests, 8 managed HTTP/D1/R2 integration tests using real SQLite and generated migrations, prior work-account authorization regressions, native input/configuration/HTTPS/idle-state tests, signed app ZIP verification, and successful managed publication. Actual production browser and Mac input verification must be recorded after permission approval.

The owner explicitly requires no portal authentication. Anyone reaching the portal can control an available Mac. A producer key only identifies the fixed Mac; it does not authenticate visitors. Existing private Google work-account tools remain separate.

The system must be awake and unlocked. The connection holds an AC-only sleep assertion while permitting display sleep; it does not bypass macOS lock or lid-close behavior. The native app never records audio. Stop access immediately with Pause, Disconnect or Quit in the Schaffer Desktop menu.
