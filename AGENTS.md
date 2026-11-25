# Phone UI requirements

These are explicit user requirements from November 25, 2026.

- The phone must look and work like a phone: a large destination display, an always-visible 3-by-4 keypad with 0–9, * and #, a green Call button, and a red End call button during a call.
- Never hide the number keypad in Settings, a collapsed disclosure, or an in-call-only container.
- Keep secondary connection, status, microphone diagnostics, volume, messages and voicemail controls behind Settings.
- Keep calling inside the website. No Google Voice redirects or separate calling window, and no Twilio.
- Preserve active calls while editing or publishing. Never reload or restart their connection during a call.
- Protect Google phone credentials in the private local connector and authenticated browser memory. Never commit them, put them in public HTML, or log them.
- Distinguish SIP registration, outgoing-call verification, and incoming-call verification. Do not claim both call directions passed unless both were observed in real calls.

## Failure to prevent

A prior simplification put the keypad inside a collapsed, in-call-only section. That contradicted the requested phone UI. Future simplifications must preserve visible number buttons.
