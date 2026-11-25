# Deployment status — November 25, 2026

**Prepared, not deployed or activated.** `config.json` intentionally has no relay URL. The homepage/developer-hub links in this branch are proposals; production has not been changed. No desktop screen capture or real keyboard/mouse input was performed during this task.

The owner requires a permanent portal with no visitor login, no fresh hosting sign-in, and no temporary connection/address tradeoff. The temporary-tunnel alternative was rejected and was not started.

The implementation includes a responsive browser client, an isolated permanent Worker relay, an alternative loopback Node relay, and a locally built native Mac app. There is no portal login, MFA, PIN, cookie credential, or secret visitor URL. A private producer key identifies the Mac to the relay; no real key is included in this repository.

Completed validation:

- 16 frontend regression tests passed.
- 12 Worker relay tests passed.
- 7 real loopback HTTP/WebSocket relay tests passed.
- 23 existing work-account authorization/phone tests passed.
- Native Swift app compiled; input/configuration self-tests passed; ZIP-extracted app passed strict code-sign verification.
- Desktop and phone-size browser layout reviewed.
- Worker deployment dry-run passed; no Worker was published.

Remaining work requires a reachable permanent HTTPS/WSS host with existing usable deployment authority, then its actual relay URL and producer secret configuration. The checked deployment session could not refresh, the existing Google portal rejected public requests, and the recorded alternative server was unreachable. No provider sign-in was completed and no existing hosting/security configuration was changed.

After hosting is available, validate actual native app-context macOS permissions, live frames, harmless document input, disconnect/lock behavior, and stable recovery before enabling the production links. Live desktop operation requires an awake, unlocked Mac; its display may be off, but actual system sleep cannot run apps or stream the desktop. The app does not bypass macOS lock or lid-close behavior.
