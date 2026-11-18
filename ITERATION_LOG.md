# SchafferAI Hub — Iteration Log

- **v2.2.1 (2026-11-17)**: Hardened `simulator_bridge.py` CORS to explicit UI origins and added ephemeral `X-Bridge-Token` / `Bearer` session protection for `/tap` and `/launch`; updated UI for truthful local-vs-unavailable action labels (`/build` not wired, Hermes/APEX blocked while paid GCP billing is kept OFF) and session-only token storage.
- **v2.2.0 (2026-11-17)**: Removed kinetic orb UI completely; replaced dark simulator boxes with borderless edge-to-edge iOS & Android live stream surfaces; modernized flat/pill button styling; added unified **Text & Voice Agent** console wired to `simulator_bridge.py` (`/devices`, `/frame`, `/tap`, `/launch`), MediaPipe gesture configuration, and Cloud Run/Hermes Gateway (`/treasury`, `/agent/reconcile`).
- **v2.1.0 (2026-11-17)**: Modern **Antigravity Bento-Grid** UI refresh with glassmorphic surfaces, refined pill navigation, and realistic iPhone & Android hardware bezels around the live `simulator_bridge.py` streams.
- **v2.0.0 (2026-11-16)**: Removed redundant CSS layout toggles; added **Simple Email Unlock**, **Real MediaPipe Hands**, **Gemini Live API** WebSocket voice client (`/live-token`), and **Live iPhone & Android Emulator Canvases**.
- **v1.2.0 (2026-11-16)**: Applied the minimalist **Antigravity** theme and Kinetic Antigravity Orb.
- **v1.1.0 (2026-11-16)**: Added webcam gesture game, Work Account Q&A, Reporting, and Control Plane.
- **v1.0.0 (2026-11-16)**: Initial revamp replacing the `HTTP 401` ChatGPT Sites gate.
