# SchafferAI permanent desktop relay

Dedicated public HTTP transport for https://schafferai.com/desktop/. Visitors do not sign in. A server-side `AGENT_KEY` authenticates the fixed Mac and its separate audio helper only.

D1 stores short viewer leases, current readiness and an expiring input queue. R2 retains the latest JPEG using a unique object key; publishing the next frame removes the prior key. Frames require a live viewer lease and a fresh, ready Mac. Stale, closed, paused or disconnected sessions clear the cache. Keyboard and mouse events expire after two seconds and are removed after acknowledgement. Content and credentials are not logged.

## Audio contract

Every new viewer starts with sound and microphone off. `POST /viewer/audio {id, revision, sound?, mic?}` changes these flags. `revision` is a positive, strictly increasing integer for the viewer; older or duplicate revisions return 409. Only one live viewer may send microphone audio. The response is `{epoch, sound, mic, revision, outputGeneration, inputGeneration, audio}`. The public lease ID tracks the session and is not an authentication credential.

- `GET /audio?id=&generation=&after=` returns Mac system sound: PCM16LE, 48 kHz, stereo, exactly 200 ms (38,400 raw bytes) per chunk.
- `POST /microphone {id,generation,seq,sampleRate:16000,channels:1,encoding:"s16le",pcm}` sends browser microphone audio: PCM16LE, 16 kHz, mono, exactly 200 ms (6,400 raw bytes). `pcm` is canonical base64.
- Producer-authenticated `POST /agent/audio {epoch,generation,seq,sampleRate:48000,channels:2,encoding:"s16le",pcm}` uploads system sound. Its JSON body limit is 70 KiB; ordinary input remains 16 KiB.
- Producer-authenticated `GET /agent/microphone?epoch=&generation=&after=` reads remote microphone chunks.
- Both reads return `{epoch,generation,sampleRate,channels,encoding:"s16le",chunks:[{seq,ageMs,pcm}]}`, at most six recent chunks. Each direction admits at most ten uploads per second and strictly increasing positive sequences. Invalid or stopped generations return 409.
- Producer-authenticated `GET /agent/audio-state` returns `{epoch,videoHealthy,videoReady,unlocked,soundViewers,micActive,outputGeneration,inputGeneration,outputSequence,inputSequence,audio}`. The audio helper must never call `/agent/connect`, which belongs to the video producer.
- Producer-authenticated `POST /agent/audio/status {epoch,status:{captureReady,microphoneReady,virtualInputName,message}}` supplies a separate audio heartbeat, normally every two seconds; it expires after eight seconds. System sound and virtual microphone readiness are independent. A missing audio permission does not change desktop `ready`.

`/health`, viewer status and audio controls expose `audio:{available,captureReady,microphoneReady,virtualInputName,message,micInUse}`. `available` means the helper heartbeat and ready, unlocked desktop are current; each direction still requires its own capability.

Sound/microphone generations change when that direction starts or stops, ownership changes, the helper expires, or the Mac locks/disconnects/reconnects. Late uploads and reads cannot republish a stopped generation. Unique per-chunk object keys prevent an old in-flight upload or cleanup from deleting a later chunk. Recent chunk rows are bounded by the upload quota and 1.2-second freshness window. Expired chunks are never served. Normal requests remove expired object data; a simultaneous hard disconnect can leave inaccessible, expired objects until the next relay request. There is no historical playback endpoint or recording archive.

The Mac helper sends remote microphone audio only to the explicit BlackHole 2ch virtual output. Mac apps must select **BlackHole 2ch** as their microphone input. Neither installing the driver nor enabling portal microphone changes the Mac's default input/output device. Browser microphone permission is requested only when the visitor clicks Microphone.

Schema lives in `db/schema.ts`; generated migrations are in `drizzle/`. Previously deployed migrations are immutable. Runtime bindings are `DB` and `BUCKET`; the producer secret belongs in Sites environment settings, never source. Native Sites tools own source publication and the stable deployment origin.

Validation: `npm test`, `npm run build`, `npm run validate`. The SQLite integration suite executes all generated migrations and exercises video/input, independent audio capabilities, PCM round trips, ownership, sequence/TTL/generation checks, helper expiry and late upload cancellation. Native Mac and browser clients live in `cjschaffer14-web/schafferai-hub/desktop`. Real Mac and browser audio still require separate live verification.
