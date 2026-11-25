# Schaffer Desktop Mac agent

This native menu-bar app publishes this Mac's main display to the dedicated desktop relay and accepts bounded mouse, scroll, keyboard, and text events. The visitor-facing portal has no login. A producer key identifies the Mac to the relay and stays in a local configuration file and the relay's secret store. Never commit a real key.

Build on an Apple Silicon Mac with Xcode command-line tools:

```sh
./desktop/mac/build.sh /private/tmp/SchafferDesktop.app
```

Create a local `config.json` from `config.example.json`, restrict it to its owner with `chmod 600`, and set the deployed HTTPS relay URL and producer key. Launch:

```sh
open /absolute/path/SchafferDesktop.app --args --config /absolute/path/config.json
```

The desktop icon in the menu bar has controls to pause/resume, disconnect, quit, and request macOS permissions. Grant **Screen Recording** and **Accessibility** to **Schaffer Desktop** through macOS System Settings. Permission prompts are never bypassed. A relaunch may be needed after changing Screen Recording permission. This app never records the microphone or sends audio.

Capture runs only while at least one viewer is connected, both permissions are granted, sharing is not paused, and the Mac's current session is unlocked. It sends JPEG frames at up to 8 frames/second, limited to 1440 pixels wide. Mouse coordinates refer to the captured main display. Changing the main display during a session requires disconnecting/reconnecting.

When the Mac locks, the app stops capture and input; the portal cannot unlock it. While the app is connected or reconnecting, an AC-only `caffeinate -s` assertion prevents system sleep without keeping the display on. It ends on manual disconnect or quit, and it does not prevent lid-close sleep. macOS automatic locking can still require a local unlock after the display turns off. This app does not alter sleep, lock, firewall, or login settings and does not install a startup job.

Nonprompting checks (no capture or input):

```sh
/absolute/path/SchafferDesktop.app/Contents/MacOS/SchafferDesktop --self-test
/absolute/path/SchafferDesktop.app/Contents/MacOS/SchafferDesktop --probe
```

The app reconnects after network failures with delays capped at 30 seconds. It releases its pressed remote keys and mouse buttons on pause, lock, last-viewer disconnect, relay failure, and quit. The portal should send `{ "type": "input", "event": { "type": "release" } }` when browser focus is lost. The transport accepts desktop input only; it has no shell, file-download, email, build, or automation API.

Unsigned distribution is not intended: local builds are ad-hoc signed for use on the owner's Mac. Moving a build to another Mac may require that Mac's normal Gatekeeper approval and fresh Screen Recording/Accessibility permissions. Build outside iCloud-synced directories: macOS can attach Finder metadata to app bundles in Documents, invalidating strict code-sign verification. A ZIP produced with `ditto --norsrc -c -k --keepParent` can be delivered through a synced folder; extract/install the app outside that folder.
