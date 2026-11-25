# Loopback desktop relay

An alternative local transport using Node 20+ and the existing `ws@8.21.0` package. It binds **127.0.0.1 only**, on port 8794 by default. It does not touch the existing simulator bridge on port 8765. A separate HTTPS/WSS tunnel or permanent gateway is required to reach it remotely; this code does not create or deploy one.

Visitors have no authentication. The allowed browser Origin is a browser-policy check, not an identity check; anyone able to reach the public viewer endpoint can emulate the expected Origin and control the available desktop. A separate secret authenticates the fixed native producer only and is never sent to viewers.

Start with a private JSON file containing `producerKey` (a random 32..249-character value shared with the native producer). Do not commit that file or put its contents in shell arguments:

```sh
node server.js --config /absolute/private/config.json --port 8794
```

Only the localhost listening address is logged. Do not point a public tunnel at port 8765, which also provides unrelated services. This server offers only `/health`, `/agent`, and `/viewer`; no arbitrary host/path/shell/file commands. Input works only when the fixed producer reports ready and its heartbeat is fresh. JPEGs are forwarded immediately, never archived or replayed. Slow viewers are disconnected rather than retaining an old-frame backlog. Viewer close releases held input and updates capture demand. A disconnected or stale producer is unavailable.

Protocol and limits match [the Worker relay](../relay/README.md). The native agent connects to `/agent` with `Authorization: Bearer <producerKey>` and sends hello/status/heartbeat JSON plus raw JPEGs. The public browser connects to `/viewer` without a token. Native heartbeat cadence is 15 seconds; freshness limit 35 seconds. Maximum two viewers, 8 JPEGs/second at 2 MiB each, and 120 input messages/second per viewer.

`npm test` exercises real localhost HTTP and WebSocket handshakes, producer rejection, intentionally unauthenticated viewers, JPEG and input delivery, stale/locked behavior, no old frame for later viewers, limits, release, and reconnect. No provider deployment or macOS capture permission is needed for these synthetic transport tests.

`package-lock.json` retains the exact `ws@8.21.0` version and package integrity from the existing installation. If dependencies are absent, use `npm ci --omit=dev --omit=optional --ignore-scripts` or copy only that existing `ws` package into the ignored `node_modules/ws` directory. No Cloudflare/Google sign-in is performed by this server.

For an already-owned permanent Linux host, a Dockerfile is included. It has not been built or deployed here. Build from the repository root with `docker build -f desktop/local/Dockerfile -t schafferai-desktop .`. Run with Linux host networking (`--network host`) and mount the private producer configuration read-only at `/run/secrets/desktop-relay.json`; the unprivileged container user must be able to read the mounted file. Host networking preserves the server's loopback-only bind. A pre-existing HTTPS reverse proxy on that host must forward `/health`, `/agent`, and `/viewer` (with WebSocket upgrades) to `127.0.0.1:8794`. Port publishing on an ordinary isolated Docker network will not reach a loopback-only listener. macOS Docker host networking is not assumed supported. No hosting, certificate, DNS, public tunnel, or provider sign-in is created by these files.
