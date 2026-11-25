# Website work-account authorization

## Separate public desktop portal

On November 25, 2026 the owner explicitly requested a live Mac desktop portal with no visitor authentication or MFA. `/desktop/` is intentionally public, as documented in `desktop/README.md`; its private producer key identifies the Mac, not a visitor. This exception applies to the desktop portal only. It does not change the server-verified session contract for the existing Google work-account tools below.

## Work-account tools

The public site and wallpaper remain available without authentication. Private Work AI chat, voice generation, text, RTC signaling, call/SMS and event polling require a server-verified session. The page never treats a successful public health response as an owner login.

The phone panel uses Google Voice SIP/WebRTC directly inside the website. It does not navigate to Google Voice or load another calling provider. A local private connector on 127.0.0.1:8878 carries SIP signaling to Google's own WSS endpoint; microphone and remote audio remain in the website browser.

The owner explicitly approved reading phone-specific SIP credentials issued to the signed-in Google Voice session. These credentials remain in an owner-only local file and authenticated browser memory. They are not committed, logged, stored in browser storage, or returned anonymously. The bridge requires the exact website origin and verifies the existing signed website owner session with Apps Script. Single-use WebSocket tickets expire after 30 seconds, and active signaling sessions are checked again every minute. No Google account cookies or OAuth refresh token are sent to the website.

The connector depends on this Mac remaining awake and the website remaining connected. Google's issued SIP credentials have an expiration; they must be renewed through an authorized signed-in Google Voice session. OAuth access to voice.googleapis.com remains unavailable for the existing Cloud projects. Live outbound/inbound call validation is separate from successful SIP registration and automated tests.

`work-auth.js` obtains a signed, expiring session from the existing Apps Script backend's `auth_login` action. The backend holds the configured credential verifier and signing secret in Script Properties; no configured password, verifier or secret belongs in this repository or public HTML. The user's shared password is a temporary credential; it can be changed server-side without publishing it.

Sessions are held in tab-scoped `sessionStorage`, expire after the backend's one-hour lifetime, and are checked on every protected action. Legacy persistent keys and URL credentials are removed rather than accepted. Signing out clears local session/history and stops polling and media. In-flight responses are discarded after logout or session change. Logout is local: an already-issued server session remains valid until its signed expiry or server-side secret rotation.

All Work AI requests use the centralized client. Anonymous calls cannot dispatch private actions even through programmatic event handlers. Authentication failure relocks the UI; network-ambiguous actions are never replayed automatically. Request bodies stay within the backend's 32,768-character cap; chat history is bounded separately from the owner's current message.

Run the offline authorization regressions with:

```sh
node --test test-work-auth.cjs
```

The tests cover unauthenticated action rejection, server authorization failure, expiry, malformed login responses, meaningful rate-limit diagnostics, request size, session storage, public-health truthfulness, signed-out page startup, logout/in-flight races and single-attempt mutations. Browser rendering and the real server's credential/session contract must be checked after deployment without invoking a paid or financial action.

The linked `/dev/` hub uses separate configured Mac bridge and gateway backends and their independent credentials. This Work AI fix does not certify those backends' authorization or make desktop-dependent tools cloud native.
