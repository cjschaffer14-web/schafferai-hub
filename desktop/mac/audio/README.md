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

The audio helper requires macOS 14.2 or later and uses CoreAudio’s dedicated system-audio tap. On first setup, its **Schaffer Desktop Audio** window offers **Enable System Sound**. That button briefly starts a private tap input so macOS can display its normal system-audio consent dialog. During this setup probe all samples are discarded and none are uploaded. Accept the normal macOS audio request; this helper does not request screen recording or microphone access. **Audio Setup…** and **Enable System Sound…** are also available from its speaker menu-bar icon.

The helper remembers that its audio engine previously initialized successfully so sound can remain available after login. This cached engine state is not a public macOS permission preflight API or proof of authorization. Every actual sound start uses the normal CoreAudio permission enforcement; initialization errors disable readiness. Actual consent must be checked in macOS and live PCM delivery must be verified separately.

For remote microphone use, install the official [BlackHole 2ch driver](https://existential.audio/blackhole/) and select **BlackHole 2ch** as the input in the target Mac app. The helper renders received samples only to the exact `BlackHole2ch_UID` output device. It never changes the default input, selects the Mac speakers, or accesses `AVAudioEngine.inputNode`. Existing calls and default devices stay under the owner's control. Installation may require a restart; defer that until current work can be interrupted.

The private global tap excludes the helper’s own audio process (and its bundle ID on macOS 26), so remote microphone output is not recaptured. A missing self-process identity blocks capture rather than creating an unfiltered tap. The tap remains unmuted, and its private aggregate has no physical microphone or speaker subdevices. It converts supported stereo tap audio into 48 kHz PCM without changing default audio devices.

The helper polls the existing producer epoch, never creates or resets it. It reports its capabilities independently of video readiness. System audio is stereo PCM16LE at 48 kHz; remote microphone is mono PCM16LE at 16 kHz, both in 200 ms packets. Queues are bounded and late packets are dropped. Lock, sleep, pause, session changes, unavailable desktop state, lease changes and connection failures stop capture and flush playback. **Pause Audio** and **Quit Audio Helper** are available from its speaker menu-bar icon. **Retry Audio** retries after a transient device or capture error.

`--capabilities` reports the cached engine-enabled flag, self audio-process mapping, lock state and BlackHole availability without opening audio IO. It does not claim to read macOS authorization or prove actual sound or microphone delivery. Real browser playback, browser microphone capture and virtual-input delivery need separate live validation. When viewing this Mac from a browser running on the same Mac, leave Sound off to avoid recapturing browser playback.
