# Browser Mac desktop

The permanent relay is deployed. The Mac connection is installed with automatic startup. Both macOS permissions are enabled and live streaming plus the app-search keyboard shortcut have been verified. See [deployment status](./DEPLOYMENT_STATUS.md) for the exact validation state.

`/desktop/` is a dedicated live desktop portal linked from the homepage and developer hub. The owner explicitly requested **no visitor authentication** on November 25, 2026. There is no portal account, password, PIN, MFA, or secret visitor link. Anyone reaching the portal can operate the connected Mac and access anything that its current desktop session can access.

The website is static GitHub Pages. The managed relay carries a fixed Mac's JPEG frames and validated mouse/keyboard input over HTTPS. Public viewers have no login. A current JPEG is briefly cached in private R2 storage and overwritten; there is no historical screen recording. The native menu-bar app connects outbound, so no router port forwarding, public VNC port, or public simulator-bridge port is needed. The existing Google work-account tools and their authorization are separate.

## Components

- `index.html`, `styles.css`, `portal.js`: responsive browser client, touch/mouse/keyboard/text input, disconnect and fullscreen controls.
- `config.json`: permanent relay origin and HTTP transport selection. Never put a producer key here.
- `http-transport.js`: anonymous viewer leases, fresh JPEG polling, ordered bounded input batches and disconnect cleanup.
- `managed-relay/`: reproducible copy of the deployed managed Worker, D1 schema/migrations, tests, manifest and deployment receipt.
- `install-mac.py`: installs the native app, owner-only configuration and a macOS login job; it does not change lock or permission settings.
- `relay/`: one fixed-target Worker/Durable Object. No screenshots, keystrokes, or desktop recordings are archived. See its README for endpoints, quotas, deployment and rollback.
- `mac/`: native Swift menu-bar app. See its README for building, permissions, config and local start commands.
- `local/`: an alternative fixed-target loopback Node relay for a permanent HTTPS host; it does not create public hosting.
- `tests/portal.test.cjs`: frontend regressions for unseen/stale frames, pointer coordinates, held keys, disconnect/reconnect races, pending scroll and unsent text.

The Mac producer has a private random key so strangers cannot impersonate it. That key is only in the Worker's secret store and an owner-readable local config, never the webpage or GitHub. It does **not** authenticate desktop visitors.

## Availability and limits

The Mac must be powered, online, and running the connection app. While connected, the app keeps the system awake on AC power while allowing the display to turn off. Closing the laptop lid can still cause sleep; keep the lid open for this setup. When macOS locks, capture and control stop; the app does not bypass the lock screen. macOS auto-lock settings can therefore make the desktop unavailable even with the display off.

Screen Recording and Accessibility permissions must be granted through normal macOS controls if not already available. The primary display streams at up to 8 JPEG frames/second and 1440 pixels wide, suitable for ordinary app/file work. This release does not send desktop audio, capture microphones, transfer files directly, or provide a new autonomous Codex agent. An assistant with browser-control tools can operate the same portal; it still needs a live execution session and authorization for its actions.

Viewer leases are public session tracking, not authentication. Inputs expire after two seconds and are removed after acknowledgement. The latest frame is served only while fresh and is cleared when sharing stops, no viewers remain, or the agent becomes unavailable.

At most two viewers may connect. They share one mouse/keyboard/session, so simultaneous input can conflict. Public access can consume the free relay quotas; service availability is not guaranteed. Neither the frontend nor the relay is a login boundary. Disconnect, pause, or quit the native menu-bar app to stop access immediately.

The browser enables control only after receiving a fresh desktop frame. It releases held inputs when focus is lost, clears pending input on disconnect, and disconnects when the tab is hidden. It never retries an input action automatically. Reconnect explicitly after returning to a backgrounded tab.

## Validation

From the repository root:

```sh
node --test desktop/tests/portal.test.cjs desktop/relay/test/relay.test.mjs
node --test test-work-auth.cjs
./desktop/mac/build.sh /absolute/output/SchafferDesktop.app
/absolute/output/SchafferDesktop.app/Contents/MacOS/SchafferDesktop --self-test
```

These offline checks do not establish that cloud deployment, screen capture, or live input works. Check the returned deployment origin, actual `/health` state and a real browser session before claiming the Mac is available. Use a harmless local test document for input validation, never an email/send/payment action.

## Stop and rollback

Use **Disconnect** or **Quit** in the Schaffer Desktop menu-bar app. This ends desktop access and the AC sleep assertion without changing macOS sleep/lock settings. Remove or revert only this portal's homepage/dev links and dedicated relay; preserve existing Google work tools, simulator bridge, Hermes services, and production history. The installer adds only `com.schafferai.desktop-portal` for the current macOS user. It starts the menu-bar connection after login. Pause, disconnect, or quit remain available from the app menu.
