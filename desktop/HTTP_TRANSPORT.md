# Permanent HTTP desktop connection

`http-transport.js` implements the public browser side of the permanent HTTPS relay. `portal.js` selects it when `config.json` contains `"transport":"http"`; omitting that field retains the WebSocket implementation. The actual deployed relay origin is provided in `relayUrl` by deployment, not inferred from a hostname.

Setting `"frameStream":true` opts into `GET /frames?id=<lease>&after=<last-id>`. One response carries up to twelve current JPEGs over at most 1.8 seconds; the browser reconnects immediately when it ends. It keeps one fetch/validation/decode pipeline and does not add a polling pause between streamed frames. The original `/frame` path remains available and is selected automatically only if `/frames` returns HTTP 404 or 405 before body decoding. HTML, malformed streams and other failures never select a fallback.

Each streamed record starts with a four-byte big-endian JSON-header length (1–1024 bytes), then the UTF-8 header and its exact JPEG bytes. A frame header contains `type:"frame"`, a UUID `id`, `ageMs`, `offsetMs` (elapsed server request time) and `byteLength` (4 bytes–2 MiB). A zero header length ends the stream. A `type:"status"` header with zero `byteLength` updates availability and is followed by the end marker. The browser validates byte boundaries, metadata, JPEG markers and the twelve-frame limit. Its three-second deadline also cancels a blocked reader or decoder; disconnect and readiness changes invalidate pending delivery.

Stream freshness uses `ageMs + max(0, clientRequestElapsed - offsetMs)`, including time receiving and decoding the image. The server-relative offset must be present, nonnegative and no larger than the observed request duration. This avoids comparing clock times across devices or counting server processing twice. Expired frames and repeated cached identities do not authorize input.

Desktop visitors do not sign in. The browser requests a public viewer lease with `POST /viewer/open {}`. Its returned ID tracks one of the two active viewers and expires if the browser stops pulsing; it is not a password or secret URL. All browser requests omit credentials and refuse redirects, so an HTML sign-in response cannot masquerade as a desktop frame.

While the tab remains connected, it renews its lease every five seconds and requests the latest JPEG on a 125-millisecond cadence measured from request start. Input briefly requests a 60-millisecond cadence for one second. Fetch and JPEG decoding remain sequential; a slow request resumes without an extra fixed pause. It validates content type, frame identity, JPEG boundaries and the 2 MiB size limit. Readiness precedes every delivered frame. Closed connections and changes in producer readiness invalidate in-flight frame responses. Frames older than the three-second freshness window cannot authorize new input. The relay may temporarily retain its latest JPEG for delivery; the browser does not archive screenshots.

Clicks, keys, text and release flush in a microtask, retaining synchronous shortcut chords in one ordered batch. Motion and scrolling coalesce for up to eight milliseconds. Batches contain at most 64 events and 12 KiB of UTF-8 JSON. Only adjacent pointer movement or scrolling is coalesced. Key and button boundaries retain their order. A single request is in flight; input older than one second or an ambiguous request failure closes the viewer lease. Input requests are never retried. Closing discards pending input and makes best-effort keepalive release and lease-close requests. Server lease expiry remains the fallback if the browser loses its network.

The **Apps** control sends the Mac Spotlight shortcut through the remote connection. Use **Send text** to enter an app name, then **Return** to open it; **Esc** cancels. These controls help on touchscreens and when the local browser reserves keyboard shortcuts.

Optional audio uses the same public lease, with separate opt-in Sound and Microphone flags and monotonically increasing control revisions. Muting fences older in-flight enable requests. Each direction has a generation ID that changes when it stops or starts; reconnecting, locking or losing helper readiness invalidates old chunks. The audio companion authenticates as the producer without creating a new video epoch. Audio readiness is reported separately from desktop readiness.

System sound is PCM16LE at 48 kHz stereo; remote microphone input is PCM16LE at 16 kHz mono. Both use 200 ms chunks. Responses contain at most six fresh chunks; clients discard backlog, stop playback and browser microphone tracks on disconnect or hiding, and never retry audio uploads. The Mac routes remote microphone samples only to BlackHole 2ch. See [managed relay protocol](./managed-relay/README.md) and the [Mac audio helper](./mac/audio/README.md).

Offline validation from the repository root:

```sh
node --test desktop/tests/portal.test.cjs desktop/tests/http-transport.test.cjs desktop/tests/frame-stream.test.cjs
```

These checks use synthetic responses and never control the Mac. Production validation must separately establish the deployed relay, Mac permissions, current frame delivery and harmless live input.
