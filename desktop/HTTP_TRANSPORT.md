# Permanent HTTP desktop connection

`http-transport.js` implements the public browser side of the permanent HTTPS relay. `portal.js` selects it when `config.json` contains `"transport":"http"`; omitting that field retains the WebSocket implementation. The actual deployed relay origin is provided in `relayUrl` by deployment, not inferred from a hostname.

Desktop visitors do not sign in. The browser requests a public viewer lease with `POST /viewer/open {}`. Its returned ID tracks one of the two active viewers and expires if the browser stops pulsing; it is not a password or secret URL. All browser requests omit credentials and refuse redirects, so an HTML sign-in response cannot masquerade as a desktop frame.

While the tab remains connected, it renews its lease every five seconds and requests the latest JPEG every 250 milliseconds, with only one frame request in flight. It validates content type, frame identity, JPEG boundaries and the 2 MiB size limit. Readiness precedes every delivered frame. Closed connections and changes in producer readiness invalidate in-flight frame responses. Frames older than the three-second freshness window cannot authorize new input. The relay may temporarily retain its latest JPEG for delivery; the browser does not archive screenshots.

Input is collected for about 10 milliseconds and submitted as ordered batches of at most 64 events and 12 KiB of UTF-8 JSON. Only adjacent pointer movement or scrolling is coalesced. Key and button boundaries retain their order. A single request is in flight; input older than one second or an ambiguous request failure closes the viewer lease. Input requests are never retried. Closing discards pending input and makes best-effort keepalive release and lease-close requests. Server lease expiry remains the fallback if the browser loses its network.

The **Apps** control sends the Mac Spotlight shortcut through the remote connection. Use **Send text** to enter an app name, then **Return** to open it; **Esc** cancels. These controls help on touchscreens and when the local browser reserves keyboard shortcuts.

Optional audio uses the same public lease, with separate opt-in Sound and Microphone flags and monotonically increasing control revisions. Muting fences older in-flight enable requests. Each direction has a generation ID that changes when it stops or starts; reconnecting, locking or losing helper readiness invalidates old chunks. The audio companion authenticates as the producer without creating a new video epoch. Audio readiness is reported separately from desktop readiness.

System sound is PCM16LE at 48 kHz stereo; remote microphone input is PCM16LE at 16 kHz mono. Both use 200 ms chunks. Responses contain at most six fresh chunks; clients discard backlog, stop playback and browser microphone tracks on disconnect or hiding, and never retry audio uploads. The Mac routes remote microphone samples only to BlackHole 2ch. See [managed relay protocol](./managed-relay/README.md) and the [Mac audio helper](./mac/audio/README.md).

Offline validation from the repository root:

```sh
node --test desktop/tests/portal.test.cjs desktop/tests/http-transport.test.cjs
```

These checks use synthetic responses and never control the Mac. Production validation must separately establish the deployed relay, Mac permissions, current frame delivery and harmless live input.
