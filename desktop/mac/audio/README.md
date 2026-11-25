# Schaffer Desktop Audio

This separate menu-bar helper adds live sound and remote microphone forwarding to the permanent HTTPS desktop connection. It leaves the video app and its current signature and permissions intact. Sound and Microphone start off and are enabled only by a connected portal viewer. No audio is written to local files.

Build and validate without opening any audio device:

```sh
./desktop/mac/audio/build.sh /private/tmp/schaffer-desktop-audio/SchafferDesktopAudio.app
/private/tmp/schaffer-desktop-audio/SchafferDesktopAudio.app/Contents/MacOS/SchafferDesktopAudio --self-test
```

Install the final signed build, using the existing private desktop configuration:

```sh
python3 desktop/mac/audio/install.py --app /private/tmp/schaffer-desktop-audio/SchafferDesktopAudio.app --start
```

Grant **Screen & System Audio Recording** to **Schaffer Desktop Audio** in macOS Privacy & Security, then relaunch the helper if macOS requests it. The helper uses ScreenCaptureKit's system-audio output; it never adds a screen-image output or captures the Mac's physical microphone. The broader permission is the compatibility path required by its ScreenCaptureKit content filter. The separate System Audio Recording Only permission is not claimed as supported by this helper.

For remote microphone use, install the official [BlackHole 2ch driver](https://existential.audio/blackhole/) and select **BlackHole 2ch** as the input in the target Mac app. The helper renders received samples only to the exact `BlackHole2ch_UID` output device. It never changes the default input, selects the Mac speakers, or accesses `AVAudioEngine.inputNode`. Existing calls and default devices stay under the owner's control. Installation may require a restart; defer that until current work can be interrupted.

The helper polls the existing producer epoch, never creates or resets it. It reports its capabilities independently of video readiness. System audio is stereo PCM16LE at 48 kHz; remote microphone is mono PCM16LE at 16 kHz, both in 200 ms packets. Queues are bounded and late packets are dropped. Lock, sleep, pause, session changes, unavailable desktop state, lease changes and connection failures stop capture and flush playback. **Pause Audio** and **Quit Audio Helper** are available from its speaker menu-bar icon. **Retry Audio** retries after a transient device or capture error.

`--capabilities` reports permission, lock and BlackHole availability without capturing audio. It does not prove actual sound or microphone delivery. Real browser playback, browser microphone capture and virtual-input delivery need separate live validation. When viewing this Mac from a browser running on the same Mac, leave Sound off to avoid recapturing browser playback.
