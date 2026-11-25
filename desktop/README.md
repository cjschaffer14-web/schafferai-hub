# Browser Mac desktop

The permanent relay is deployed. The Mac connection is installed with automatic startup. Both macOS permissions are enabled and live streaming plus the app-search keyboard shortcut have been verified. See [deployment status](./DEPLOYMENT_STATUS.md) for the exact validation state.

`/desktop/` is a dedicated live desktop portal linked from the homepage and developer hub. The owner explicitly requested **no visitor authentication** on November 25, 2026. There is no portal account, password, PIN, MFA, or secret visitor link. Anyone reaching the portal can operate the connected Mac and access anything that its current desktop session can access.

The website is static GitHub Pages. The managed relay carries a fixed Mac's JPEG frames, validated mouse/keyboard input and optional live audio over HTTPS. Public viewers have no login. Fresh frames and short audio chunks are briefly cached in private R2 storage; there is no history playback endpoint. The native apps connect outbound, so no router port forwarding, public VNC port, or public simulator-bridge port is needed. The existing Google work-account tools and their authorization are separate.

## Components

- `index.html`, `styles.css`, `portal.js`: responsive browser client, touch/mouse/keyboard/text input, disconnect and fullscreen controls.
- `config.json`: permanent relay origin and HTTP transport selection. Never put a producer key here.
- `http-transport.js`: anonymous viewer leases, fresh JPEG polling, ordered bounded input batches and disconnect cleanup.
- `audio.js`, `audio-capture-worklet.js`: explicit sound playback and browser microphone forwarding. Both begin off.
- `managed-relay/`: reproducible copy of the deployed managed Worker, D1 schema/migrations, tests, manifest and deployment receipt.
- `install-mac.py`: installs the native app, owner-only configuration and a macOS login job; it does not change lock or permission settings.
- `relay/`: one fixed-target Worker/Durable Object. No screenshots, keystrokes, or desktop recordings are archived. See its README for endpoints, quotas, deployment and rollback.
- `mac/`: native Swift menu-bar app. See its README for building, permissions, config and local start commands.
- `mac/audio/`: separate audio helper and login job. Its signature and permissions are independent of the working desktop app.
- `local/`: an alternative fixed-target loopback Node relay for a permanent HTTPS host; it does not create public hosting.
- `tests/portal.test.cjs`: frontend regressions for unseen/stale frames, pointer coordinates, held keys, disconnect/reconnect races, pending scroll and unsent text.

The Mac producer has a private random key so strangers cannot impersonate it. That key is only in the Worker's secret store and an owner-readable local config, never the webpage or GitHub. It does **not** authenticate desktop visitors.

## Availability and limits

The Mac must be powered, online, and running the connection app. While connected, the app keeps the system awake on AC power while allowing the display to turn off. Closing the laptop lid can still cause sleep; keep the lid open for this setup. When macOS locks, capture and control stop; the app does not bypass the lock screen. macOS auto-lock settings can therefore make the desktop unavailable even with the display off.

Screen Recording and Accessibility permissions must be granted through normal macOS controls if not already available. The primary display streams at up to 8 JPEG frames/second and 1440 pixels wide, suitable for ordinary app/file work. It does not transfer files directly or provide a new autonomous Codex agent. An assistant with browser-control tools can operate the same portal; it still needs a live execution session and authorization for its actions.

## Sound and remote microphone

After connecting, **Sound** plays Mac system audio on the visiting device. **Microphone** asks the visiting browser for microphone permission and forwards that input to **BlackHole 2ch** on the Mac. Select **BlackHole 2ch** as the input device in the Mac app that should receive it. The helper never changes the Mac's default input or output device, and never captures the Mac's physical microphone.

The separate **Schaffer Desktop Audio** helper needs the normal macOS system audio capture permission. BlackHole is installed from its official signed installer; a Mac restart may be required before its device appears. Missing permissions or devices are reported in the portal. Sound and microphone both begin off, stop when the viewer disconnects or the tab is hidden, and require another deliberate click to resume. One visitor at a time can forward a microphone.

Audio uses 200 ms PCM chunks with bounded queues and freshness checks. It adds network and buffering delay. Expired chunks are never served; physical cleanup happens on normal relay requests. Testing a portal on the same Mac that produces its audio can cause feedback, so use a separate visiting device or leave Sound off.

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

Use **Disconnect** or **Quit** in the Schaffer Desktop menu-bar app. This ends desktop access and the AC sleep assertion without changing macOS sleep/lock settings. Remove or revert only this portal's homepage/dev links and dedicated relay; preserve existing Google work tools, simulator bridge, Hermes services, and production history. The desktop installer adds `com.schafferai.desktop-portal`; the optional audio installer adds `com.schafferai.desktop-audio` for the current macOS user. They start after login. Pause, disconnect, or quit remain available from the app menus.
