# Website work-account authorization

The public site and wallpaper remain available without authentication. Private Work AI chat, voice generation, text, RTC signaling, call/SMS and event polling require a server-verified session. The page never treats a successful public health response as an owner login.

The Google Voice panel's Calls, Messages, Voicemail and Settings buttons only open the official Google Voice site, selecting the work account with `authuser`. Google handles its own sign-in, microphone, call controls and message sending. These navigation buttons do not call the private backend and do not need the website password. The panel's line-status and Gmail-forwarded inbox requests still require the website session. Late status, inbox and reply responses are discarded after logout; opening a Google window never claims that a call has connected. Inbound calls require Google Voice to stay open on the computer being used, as described in [Google's setup guide](https://support.google.com/voice/answer/165221?co=GENIE.Platform%3DDesktop&hl=en).

When a number is entered in the website's phone panel, its Call button uses [Google's documented call URL](https://support.google.com/voice/answer/3379129?co=GENIE.Platform%3DDesktop&hl=en), passing the normalized number through `a=nc`. A click requests a call through Google Voice; typing alone sends nothing. If a popup is blocked, an explicitly labeled direct call link is offered and no automatic retry occurs. Connection state and audio remain in Google Voice.

`work-auth.js` obtains a signed, expiring session from the existing Apps Script backend's `auth_login` action. The backend holds the configured credential verifier and signing secret in Script Properties; no configured password, verifier or secret belongs in this repository or public HTML. The user's shared password is a temporary credential; it can be changed server-side without publishing it.

Sessions are held in tab-scoped `sessionStorage`, expire after the backend's one-hour lifetime, and are checked on every protected action. Legacy persistent keys and URL credentials are removed rather than accepted. Signing out clears local session/history and stops polling and media. In-flight responses are discarded after logout or session change. Logout is local: an already-issued server session remains valid until its signed expiry or server-side secret rotation.

All Work AI requests use the centralized client. Anonymous calls cannot dispatch private actions even through programmatic event handlers. Authentication failure relocks the UI; network-ambiguous actions are never replayed automatically. Request bodies stay within the backend's 32,768-character cap; chat history is bounded separately from the owner's current message.

Run the offline authorization regressions with:

```sh
node --test test-work-auth.cjs
```

The tests cover unauthenticated action rejection, server authorization failure, expiry, malformed login responses, meaningful rate-limit diagnostics, request size, session storage, public-health truthfulness, signed-out page startup, logout/in-flight races and single-attempt mutations. Browser rendering and the real server's credential/session contract must be checked after deployment without invoking a paid or financial action.

The linked `/dev/` hub uses separate configured Mac bridge and gateway backends and their independent credentials. This Work AI fix does not certify those backends' authorization or make desktop-dependent tools cloud native.
